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

The consequence is a startup ordering rule. Every path this file
exports is the empty string until `bootstrap()` in
`src/renderer/main.js` awaits `lib/platform/paths.appPaths()` and feeds
the answer to `useHostPaths`, which it does before `State.load`.
Anything that reads `CONFIG_PATH`, `TORRENT_PATH`, `POSTER_PATH` or
`DEFAULT_DOWNLOAD_PATH` must therefore read it **at call time**, never
capture it at module load -- `stateFile()` in `lib/state.js` is a
function for exactly this reason. `test/unit/renderer-boots.js` runs
the emitted bundle and asserts the ordering; `test/unit/state-file.js`
asserts the late read.

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

`dispatcher.js`'s `dispatcher(...)` memo is module-wide and keyed by
the JSON of its arguments, so it only shrinks when something calls
`dropDispatchers()`. Anything that makes a whole family of keys
meaningless (deleting torrents does today) should drop it; tests
observe the drop as `dispatcher(sameArgs)` returning a new function.

## Deferring a module load in the renderer

**Do not use dynamic `import()` in `src/renderer/`.** It never settles
there -- no resolve, no reject, no console error, and control never
returns to the caller. `static/main.html` loads
`build-vite/renderer/main.js` from a classic `<script src>`, so
`import()` goes through the webview's loader rather than Node's, and a
bare specifier just hangs. That was measured under Electron on a
`file://` document; the document is served over Tauri's asset protocol
now, out of the root `bin/build-tauri.js` assembles, and the bundle is
an `iife` with no bare specifiers left in it either way.

That leaves only two ways to load a module, and the choice is a
measurement, not a preference:

- A static `import` is right for anything cheap, which is nearly
  everything. This is what US-005..US-013 did for the lazy `require()`
  and `fn-getter` thunks they replaced.
- A `require()` inside a function is the only working deferral. It is a
  deliberate exception, so it needs a comment saying what it cost to
  load and confirming a static import was actually measured.

**There is no such exception today.** `lib/cast.js:47-49` was the only
one -- the casting stack blocked the renderer for ~3.8 seconds -- and
US-079 deleted the file with the three packages (ADR-015), which took
the last `require()` out of `src/renderer/` altogether. A new one is
therefore also a new *kind* of thing, and
`test/unit/platform-boundary.js` will not let it reach a host module.

Measure with `git stash && npm start` for the before, and
`performance.now()` either side of the `require` in
`build-vite/renderer/main.js` for the where.

## Node builtins in `src/renderer/`

**There are no externals.** Until US-072 a builtin could be left as a
`require()` and answered at runtime by the Electron window's
`nodeIntegration: true` (ADR-004). A webview has no `require` and no
module registry, so that list came out with the host; everything the
bundle names is now bundled into it.

That leaves one strategy and one trap. The strategy: if the renderer
needs a builtin, give it a **first-party implementation** and alias it
in `vite.config.js`. `path` (`lib/path.js`, ADR-011), `events`,
`stream` and `util` are aliased this way, which is why `path`'s 13
renderer call sites need no shim and no change; each has a unit test,
and extending one means adding cases there rather than trusting a
package. Anything that needs the *real* Node module belongs behind the
platform shim or in the sidecar, not in the bundle.

The trap: Vite rewrites an un-aliased builtin to an **empty object**,
not to an error, so a green `vite build` proves nothing. The failure is
`undefined()` inside some module body at load, one frame further in
with each fix. `test/unit/renderer-boots.js` runs the emitted bundle in
a webview-shaped sandbox with no `require` and no `process` and is what
catches it -- run that, read the stack, and do not try to reason the
list out in advance. The comment block above `PROCESS_SHIM` in
`vite.config.js` is the current inventory of what is aliased, what is
left as the empty object, and why each one is safe there.

A bundler resolves `require('electron')` to
`node_modules/electron/index.js` -- the npm CLI helper, which exports a
path string, not the runtime API -- and emits no warning at all. That
is why `test/unit/electron-removed.js` scans the AST of every source
for the import rather than trusting the build to complain.
