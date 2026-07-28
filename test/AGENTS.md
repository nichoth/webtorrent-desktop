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

`require.resolve('electron')` gives the same path the built module
resolves (the npm CLI helper, which is never the real runtime API
outside Electron anyway). Babel emits `_electron.ipcRenderer` as a
property read at each call site, so the getter is consulted per call
and the stub can be swapped between tests. See
`test/unit/platform-ipc-os.js`.

Only `src/renderer/lib/**` and `src/main/**` are reachable this way.
`build:main` deliberately ignores `src/renderer/main.js`,
`components/`, `controllers/` and `pages/` (Vite owns those), so those
modules cannot be unit tested through `build/`. See `src/AGENTS.md`.
