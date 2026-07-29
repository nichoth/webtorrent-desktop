# src/engine/

The torrent engine and its transport (ADR-012). Phase 3 moves the
engine here from `src/renderer/webtorrent.js` and turns it into a Node
sidecar; US-039 landed the transport seam first, so the directory
starts with the transport alone.

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

It is outside `src/renderer/`, so it is outside both boundary
mechanisms (`eslint-boundary.config.js` and
`test/unit/platform-boundary.js`) -- which is why moving the engine's
`electron` import here let those two checks drop their last
`webtorrent.js` exemptions. US-046 extends the boundary rules to cover
this directory; until then, do not add a host import here on the
grounds that nothing stops you.
