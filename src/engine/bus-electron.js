// The Electron transport for the `wt-*` protocol (US-039, ADR-012).
//
// This is the only file on the engine side of the seam that knows the
// engine currently runs inside a hidden `BrowserWindow` and reaches the
// UI through `ipcMain`. Everything above it -- `webtorrent.js`, and
// `src/engine/index.js` once US-040 moves it -- speaks `bus.send` and
// `bus.on` only, so US-044 substitutes a WebSocket bus here without
// touching engine logic.
//
// It carries no protocol: no channel name, no payload shape, no
// knowledge of which direction a channel travels. `docs/platform-shim.md`
// owns those.

import { ipcRenderer } from 'electron'

/**
 * A bus is `{ send, on }`:
 *
 * - `send(channel, ...args)` delivers one message to the UI.
 * - `on(channel, handler)` subscribes to a channel and resolves to an
 *   unsubscribe function. The handler receives the payload arguments
 *   only; the transport's own event object never reaches it.
 */
export function createElectronBus () {
  return {
    send (channel, ...args) {
      ipcRenderer.send(channel, ...args)
    },

    on (channel, handler) {
      // Electron hands every listener an `IpcRendererEvent` first.
      // Stripping it here is what makes the handler signature the
      // protocol's argument list rather than Electron's.
      const listener = (event, ...args) => handler(...args)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    }
  }
}
