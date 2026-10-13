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
// - `wt-generate-torrent-poster` and `wt-poster`, which needed a DOM.
//   US-043 deleted both from the wire: poster generation runs in the UI
//   renderer now (ADR-013), and the engine handles no media at all.

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import util from 'util'
import mm from 'music-metadata'
import networkAddress from 'network-address'
import WebTorrent from 'webtorrent'

import config from '../config'
import { runAnnounceSweep, SWEEP_INTERVAL_MS } from './announce'
import { createWebSocketBus } from './bus-websocket'
import { limitPendingDials } from './dials'
import {
  bannedSinceProgress, createHashFailTracker, guardIncomingPeers,
  guardPeerAdds, parseFailedPiece
} from './hashfail'
import { createStallTracker, verifiedBytes } from './stall'

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
// The WebTorrent-to-HTTP streaming servers, one per torrent, keyed by
// info hash (US-043, ADR-013). Poster generation and playback can want
// a server at the same time for different torrents, so each entry
// counts its holders and is destroyed when the last one releases it.
const servers = new Map()

// Info hash -> when the sweep last asked this torrent to announce. A
// torrent that has never been asked is eligible immediately, so a new
// torrent is seeded here when its info hash arrives: `client.add()`
// has just sent a `start` announce of its own and a second one a
// minute later would be pure waste.
const lastAnnounceAt = new Map()

// Which peers have served corrupt piece data, client-wide. A peer that
// poisons one torrent gets no second chance on another, which is also
// what `client.blocked` can express: WebTorrent consults it once per
// `addPeer`, so the ban covers reconnections without any bookkeeping
// here.
const hashFails = createHashFailTracker()

// Info hash -> what the UI is told about that torrent's corrupt peers.
// The tracker itself is client-wide and keyed by address, which cannot
// answer "is *this* torrent stuck", so the per-torrent tally lives here
// and is dropped with the torrent.
const corruptPeerStats = new Map()

// How fast each torrent is verifying data, and how long since it last
// managed to. Neither question can be answered from what WebTorrent
// reports: `downloadSpeed` counts every byte off the socket, and
// `downloaded` counts piece buffers that may still fail their hash.
const stalls = createStallTracker()

// The one hook WebTorrent 1.9.7 offers for refusing a peer. It is
// documented as a static IP blocklist loaded at construction, but
// `Torrent#addPeer` only ever asks `client.blocked.contains(host)`, so
// a live view of the ban set works and covers every path a peer can
// arrive by -- tracker, DHT, PEX, incoming. Without this a banned peer
// reconnects within seconds and the loop resumes.
client.blocked = { contains: (host) => hashFails.isBanned(host) }

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
  bus.on('wt-stop-server', (infoHash) =>
    stopServer(infoHash))
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

  // When the host spawned us with a stdin pipe it sets this, and the
  // pipe closing means the host is gone -- including the paths that
  // never reach its `before-quit`, like a force quit. Without it a
  // killed host leaves an orphan still seeding. Only honoured when the
  // flag is set: `node build/engine/index.js` by hand gets /dev/null on
  // stdin, which ends immediately.
  if (process.env.WEBTORRENT_ENGINE_PARENT_PIPE) {
    process.stdin.on('end', shutdown)
    process.stdin.on('close', shutdown)
    process.stdin.resume()
  }

  setInterval(updateTorrentProgress, 1000)
  setInterval(runSweep, SWEEP_INTERVAL_MS)

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

// Every exit path lands here, and more than one can fire: a closed
// stdin pipe emits `end` then `close`, and a signal can arrive mid-way.
// `client.destroy` throws on a second call, so only the first counts.
let shuttingDown = false
function shutdown () {
  if (shuttingDown) return
  shuttingDown = true
  stopAllServers()
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
  lastAnnounceAt.delete(infoHash)
  corruptPeerStats.delete(infoHash)
  stalls.forget(infoHash)
  const torrent = client.get(infoHash)
  if (torrent) torrent.destroy()
}

