# src/

## The three trees, and the boundary between them

Since US-072 there is no JavaScript host. The app is two processes
plus the Rust host in `src-tauri/`, and this directory holds no host
code at all:

- `src-tauri/` -- the host, in Rust. It creates the window, owns the
  menus, tray, dialogs and paths, and spawns and supervises the engine
  (`src-tauri/src/engine.rs`), handing the UI its endpoint through the
  `get_engine_endpoint` command. It was `src/main/` until US-072; see
  `src-tauri/AGENTS.md`.
- `src/renderer/` -- the one UI window. Reaches the host **only**
  through `src/renderer/lib/platform/` (FR-8/FR-11), and reaches the
  engine only through that directory's `ipc-engine.js`.
- `src/engine/` -- the torrent sidecar (ADR-012). A plain Node process:
  Node builtins are its native surface, but it must not import Electron
  or touch a DOM global. See `src/engine/AGENTS.md`.
- `src/shared/` -- loaded by two runtimes at once, so no host import of
  any kind. See `src/shared/AGENTS.md`.

Two mechanisms enforce that, and they are complementary rather than
redundant. `eslint-boundary.config.js` (run by `npm run lint:boundary`
inside `npm run lint`) lints `src/renderer` and `src/engine` for banned
`import` declarations and, in the engine, banned globals.
`test/unit/platform-boundary.js` scans the same two trees in source,
which is what catches the `require()` spellings ESLint cannot see plus
the usage-level concerns no import rule can express. Adding a banned
specifier means editing the config; adding a banned *usage* means
editing the scan.

`docs/platform-shim.md` is the contract for both seams: the shim's API
surface and the full `wt-*` wire protocol, including the sidecar
topology and the pre-connect queue.

## Module systems

`src/renderer/` is ESM; `src/config.js`, `src/shared/` and
`src/engine/` are loaded by plain Node and stay CommonJS.
`npm run build` runs two halves:

- `npm run build:renderer` (`vite build`) bundles the renderer entry
  `src/renderer/main.js` and everything it reaches into
  `build-vite/renderer/main.js`, which `static/main.html` loads. There
  is one of these now: US-072 deleted the `WT_HOST` flag and the
  second, Tauri-specific renderer build that went with it.
- `npm run build:node` (`babel src --out-dir build`) compiles
  everything else: `src/config.js`, `src/shared/**` (see
  `src/shared/AGENTS.md`), `src/engine/**` (see
  `src/engine/AGENTS.md`) and `src/renderer/lib/**`, which the unit
  tests require. It was `build:main` until US-072; the name went with
  the main process it built.

`build:node` therefore passes `--ignore` for the four paths Vite owns
exclusively -- `src/renderer/main.js`, `components/`, `controllers/`
and `pages/`. Nothing outside the Vite bundle requires them, so Babel
emitting them again would only leave a stale second copy of the
renderer that nothing loads. If a *new* non-Vite consumer ever needs
one of those files, shrink the ignore list rather than adding a second
build step. `src/renderer/lib/**` is deliberately NOT ignored: it is
built twice because `test/unit/*.js` is CommonJS and requires the Babel
output, never the ESM sources (ADR-010).

The `babel` key in `package.json` carries
`@babel/plugin-transform-modules-commonjs` with
`sourceType: "unambiguous"`. Without that plugin Babel leaves `import`
and `export` untouched in the output, and the sidecar and the unit
suite cannot `require()` the result. Do not remove it. `unambiguous` is
what keeps files with no `import`/`export` compiling as scripts, so the
still-CommonJS files are not silently switched to strict mode.

Convert consumers before their dependencies. Babel compiles
`export default X` to `exports.default = X`, so a CommonJS caller doing
`require('./x')` on a converted module gets a wrapper object instead of
the value. The reverse (ESM importing CommonJS) is safe via Babel's
`_interopRequireDefault`.

## `src/config.js`

Exports every value **twice**: once as a named export and once inside
the default export object. Both are load-bearing.

- Named exports serve the CommonJS consumers -- the engine sidecar,
  `src/shared/`, `bin/` and the unit suite (`config.APP_NAME` and
  `const { APP_NAME } = require('../config')`).
- The default export serves ESM renderer code
  (`import config from '../config'`).

Adding a value to one and not the other makes it silently missing for
half the codebase. There is a "keep in sync" comment on the default
export object.

`bin/clean.js` and `bin/open-config.js` require this file **straight
from source**, so plain Node loads it as real ESM rather than through
Babel. That is why `__dirname` is read through the `DIRNAME` guard at
the top -- it does not exist in an ES module scope. Anything new added
here that depends on a CommonJS-only global will break those two npm
scripts, and nothing else will notice.

**Do not put a host import in this file at all.** It used to require
`electron` and `@electron/remote` lazily, inside the branch of
`getPath()` that needed them, so that the sidecar -- which has no
`node_modules/electron` once packaged -- could still load it. US-072
removed both branches with the host: the OS directory lookup is
`src-tauri/src/paths.rs` now and reaches the renderer through the
`app_paths` command. `getPath()` and `isProduction()` are left as
constant answers with the reasoning in a comment at each, because
neither of the two runtimes that still load this file -- plain `node`
for the sidecar, the webview for the renderer -- can answer them.

One consequence is open and is recorded against US-072 in
`progress.log`: nothing in the renderer consumes `app_paths` yet, so
`DEFAULT_DOWNLOAD_PATH` is empty in a profile created before it does.

## `src/renderer/lib/`

The utility modules that used to do `module.exports = { fnA, fnB }` now
use plain named exports, and their call sites import them as namespaces
(`import * as TorrentSummary from '../lib/torrent-summary'`) because
every call site uses them namespace-style (`TorrentSummary.getByKey`).
Do not reintroduce a default export object for these -- a default and a
namespace would drift apart.

The single-value modules (`media-extensions.js`, `state.js`) use
`export default`. Their remaining CommonJS consumers -- the unit suite,
which requires the Babel output -- therefore have to say
`require('...').default`. `torrent-poster.js` has both a default export
(`torrentPoster`) and named ones (`generateTorrentPoster`,
`choosePosterSource`), because US-043 gave it a job as well as an
answer.

`state.js` was imported by the main process as well until US-055 moved
its save and load behind the shim, and US-072 deleted the last caller
with the process. It is renderer-only now, and the
`process.type === 'renderer'` guard it kept in `load()` for that reason
is dead weight rather than a constraint -- there is no other process
that could reach it.

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

Measure with `git stash && npm start` for the before, and
`performance.now()` either side of the `require` in
`build-vite/renderer/main.js` for the where.

## Node builtins in `src/renderer/`

Every builtin the renderer imports needs an entry in `vite.config.js`,
or Rolldown silently swaps in a browser stub that throws on first use.
A green `npx vite build` does not catch this -- it is a *warning*
(`Module "x" has been externalized for browser compatibility`), not an
error. So after adding any new builtin import, check the build's stderr
for that warning; the expected count is 0.

There are two strategies, and the choice is deliberate:

- **Bundle** it, if a browser-safe implementation is equivalent. `path`
  is aliased to `src/renderer/lib/path.js` this way, which is why its 13
  renderer call sites need no shim and no change. That module is
  first-party (ADR-011) and its unit test diffs it against Node's
  `path.posix`, so extending it means adding cases to
  `test/unit/path.js`, not trusting a package.
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
