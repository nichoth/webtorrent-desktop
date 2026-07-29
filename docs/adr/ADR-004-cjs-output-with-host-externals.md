# ADR-004: Emit CommonJS and externalize host modules

**Date:** 2026-07-27

## Context

Vite targets browsers. Its default response to a Node builtin is to
substitute a browser shim, and its default response to a module it
cannot resolve is to warn and continue. Both defaults are wrong for
this renderer, which runs in an Electron window with
`nodeIntegration: true` and genuinely has Node available.

The failure mode is specific and dangerous. Left to the bundler,
`electron` resolves to `node_modules/electron/index.js` -- the npm CLI
helper, which exports a path string, not the runtime API. The build
reports success and `ipcRenderer` is `undefined` at runtime, with no
warning anywhere.

The renderer's dependency inventory, taken in US-001 and refined in
US-014, splits into three groups: builtins imported by first-party
renderer files, builtins reached only through dependencies (the
config-persistence stack under `lib/state.js`, the casting stack under
`lib/cast.js`), and `path`, which is a special case because thirteen
first-party files import it and every use is pure string manipulation.

Alternatives considered:

- **Bundle browser polyfills for everything.** Silently swaps in stubs
  that throw the first time config is written or a cast device is
  discovered.
- **Shim every builtin behind the platform boundary now.** Correct
  eventually, but it makes Phase 1 depend on Phase 2 and inflates the
  shim to cover modules no renderer file imports.

## Decision

Emit the bundle as CommonJS (`output.format: 'cjs'`) and externalize
the host modules, so a `require()` left in the output resolves against
the real Node and Electron registry at load time. CJS output is what
makes the `require()` calls emittable at all.

Two separate external lists, kept apart deliberately:

- **First-party externals** -- `fs`, `fs/promises`, `http`, `events`,
  `electron`, `@electron/remote`. This list is an accurate statement
  of what Phase 2's shim has to cover.
- **Transitive externals** -- `assert`, `constants`, `dgram`, `https`,
  `net`, `os`, `querystring`, `stream`, `timers`, `tls`, `url`,
  `util`, `worker_threads`. Reached only through dependencies.

The transitive list was enumerated from the externalization warnings
of a build with only the first list applied, rather than taken
wholesale from `module.builtinModules`, so a dependency reaching for a
new builtin surfaces as a warning instead of being silently absorbed.

`electron` and `@electron/remote` **must** be external, for the
resolution reason above.

`path` is the exception: it is bundled from `path-browserify` rather
than externalized, because all thirteen call sites do string
manipulation only. Matched as `/^path$/` so a package named
`path-something` is not captured, with `node:path` aliased separately
because dependencies spell it either way.

`crypto` and `os` are deliberately absent from the first-party list.
`crypto` is used only by `src/renderer/webtorrent.js`, which is exempt
from this build; `os` has had no renderer importer since the telemetry
deletion in US-002.

## Consequences

The renderer runs with real Node and Electron at hand, which is what
it did before, so this part of Phase 1 is behaviour-preserving.

The first-party external list doubles as the Phase 2 work inventory.
As call sites move behind the shim, entries drain from it: `fs` left
in US-028, leaving `fs/promises` for the shim's own use.

Externalizing is not decoupling. Every entry in the first-party list
is a dependency a Tauri host must satisfy, so this decision converts a
hidden problem into a visible list rather than solving it.

`path` being bundled means those thirteen call sites need no shim and
no change, which is a real saving, but it also means `path` is the one
Node-shaped import in the renderer that is *not* a decoupling concern.
Someone auditing imports has to know that.

A new builtin reached by a dependency shows up as a build warning, not
a failure. That is intentional, but it does depend on someone reading
build output.
