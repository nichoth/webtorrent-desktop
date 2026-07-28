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

Only `src/renderer/lib/**` and `src/main/**` are reachable this way.
`build:main` deliberately ignores `src/renderer/main.js`,
`components/`, `controllers/` and `pages/` (Vite owns those), so those
modules cannot be unit tested through `build/`. See `src/AGENTS.md`.
