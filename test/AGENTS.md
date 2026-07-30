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

### Stubbing `@tauri-apps/api` in a unit test

The same route, at `require.resolve('@tauri-apps/api/event')` and
`require.resolve('@tauri-apps/api/core')` -- the package ships a CJS
build, so an unstubbed `require()` of it succeeds and the failure of a
missed stub is a real `invoke` at call time rather than a load error.

Several files stub the same subpath (`platform-dialog.js` for
`tauri/dialog`, `platform-tauri-ipc-os.js` for `tauri/ipc-os`,
`platform-window.js` for `tauri/window`), and each overwrites the
previous one's `require.cache` entry. Each module keeps the `exports`
object that was there when *it* was first required, so the recorders do
not collide -- but a test that swaps a stub function mid-run has to
hold its own reference to that object rather than reaching through
`require.cache`, which by then holds another file's. Keeping the stub
in a local and having its `invoke` delegate to a swappable handler
sidesteps the question entirely; `platform-dialog.js` does that.

Glob order decides who is first, and it is the alphabetical order of
the filenames: `platform-dialog.js` seeds the entry, the other two
replace it, and `platform-tauri.js` requires every Tauri module inside
its test callbacks (after all files have loaded), so every stub is in
place by then.

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

### Stubbing `src/config` in a unit test

A module that reads its paths from `config` can be pointed at a temp
directory by seeding `require.cache[require.resolve('../../build/config')]`
before the first require of the module under test. The stub's exports
have to look like a Babel-compiled ES module -- `{ __esModule: true,
default: {...} }` -- because every renderer module imports config as a
default import. `test/unit/migrations.js` uses this to run the real
migrations, against the real filesystem, in a throwaway profile.

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
the shim (`shell` and `clipboard`; plus, since US-027, the
`@electron/remote` dialog API and the `getCurrentWindow().isVisible` /
`.isMaximized` reads; plus, since US-028, any import of `fs`; plus,
since US-029, `new remote.Menu` / `new remote.MenuItem`; plus, since
US-030..US-032, any use of `ipcRenderer` at all and any `wt-` channel
string; plus, since US-034, any `require()` of a banned host module).
Each of US-027..US-032 added its concern to that list as it landed.
Reading source rather than build output is the point -- do not
repoint it at `build/`.

**US-034 did not supersede this file.** The lint rule added there
(`eslint-boundary.config.js`, run by `npm run lint:boundary` and
covered by `test/unit/lint-boundary.js`) bans the import
**specifiers** -- `electron`, `@electron/remote`, `fs`, `os`,
`crypto`, `http` -- under `src/renderer/`, with
`src/renderer/lib/platform/` exempt by directory glob and one per-file
override for the deferred casualty `lib/cast.js`. (US-046 dropped the
`webtorrent.js` override with the file, and added two per-file rules
that *tighten* rather than exempt: `lib/platform/ipc-engine.js` is
banned from Electron again, and `src/engine/**` -- the sidecar -- is
banned from Electron and from every DOM global while keeping Node
builtins. `npm run lint:boundary` lints both trees; a test asserts the
script still names both.) It catches a brand new file reaching for a
host module,
which the concern-based checks here would miss. It cannot see
`ipcRenderer.` member reads, `wt-` channel strings, `new remote.Menu`,
or any `require()` call, which is what this file is for. Add a new
banned **specifier** to the lint config; add a new banned **usage** to
this file.

`lint-boundary.js` drives the config through ESLint's Node API
(`new ESLint({ useEslintrc: false, overrideConfigFile })`) rather than
shelling out, so it can `lintText()` synthetic sources at a chosen
`filePath` and prove an exemption actually exempts without creating a
throwaway file under `src/`. Do not rewrite it to write probe files:
a crashed run would leave them behind for `standard` to trip over.

The OS-IPC check walked a hand-maintained file list while the
migration was partial. Since US-031 it walks the whole renderer, and
since US-032 -- with both IPC concerns migrated -- the OS and `wt-*`
checks collapsed into one: no `ipcRenderer` and no `wt-` string
literal anywhere outside `lib/platform/`, plus an exact assertion on
which renderer files still import `electron` at all (since US-039,
none). There is no "left alone for a later story" counterpart any
more, because there is nothing left.

The `fs` check is the one exception to the rule below: `fs` is a Node
builtin with a single concern behind it, so it bans the specifier
outright, with no exemption since US-045 deleted `webtorrent.js`.

Since US-046 this file also scans `src/engine/` for the mirror-image
mistake -- an Electron import or a DOM global in the sidecar -- and
scans `lib/platform/ipc-engine.js`, which every renderer walk here
skips because it is inside the shim.

The checks name **concerns, not module specifiers**. Add a pattern for
what your story actually migrated, not for the import it happens to sit
next to. (Up to US-029 that mattered because `remote.Menu` and
`remote.dialog` lived in the same file and left in different stories.)

## Unit testing a controller

Controllers are outside `build:main`, so there is no prebuilt copy to
require. `test/unit/torrent-context-menu.js` compiles the one file
under test with `@babel/core` (`transformFileSync(src, { root, cwd })`
picks up the `babel` key in `package.json`) and writes the result into
`build/renderer/controllers/`. Emitting it *there* is what makes the
controller's own `../lib/...` imports resolve against the real built
`build/renderer/lib/**`; a temp directory would not resolve at all.
Stub the shim modules it imports by `require.cache`-seeding their
built paths, and record dispatches through the real
`lib/dispatcher`'s `setDispatch()` rather than stubbing it.

