# `src/renderer/lib/platform/`

The platform shim: the sole source of Electron and Node access for
`src/renderer/` (FR-8). `docs/platform-shim.md` is the contract --
read it before changing anything here, and update it in the same
commit when the surface changes.

## There was a second tree here until US-072

**Read this section as history.** US-072 promoted `tauri/` to this
directory and deleted the Electron tree, the `WT_HOST` variable and
the resolver that chose between them, so there is one implementation
and everything below about *parity between two trees* no longer
applies. What survives is the register of unported exports, now in
`test/unit/platform-stubs.js`. The original text follows because the
reasoning about stubs and capabilities is still current.

## There were two trees here (US-052)

`*.js` is the Electron implementation and `tauri/*.js` is the Tauri
one (ADR-014). Exactly one is in a given bundle: `WT_HOST=tauri`
selects the second, and anything else -- including nothing, which is
the default -- selects the first. The rewrite is a `resolveId` plugin
in `vite.config.js` over `bin/shim-resolver.js`; it matches the
resolved *file*, so relative specifiers like the barrel's
`./clipboard` are caught, and it skips imports made from inside
`tauri/` so it cannot recurse.

Consequences for anything done in this directory:

- **Adding or renaming an export means doing it in both trees.**
  `test/unit/platform-tauri.js` fails otherwise -- it compares export
  names and arities across the two, reading the ESM sources rather
  than requiring them (half of this directory only loads inside a real
  Electron process, and the sibling test files stub `electron` in a
  `require.cache` this one would trample).
- **A new file here that is not a shim module** has to be added to
  `HELPERS` in that test, or the tree-parity check reads it as drift.
  `tauri/not-implemented.js` is the only one today.
- **Tauri stubs throw, they do not return `undefined`.** Every one
  calls `notImplemented(module, name)`, which throws a
  `NotImplementedError` with `code: 'WT_TAURI_NOT_IMPLEMENTED'`. A
  Phase 4 story replaces one module's throws with real calls and
  leaves the rest alone.
- **Porting an export means registering it.** `test/unit/platform-tauri.js`
  sweeps every Tauri export expecting a not-implemented throw, so a
  newly ported one has to go in that file's `IMPLEMENTED` map or the
  sweep fails. The map is also what keeps a ported export from
  silently regressing to a stub, and each entry is meant to have a
  test file of its own (`platform-tauri-ipc-os.js` is the first).
- **The Tauri host arrives through `@tauri-apps/api`**, and it is
  banned outside this directory exactly as `electron` is -- by
  `eslint-boundary.config.js` (as a `patterns` entry, because it is
  reached by subpath) and by the source scan in
  `test/unit/platform-boundary.js`. In a unit test it is stubbed
  through `require.cache` at `require.resolve('@tauri-apps/api/event')`,
  the same route `electron` uses.
- **A host *event* needs a Tauri capability.** Listener exports are
  `listen()`/`once()` from `@tauri-apps/api/event`, which the core
  permission set covers -- `src-tauri/capabilities/default.json`. A
  missing grant is a runtime permission error, not a build failure.
- **`tauri/ipc-engine.js` is a re-export, not a stub**, because the
  module has been host-free since US-044. Do not "finish" it.
- **Nothing outside this directory may name `platform/tauri`.** Both
  the lint config and `test/unit/platform-boundary.js` ban it.

## Rules every module follows

- **Every export is `async`** (FR-10), including wrappers around
  Electron APIs that are synchronous today. A future host has to cross
  a process boundary; callers must not need a second refactor.
- **No channel string reaches a caller.** One named function per
  channel. The dynamic engine channels take the info hash as an
  argument.
- **Listener registration resolves to an unsubscribe function** and
  takes an optional `{ once: true }`. Nothing outside this directory
  calls `removeListener`.
- **`ipc-os.js` and `ipc-engine.js` share no exports** (FR-9).
  `ipc-engine.js` is `wt-*` and only `wt-*`; `ipc-os.js` is everything
  else. Adding a `wt-` channel to `ipc-os.js` breaks the seam the
  engine is swapped at. The full `wt-*` wire contract -- direction,
  payload shape, one-shot vs subscription, and the two dynamic
  families -- is the **The `wt-*` protocol** section of
  `docs/platform-shim.md`. Changing a `wt-*` payload means changing
  that section in the same commit; it is what a librqbit
  implementation is written against.
