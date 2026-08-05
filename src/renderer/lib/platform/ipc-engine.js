/**
 * Platform shim: engine-facing IPC, i.e. the `wt-*` protocol.
 *
 * Per FR-9 this module covers the `wt-*` channels and nothing else,
 * and shares no exports with `ipc-os.js`. It is the seam the torrent
 * engine is swapped at: a librqbit implementation has to satisfy
 * exactly this surface and nothing more.
 *
 * The counterparty is the engine sidecar, `src/engine/index.js`,
 * reached over a localhost WebSocket (US-044, ADR-012). This module
 * owns that socket and is the only place in the UI that knows the
 * engine is a separate process: the endpoint comes from
 * `ipc-os.getEngineEndpoint()`, every frame is encoded by
 * `src/shared/wire.js`, and the two behaviours a socket has that
 * `ipcRenderer` did not -- a pre-connect queue and a reconnect loop --
 * live below in `send` and `retry`.
 *
 * The two dynamic channels (`wt-ready-${infoHash}` and
 * `wt-server-${infoHash}`) are addressed by passing the info hash as
 * an argument; no caller builds a channel string.
 *
 * Implemented in US-021. `main.js` moved onto it in US-031 and the
 * four engine-facing controllers in US-032, so every renderer call
 * site now goes through here. The protocol itself is documented in
 * US-033. See docs/platform-shim.md.
 *
 * US-043 deleted `generateTorrentPoster` and `onPosterSaved` from this
 * surface: poster generation runs in the UI renderer now (ADR-013), so
 * there is nothing left for `wt-generate-torrent-poster` or `wt-poster`
 * to carry. `startServer` and `stopServer` became per-torrent in the
 * same story, and `onServerRunningFor` gained its first caller --
 * poster generation and playback can each hold a server, for different
 * torrents, at the same time.
 *
 * US-044 replaced the transport. The exported surface is unchanged --
 * same names, same arguments, same return types -- so no call site in
 * `controllers/` or `main.js` moved.
 */

import { decode, encode } from '../../../shared/wire'
import { getEngineEndpoint } from './ipc-os'

/**
 * @typedef {() => void} Unsubscribe
 */

/**
 * @typedef {object} ListenOptions
 * @property {boolean} [once] Remove the listener after one event.
 */

// `WebSocket.OPEN`. Read as a literal rather than off the constructor
// so the class can be swapped wholesale in a test.
const OPEN = 1

// Reconnect backoff. The first retry is immediate because
// `getEngineEndpoint()` already waits out a sidecar restart on the host
// side; the doubling is for the cases it cannot help with (no engine at
// all, an endpoint that refuses the upgrade).
const RETRY_BASE_MS = 100
const RETRY_MAX_MS = 5000

// channel -> Set of listener. The subscriptions live here rather than
// on the socket, which is what makes a reconnect transparent: nothing
// has to be re-registered on the new socket, because nothing was ever
// registered on the old one.
const handlers = new Map()

// Frames issued before a socket was open. `main.js` sends
// `wt-set-global-trackers` and `wt-start-torrenting` during startup and
// expects delivery, not a drop (ADR-012), so this queue is protocol.
const outbox = []

let socket = null
let connecting = false
let failures = 0
let retryTimer = null

/**
 * Ensure a connection is up or on its way. Called by every send and
 * every subscription, so the socket is opened by first use and the
 * module has no init step for a caller to forget.
 */
function connect () {
  if (socket || connecting || retryTimer !== null) return
  connecting = true
  getEngineEndpoint().then(endpoint => {
    connecting = false
    // `null` means the host has no engine to offer *yet* -- it already
    // waits out a restart before answering, so this is a real absence
    // and the only thing to do is ask again later.
    if (!endpoint) return retry()
    open(endpoint)
  }, err => {
    connecting = false
    report(err)
    retry()
  })
}