`test/unit/os-ipc-call-sites.js` follows the same recipe for the
US-030 controllers and `test/unit/engine-ipc-call-sites.js` for the
US-032 ones. Cross-file hazards these had to solve, all because
`tape test/unit/*.js` is a **single process** that requires every file
before running any test:

- **`setDispatch()` is process-wide.** Registering it once at require
  time means the last file loaded wins for the entire run. Call
  `setDispatch()` inside each file's per-test `reset()` instead.
- **A `require.cache` stub of a *built shim module* leaks into later
  files.** `platform-ipc-os.js` tests the real `ipc-os`, so a stub left
  at its path breaks it. Withdraw the stub (restore the previous cache
  entry, or `delete` it) right after requiring the module under test --
  Babel binds the imported module object at that first require, so the
  module under test keeps the stub afterwards. Stubs of `electron` and
  `@electron/remote` do not need this; every file that cares seeds its
  own.
- **Two files compiling the same controller collide.** The compiled
  copy is keyed in `require.cache` by its emitted path, so whichever
  file loads first hands its stubs to the other.
  `engine-ipc-call-sites.js` emits under a `.engine-test.js` suffix
  into the same directory (the directory is what resolves
  `../lib/...`, not the file name).
- **Two files testing `build/main/ipc` collide the same way.** It is
  cached under its own path, bound to whichever file seeded `electron`,
  `log`, `menu` and `windows` first (`hidden-window-removed.js`, by
  glob order). A second file wanting its own stubs has to
  `delete require.cache[...]` before requiring, then put the previous
  entry back -- both instances then keep the stubs they were built
  with. `unported-modules-removed.js` does this. Its handlers also
  `require()` `power-save-blocker`, `shortcuts` and `external-player`
  **lazily, when the event fires**, so those stubs must still be seeded
  at emit time and withdrawn in a trailing test.
- **Stub every built module the controller graph reaches, not just the
  one under test.** Letting a real shim module load here binds *this*
  file's `electron` stub into it for the whole run, which breaks
  `platform-clipboard.js` / `platform-ipc-engine.js` later in the
  glob. `playback-controller` reaches `lib/state` -> `lib/migrations`
  that way, which is exactly what `migrations.js` tests against.
- **`migrations.js` never withdraws its `build/config` stub.** It is
  seeded at require time and left there for the rest of the run, so a
  later file wanting its own config has to save the previous cache
  entry, seed its own, `require()` the module under test, and put the
  previous one back -- `state-file.js`'s `withConfig()` helper is the
  shape. Pointing that stub's `CONFIG_PATH`, `POSTER_PATH` and
  `TORRENT_PATH` at a `mkdtemp` directory is what makes it safe to run
  the *real* `lib/platform/fs` against a throwaway profile.
- **A recording wrapper beats a fake when the claim is "it goes
  through the shim".** Require the real built shim first, wrap each
  export in a function that pushes its arguments onto an array and
  delegates, seed *that* at the shim's path, require the module under
  test, then restore. The assertions are then about real filesystem
  behaviour and about the routing at once, and anything reaching for
  `fs` directly leaves no trace in the array.

## Testing `src/renderer/main.js`

`main.js` cannot be required in a unit test at all -- not even with
the compile-it-yourself recipe above. Its module body calls
`State.load()`, and it pulls in React, ReactDOM, every page and the
whole controller graph. `test/unit/main-ipc-call-sites.js` therefore
checks it statically, but goes one step past a channel-string ban: it
extracts every `ipcOs.x` / `ipcEngine.x` member the file reaches for
and resolves each against the `export function` names in the shim
source, so a typo'd or invented export fails there instead of
silently becoming `undefined` at runtime. It also asserts the set of
shim exports covers every channel `main.js` spoke before the
migration, which is the only automated guard against a channel being
dropped.

The behaviour of the shim functions themselves stays in
`platform-ipc-os.js` / `platform-ipc-engine.js`; do not duplicate it
here.

## Testing the engine sidecar

`test/unit/engine-entry.js` runs the real thing: it spawns
`build/engine/index.js` with `process.execPath`, waits for the
`WEBTORRENT_ENGINE_PORT=` line on stdout, connects a real `ws` client
and speaks `wt-*` through `build/shared/wire.js`. Four things keep that
honest and cheap:

- **`NODE_ENV=test` in the child's env** makes `config` portable, so the
  run cannot touch the real profile directory.
- **A `static/*.torrent` fixture with every file deselected.** Metadata,
  `wt-parsed`, `wt-ready` and `wt-progress` all arrive from the torrent
  file itself, so the assertions do not need a peer -- and nothing
  downloads.
- **Kill the child in a `finally`, then await its `exit`.** A leaked
  sidecar keeps a port and a download directory.
- **Never patch module resolution in the tape process.** All unit files
  share one process, so the "config loads with no electron module" check
  runs the patch in a `spawnSync` child instead.

`createWebSocketBus` is tested against a real server and a real client
in `engine-bus-websocket.js` rather than a fake socket: the story is
that the engine is reachable by a plain socket, so a stub would only
test the stub. Wait on a condition (`waitFor`), never on a delay.
