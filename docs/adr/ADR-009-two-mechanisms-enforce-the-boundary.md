# ADR-009: Enforce the shim boundary with two complementary mechanisms

**Date:** 2026-07-28

## Context

By the end of Phase 2 the renderer reached the host only through
`src/renderer/lib/platform/`. Nothing kept it that way. The decoupling
was a convention, and a convention that took nine stories to establish
can be undone by one plausible-looking import.

Two different things can erode it, and no single mechanism catches
both:

- **A new file importing a host module.** `import os from 'os'` in a
  new `lib/` helper. An import-specifier rule catches this, including
  in files nobody thought to check.
- **A migrated concern creeping back in an existing file.** An
  `ipcRenderer.` member read, a `wt-` channel string built by hand, a
  `new remote.Menu`, a `require()` spelling of a banned specifier.
  ESLint's `no-restricted-imports` sees `import` declarations only, so
  it is blind to every one of these.

Folding the architectural rule into the existing `standard` config was
considered and rejected: `standard` owns style, is shared with the
upstream project's conventions, and mixing an architectural constraint
into it makes both harder to reason about.

## Decision

Two mechanisms, deliberately complementary, neither replacing the
other.

**1. `eslint-boundary.config.js`** -- a standalone ESLint config at
the repo root, run with `--no-eslintrc`. It does not extend, override
or read `standard`'s settings, and `standard` does not read it. It
sets exactly one rule, `no-restricted-imports`, over
`src/renderer/**/*.js`, banning `electron`, `@electron/remote`, `fs`,
`os`, `crypto` and `http`, plus the `fs/promises`, `node:` and
`original-fs` spellings so the ban cannot be sidestepped by renaming.
It uses `@babel/eslint-parser`, the same parser `standard` uses, so it
parses exactly what `standard` parses -- JSX inside `.js` included.

Exemptions, in override order: `src/renderer/lib/platform/**/*.js` by
directory glob, so a new shim module is exempt without editing the
config; then the two deferred casualties from ADR-008.

`os` and `crypto` are preventive -- no renderer file has used either
since the telemetry deletion, and neither has a shim module -- so the
ban means the next use has to add one rather than reach past the
boundary.

**2. `test/unit/platform-boundary.js`** -- a source scan that walks
`src/renderer/`, skipping `lib/platform/`, and fails on banned
*usage*: any `ipcRenderer` reference, any `wt-` string literal, `new
remote.Menu`, `remote.dialog`, the `getCurrentWindow().isVisible` /
`.isMaximized` reads, and any `require()` of a banned host module. It
also asserts exactly which renderer files still import `electron` at
all, which is now only `webtorrent.js`.

It reads **source**, not build output, which is the point: the files
most likely to erode (`components/`, `controllers/`, `main.js`) have
no prebuilt copy under `build/` and are unreachable any other way.

The rule for extending: a new banned **specifier** goes in the lint
config, a new banned **usage** goes in the source scan.

Wiring: `npm run lint` is `standard && npm run lint:boundary`, and
`npm test` runs `npm run lint` first, so a direct host import stops the
run before `depcheck` or the unit tests execute.

## Consequences

The decoupling is a build failure rather than a convention. Adding
`import os from 'os'` to `lib/dispatcher.js` and running `npm test`
stops at `lint:boundary` with `'os' import is restricted from being
used`.

Two mechanisms means two places to look and two places to extend, and
someone will eventually add a rule to the wrong one. The
specifier/usage split is the rule that decides, and it is written into
both files and into `test/AGENTS.md`.

`test/unit/lint-boundary.js` drives the lint config through ESLint's
Node API rather than shelling out, so it can lint synthetic sources at
a chosen path and prove an exemption actually exempts without creating
throwaway files under `src/` that a crashed run would leave behind for
`standard` to trip over.

The checks name concerns, not module specifiers. That distinction
mattered during the migration -- `remote.Menu` and `remote.dialog`
lived in the same file and left in different stories -- and it means a
new check should describe what was migrated, not the import it happens
to sit beside.

`fs` is the one exception: a Node builtin with a single concern behind
it, so the scan bans the specifier outright.
