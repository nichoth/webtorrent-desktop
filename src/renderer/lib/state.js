import path from 'path'
import { EventEmitter } from 'events'
import debounce from 'debounce'
import LocationHistory from 'location-history'
import parseTorrent from 'parse-torrent'
import createTorrent from 'create-torrent'

import config from '../../config'
import * as fs from './platform/fs'
import * as staticAsset from './static-asset'
import * as migrations from './migrations'

const defaultAnnounceList = createTorrent.announceList.map((arr) => arr[0])

const SAVE_DEBOUNCE_INTERVAL = 1000

// The renderer owns this file. It used to be read and written through
// `application-config`, which reaches for Node's `fs` directly; since
// US-055 both halves go through the platform shim, so a host without a
// Node filesystem can back them. Since US-072 the renderer is the only
// thing that reads it at all -- the Rust host keeps its own window
// bounds in `src-tauri/src/window.rs`.
//
// A function, not a constant, and that is load-bearing. `config
// .CONFIG_PATH` is empty until the host answers `app_paths`, and
// `src/renderer/main.js` cannot call `config.useHostPaths` until after
// this module's body has run -- importing it is what runs it. A path
// joined at module load would therefore be `./config.json`, relative
// to whatever the webview considers its working directory, for the
// life of the process.
function stateFile () {
  return path.join(config.CONFIG_PATH, 'config.json')
}

const State = Object.assign(new EventEmitter(), {
  getDefaultPlayState,
  load,
  // state.save() calls are rate-limited. Use state.saveImmediate() to skip limit.
  save (...args) {
    // After first State.save() invokation, future calls go straight to the
    // debounced function
    State.save = debounce(saveImmediate, SAVE_DEBOUNCE_INTERVAL)
    State.save(...args)
  },
  saveImmediate
})

export default State

function getDefaultState () {
  return {
    /*
     * Temporary state disappears once the program exits.
     * It can contain complex objects like open connections, etc.
     */
    client: null, /* the WebTorrent client */
    server: null, /* local WebTorrent-to-HTTP server */
    prev: { /* used for state diffing in updateElectron() */
      title: null,
      progress: -1,
      badge: null
    },
    location: new LocationHistory(),
    window: {
      bounds: null, /* {x, y, width, height } */
      isFocused: true,
      isFullScreen: false,
      title: config.APP_WINDOW_TITLE
    },
    selectedInfoHash: null, /* the torrent we've selected to view details. see state.torrents */
    playing: getDefaultPlayState(), /* the media (audio or video) that we're currently playing */
    devices: {}, /* playback devices like Chromecast and AppleTV */
    dock: {
      badge: 0,
      progress: 0
    },
    modal: null, /* modal popover */
    errors: [], /* user-facing errors */
    nextTorrentKey: 1, /* identify torrents for IPC between the main and webtorrent windows */

    /*
     * Saved state is read from and written to a file every time the app runs.
     * It should be simple and minimal and must be JSON.
     * It must never contain absolute paths since we have a portable app.
     *
     * Config path:
     *
     * Mac                  ~/Library/Application Support/WebTorrent/config.json
     * Linux (XDG)          $XDG_CONFIG_HOME/WebTorrent/config.json
     * Linux (Legacy)       ~/.config/WebTorrent/config.json
     * Windows (> Vista)    %LOCALAPPDATA%/WebTorrent/config.json
     * Windows (XP, 2000)   %USERPROFILE%/Local Settings/Application Data/WebTorrent/config.json
     *
     * The directory is `config.CONFIG_PATH`; see `stateFile()` above.
     */
    saved: {},

    /*
     * Getters, for convenience
     */
    getPlayingTorrentSummary,
    getPlayingFileSummary,
    getExternalPlayerName,
    getGlobalTrackers,
    shouldHidePlayerControls
  }
}

/* Whenever we stop playing video or audio, here's what we reset state.playing to */
function getDefaultPlayState () {
  return {
    infoHash: null, /* the info hash of the torrent we're playing */
    fileIndex: null, /* the zero-based index within the torrent */
    fileName: null, /* name of the file that is playing */
    location: 'local', /* 'local', 'chromecast', 'airplay' */
    type: null, /* 'audio' or 'video', could be 'other' if ever support eg streaming to VLC */
    currentTime: 0, /* seconds */
    duration: 1, /* seconds */
    isReady: false,
    isPaused: true,
    isStalled: false,
    lastTimeUpdate: 0, /* Unix time in ms */
    mouseStationarySince: 0, /* Unix time in ms */
    playbackRate: 1,
    volume: 1,
    subtitles: {
      tracks: [], /* subtitle tracks, each {label, language, ...} */
      selectedIndex: -1, /* current subtitle track */
      showMenu: false /* popover menu, above the video */
    },
    audioTracks: {
      tracks: [],
      /* current audio track; -1 until `loadedmetadata` reads the
         file's own default track, so nothing is forced on before then
         and a webview with no track list forces nothing at all */
      selectedIndex: -1,
      showMenu: false /* popover menu, above the video */
    },
    aspectRatio: 0 /* aspect ratio of the video */
  }
}

