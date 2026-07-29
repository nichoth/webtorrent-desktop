// The WebSocket transport for the `wt-*` protocol (US-040, ADR-012).
//
// The sidecar's counterpart to `bus-electron.js`: the same two
// functions, `send(channel, ...args)` and `on(channel, handler)`, over a
// localhost WebSocket server instead of `ipcRenderer`. Engine logic
// above the seam cannot tell the two apart, which is the whole point of
// the seam.
//
// It carries no protocol -- no channel name, no payload shape, no
// direction. `docs/platform-shim.md` owns those and `src/shared/wire.js`
// owns the bytes.
//
// Access control, both halves required by ADR-012:
//
// - The server binds to `127.0.0.1`, never `0.0.0.0`, so nothing off
//   the machine can reach it and no firewall prompt appears.
// - When a token is configured, every upgrade has to present it as
//   `?token=`. The host generates one per launch, passes it to the
//   child, and hands the same value to the renderer through
//   `ipc-os.getEngineEndpoint()` (US-041, US-042). With no token
//   configured the server is open to every local process, which is
//   acceptable only for `node build/engine/index.js` by hand.

import { Server as WebSocketServer } from 'ws'
import { decode, encode } from '../shared/wire'

const LOOPBACK = '127.0.0.1'

/**
 * Create the engine side of the WebSocket bus. The server starts
 * listening immediately; `listen()` resolves once it has a port.
 *
 * @param {object} [options]
 * @param {number} [options.port] 0, the default, lets the kernel pick
 * @param {string|null} [options.token] required on every upgrade when set
 * @param {Function} [options.onError] sink for transport-level faults:
 *   a malformed frame, a throwing handler, a late server error. The bus
 *   never throws at the caller and never lets one bad frame close the
 *   connection.
 * @returns {{ send: Function, on: Function, listen: Function,
 *   close: Function, address: Function }}
 */
export function createWebSocketBus (options = {}) {
  const { port = 0, token = null, onError = null } = options

  // channel -> Set of handler. The engine subscribes once per channel
  // at startup, so this never grows after init.
  const handlers = new Map()

  const server = new WebSocketServer({
    host: LOOPBACK,
    port,
    verifyClient: ({ req }) => tokenMatches(req)
  })

  let listeningPort = null
  let resolveListening = null
  let rejectListening = null
  const listening = new Promise((resolve, reject) => {
    resolveListening = resolve
    rejectListening = reject
  })

  server.on('listening', () => {
    listeningPort = server.address().port
    resolveListening(listeningPort)
  })

  server.on('error', (err) => {
    // Before the port is bound this is fatal -- the caller cannot do
    // anything without an endpoint. Afterwards it is just a fault.
    if (listeningPort === null) rejectListening(err)
    else report(err)
  })

  server.on('connection', (socket) => {
    socket.on('message', (data) => dispatch(data))
    socket.on('error', (err) => report(err))
  })

  function tokenMatches (req) {
    if (token === null) return true
    let presented = null
    try {
      presented = new URL(req.url, 'ws://' + LOOPBACK).searchParams.get('token')
    } catch (err) {
      return false
    }
    return presented === token
  }

  function report (err) {
    if (onError) onError(err)
  }

  function dispatch (data) {
    let frame
    try {
      frame = decode(data)
    } catch (err) {
      // A frame the codec rejects is a bug on the other side. Report it
      // and keep the connection: the engine is a long-lived process and
      // one bad message is not a reason to lose the rest of the session.
      report(err)
      return
    }
    for (const handler of [...(handlers.get(frame.channel) || [])]) {
      try {
        handler(...frame.args)
      } catch (err) {
        report(err)
      }
    }
  }

  return {
    send (channel, ...args) {
      const frame = encode(channel, args)
      for (const socket of server.clients) {
        if (socket.readyState === socket.OPEN) socket.send(frame)
      }
    },

    on (channel, handler) {
      if (!handlers.has(channel)) handlers.set(channel, new Set())
      handlers.get(channel).add(handler)
      return () => handlers.get(channel).delete(handler)
    },

    /** @returns {Promise<number>} the bound port */
    listen () {
      return listening
    },

    address () {
      return server.address()
    },

    close () {
      return new Promise((resolve) => {
        for (const socket of server.clients) socket.terminate()
        server.close(() => resolve())
      })
    }
  }
}
