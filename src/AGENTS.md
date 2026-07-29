# src/

## Module systems

`src/renderer/` is being converted to ESM; `src/main/` stays CommonJS.
Both reach Electron as CommonJS, but by two different routes, and
`npm run build` runs both:

- `npm run build:renderer` (`vite build`) bundles the renderer entry
  `src/renderer/main.js` and everything it reaches into
  `build-vite/renderer/main.js`, which `static/main.html` loads.
- `npm run build:main` (`babel src --out-dir build`) compiles
  everything else: `src/config.js`, `src/main/**`,
  `src/renderer/webtorrent.js` (FR-4 exempts it from Vite) and
  `src/renderer/lib/**`, which both `webtorrent.js` and
  `src/main/index.js` require.

`build:main` therefore passes `--ignore` for the four paths Vite now
owns exclusively -- `src/renderer/main.js`, `components/`,
`controllers/` and `pages/`. Nothing outside the Vite bundle requires
them, so Babel emitting them again would only leave a stale second copy
of the renderer that nothing loads. If a *new* non-Vite consumer ever
needs one of those files, shrink the ignore list rather than adding a
second build step. `src/renderer/lib/**` is deliberately NOT ignored:
it is shared, so it is built both ways.

The `babel` key in `package.json` carries
`@babel/plugin-transform-modules-commonjs` with
`sourceType: "unambiguous"`. Without that plugin Babel leaves `import`
and `export` untouched in the output, and Electron 27 (Node 18) cannot
`require()` an ES module -- the app dies at startup. Do not remove it.
`unambiguous` is what keeps files with no `import`/`export` compiling as
scripts, so the still-CommonJS files are not silently switched to strict
mode.

Convert consumers before their dependencies. Babel compiles
`export default X` to `exports.default = X`, so a CommonJS caller doing
`require('./x')` on a converted module gets a wrapper object instead of
the value. The reverse (ESM importing CommonJS) is safe via Babel's
`_interopRequireDefault`.

## `src/config.js`

Exports every value **twice**: once as a named export and once inside
the default export object. Both are load-bearing.

- Named exports serve `src/main/` (`config.APP_NAME` and
  `const { APP_NAME } = require('../config')`).
- The default export serves ESM renderer code
  (`import config from '../config'`).

Adding a value to one and not the other makes it silently missing for
half the codebase. There is a "keep in sync" comment on the default
export object.

`bin/clean.js`, `bin/package.js` and `bin/open-config.js` require this
file **straight from source**, so plain Node loads it as real ESM rather
than through Babel. That is why `__dirname` is read through the
`DIRNAME` guard at the top -- it does not exist in an ES module scope.
Anything new added here that depends on a CommonJS-only global will
break those three npm scripts, and nothing else will notice.

## `src/renderer/lib/`

The utility modules that used to do `module.exports = { fnA, fnB }` now
use plain named exports, and their call sites import them as namespaces
(`import * as TorrentSummary from '../lib/torrent-summary'`) because
every call site uses them namespace-style (`TorrentSummary.getByKey`).
Do not reintroduce a default export object for these -- a default and a
namespace would drift apart.

The single-value modules (`media-extensions.js`, `torrent-poster.js`,
`state.js`) use `export default`. Their remaining CommonJS consumers
therefore have to say `require('...').default`; see
`src/renderer/webtorrent.js`, `test/test-select-poster.js` and
`src/main/index.js`.

`state.js` is the only renderer module the **main** process consumes
(`src/main/index.js` calls `State.load(cb)`). It is also imported by
both processes at once, so it must stay free of renderer-only globals:
anything that needs the renderer belongs behind the
`process.type === 'renderer'` guard in `load()`, the way `migrations.run`
is.

## `src/renderer/webtorrent.js`

Exempt from all of the above (FR-4): it stays CommonJS, is never passed
through Vite, and loads via `static/webtorrent.html`.

## Deferring a module load in the renderer

**Do not use dynamic `import()` in `src/renderer/`.** It never settles
there -- no resolve, no reject, no console error, and control never
returns to the caller. `static/main.html` loads
`build-vite/renderer/main.js` from a classic `<script src>` in a
`file://` document, so `import()` goes through Chromium's loader rather
than Node's, and a bare specifier just hangs.

That leaves only two ways to load a module, and the choice is a
measurement, not a preference:

- A static `import` is right for anything cheap, which is nearly
  everything. This is what US-005..US-013 did for the lazy `require()`
  and `fn-getter` thunks they replaced.
- A `require()` inside a function is the only working deferral. It is a
  deliberate exception, so it needs a comment saying what it cost to
  load and confirming a static import was actually measured.

`lib/cast.js:47-49` is the only such exception today: the casting stack
blocks the renderer for ~3.8 seconds.

Measure with `git stash && npm run build && npx electron --no-sandbox .`
for the before, and `performance.now()` either side of the `require` in
`build/renderer/main.js` for the where.

## Node builtins in `src/renderer/`

Every builtin the renderer imports needs an entry in `vite.config.js`,
or Rolldown silently swaps in a browser stub that throws on first use.
A green `npx vite build` does not catch this -- it is a *warning*
(`Module "x" has been externalized for browser compatibility`), not an
error. So after adding any new builtin import, check the build's stderr
for that warning; the expected count is 0.

There are two strategies, and the choice is deliberate:

- **Bundle** it, if a browser-safe implementation is equivalent. `path`
  is aliased to `path-browserify` this way, which is why its 13 renderer
  call sites need no shim and no change.
- **Externalize** it, for anything that needs the real Node module.
  Works because the Vite output format is `'cjs'` and the renderer runs
  with `nodeIntegration: true`, so an emitted `require()` resolves
  against Electron's module registry at load time. Do not change that
  format without re-checking every external.

`electron` and `@electron/remote` MUST stay external. A bundler resolves
`require('electron')` to `node_modules/electron/index.js` -- the npm CLI
helper, which exports a path string, not the runtime API -- and emits no
warning at all, so `ipcRenderer` ends up `undefined` while the build
reports success.

`vite.config.js` keeps first-party externals and dependency-only ones in
separate lists on purpose: the first list is the inventory of what the
Phase 2 platform shim has to cover. Add to the right one.
