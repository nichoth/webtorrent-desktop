// The torrent engine, as a standalone Node process (US-040, ADR-012).
//
// This is the sidecar entry point: `node build/engine/index.js`. It
// imports no Electron module and touches no DOM. It binds a WebSocket
// server to 127.0.0.1 on a kernel-assigned port, prints that port on
// stdout as one line, and then speaks exactly the `wt-*` protocol in
// the command and event tables of `docs/platform-shim.md`.
//
// Until US-045 cuts the app over, the live engine is still
// `src/renderer/webtorrent.js` in the hidden window. The two are
// deliberately separate files rather than one shared core: keeping the
// live engine byte-identical is worth more during the move than
// avoiding the duplication, which US-045 deletes. Any change to engine
// behaviour before then has to land in both.
//
// Two channels of the hidden-window engine are gone here:
//
// - `ipcReadyWebTorrent`, the `ipcMain` relay's handshake. Readiness is
//   now the port line plus an accepted socket.
// - `wt-generate-torrent-poster` and `wt-poster`, which need a DOM.
//   ADR-013 moves poster generation into the UI renderer and deletes
//   both from the wire; US-043 does that work.

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import util from 'util'
import mm from 'music-metadata'
import networkAddress from 'network-address'
import WebTorrent from 'webtorrent'

import config from '../config'
import { createWebSocketBus } from './bus-websocket'

console.time('init')

// The one line US-041's supervisor parses out of the child's stdout.
// Everything else the engine prints is log output.
const PORT_LINE_PREFIX = 'WEBTORRENT_ENGINE_PORT='

/**
 * Version number in Azureus-style. Generated from major and minor semver
 * version. For example:
 *   '0.16.1' -> '0016'
 *   '1.2.5' -> '0102'
 */
const VERSION_STR = config.APP_VERSION
  .replace(/\d*./g, v => `0${v % 100}`.slice(-2))
  .slice(0, 4)

/**
 * Version prefix string (used in peer ID). WebTorrent uses the
 * Azureus-style encoding: '-', two characters for client id ('WW'), four
 * ascii digits for version number, '-', followed by random numbers.
 * For example:
 *   '-WW0102-'...
 */
const VERSION_PREFIX = '-WD' + VERSION_STR + '-'

/**
 * Generate an ephemeral peer ID each time.
 */
const PEER_ID = Buffer.from(VERSION_PREFIX + crypto.randomBytes(9).toString('base64'))

// The transport the engine speaks to the UI over. Swapping this one
// line swaps the transport; nothing below names a socket API.
const bus = createWebSocketBus({
  token: process.env.WEBTORRENT_ENGINE_TOKEN || null,
  onError: (err) => onUncaughtError(err)
})

// Connect to the WebTorrent and BitTorrent networks. WebTorrent Desktop
// is a hybrid client, as explained here: https://webtorrent.io/faq
const client = new WebTorrent({ peerId: PEER_ID })

// WebTorrent-to-HTTP streaming sever
let server = null

// Used for diffing, so we only send progress updates when necessary
let prevProgress = null

init()

function init () {
  listenToClientEvents()

  bus.on('wt-set-global-trackers', (globalTrackers) =>
    setGlobalTrackers(globalTrackers))
  bus.on('wt-start-torrenting', (torrentKey, torrentID, path, fileModtimes, selections) =>
    startTorrenting(torrentKey, torrentID, path, fileModtimes, selections))
  bus.on('wt-stop-torrenting', (infoHash) =>
    stopTorrenting(infoHash))
  bus.on('wt-create-torrent', (torrentKey, options) =>
    createTorrent(torrentKey, options))
  bus.on('wt-save-torrent-file', (torrentKey) =>
    saveTorrentFile(torrentKey))
  bus.on('wt-get-audio-metadata', (infoHash, index) =>
    getAudioMetadata(infoHash, index))
  bus.on('wt-start-server', (infoHash) =>
    startServer(infoHash))
  bus.on('wt-stop-server', () =>
    stopServer())
  bus.on('wt-select-files', (infoHash, selections) =>
    selectFiles(infoHash, selections))

  // No `window` to hang an `error` listener on, so the process reports
  // for itself. Both handlers stay installed: the sidecar's job is to
  // keep torrenting, and the UI has always been told about engine
  // errors rather than losing the engine to them.
  process.on('uncaughtException', onUncaughtError)
  process.on('unhandledRejection', onUncaughtError)

  // A quit kills the child, and a lost socket must not leave a torrent
  // client holding the download directory open.
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  setInterval(updateTorrentProgress, 1000)

  bus.listen().then((port) => {
    // The one line the host parses. Nothing may precede it on this
    // line and nothing may follow it.
    console.log(PORT_LINE_PREFIX + port)
    console.timeEnd('init')
  }, (err) => {
    console.error('engine failed to listen: %o', err)
    process.exit(1)
  })
}

function onUncaughtError (err) {
  bus.send('wt-uncaught-error', {
    message: err && err.message,
    stack: err && err.stack
  })
  console.error(err)
}