function open (endpoint) {
  let next
  try {
    next = new globalThis.WebSocket(socketURL(endpoint))
  } catch (err) {
    report(err)
    return retry()
  }
  socket = next

  next.onopen = () => {
    failures = 0
    flush()
  }
  next.onmessage = event => dispatch(event.data)
  // A socket error is always followed by a close in the browser, but
  // not necessarily in every host webview, so both routes end up in
  // `lost` and `lost` is idempotent.
  next.onerror = () => lost(next)
  next.onclose = () => lost(next)
}

function lost (dead) {
  if (socket !== dead) return
  socket = null
  retry()
}

function retry () {
  if (socket || retryTimer !== null) return
  const delay = failures === 0
    ? 0
    : Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(2, failures - 1))
  failures++
  retryTimer = setTimeout(() => {
    retryTimer = null
    connect()
  }, delay)
}

/**
 * The endpoint carries a bare `ws://host:port`; the token goes on the
 * query string, which is where `src/engine/bus-websocket.js` reads it
 * in `verifyClient`.
 */
function socketURL (endpoint) {
  const url = new URL(endpoint.url)
  if (endpoint.token) url.searchParams.set('token', endpoint.token)
  return url.href
}

function dispatch (data) {
  let frame
  try {
    frame = decode(data)
  } catch (err) {
    // A frame the codec rejects is a bug on the engine side. Report it
    // and keep the connection: one bad message is not a reason to lose
    // the session, the same rule the engine's bus follows.
    return report(err)
  }
  for (const listener of [...(handlers.get(frame.channel) || [])]) {
    try {
      listener(...frame.args)
    } catch (err) {
      report(err)
    }
  }
}

function flush () {
  const live = socket
  if (live === null || live.readyState !== OPEN) return
  while (outbox.length > 0) {
    try {
      live.send(outbox[0])
    } catch (err) {
      // The socket died between the readyState read and the send. Leave
      // the frame at the head of the queue for the next open one.
      report(err)
      return
    }
    outbox.shift()
  }
}

/**
 * Queue one command and deliver it as soon as there is a socket.
 *
 * @param {string} channel
 * @param {any[]} args
 */
function send (channel, args) {
  // `encode` throws on a value the wire cannot carry, which is a caller
  // bug and belongs at the caller: every export is async, so it arrives
  // as a rejected promise on the shim's usual `dispatch('error')` path.
  outbox.push(encode(channel, args))
  connect()
  flush()
}

/**
 * Register a listener on `channel`, hiding both the transport's event
 * object and the unsubscribe bookkeeping from the caller.
 *
 * @param {string} channel
 * @param {(...args: any[]) => void} listener
 * @param {ListenOptions} [options]
 * @returns {Unsubscribe}
 */
function listen (channel, listener, options) {
  const wrapped = options && options.once
    ? (...args) => {
        remove(channel, wrapped)
        listener(...args)
      }
    : listener

  if (!handlers.has(channel)) handlers.set(channel, new Set())
  handlers.get(channel).add(wrapped)
  connect()
  return () => remove(channel, wrapped)
}

function remove (channel, listener) {
  const set = handlers.get(channel)
  if (!set) return
  set.delete(listener)
  if (set.size === 0) handlers.delete(channel)
}

// Transport faults have no caller to reject at -- a dropped socket and
// a malformed frame both happen between calls -- so they go to the
// console rather than to `dispatch('error')`.
function report (err) {
  console.error('ipc-engine: ' + (err && err.message ? err.message : err))
}

// -- Commands: UI -> engine -----------------------------------------

/**
 * Replace the tracker list applied to new and existing torrents.
 *
 * @param {string[]} trackers
 * @returns {Promise<void>}
 */
export async function setGlobalTrackers (trackers) {
  send('wt-set-global-trackers', [trackers])
}

