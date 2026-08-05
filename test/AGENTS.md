# test/

One suite lives here now.

## The integration suite is gone (US-072)

`npm run test-integration` ran `tape` through Spectron against the real
Electron app: `test/index.js` required each `test/test-*.js`, and
`test/setup.js`, `test/mocks.js`, `test/resources/` and
`test/screenshots/` supported it. US-072 deleted all of it with the
host it drove. **Do not restore any of it.** Spectron drives Electron
over the ChromeDriver protocol and has no Tauri counterpart, and it had
not run on this branch anyway: Spectron 19 cannot drive Electron 27
under the installed Node, so every run died with
`Error: Application not running` on the first test -- verified at HEAD
before the branch, so it was broken before the port started rather than
by it.

What replaces it, and when:

- **Now.** The unit suite below plus the host-side checks it already
  carries. `tauri-host.js` holds the launch wiring (the document root,
  the window declaration, the sidecar path, the port line),
  `electron-removed.js` holds the cutover, and `engine-entry.js` runs
  the real sidecar in a child process over a real socket. Between them
  the automated coverage of "the app can start" is higher than the
  Spectron suite's was while it was failing.
- **US-073**, the Phase 4 verification pass, is the manual smoke test
  in the meantime. It is a human at a window, and it is deliberately
  not automated: the thing being verified is a webview nothing in this
  repo can yet drive.