// Ask any torrent sitting at zero peers to re-announce. Without this a
// torrent whose last peer drops waits out the tracker's own interval,
// which `bittorrent-tracker` defaults to 30 minutes for HTTP and UDP,
// or the DHT's 15 minutes plus jitter. The guards -- who qualifies, a
// five minute per-torrent cooldown, a cap per sweep -- are in
// `announce.js`, along with their tests.
function runSweep () {
  runAnnounceSweep({
    torrents: client.torrents,
    dht: client.dht,
    lastAnnounceAt,
    now: Date.now(),
    log: (...args) => console.log(...args)
  })
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
  // Before any handler, because the reconnect this closes off starts
  // the moment the first wire to a banned peer is destroyed below.
  // `client.blocked` covers discovery; this covers WebTorrent's own
  // backoff, which walks past it into the private `_addPeer`. Without
  // it a banned peer reconnects once a second for the life of the
  // torrent, and the handshake traffic reads as download speed.
  guardPeerAdds(torrent, hashFails.isBanned)

  // The other half of the same job, for the direction `_addPeer` never
  // sees. A banned peer that dials us reaches `_addIncomingPeer`
  // without passing any blocklist, and is registered -- which is what
  // attaches the byte counters -- before the `wire` guard below gets a
  // say. Refusing at the accept keeps its handshake off the torrent's
  // download speed entirely.
  guardIncomingPeers(torrent, hashFails.isBanned)

  // `client.maxConns` counts connections that are up, so it never sees
  // a dial still waiting on its SYN and cannot bound them. This can.
  limitPendingDials(torrent)

  torrent.on('warning', (err) => {
    onTorrentWarning(torrent, err)
    bus.send('wt-warning', torrent.key, err.message)
  })
  torrent.on('error', (err) =>
    bus.send('wt-error', torrent.key, err.message))

  torrent.on('wire', (wire) => {
    // The choke point for the ban. `Torrent#_onWire` is the one funnel
    // every connection passes through -- outgoing, incoming, and
    // WebTorrent's own reconnect -- so a banned peer cannot get a wire
    // past this line by any route.
    //
    // `client.blocked` alone is not enough, and the gap is not
    // theoretical: it is consulted by the public `addPeer` only, while
    // the backoff reconnect in `conn.on('close')` calls the private
    // `_addPeer` and walks straight past it. So does
    // `_addIncomingPeer`. Destroying the offender's wire without this
    // guard just starts that reconnect, and the corrupt data resumes a
    // second later.
    if (hashFails.isBanned(wire.remoteAddress)) return wire.destroy()

    // Who sent which block. `wire.remoteAddress` is set by WebTorrent
    // when the connection is established, before any block can arrive.
    wire.on('piece', (index) =>
      hashFails.recordContribution(index, wire.remoteAddress))
  })
  torrent.on('infoHash', () => {
    // `client.add()` announces `started` as it goes, so the sweep's
    // clock for this torrent starts here rather than at zero.
    lastAnnounceAt.set(torrent.infoHash, Date.now())
    bus.send('wt-parsed', torrent.key, torrent.infoHash, torrent.magnetURI)
  })
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

// Charge a failed piece to whoever fed it, and cut off any peer that
// has now failed once too often.
//
// Only verification failures are acted on. Every other warning -- a
// tracker timeout, a bad peer handshake -- reaches the bus unchanged,
// which is the same passthrough the caller had before.
function onTorrentWarning (torrent, err) {
  const pieceIndex = parseFailedPiece(err && err.message)
  if (pieceIndex === null) return

  const stats = statsFor(torrent)
  stats.hashFails += 1

  const { banned } = hashFails.recordFailure(pieceIndex)
  if (banned.length === 0) return

  stats.bannedPeers += banned.length
  // The tally above never goes down, so it cannot say whether a ban has
  // anything to do with how the torrent looks right now. This can.
  stats.lastBanAt = Date.now()

  banned.forEach((address) => {
    console.log(
      'banning peer %s: %s pieces failed verification, latest %s on %s',
      address, hashFails.strikesFor(address) || 'enough', pieceIndex,
      torrent.name)
  })

  // `client.blocked` keeps a banned peer from being re-added, but says
  // nothing about the connection it is already on. Without this the
  // existing wire keeps serving the same garbage and the ban only takes
  // effect whenever that connection happens to drop.
  disconnectBanned()
}

// Drop every live wire belonging to a banned peer, across all torrents:
// the ban is client-wide, and a peer poisoning one torrent is a peer
// worth losing on the rest.
function disconnectBanned () {
  client.torrents.forEach((torrent) => {
    // `wires` is mutated as connections close, so iterate a copy.
    torrent.wires.slice().forEach((wire) => {
      if (hashFails.isBanned(wire.remoteAddress)) wire.destroy()
    })
  })
}

function statsFor (torrent) {
  let stats = corruptPeerStats.get(torrent.infoHash)
  if (!stats) {
    stats = { hashFails: 0, bannedPeers: 0, lastBanAt: 0 }
    corruptPeerStats.set(torrent.infoHash, stats)
  }
  return stats
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
  // One reading of the clock for the whole payload, so a torrent's
  // stall and the ban compared against it are measured from the same
  // instant.
  const now = Date.now()

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
    // Absent until a piece of this torrent actually fails, so the
    // common case adds two zeroes rather than a lookup miss.
    const corrupt = corruptPeerStats.get(torrent.infoHash)

    // Read once: `downloaded` is a getter that walks every piece, and
    // it is the stall signal as well as a reported field.
    const downloaded = torrent.downloaded

    // `stalledForMs` is deliberately not on the wire. It changes every
    // tick, which would defeat the diff in `updateTorrentProgress` and
    // put the whole payload on the bus once a second forever. `stalled`
    // and a rounded speed both settle, so an idle torrent goes quiet.
    //
    // Two counters, because the two questions have different answers:
    // the speed an ETA is built on may only count data that is
    // certainly kept, while "has it stopped" has to notice the 16 KB
    // block rather than wait on the megabyte piece. `stall.js` has the
    // argument.
    const motion = stalls.sample(torrent.infoHash, {
      verified: verifiedBytes(torrent),
      payload: downloaded
    }, now)

    return {
      torrentKey: torrent.key,
      ready: torrent.ready,
      progress: torrent.progress,
      hashFails: corrupt ? corrupt.hashFails : 0,
      bannedPeers: corrupt ? corrupt.bannedPeers : 0,
      // Whether a ban is why this torrent is quiet, which the running
      // tally above cannot say -- it counts every ban the torrent ever
      // made and never comes back down. Only the engine can answer it:
      // it owns the clock both times are measured against.
      bannedSinceProgress: bannedSinceProgress(
        corrupt ? corrupt.lastBanAt : 0, motion.stalledForMs, now),
      verifiedSpeed: Math.round(motion.verifiedSpeed),
      stalled: motion.stalled,
      downloaded,
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
  // DIAGNOSTIC (temporary): which caller asks for a server on a torrent
  // the engine no longer has, and what does the client still hold?
  if (!torrent) {
    console.log(
      'DIAG start-server: no torrent %s -- client holds [%s]',
      infoHash, client.torrents.map((t) => t.infoHash).join(' '))
    return
  }
  if (torrent.ready) startServerFromReadyTorrent(torrent)
  else torrent.once('ready', () => startServerFromReadyTorrent(torrent))
}

function startServerFromReadyTorrent (torrent) {
  const existing = servers.get(torrent.infoHash)
  if (existing) {
    existing.holders++
    // `wt-start-server` always replies, even for a server that is
    // already listening -- a caller that got silence would wait
    // forever. A request that arrives before the first `listen`
    // callback needs no re-send: the reply below is a broadcast and
    // every subscriber gets it.
    if (existing.info) sendServerRunning(torrent.infoHash, existing.info)
    return
  }

  // start the streaming torrent-to-http server
  const server = torrent.createServer()
  const entry = { server, info: null, holders: 1 }
  servers.set(torrent.infoHash, entry)

  server.listen(0, () => {
    const port = server.address().port
    const urlSuffix = ':' + port
    entry.info = {
      torrentKey: torrent.key,
      localURL: 'http://localhost' + urlSuffix,
      networkURL: 'http://' + networkAddress() + urlSuffix,
      networkAddress: networkAddress()
    }

    sendServerRunning(torrent.infoHash, entry.info)
  })
}

function sendServerRunning (infoHash, info) {
  bus.send('wt-server-running', info)
  bus.send('wt-server-' + infoHash, info)
}

function stopServer (infoHash) {
  const entry = servers.get(infoHash)
  if (!entry) return
  if (--entry.holders > 0) return
  servers.delete(infoHash)
  entry.server.destroy()
}

function stopAllServers () {
  for (const entry of servers.values()) entry.server.destroy()
  servers.clear()
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