/**
 * Start downloading or seeding a torrent.
 *
 * @param {number} torrentKey Renderer-assigned key; the engine echoes
 *   it back on every event about this torrent.
 * @param {string} torrentId Magnet URI, .torrent path, or info hash.
 * @param {string} [path] Download directory.
 * @param {object} [fileModtimes] Map of file path to mtime, used to
 *   skip re-verifying an already-complete torrent.
 * @param {boolean[]} [selections] Per-file selected flags.
 * @returns {Promise<void>}
 */
export async function startTorrenting (
  torrentKey, torrentId, path, fileModtimes, selections
) {
  send('wt-start-torrenting',
    [torrentKey, torrentId, path, fileModtimes, selections])
}

/**
 * Stop and remove a torrent from the engine.
 *
 * @param {string} infoHash
 * @returns {Promise<void>}
 */
export async function stopTorrenting (infoHash) {
  send('wt-stop-torrenting', [infoHash])
}

/**
 * Seed local files as a new torrent.
 *
 * @param {number} torrentKey
 * @param {object} options Seed options, including the file list.
 * @returns {Promise<void>}
 */
export async function createTorrent (torrentKey, options) {
  send('wt-create-torrent', [torrentKey, options])
}

/**
 * Ask the engine to write the .torrent file to disk. The reply
 * arrives on `onTorrentFileSaved`.
 *
 * @param {number} torrentKey
 * @returns {Promise<void>}
 */
export async function saveTorrentFile (torrentKey) {
  send('wt-save-torrent-file', [torrentKey])
}

/**
 * Ask the engine for a file's audio metadata. The reply arrives on
 * `onAudioMetadata`.
 *
 * @param {string} infoHash
 * @param {number} index File index within the torrent.
 * @returns {Promise<void>}
 */
export async function getAudioMetadata (infoHash, index) {
  send('wt-get-audio-metadata', [infoHash, index])
}

/**
 * Start the local streaming HTTP server for one torrent. Idempotent
 * per torrent, and it always replies -- on `onServerRunning` and on
 * `onServerRunningFor` -- whether or not a server was already up.
 * Every caller that starts a server must release it with `stopServer`.
 *
 * @param {string} infoHash
 * @returns {Promise<void>}
 */
export async function startServer (infoHash) {
  send('wt-start-server', [infoHash])
}

/**
 * Release this caller's hold on one torrent's streaming server. The
 * server is destroyed once its last holder releases it.
 *
 * @param {string} infoHash
 * @returns {Promise<void>}
 */
export async function stopServer (infoHash) {
  send('wt-stop-server', [infoHash])
}

/**
 * Ask the engine to re-announce one torrent to its trackers and the
 * DHT, without tearing the torrent down. Fire-and-forget: the engine
 * logs the result rather than replying, because the answer is a peer
 * count some seconds later.
 *
 * DIAGNOSTIC. Paired with the `DIAG announce` logging in
 * `src/engine/index.js`, and comes out with it.
 *
 * @param {string} infoHash
 * @returns {Promise<void>}
 */
export async function forceAnnounce (infoHash) {
  send('wt-force-announce', [infoHash])
}

/**
 * Change which files in a torrent are downloaded.
 *
 * @param {string} infoHash
 * @param {boolean[]} selections
 * @returns {Promise<void>}
 */
export async function selectFiles (infoHash, selections) {
  send('wt-select-files', [infoHash, selections])
}

// -- Events: engine -> UI -------------------------------------------

/**
 * A torrent ID was parsed into an info hash and magnet URI.
 *
 * @param {(torrentKey: number, infoHash: string,
 *   magnetURI: string) => void} listener
 * @param {ListenOptions} [options]
 * @returns {Promise<Unsubscribe>}
 */
export async function onTorrentParsed (listener, options) {
  return listen('wt-parsed', listener, options)
}

/**
 * Torrent metadata arrived.
 *
 * @param {(torrentKey: number, info: object) => void} listener
 * @param {ListenOptions} [options]
 * @returns {Promise<Unsubscribe>}
 */