- **`shell.js` owns `showItemInFolder`, `openPath` and
  `moveItemToTrash`**, even though they are IPC channels, because they
  are one concern. Do not move them to `ipc-os.js`. Those three stay
  on `ipcRenderer.send` rather than calling `shell` directly:
  `moveItemToTrash` is main-process-only in Electron, and the main
  handlers already exist. Only `openExternal` runs in the renderer.
  The Tauri tree makes all four host commands, which means those three
  gain a rejection they never had: an `ipcRenderer.send` cannot report
  anything, and a command answers. When porting an export whose
  Electron version is fire-and-forget, check the call sites catch and
  record the difference in `docs/platform-shim.md` -- the two trees
  must agree on names and arities, but where they cannot agree on
  behaviour the difference belongs in writing rather than in a
  swallowed error.
- **Nothing here returns a Node object.** `fs.stat` resolves to a
  plain `{ size, isDirectory, isFile }`, not a `Stats` instance; menus
  are descriptor objects, not `MenuItem` instances (FR-12). Anything
  crossing the boundary has to be serialisable. `fs.readFile` resolves
  to a plain `Uint8Array` view for the same reason -- never a `Buffer`,
  so text callers have to decode.
- **`fs.js` is backed by `fs/promises`, not `fs`.** Callback and
  `*Sync` variants stay out of this directory; every operation is
  already a promise there. `fs/promises` is externalized as a
  first-party builtin in `vite.config.js` for this module's sake.

## `cast.js` is the surface for work that has not happened (US-075)

It is the one module here that replaces nothing in `src/main/`:
casting ran in the renderer, and ADR-015 moves it to the host. The
shim is complete -- fourteen exports, eleven commands and three events
-- and the host behind it owns no protocol at all, which makes it the
pattern to copy for any other "define the seam first" story:

- **It is not in the unimplemented register**, because the *shim* is
  implemented. The not-implemented answer comes from the host
  (`src-tauri/src/cast.rs`), so it is a rejected promise carrying the
  host's message rather than a `NotImplementedError`. Use
  `notImplemented()` for an export with no host command behind it, and
  a host that refuses for an export whose command exists.
- **An empty answer can be the correct one.** Discovery reports no
  devices and raises nothing, and `player-page.js` hides a protocol
  with no devices -- so an unimplemented protocol has no control on
  screen without the UI knowing anything about it. Look for that shape
  before adding a feature flag.
- **The event names are checked against the host by `cargo test`**,
  not by this suite: the renderer's tests stub `invoke` and so cannot
  see the host at all. `cast::tests` reads this file for the three
  event names and for every `invoke('...')` string, and fails if
  `main.rs` does not define and register the matching command. Adding
  a command here means adding both, or that test says so.

## `ipc-engine.js` is not an IPC module any more (US-044)

It is a WebSocket client. The engine is a sidecar process (ADR-012), so
this module holds the socket to it: the endpoint comes from
`ipc-os.getEngineEndpoint()` on every connect (the port changes when the
sidecar restarts, so it is never cached), frames are encoded by
`src/shared/wire.js`, and the socket class is read as
`globalThis.WebSocket` at connect time so a test can swap it.

The counterparty is `src/engine/index.js` and nothing else. There is no
hidden window and no `ipcMain` relay any more -- US-045 deleted both --
so a `wt-*` message never passes through the Electron main process. The
whole topology is in the "Transport, and what the engine is today"
section of `docs/platform-shim.md`.

It is the one module here that imports another shim module. That is
deliberate: the endpoint is host knowledge and `ipc-os.js` already owns
the channel that carries it.

Three behaviours are contract, not incidental:

- **Sends are queued until a socket is open**, then flushed in order.
  `main.js` sends `wt-set-global-trackers` and `wt-start-torrenting`
  during startup, before any socket can exist, and expects delivery
  rather than a drop. Do not "simplify" that queue away: it is protocol
  a replacement engine's transport has to provide, and drop it and the
  app comes up with no trackers and nothing resumed. The engine's own
  bus does the opposite -- a send with nobody connected is dropped, not
  queued -- because commands always originate here.
- **Subscriptions live in this module's own `handlers` map, never on the
  socket.** That is what makes a reconnect transparent: there is nothing
  to re-register, and an unsubscribe function handed out before a drop
  still works after it.
- **A dropped connection retries forever, with capped backoff**, and a
  `null` endpoint is a wait rather than a failure -- the host already
  waits out a sidecar restart before answering.

Transport faults (a malformed frame, a throwing listener, a dead socket)
go to `console.error` through the private `report()`. They happen
between calls, so there is no caller to reject at; that is the one place
the shim's usual `dispatch('error')` route does not apply.

