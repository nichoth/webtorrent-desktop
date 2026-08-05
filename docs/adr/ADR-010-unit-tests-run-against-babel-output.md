# ADR-010: Unit tests require Babel output under `build/`, never `src/`

**Date:** 2026-07-28

**Amended by US-072 (2026-08-04).** The decision holds -- unit tests
are still CommonJS over `build/` -- but two of its surroundings moved.
`npm run test-unit` runs `npm run build` (both halves, so the Vite
bundle the boot test loads is current) rather than the renamed
`build:main`, and the Spectron suite the alternatives below weigh
against is deleted with the host it drove; `test/AGENTS.md` records
what replaces it. The shim modules no longer import `electron`, so the
second obstacle below is now solved by the port rather than by this
record -- what remains is stubbing `@tauri-apps/api` through
`require.cache`, which works the same way for the same reason.

## Context

Before Phase 2 the only automated coverage was `standard`, `depcheck`
and a Spectron integration suite that launches the real Electron app.
The shim needed real unit tests: nine modules whose whole job is to
translate between callers and Electron, where the interesting
behaviour is exactly what gets sent on which channel.

Two obstacles.

`src/renderer/` is ESM after Phase 1 while the rest of the repo is
CommonJS loaded by Node directly (ADR-003). A plain
`require('../../src/renderer/lib/time')` fails on the `export`
keyword.

And the modules under test import `electron` and `@electron/remote`,
which do not exist outside an Electron process. `require('electron')`
in plain Node resolves to the npm CLI helper, which exports a path
string.

Alternatives considered:

- **Add a transform dependency** (`esbuild-register`, `tsx`, a Jest
  transform) so tests can require `src/` directly. Introduces a second
  compilation path for the same code, which can drift from the Babel
  build that actually ships.
- **Test through Spectron only.** Launching the whole app to assert
  that `setBadge(3)` sends on the `setBadge` channel is slow and
  proves less.

## Decision

Unit tests are CommonJS, use `tape`, and require the **Babel output
under `build/`**, not the ESM sources under `src/`:

```js
const { calculateEta } = require('../../build/renderer/lib/time')
```

`npm run test-unit` therefore runs `npm run build:main` first, then
`tape test/unit/*.js`. This is the same route `src/main/index.js` and
`static/webtorrent.html` already use, so no extra transform dependency
is needed and there is no second compilation path.

Electron is stubbed by seeding `require.cache` at
`require.resolve('electron')` before the first require of the module
under test. `require.resolve` never executes the module, so the real
one's throw is never reached, and Babel emits `_electron.ipcRenderer`
as a property read at each call site, so a getter on the stub is
consulted per call and can be swapped between tests. `@electron/remote`
is stubbed the same way, with `__esModule: true` so Babel's interop
does not wrap it in a `default`.

Node builtins cannot use that route -- Node never consults the cache
for them -- so `fs/promises` is stubbed by assigning over the
properties of the shared module object and restoring them in the same
test.

Controllers have no prebuilt copy, because `build:main` ignores
`components/`, `controllers/`, `pages/` and `main.js`. A controller
test compiles its one file with `@babel/core` and writes the result
into `build/renderer/controllers/`, which is what makes the
controller's own `../lib/...` imports resolve against the real built
`lib/`. A temp directory would not resolve at all.

`src/renderer/main.js` cannot be required at all -- its module body
calls `State.load()` and pulls in React, every page and the whole
controller graph -- so it is checked statically instead.

## Consequences

Tests exercise the code that ships, compiled the way it ships. The
suite is 654 assertions and runs in seconds without Electron.

The cost is a rule that has to be known: `npx tape test/unit/*.js` on
its own tests a stale copy unless you have just built. Always go
through `npm run test-unit`.

Coverage has a hard edge. Only `src/renderer/lib/**` and `src/main/**`
are reachable through `build/`. Anything Vite owns is testable only via
the compile-it-yourself recipe or a static check, which is why the
boundary enforcement in ADR-009 needs a source scan.

`tape test/unit/*.js` is a **single process** that requires every file
before running any test, and that produced a class of cross-file
hazards worth stating: `setDispatch()` is process-wide, so the last
file loaded wins unless it is called per-test; a `require.cache` stub
of a built shim module leaks into later files unless withdrawn right
after the module under test is required; two files compiling the same
controller collide on the emitted path unless one uses a distinct
suffix; and letting a real shim module load inside a controller test
binds that file's `electron` stub into it for the whole run.

Statically checking `main.js` turned out to be worth more than a
require-based test would have been. `test/unit/main-ipc-call-sites.js`
resolves every `ipcOs.x` / `ipcEngine.x` member the file reaches for
against the shim's actual exports, so a typo'd or invented export fails
there instead of silently becoming `undefined` at runtime.