function shutdown () {
  stopServer()
  client.destroy(() => {
    bus.close().then(() => process.exit(0), () => process.exit(0))
  })
}

function listenToClientEvents () {
  client.on('warning', (err) => bus.send('wt-warning', null, err.message))
  client.on('error', (err) => bus.send('wt-error', null, err.message))
}

// Sets the default trackers
function setGlobalTrackers (globalTrackers) {
  globalThis.WEBTORRENT_ANNOUNCE = globalTrackers
}

// Starts a given TorrentID, which can be an infohash, magnet URI, etc.
// Returns a WebTorrent object. See https://git.io/vik9M
function startTorrenting (torrentKey, torrentID, path, fileModtimes, selections) {
  console.log('starting torrent %s: %s', torrentKey, torrentID)

  const torrent = client.add(torrentID, {
    path,
    fileModtimes
  })
  torrent.key = torrentKey

  // Listen for ready event, progress notifications, etc
  addTorrentEvents(torrent)

  // Only download the files the user wants, not necessarily all files
  torrent.once('ready', () => selectFiles(torrent, selections))
}

function stopTorrenting (infoHash) {
  console.log('--- STOP TORRENTING: ', infoHash)
  const torrent = client.get(infoHash)
  if (torrent) torrent.destroy()
}

// Create a new torrent, start seeding
function createTorrent (torrentKey, options) {
  console.log('creating torrent', torrentKey, options)
  const paths = options.files.map((f) => f.path)
  const torrent = client.seed(paths, options)
  torrent.key = torrentKey
  addTorrentEvents(torrent)
  bus.send('wt-new-torrent')
}

function addTorrentEvents (torrent) {
  torrent.on('warning', (err) =>
    bus.send('wt-warning', torrent.key, err.message))
  torrent.on('error', (err) =>
    bus.send('wt-error', torrent.key, err.message))
  torrent.on('infoHash', () =>
    bus.send('wt-parsed', torrent.key, torrent.infoHash, torrent.magnetURI))
  torrent.on('metadata', torrentMetadata)
  torrent.on('ready', torrentReady)
  torrent.on('done', torrentDone)

  function torrentMetadata () {
    const info = getTorrentInfo(torrent)
    bus.send('wt-metadata', torrent.key, info)

    updateTorrentProgress()
  }

  function torrentReady () {
    const info = getTorrentInfo(torrent)
    bus.send('wt-ready', torrent.key, info)
    bus.send('wt-ready-' + torrent.infoHash, torrent.key, info)

    updateTorrentProgress()
  }

  function torrentDone () {
    const info = getTorrentInfo(torrent)
    bus.send('wt-done', torrent.key, info)

    updateTorrentProgress()

    torrent.getFileModtimes((err, fileModtimes) => {
      if (err) return onError(err)
      bus.send('wt-file-modtimes', torrent.key, fileModtimes)
    })
  }
}

// Produces a JSON saveable summary of a torrent
function getTorrentInfo (torrent) {
  return {
    infoHash: torrent.infoHash,
    magnetURI: torrent.magnetURI,
    name: torrent.name,
    path: torrent.path,
    files: torrent.files.map(getTorrentFileInfo),
    bytesReceived: torrent.received
  }
}

// Produces a JSON saveable summary of a file in a torrent
function getTorrentFileInfo (file) {
  return {
    name: file.name,
    length: file.length,
    path: file.path
  }
}

// Every time we resolve a magnet URI, save the torrent file so that we
// can use it on next startup. Starting with the full torrent metadata
// will be faster than re-fetching it from peers using ut_metadata.
function saveTorrentFile (torrentKey) {
  const torrent = getTorrent(torrentKey)
  const torrentPath = path.join(config.TORRENT_PATH, torrent.infoHash + '.torrent')

  fs.access(torrentPath, fs.constants.R_OK, err => {
    const fileName = torrent.infoHash + '.torrent'
    if (!err) {
      // We've already saved the file
      return bus.send('wt-file-saved', torrentKey, fileName)
    }

    // Otherwise, save the .torrent file, under the app config folder
    fs.mkdir(config.TORRENT_PATH, { recursive: true }, _ => {
      fs.writeFile(torrentPath, torrent.torrentFile, err => {
        if (err) return console.log('error saving torrent file %s: %o', torrentPath, err)
        console.log('saved torrent file %s', torrentPath)
        return bus.send('wt-file-saved', torrentKey, fileName)
      })
    })
  })
}

function updateTorrentProgress () {
  const progress = getTorrentProgress()
  // TODO: diff torrent-by-torrent, not once for the whole update
  if (prevProgress && util.isDeepStrictEqual(progress, prevProgress)) {
    return /* don't send heavy object if it hasn't changed */
  }
  bus.send('wt-progress', progress)
  prevProgress = progress
}

