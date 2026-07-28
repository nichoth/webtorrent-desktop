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
 * Design-only stubs (US-018). Implemented in US-021, call sites
 * migrated in US-032, protocol documented in US-033. See
 * docs/platform-shim.md.
 */

const NOT_IMPLEMENTED = 'platform/ipc-engine: not implemented yet (US-021)'

/**
 * @typedef {() => void} Unsubscribe
 */

/**
 * @typedef {object} ListenOptions
 * @property {boolean} [once] Remove the listener after one event.
 */

// -- Commands: UI -> engine -----------------------------------------

/**
 * Replace the tracker list applied to new and existing torrents.
 *
 * @param {string[]} trackers
 * @returns {Promise<void>}
 */
export async function setGlobalTrackers (trackers) {
  throw new Error(NOT_IMPLEMENTED)
}

/**
 * Start downloading or seeding a torrent.
 *
 * @param {string} torrentKey Renderer-assigned key; the engine echoes
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
  throw new Error(NOT_IMPLEMENTED)
}

/**
 * Stop and remove a torrent from the engine.
 *
 * @param {string} infoHash
 * @returns {Promise<void>}
 */
export async function stopTorrenting (infoHash) {
  throw new Error(NOT_IMPLEMENTED)
}

/**
 * Seed local files as a new torrent.
 *
 * @param {string} torrentKey
 * @param {object} options Seed options, including the file list.
 * @returns {Promise<void>}
 */
export async function createTorrent (torrentKey, options) {
  throw new Error(NOT_IMPLEMENTED)
}

/**
 * Ask the engine to write the .torrent file to disk. The reply
 * arrives on `onTorrentFileSaved`.
 *
 * @param {string} torrentKey
 * @returns {Promise<void>}
 */
export async function saveTorrentFile (torrentKey) {
  throw new Error(NOT_IMPLEMENTED)
}

/**
 * Ask the engine to generate a poster image. The reply arrives on
 * `onPosterSaved`.
 *
 * @param {string} torrentKey
 * @returns {Promise<void>}
 */
export async function generateTorrentPoster (torrentKey) {
  throw new Error(NOT_IMPLEMENTED)
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
  throw new Error(NOT_IMPLEMENTED)
}

/**
 * Start the local streaming HTTP server for a torrent. The reply
 * arrives on `onServerRunning`.
 *
 * @param {string} infoHash
 * @returns {Promise<void>}
 */
export async function startServer (infoHash) {
  throw new Error(NOT_IMPLEMENTED)
}

/**
 * Stop the local streaming HTTP server.
 *
 * @returns {Promise<void>}
 */
export async function stopServer () {
  throw new Error(NOT_IMPLEMENTED)
}

/**
 * Change which files in a torrent are downloaded.
 *
 * @param {string} infoHash
 * @param {boolean[]} selections
 * @returns {Promise<void>}
 */
export async function selectFiles (infoHash, selections) {
  throw new Error(NOT_IMPLEMENTED)
}

// -- Events: engine -> UI -------------------------------------------

/**
 * A torrent ID was parsed into an info hash and magnet URI.
 *
 * @param {(torrentKey: string, infoHash: string,
 *   magnetURI: string) => void} listener
 * @param {ListenOptions} [options]
 * @returns {Promise<Unsubscribe>}
 */
export async function onTorrentParsed (listener, options) {
  throw new Error(NOT_IMPLEMENTED)
}

/**
 * Torrent metadata arrived.
 *
 * @param {(torrentKey: string, info: object) => void} listener
 * @param {ListenOptions} [options]
 * @returns {Promise<Unsubscribe>}
 */
export async function onTorrentMetadata (listener, options) {
  throw new Error(NOT_IMPLEMENTED)
}

/**
 * A torrent finished loading and is ready to stream.
 *
 * @param {(torrentKey: string, info: object) => void} listener
 * @param {ListenOptions} [options]
 * @returns {Promise<Unsubscribe>}
 */
export async function onTorrentReady (listener, options) {
  throw new Error(NOT_IMPLEMENTED)
}

/**
 * One specific torrent became ready. Wraps the dynamic
 * `wt-ready-${infoHash}` channel.
 *
 * @param {string} infoHash
 * @param {(torrentKey: string, info: object) => void} listener
 * @param {ListenOptions} [options]
 * @returns {Promise<Unsubscribe>}
 */
export async function onTorrentReadyFor (infoHash, listener, options) {
  throw new Error(NOT_IMPLEMENTED)
}

/**
 * A torrent finished downloading.
 *
 * @param {(torrentKey: string, info: object) => void} listener
 * @param {ListenOptions} [options]
 * @returns {Promise<Unsubscribe>}
 */
export async function onTorrentDone (listener, options) {
  throw new Error(NOT_IMPLEMENTED)
}

/**
 * A non-fatal engine warning. `torrentKey` is `null` for
 * client-level warnings.
 *
 * @param {(torrentKey: string|null, message: string) => void} listener
 * @param {ListenOptions} [options]
 * @returns {Promise<Unsubscribe>}
 */
export async function onTorrentWarning (listener, options) {
  throw new Error(NOT_IMPLEMENTED)
}

/**
 * An engine error. `torrentKey` is `null` for client-level errors.
 *
 * @param {(torrentKey: string|null, message: string) => void} listener
 * @param {ListenOptions} [options]
 * @returns {Promise<Unsubscribe>}
 */
export async function onTorrentError (listener, options) {
  throw new Error(NOT_IMPLEMENTED)
}

/**
 * Aggregate progress for every active torrent, sent on a timer.
 *
 * @param {(progress: object) => void} listener
 * @param {ListenOptions} [options]
 * @returns {Promise<Unsubscribe>}
 */
export async function onProgress (listener, options) {
  throw new Error(NOT_IMPLEMENTED)
}

/**
 * File modification times for a completed torrent.
 *
 * @param {(torrentKey: string, fileModtimes: object) => void} listener
 * @param {ListenOptions} [options]
 * @returns {Promise<Unsubscribe>}
 */
export async function onFileModtimes (listener, options) {
  throw new Error(NOT_IMPLEMENTED)
}

/**
 * The .torrent file was written to disk.
 *
 * @param {(torrentKey: string, fileName: string) => void} listener
 * @param {ListenOptions} [options]
 * @returns {Promise<Unsubscribe>}
 */
export async function onTorrentFileSaved (listener, options) {
  throw new Error(NOT_IMPLEMENTED)
}

/**
 * A poster image was written to disk.
 *
 * @param {(torrentKey: string, posterFileName: string) => void}
 *   listener
 * @param {ListenOptions} [options]
 * @returns {Promise<Unsubscribe>}
 */
export async function onPosterSaved (listener, options) {
  throw new Error(NOT_IMPLEMENTED)
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
  throw new Error(NOT_IMPLEMENTED)
}

/**
 * The streaming server started.
 *
 * @param {(info: object) => void} listener
 * @param {ListenOptions} [options]
 * @returns {Promise<Unsubscribe>}
 */
export async function onServerRunning (listener, options) {
  throw new Error(NOT_IMPLEMENTED)
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
  throw new Error(NOT_IMPLEMENTED)
}
