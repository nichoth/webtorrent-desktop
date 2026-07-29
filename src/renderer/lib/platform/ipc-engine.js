/**
 * Platform shim: engine-facing IPC, i.e. the `wt-*` protocol.
 *
 * Per FR-9 this module covers the `wt-*` channels and nothing else,
 * and shares no exports with `ipc-os.js`. It is the seam the torrent
 * engine is swapped at: a librqbit implementation has to satisfy
 * exactly this surface and nothing more.
 *
 * The counterparty is `src/renderer/webtorrent.js`, running in the
 * hidden window. Per FR-4 it is *not* migrated to the shim and stays
 * a direct `ipcRenderer` consumer.
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
 * `onServerRunningFor` has no caller in the renderer UI: the engine
 * sends `wt-server-${infoHash}` but nothing subscribes to it. It is
 * kept because the channel is part of the protocol a librqbit
 * implementation has to satisfy.
 */

import { ipcRenderer } from 'electron'

/**
 * @typedef {() => void} Unsubscribe
 */

/**
 * @typedef {object} ListenOptions
 * @property {boolean} [once] Remove the listener after one event.
 */

/**
 * Register a listener on `channel`, hiding both the Electron event
 * object and `removeListener` from the caller.
 *
 * @param {string} channel
 * @param {(...args: any[]) => void} listener
 * @param {ListenOptions} [options]
 * @returns {Unsubscribe}
 */
function listen (channel, listener, options) {
  const wrapped = (e, ...args) => listener(...args)
  if (options && options.once) ipcRenderer.once(channel, wrapped)
  else ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

// -- Commands: UI -> engine -----------------------------------------

/**
 * Replace the tracker list applied to new and existing torrents.
 *
 * @param {string[]} trackers
 * @returns {Promise<void>}
 */
export async function setGlobalTrackers (trackers) {
  ipcRenderer.send('wt-set-global-trackers', trackers)
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
  ipcRenderer.send('wt-start-torrenting',
    torrentKey, torrentId, path, fileModtimes, selections)
}

/**
 * Stop and remove a torrent from the engine.
 *
 * @param {string} infoHash
 * @returns {Promise<void>}
 */
export async function stopTorrenting (infoHash) {
  ipcRenderer.send('wt-stop-torrenting', infoHash)
}

/**
 * Seed local files as a new torrent.
 *
 * @param {number} torrentKey
 * @param {object} options Seed options, including the file list.
 * @returns {Promise<void>}
 */
export async function createTorrent (torrentKey, options) {
  ipcRenderer.send('wt-create-torrent', torrentKey, options)
}

/**
 * Ask the engine to write the .torrent file to disk. The reply
 * arrives on `onTorrentFileSaved`.
 *
 * @param {number} torrentKey
 * @returns {Promise<void>}
 */
export async function saveTorrentFile (torrentKey) {
  ipcRenderer.send('wt-save-torrent-file', torrentKey)
}

/**
 * Ask the engine to generate a poster image. The reply arrives on
 * `onPosterSaved`.
 *
 * @param {number} torrentKey
 * @returns {Promise<void>}
 */
export async function generateTorrentPoster (torrentKey) {
  ipcRenderer.send('wt-generate-torrent-poster', torrentKey)
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
  ipcRenderer.send('wt-get-audio-metadata', infoHash, index)
}

/**
 * Start the local streaming HTTP server for a torrent. The reply
 * arrives on `onServerRunning`.
 *
 * @param {string} infoHash
 * @returns {Promise<void>}
 */
export async function startServer (infoHash) {
  ipcRenderer.send('wt-start-server', infoHash)
}

/**
 * Stop the local streaming HTTP server.
 *
 * @returns {Promise<void>}
 */
export async function stopServer () {
  ipcRenderer.send('wt-stop-server')
}

/**
 * Change which files in a torrent are downloaded.
 *
 * @param {string} infoHash
 * @param {boolean[]} selections
 * @returns {Promise<void>}
 */
export async function selectFiles (infoHash, selections) {
  ipcRenderer.send('wt-select-files', infoHash, selections)
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
 * A poster image was written to disk.
 *
 * @param {(torrentKey: number, posterFileName: string) => void}
 *   listener
 * @param {ListenOptions} [options]
 * @returns {Promise<Unsubscribe>}
 */
export async function onPosterSaved (listener, options) {
  return listen('wt-poster', listener, options)
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
