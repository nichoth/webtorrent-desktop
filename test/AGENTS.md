# test/

Two independent suites live here.

## Integration (`npm run test-integration`)

`test/index.js` is the entry point. It runs `tape` through Spectron,
launching the real Electron app, and requires each `test/test-*.js`
file explicitly. Adding a new integration file means adding a
`require()` to `test/index.js` -- there is no glob.

## Unit (`npm run test-unit`)

`test/unit/*.js` is globbed by the `test-unit` script, so a new file
is picked up with no registration. `npm test` runs `test-unit` after
`standard` and `depcheck`.

Unit tests are **CommonJS** and require the Babel output under
`build/`, not the ESM sources under `src/`:

```js
const { calculateEta } = require('../../build/renderer/lib/time')
```

`src/renderer/` is ESM and the rest of the repo is CommonJS loaded by
Node directly, so plain `require('../../src/renderer/lib/time')` fails
on the `export` keyword. `test-unit` therefore runs `npm run
build:main` first; do not run `npx tape test/unit/*.js` on its own
unless you have just built, or you are testing a stale copy of the
source. This is the same route `src/main/index.js` and
`static/webtorrent.html` already use, so no extra transform dependency
is needed.

### Stubbing `electron` in a unit test

Modules that `import { ipcRenderer } from 'electron'` are testable
without Electron by seeding `require.cache` before the first require
of the module under test:

```js
const electronPath = require.resolve('electron')
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: { get ipcRenderer () { return stub } }
}
const mod = require('../../build/renderer/lib/platform/ipc-os')
```

A module that imports several Electron surfaces needs one cache entry
with a getter per surface -- `shell.js` is stubbed with `shell` and
`ipcRenderer` getters on the same `exports` object (see
`test/unit/platform-shell.js`).

`@electron/remote` is stubbed the same way, at
`require.resolve('@electron/remote')` -- add `__esModule: true` to the
stub's `exports` so Babel's interop treats it as a module rather than
wrapping it in a `default` (see `test/unit/platform-dialog.js`).
`require.resolve` never executes the module, so the real one's
"cannot be required in the browser process" throw is not reached.

The stub's `exports` **object** is bound once, at the first require of
the module under test -- Babel keeps the result of its single
`require()` call. So a helper that rebuilds the whole stub between
tests silently leaves the module talking to the first one. Swap the
recording state behind stable stub functions/classes instead, or use
getters on one `exports` object (see `test/unit/platform-menu.js`).

`require.resolve('electron')` gives the same path the built module
resolves (the npm CLI helper, which is never the real runtime API
outside Electron anyway). Babel emits `_electron.ipcRenderer` as a
property read at each call site, so the getter is consulted per call
and the stub can be swapped between tests. See
`test/unit/platform-ipc-os.js`.

### Stubbing a Node builtin (`fs/promises`) in a unit test

The `require.cache` route does **not** work for builtins -- Node never
consults the cache for them, so seeding `require.resolve('fs/promises')`
has no effect. Their exports are plain writable properties on one
shared module object instead, and Babel emits the same per-call-site
`_promises.readFile` property read, so assigning over those properties
before a call and restoring them after does the same job:

```js
const fsp = require('fs/promises')
const real = fsp.readFile
fsp.readFile = async (...args) => { calls.push(args); return stubbed }
// ... exercise the module, then:
fsp.readFile = real
```

Always restore in the same test, or later tests (and tape itself) run
against the stub. See `test/unit/platform-fs.js`.

Only `src/renderer/lib/**` and `src/main/**` are reachable this way.
`build:main` deliberately ignores `src/renderer/main.js`,
`components/`, `controllers/` and `pages/` (Vite owns those), so those
modules cannot be unit tested through `build/`. See `src/AGENTS.md`.

## Static boundary tests

Because `components/`, `controllers/` and `main.js` are unreachable
through `build/`, the only automated check on their imports is a
static one. `test/unit/platform-boundary.js` walks the **sources**
under `src/renderer/`, skipping `lib/platform/`, and fails on any
direct use of an Electron API that has already been migrated behind
the shim (`shell` and `clipboard` today). Each of US-027..US-032 adds
its concern to that list as it lands; US-034 supersedes the whole file
with a lint rule. Reading source rather than build output is the
point -- do not repoint it at `build/`.