/* If the saved state file doesn't exist yet, here's what we use instead */
async function setupStateSaved () {
  const saved = {
    prefs: {
      downloadPath: config.DEFAULT_DOWNLOAD_PATH,
      isFileHandler: false,
      openExternalPlayer: false,
      externalPlayerPath: '',
      startup: false,
      soundNotifications: true,
      autoAddTorrents: false,
      torrentsFolderPath: '',
      highestPlaybackPriority: true,
      globalTrackers: defaultAnnounceList
    },
    torrents: await Promise.all(config.DEFAULT_TORRENTS.map(createTorrentObject)),
    torrentsToResume: [],
    version: config.APP_VERSION /* make sure we can upgrade gracefully later */
  }

  await fs.mkdir(config.POSTER_PATH)
  await fs.mkdir(config.TORRENT_PATH)

  // The directories have to exist before anything is written into
  // them, so the copies start only once both mkdirs have resolved.
  //
  // A read-then-write rather than the `fs.copyFile` this used to be:
  // the source is a bundled file and the destination is in the user's
  // profile, and after US-072 those are two different worlds. The
  // profile is on the filesystem, behind the shim's allowlist; the
  // defaults are inside the document root, embedded in the binary in a
  // packaged build, where no filesystem path names them at all. Only
  // the destination half is a path, so only it goes through the shim.
  await Promise.all(config.DEFAULT_TORRENTS.map((t, i) => {
    const infoHash = saved.torrents[i].infoHash
    return Promise.all([
      copyBundled(
        t.posterFileName,
        path.join(config.POSTER_PATH, infoHash + path.extname(t.posterFileName))
      ),
      copyBundled(
        t.torrentFileName,
        path.join(config.TORRENT_PATH, infoHash + '.torrent')
      )
    ])
  }))

  return saved

  async function copyBundled (name, dest) {
    await fs.writeFile(dest, await staticAsset.read(name))
  }

  async function createTorrentObject (t) {
    const bytes = await staticAsset.read(t.torrentFileName)
    // The shim resolves a plain `Uint8Array`; parse-torrent only accepts
    // a `Buffer`. `Buffer.from(view)` copies, so wrap the same memory.
    const torrent = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const parsedTorrent = parseTorrent(torrent)

    return {
      status: 'paused',
      infoHash: parsedTorrent.infoHash,
      name: t.name,
      displayName: t.name,
      posterFileName: parsedTorrent.infoHash + path.extname(t.posterFileName),
      torrentFileName: parsedTorrent.infoHash + '.torrent',
      magnetURI: parseTorrent.toMagnetURI(parsedTorrent),
      files: parsedTorrent.files,
      selections: parsedTorrent.files.map((x) => true),
      testID: t.testID
    }
  }
}

function getPlayingTorrentSummary () {
  const infoHash = this.playing.infoHash
  return this.saved.torrents.find((x) => x.infoHash === infoHash)
}

function getPlayingFileSummary () {
  const torrentSummary = this.getPlayingTorrentSummary()
  if (!torrentSummary) return null
  return torrentSummary.files[this.playing.fileIndex]
}

function getExternalPlayerName () {
  const playerPath = this.saved.prefs.externalPlayerPath
  if (!playerPath) return 'VLC'
  return path.basename(playerPath).split('.')[0]
}

function shouldHidePlayerControls () {
  return this.location.url() === 'player' &&
    this.playing.mouseStationarySince !== 0 &&
    new Date().getTime() - this.playing.mouseStationarySince > 2000 &&
    !this.playing.mouseInControls &&
    !this.playing.isPaused &&
    this.playing.location === 'local'
}

function getGlobalTrackers () {
  const trackers = this.saved.prefs.globalTrackers
  if (!trackers) {
    return defaultAnnounceList
  }
  return trackers
}

async function load (cb) {
  let saved = await readSavedState()

  if (!saved || !saved.version) {
    console.log('Missing config file: Creating new one')
    try {
      saved = await setupStateSaved()
    } catch (err) {
      return cb(err)
    }
  }

  const state = getDefaultState()
  state.saved = saved

  // Migrations used to be guarded by a `process.type === 'renderer'`
  // test, because the main process loaded this module too and must not
  // run them. It does not load it any more (US-055), and the test would
  // be false under a host that is not Electron, so the guard is gone.
  // They are async since US-028, and `cb` must not fire until they have
  // finished writing -- the caller starts torrenting off `state.saved`.
  try {
    await migrations.run(state)
  } catch (err) {
    return cb(err)
  }

  cb(null, state)
}

/**
 * Read the saved state file. A missing or unparseable file is not an
 * error: `load()` treats `null` as "no config yet" and creates a fresh
 * profile, which is also the only sane response to a corrupt one --
 * the old reader threw a SyntaxError out of `load()` instead.
 */
async function readSavedState () {
  try {
    const bytes = await fs.readFile(stateFile())
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch (err) {
    return null
  }
}

/**
 * Write the saved state file, reproducing exactly what
 * `application-config` wrote through `write-json-file`: the directory
 * created first, tab-indented JSON, trailing newline. A config written
 * by this version and one written by the last are byte-identical.
 *
 * The one thing not reproduced is `write-file-atomic`'s
 * write-to-temp-and-rename. The shim has no atomic write and adding
 * one would put a Node-shaped guarantee into a surface the Tauri host
 * has to implement as well.
 */
async function writeSavedState (saved) {
  await fs.mkdir(config.CONFIG_PATH)
  await fs.writeFile(stateFile(), JSON.stringify(saved, null, '\t') + '\n')
}

// Write state.saved to the JSON state file
async function saveImmediate (state, cb) {
  console.log('Saving state to ' + stateFile())

  // Clean up, so that we're not saving any pending state
  const copy = Object.assign({}, state.saved)
  // Remove torrents pending addition to the list, where we haven't finished
  // reading the torrent file or file(s) to seed & don't have an infohash
  copy.torrents = copy.torrents
    .filter((x) => x.infoHash)
    .map(x => {
      const torrent = {}
      for (const key in x) {
        if (key === 'progress' || key === 'torrentKey') {
          continue // Don't save progress info or key for the webtorrent process
        }
        if (key === 'error') {
          continue // Don't save error states
        }
        torrent[key] = x[key]
      }
      return torrent
    })

  try {
    await writeSavedState(copy)
    State.emit('stateSaved')
  } catch (err) {
    console.error(err)
  }
}
