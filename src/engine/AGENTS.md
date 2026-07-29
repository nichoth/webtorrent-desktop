# src/engine/

The torrent engine and its transport (ADR-012). Phase 3 moves the
engine here from `src/renderer/webtorrent.js` and turns it into a Node
sidecar; US-039 landed the transport seam first and US-040 added the
sidecar entry point.

**Two engines exist until US-045.** `src/engine/index.js` is the
sidecar; `src/renderer/webtorrent.js` in the hidden window is still the
live one. US-040 copied rather than shared, so that the live engine
stayed byte-identical through the move. Until US-045 deletes the hidden
window, a change to engine behaviour has to land in both files.

`build:main` compiles the whole of `src` except the four Vite-owned
paths, so a file added here is emitted to `build/engine/` with no build
change -- that is also the path unit tests require.

## The bus contract

The engine talks to the UI through an injected bus and never names a
transport API itself. A bus is exactly two functions:

- `send(channel, ...args)` -- deliver one message to the UI.
- `on(channel, handler)` -- subscribe; resolves to an unsubscribe
  function. The handler receives the protocol's argument list only,
  never the transport's own event object. Stripping that object is the
  bus's job, not the caller's.

The bus carries no protocol. Channel names, argument lists and payload
shapes live in the command and event tables in
`docs/platform-shim.md`; the codec that turns them into bytes is
`src/shared/wire.js`. A bus implementation that knows a channel name is
a bug.

The engine constructs its bus in exactly one place and
`test/unit/engine-bus-electron.js` asserts that, by scanning the engine
source for `ipcRenderer`, for stray `.send(` calls and for
subscriptions that bypass `bus.on`. That scan is what keeps the seam
substitutable, so keep it passing rather than relaxing it.

## `bus-electron.js`

The Phase 3 transitional implementation: `ipcRenderer` in the hidden
`BrowserWindow`, relayed by the `ipcMain.emit` override in
`src/main/ipc.js`. It is the only file on the engine side that knows
the engine is currently a renderer at all. US-044 adds the WebSocket
implementation and US-045 deletes this one.

It is only reachable from `src/renderer/webtorrent.js`, so it dies with
that file.

It is outside `src/renderer/`, so it is outside both boundary
mechanisms (`eslint-boundary.config.js` and
`test/unit/platform-boundary.js`) -- which is why moving the engine's
`electron` import here let those two checks drop their last
`webtorrent.js` exemptions. US-046 extends the boundary rules to cover
this directory; until then, do not add a host import here on the
grounds that nothing stops you.

## `bus-websocket.js`

The sidecar implementation, and the one that survives Phase 4. It binds
a `ws` server to `127.0.0.1` on port 0, encodes every frame with
`src/shared/wire.js`, and exposes `send`/`on` plus three lifecycle
functions the entry point needs: `listen()` (resolves to the bound
port, idempotent), `address()` and `close()`.

Three behaviours are contract, not incidental:

- **A send with nobody connected is dropped, not queued.** Commands
  always originate from the UI, so a connected client is the normal
  case; the pre-connect queue that ADR-012 requires lives on the *UI*
  side, in `ipc-engine.js` (US-044).
- **A malformed frame and a throwing handler are both reported through
  `onError`, never rethrown and never fatal to the socket.** The engine
  is a long-lived process; one bad message from a buggy UI must not end
  the session. `index.js` wires `onError` to the same
  `wt-uncaught-error` path the process handlers use.
- **The token, when configured, is checked in `verifyClient`**, which
  answers a bad upgrade with HTTP 401 before any frame is read. It is
  read from `WEBTORRENT_ENGINE_TOKEN` by `index.js`. No token means an
  open server, which is only acceptable for running the sidecar by
  hand. The `Origin` check ADR-012 also asks for is not implemented
  yet -- it needs the real header the Electron and Tauri webviews send,
  which is US-044/US-046 territory.

## `index.js`

The sidecar entry point: `node build/engine/index.js`. It imports no
Electron module and uses no DOM.

**The stdout contract with the host.** Exactly one line matches
`WEBTORRENT_ENGINE_PORT=<port>`, printed once the server is listening.
Everything else on stdout and stderr is log output for
`src/main/log.js`. `src/main/engine-process.js` (US-041) parses that
line; keep the prefix and the `=` if you touch either side.

Differences from the hidden-window engine, all deliberate:

- No `ipcReadyWebTorrent`. Readiness is the port line plus an accepted
  socket.
- No `wt-generate-torrent-poster` and no `wt-poster`. Both need a DOM;
  ADR-013 moves poster generation into the UI renderer and deletes them
  from the wire (US-043).
- No `window.client` and no `window.testOfflineMode`.
- Uncaught errors come from `process.on('uncaughtException')` and
  `process.on('unhandledRejection')` rather than a `window` error
  listener, and still go out on `wt-uncaught-error`.
- `SIGTERM` and `SIGINT` destroy the client and close the server, so a
  quit does not leave the download directory held open.
- `getTorrent()` throws a plain `Error` with the same message
  `TorrentKeyNotFoundError` produced. The class lives in
  `src/renderer/lib/errors.js`, only its message ever crossed the wire,
  and the sidecar does not import renderer code.

`config.TORRENT_PATH` and `config.POSTER_PATH` resolve under plain
`node` because US-040 made `src/config.js` require `electron` lazily,
inside the main-process branch of `getPath()`. Do not hoist that back
to a top-level import: the packaged sidecar has no
`node_modules/electron` to resolve.
