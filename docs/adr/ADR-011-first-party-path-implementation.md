# ADR-011: Own the renderer's `path` implementation

**Date:** 2026-07-29

## Context

ADR-004 decided that `path` is bundled into the renderer rather than
externalized, because all thirteen first-party call sites do pure
string manipulation and a bundled implementation keeps them off the
Phase 2 shim inventory. The implementation it reached for was the
`path-browserify` package, aliased in `vite.config.js`.

Two things about that were unsatisfying once it had been in place for
a while.

The alias is not scoped to first-party code. It matches every `path`
specifier in the graph, so it also serves eleven bundled dependencies
-- `application-config`, `application-config-path`,
`write-file-atomic`, `write-json-file`, `load-json-file`, `make-dir`,
`rimraf`, `path-scurry`, `mime`, `parse-torrent`, `create-torrent` --
which use a wider surface than the UI does: `resolve`, `normalize`,
`format`, and in `path-scurry`'s case `import { posix, win32 } from
'path'`. So `path-browserify` was not a leaf polyfill for thirteen
call sites. It was load-bearing infrastructure underneath the config
persistence and torrent-creation stacks, and the repo neither owned nor
tested it.

`path-browserify` is also a vendored copy of Node's own posix
implementation, frozen at 1.0.1 in 2020. It is 529 lines of code the
app ships, that nothing in this repo exercises, to provide behaviour
Node documents publicly and that any implementation can be checked
against.

Alternatives considered:

- **Externalize `path` like `fs` and `events`.** Zero code, and the
  renderer genuinely has Node today. But it makes `path` a host
  dependency in thirteen renderer files, and a Tauri renderer has no
  Node to satisfy it. That reverses part of ADR-001 to save writing a
  string library.
- **Keep `path-browserify`.** Nothing is broken. But the objection is
  not correctness, it is that the repo cannot see or test code its
  dependencies rely on at runtime.

## Decision

Replace `path-browserify` with `src/renderer/lib/path.js`, a
first-party posix implementation, and point the existing `/^path$/`
and `/^node:path$/` aliases at it. The package is removed from
`package.json`; the two aliases and the ADR-004 bundling decision are
otherwise unchanged.

The module matches the surface `path-browserify` exposed, and no more:
posix `resolve`, `normalize`, `isAbsolute`, `join`, `relative`,
`dirname`, `basename`, `extname`, `format`, `parse`,
`toNamespacedPath` (with the legacy `_makeLong` alias), `sep`,
`delimiter`, a `posix` self-reference, and `win32` as `null`. It is
ESM with both named and default exports, so `import path from 'path'`
and `import { posix, win32 } from 'path'` both resolve.

**Windows semantics are deliberately out of scope.** `path.win32` is
`null`, exactly as it was under `path-browserify`. `path-scurry`'s
Windows classes read `win32.parse` and would fail on it -- a hole this
decision carries over rather than introduces. Closing it means writing
drive-letter and UNC handling, which is where a path implementation is
most likely to be subtly wrong, and doing it blind with no Windows
machine in the loop. Ban it from this change and decide it on its own
merits later.

Correctness is settled by differential testing, not by review.
`test/unit/path.js` runs 633 assertions -- a table of paths, suffixes,
join and resolve argument lists, and `parse`/`format` round-trips --
through both this module and Node's own `path.posix`, and requires the
answers to be identical. Node is the oracle and no expected strings are
hard-coded, so the test states the contract as "behaves as Node does"
rather than as a frozen snapshot of one author's understanding.

That test earned its keep immediately: it caught six divergences on
first run. `dirname('//a')` is `'//'`, not `'/'`. `basename` takes a
genuinely different code path when a suffix is given, in which an
input of nothing but slashes returns itself rather than `''`, and a
suffix equal to the entire input returns `''` -- while the same suffix
against the same name under a directory does not. None of those would
have been found by reading.

## Consequences

One fewer dependency, and the ~500 lines it contributed to the bundle
are replaced by ~250 the repo can read.

The renderer's `path` is now testable, and tested, including on behalf
of the eleven dependencies that reach it through the alias. Before this
it was a black box that the app's config persistence depended on.

`resolve()` is the one function that consults the host, for the working
directory a relative path resolves against. It reads `process.cwd`
defensively and falls back to `/` where there is no `process`, so it
matches Node under Electron and degrades rather than throwing under
Tauri. No renderer call site resolves a relative path today, so the
fallback is currently unreachable.

The cost is ownership. A `path` bug is now this repo's bug, and a
dependency that starts using a function outside the implemented
surface gets `undefined` rather than a working import. The build will
not warn about that -- the alias resolves fine, the missing export is
a runtime failure. The differential test is the mitigation, and
extending the module means extending the test in the same commit.

ADR-004's reasoning is untouched: `path` is still bundled, still not a
Phase 2 shim concern, and still the one Node-shaped import in the
renderer that is not a decoupling problem. It is now more clearly so,
because it is no longer a Node module in any sense -- it is renderer
code that happens to be reachable under the specifier `path`.