export async function onTorrentMetadata (listener, options) {
  return listen('wt-metadata', listener, options)
}

/**
 * A torrent finished loading and is ready to stream.
 *
 * @param {(torrentKey: number, info: object) => void} listener
 * @param {ListenOptions} [options]
 * @returns {Promise<Unsubscribe>}
 */
export async function onTorrentReady (listener, options) {
  return listen('wt-ready', listener, options)
}

/**
 * One specific torrent became ready. Wraps the dynamic
 * `wt-ready-${infoHash}` channel.
 *
 * @param {string} infoHash
 * @param {(torrentKey: number, info: object) => void} listener
 * @param {ListenOptions} [options]
 * @returns {Promise<Unsubscribe>}
 */
export async function onTorrentReadyFor (infoHash, listener, options) {
  return listen('wt-ready-' + infoHash, listener, options)
}

/**
 * A torrent finished downloading.
 *
 * @param {(torrentKey: number, info: object) => void} listener
 * @param {ListenOptions} [options]
 * @returns {Promise<Unsubscribe>}
 */
export async function onTorrentDone (listener, options) {
  return listen('wt-done', listener, options)
}

/**
 * A non-fatal engine warning. `torrentKey` is `null` for
 * client-level warnings.
 *
 * @param {(torrentKey: number|null, message: string) => void} listener
 * @param {ListenOptions} [options]
 * @returns {Promise<Unsubscribe>}
 */
export async function onTorrentWarning (listener, options) {
  return listen('wt-warning', listener, options)
}

/**
 * An engine error. `torrentKey` is `null` for client-level errors.
 *
 * @param {(torrentKey: number|null, message: string) => void} listener
 * @param {ListenOptions} [options]
 * @returns {Promise<Unsubscribe>}
 */
export async function onTorrentError (listener, options) {
  return listen('wt-error', listener, options)
}

/**
 * Aggregate progress for every active torrent, sent on a timer.
 *
 * @param {(progress: object) => void} listener
 * @param {ListenOptions} [options]
 * @returns {Promise<Unsubscribe>}
 */
export async function onProgress (listener, options) {
  return listen('wt-progress', listener, options)
}

/**
 * File modification times for a completed torrent.
 *
 * @param {(torrentKey: number, fileModtimes: object) => void} listener
 * @param {ListenOptions} [options]
 * @returns {Promise<Unsubscribe>}
 */
export async function onFileModtimes (listener, options) {
  return listen('wt-file-modtimes', listener, options)
}

/**
 * The .torrent file was written to disk.
 *
 * @param {(torrentKey: number, fileName: string) => void} listener
 * @param {ListenOptions} [options]
 * @returns {Promise<Unsubscribe>}
 */
export async function onTorrentFileSaved (listener, options) {
  return listen('wt-file-saved', listener, options)
}

/**
 * Audio metadata for one file.
 *
 * @param {(infoHash: string, index: number,
 *   metadata: object) => void} listener
 * @param {ListenOptions} [options]
 * @returns {Promise<Unsubscribe>}
 */
export async function onAudioMetadata (listener, options) {
  return listen('wt-audio-metadata', listener, options)
}

/**
 * The streaming server started.
 *
 * @param {(info: object) => void} listener
 * @param {ListenOptions} [options]
 * @returns {Promise<Unsubscribe>}
 */
export async function onServerRunning (listener, options) {
  return listen('wt-server-running', listener, options)
}

/**
 * The streaming server started for one specific torrent. Wraps the
 * dynamic `wt-server-${infoHash}` channel.
 *
 * @param {string} infoHash
 * @param {(info: object) => void} listener
 * @param {ListenOptions} [options]
 * @returns {Promise<Unsubscribe>}
 */
export async function onServerRunningFor (infoHash, listener, options) {
  return listen('wt-server-' + infoHash, listener, options)
}