function getTorrentProgress () {
  // First, track overall progress
  const progress = client.progress
  const hasActiveTorrents = client.torrents.some(torrent => torrent.progress !== 1)

  // Track progress for every file in each torrent
  // TODO: ideally this would be tracked by WebTorrent, which could do it
  // more efficiently than looping over torrent.bitfield
  const torrentProg = client.torrents.map(torrent => {
    const fileProg = torrent.files && torrent.files.map(file => {
      const numPieces = file._endPiece - file._startPiece + 1
      let numPiecesPresent = 0
      for (let piece = file._startPiece; piece <= file._endPiece; piece++) {
        if (torrent.bitfield.get(piece)) numPiecesPresent++
      }
      return {
        startPiece: file._startPiece,
        endPiece: file._endPiece,
        numPieces,
        numPiecesPresent
      }
    })
    return {
      torrentKey: torrent.key,
      ready: torrent.ready,
      progress: torrent.progress,
      downloaded: torrent.downloaded,
      downloadSpeed: torrent.downloadSpeed,
      uploadSpeed: torrent.uploadSpeed,
      numPeers: torrent.numPeers,
      length: torrent.length,
      bitfield: torrent.bitfield,
      files: fileProg
    }
  })

  return {
    torrents: torrentProg,
    progress,
    hasActiveTorrents
  }
}

function startServer (infoHash) {
  const torrent = client.get(infoHash)
  if (torrent.ready) startServerFromReadyTorrent(torrent)
  else torrent.once('ready', () => startServerFromReadyTorrent(torrent))
}

function startServerFromReadyTorrent (torrent) {
  if (server) return

  // start the streaming torrent-to-http server
  server = torrent.createServer()
  server.listen(0, () => {
    const port = server.address().port
    const urlSuffix = ':' + port
    const info = {
      torrentKey: torrent.key,
      localURL: 'http://localhost' + urlSuffix,
      networkURL: 'http://' + networkAddress() + urlSuffix,
      networkAddress: networkAddress()
    }

    bus.send('wt-server-running', info)
    bus.send('wt-server-' + torrent.infoHash, info)
  })
}

function stopServer () {
  if (!server) return
  server.destroy()
  server = null
}

console.log('Initializing...')

function getAudioMetadata (infoHash, index) {
  const torrent = client.get(infoHash)
  const file = torrent.files[index]

  // Set initial matadata to display the filename first.
  const metadata = { title: file.name }
  bus.send('wt-audio-metadata', infoHash, index, metadata)

  const options = {
    native: false,
    skipCovers: true,
    fileSize: file.length,
    observer: () => {
      bus.send('wt-audio-metadata', infoHash, index, {
        common: metadata.common,
        format: metadata.format
      })
    }
  }
  const onMetadata = file.done
    // If completed; use direct file access
    ? mm.parseFile(path.join(torrent.path, file.path), options)
    // otherwise stream
    : mm.parseStream(file.createReadStream(), file.name, options)

  onMetadata
    .then(
      metadata => {
        bus.send('wt-audio-metadata', infoHash, index, metadata)
        console.log(`metadata for file='${file.name}' completed.`)
      },
      err => {
        console.log(
          `error getting audio metadata for ${infoHash}:${index}`,
          err
        )
      }
    )
}

function selectFiles (torrentOrInfoHash, selections) {
  // Get the torrent object
  let torrent
  if (typeof torrentOrInfoHash === 'string') {
    torrent = client.get(torrentOrInfoHash)
  } else {
    torrent = torrentOrInfoHash
  }
  if (!torrent) {
    throw new Error('selectFiles: missing torrent ' + torrentOrInfoHash)
  }

  // Selections not specified?
  // Load all files. We still need to replace the default whole-torrent
  // selection with individual selections for each file, so we can
  // select/deselect files later on
  if (!selections) {
    selections = new Array(torrent.files.length).fill(true)
  }

  // Selections specified incorrectly?
  if (selections.length !== torrent.files.length) {
    throw new Error('got ' + selections.length + ' file selections, ' +
      'but the torrent contains ' + torrent.files.length + ' files')
  }

  // Remove default selection (whole torrent)
  torrent.deselect(0, torrent.pieces.length - 1, false)

  // Add selections (individual files)
  selections.forEach((selection, i) => {
    const file = torrent.files[i]
    if (selection) {
      file.select()
    } else {
      console.log('deselecting file ' + i + ' of torrent ' + torrent.name)
      file.deselect()
    }
  })
}

// Gets a WebTorrent handle by torrentKey
// Throws an Error if we're not currently torrenting anything w/ that key
//
// The hidden-window engine threw `TorrentKeyNotFoundError` from
// `src/renderer/lib/errors.js`. The class identity never crossed the
// wire -- only the message did -- and the sidecar does not import
// renderer code, so the message is what it keeps.
function getTorrent (torrentKey) {
  const ret = client.torrents.find((x) => x.key === torrentKey)
  if (!ret) throw new Error(`Can't resolve torrent key ${torrentKey}`)
  return ret
}

function onError (err) {
  console.log(err)
}