- **A replacement harness is not scoped to a story yet.** The candidate
  is WebDriver against `tauri-driver`, which is Tauri's own answer and
  speaks the same protocol Spectron did, so the deleted `test-*.js`
  files are readable as a specification of what to reimplement -- they
  are in the history at `70b91d0`. Whoever picks it up should know it
  needs `webkit2gtk-driver` on Linux and Edge WebDriver on Windows, and
  that **macOS is unsupported by `tauri-driver`**, which is the machine
  this port is being developed on. That is why this is a plan rather
  than a story: on this hardware it would be a harness nobody here can
  run.

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
build:node` first (it was `build:main` until US-072 renamed it, there
being no main process left to name); do not run
`npx tape test/unit/*.js` on its own unless you have just built, or you
are testing a stale copy of the source.

The stub recipes below share one trap, so it is stated once here. A
stub's `exports` **object** is bound at the first require of the module
under test -- Babel keeps the result of its single `require()` call. A
helper that rebuilds the whole stub between tests therefore leaves the
module talking to the first one, silently. Swap the recording state
behind stable stub functions, or put getters on one `exports` object
(see `test/unit/platform-menu.js`).

### Stubbing `@tauri-apps/api` in a unit test

Seed `require.cache` before the first require of the module under
test, at `require.resolve('@tauri-apps/api/event')` and
`require.resolve('@tauri-apps/api/core')`:

```js
const corePath = require.resolve('@tauri-apps/api/core')
require.cache[corePath] = {
  id: corePath,
  filename: corePath,
  loaded: true,
  exports: { __esModule: true, invoke: (...args) => handler(...args) }
}
const mod = require('../../build/renderer/lib/platform/window')
```

`__esModule: true` matters: every shim module imports the API as named
ESM imports, and without it Babel's interop wraps the stub in a
`default`. The package ships a CJS build, so an unstubbed `require()`
of it *succeeds* -- the failure of a missed stub is a real `invoke` at
call time rather than a load error, which is why the stub has to be in
place before the require rather than merely before the assertion.

Several files stub the same subpath -- `platform-clipboard.js`,
`platform-dialog.js`, `platform-shell.js`, `platform-ipc-os.js` and
`platform-window.js`, each for its own shim module -- and each
overwrites the previous one's `require.cache` entry. Each module keeps
the `exports` object that was there when *it* was first required, so
the recorders do not collide -- but a test that swaps a stub function
mid-run has to hold its own reference to that object rather than
reaching through `require.cache`, which by then holds another file's.
Keeping the stub in a local and having its `invoke` delegate to a
swappable handler sidesteps the question entirely; `platform-dialog.js`
does that.

Glob order decides who is first, and it is the alphabetical order of
the filenames: `platform-clipboard.js` seeds the entry and the rest
replace it. `platform-stubs.js` requires every shim module inside its
test callbacks (after all files have loaded), so every stub is in place
by then.

A shim that subscribes to a host event **once for the life of the
page** (`menu.js` does, and any module that keeps a standing listener
behind a `let subscription` will) needs its recorded listeners kept
across a per-test reset. Clearing them leaves every test after the
first delivering events to nobody, and the failure reads as "the
callback did not run" rather than as a broken stub. Reset the call
records and leave the listener list alone; `platform-menu.js` says so
where it does it.

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

### Running a module against a real filesystem (`test/fs-shim.js`)

Until US-072 the fs shim *was* a thin wrapper over `fs/promises`, and
that is what let `migrations.js` and `state-file.js` run the real
migration and the real save/load loop against a throwaway profile. The
cutover replaced it with nine host commands, and a host command needs a
running Tauri process.

So that implementation moved to `test/fs-shim.js`. Seed it at
`build/renderer/lib/platform/fs` and any module that reads or writes
through the shim can be exercised for real. It honours the same
contract the shim documents -- promises, a plain `Uint8Array` out of
`readFile`, a plain object out of `stat`, `exists` swallowing every
stat failure -- and `test/unit/platform-fs.js` is what holds the real
shim to that contract, so the two cannot drift silently. It lives in
`test/` rather than `test/unit/` because `test-unit` globs
`test/unit/*.js` as test files.

### Stubbing `src/config` in a unit test

A module that reads its paths from `config` can be pointed at a temp
directory by seeding `require.cache[require.resolve('../../build/config')]`
before the first require of the module under test. The stub's exports
have to look like a Babel-compiled ES module -- `{ __esModule: true,
default: {...} }` -- because every renderer module imports config as a
default import. `test/unit/migrations.js` uses this to run the real
migrations, against the real filesystem, in a throwaway profile.

Only `src/renderer/lib/**`, `src/shared/**` and `src/engine/**` are
reachable this way. `build:node` deliberately ignores
`src/renderer/main.js`, `components/`, `controllers/` and `pages/`
(Vite owns those), so those modules cannot be unit tested through
`build/`. See `src/AGENTS.md`.

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
which renderer files still import a host module at all (since US-039,
none). There is no "left alone for a later story" counterpart any
more, because there is nothing left. The Electron spellings it scans
for outlived the host: US-072 deleted every one of them, and the scan
is what keeps a reflex from bringing one back.

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

Controllers are outside `build:node`, so there is no prebuilt copy to
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
  module under test keeps the stub afterwards. Stubs of a package that
  is not itself a shim module -- `@tauri-apps/api/core`, say -- do not
  need this; every file that cares seeds its own.
- **Two files compiling the same controller collide.** The compiled
  copy is keyed in `require.cache` by its emitted path, so whichever
  file loads first hands its stubs to the other.
  `engine-ipc-call-sites.js` emits under a `.engine-test.js` suffix
  into the same directory (the directory is what resolves
  `../lib/...`, not the file name).
  The same collision used to bite two files that both required the
  main process's `ipc` module; both those files went with the host in
  US-072. The recipe they used is still the one to reach for when two
  files need different stubs of the same built module:
  `delete require.cache[...]` before requiring, then put the previous
  entry back, so both instances keep the stubs they were built with.
- **Stub every built module the controller graph reaches, not just the
  one under test.** Letting a real shim module load here binds *this*
  file's host stub into it for the whole run, which breaks
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

What *is* testable is the emitted bundle, which
`test/unit/renderer-boots.js` runs in a webview-shaped sandbox: a
`vm` context with a minimal DOM and deliberately no `require`,
`process`, `module` or `global`. Its `__TAURI_INTERNALS__.invoke`
records every command and has two modes, and the difference matters:

- **Nothing answers.** Every `invoke` returns a promise that never
  settles, so startup stops at the first host call and the recorded
  commands are exactly what the bundle asks for before it knows
  anything. This is how the load itself and the startup *ordering*
  are asserted.
- **One command answers.** Resolve `app_paths` and leave the rest
  pending, and startup advances exactly one step further -- far
  enough to assert what the bundle did with the answer. US-072 needed
  this: the bootstrap reached `useHostPaths` through the wrong export
  and threw one tick after every other test had gone green.

Anything asserted in the second mode runs on a later tick, so wrap it
in a `process.on('unhandledRejection')` capture. `main.js`'s
`bootstrap()` deliberately has no `catch` -- there is no UI to report
into that early -- and an uncaught rejection there lands outside any
`try` in the test file and takes the whole `tape` process with it.

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