## Implementation pattern (set by `ipc-os.js`, US-020)

Every module except `ipc-engine.js` follows it exactly. Until US-044
`ipc-engine.js` did too, with a private `listen()` helper of its own --
the two IPC modules deliberately share no code, which is what let the
engine seam be reimplemented without touching `ipc-os.js`.

- Import the Electron surface at module top level with a named
  import: `import { ipcRenderer } from 'electron'`. Babel compiles
  that to a lazy `_electron.ipcRenderer` property read at each call
  site, which is what makes the module unit-testable (see
  `test/AGENTS.md`). A destructured `const { ipcRenderer } =
  require('electron')` would bind eagerly and defeat that.
- Each listener export is a one-liner over a private `listen(channel,
  listener, options)` helper that wraps the caller's function to drop
  the Electron event object, honours `{ once: true }`, and returns the
  `removeListener` closure.
- Request/response over `send` + `once` collapses into a single
  promise (`ipc-os.checkForExternalPlayer`). Register the reply
  listener *before* sending.
- `@electron/remote` is imported by name too --
  `import { dialog, getCurrentWindow } from '@electron/remote'`
  (`dialog.js`, `window.js`, US-024). Its renderer entry sets
  `__esModule` and defines every builtin (`dialog`, `clipboard`, ...)
  as a lazy getter on `exports` with **no `default`**, so named
  imports match its real shape and give the same per-call property
  read Babel needs for the unit-test stub. The `import remote from
  '@electron/remote'` form used by the not-yet-migrated call sites
  survives only because Rolldown's CJS-external interop supplies a
  default; do not copy it into this directory.

- **`menu.js` validates descriptors before it builds anything**
  (US-025). Map the whole array to options first, then construct the
  `Menu` -- a throw halfway through would leave a partly built menu
  on screen. And every caller `click` is wrapped so Electron's
  `(menuItem, browserWindow, event)` arguments stop at the shim.

## Gotchas

- `index.js` uses `import * as x` plus `export { x }`, not
  `export * as x from`. Keep it that way: three toolchains
  (`standard`, Babel, Rolldown) have to agree on the syntax.
- This directory is compiled by **both** Babel (`build/`, which is
  what `test/unit/*.js` requires) and Vite (`build-vite/`). Both must
  keep building. The main process stopped requiring
  `../renderer/lib/state` in US-055, so nothing the *app* runs loads
  the Babel copy of this tree any more -- but the unit tests do, so
  do not add it to the `build:main` ignore list.
- The lint rule from US-034 (`eslint-boundary.config.js`, run by
  `npm run lint:boundary` inside `npm run lint`) exempts this
  directory. It is the only place a direct `electron`,
  `@electron/remote`, `fs`, `os`, `crypto` or `http` import is
  allowed, alongside the one remaining deferred casualty
  `lib/cast.js`. The exemption is a directory glob, so a new module
  here needs no config change -- but adding a **new** host module to
  the shim means adding its specifier to the ban list, or the next
  file to reach for it directly will pass lint. Since US-046 that same
  config lints `src/engine/` too, for the mirror-image mistake: the
  sidecar may use Node builtins freely and may not import Electron or
  touch a DOM global.
- **`ipc-engine.js` is the exception to that glob.** Since US-046 it
  is banned from importing Electron like any non-shim file, because
  US-044 turned it into a WebSocket client of the sidecar and it needs
  no host module at all. The Node half of the ban stays off for it.
  If a shim module ever stops needing a host import, do the same
  rather than leaving it covered by the directory exemption.
- A **Tauri event carries one payload where Electron's `send` carries
  an argument list.** An inbound export whose listener takes more than
  one argument (`onDispatch`, and `onLog`/`onError` when they land)
  therefore has the host send the whole list as an array and the Tauri
  shim spread it, so both trees hand the caller the same
  `(first, ...rest)`. The parity test only checks arity, so a shim
  that forgets to spread passes it and hands the caller one array.
- A **request/response export** (`checkForExternalPlayer`,
  `getEngineEndpoint`) is a `send` plus an `ipcRenderer.once` on the
  same channel name, and it never resolves without a main-process
  answer. Two consequences: the main side must reply on that channel
  (a `windows.main.send` or `e.sender.send`, not a `return`), and the
  export has to go in the `skip` list of the "no export sends on a
  wt-* channel" test in `test/unit/platform-ipc-os.js`, which calls
  every export with no arguments and would otherwise hang.
