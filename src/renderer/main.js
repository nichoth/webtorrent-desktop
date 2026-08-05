// First, and deliberately: it installs the `Buffer` global that the
// torrent stack below assumes. ES modules initialize in import order,
// so anything above this line would run without one. See
// `lib/buffer-global.js`.
import './lib/buffer-global'

import createGetter from 'fn-getter'
import debounce from 'debounce'
import dragDrop from 'drag-drop'
import React from 'react'
import ReactDOM from 'react-dom'

// `useHostPaths` by name: the default export is the values, and it is
// one of the two surfaces this call writes to, so it cannot be reached
// through it. See the "Keep in sync" comment in `src/config.js`.
import config, { useHostPaths } from '../config'
import State from './lib/state'
import * as sound from './lib/sound'
import * as TorrentPlayer from './lib/torrent-player'
import { setDispatch, reportErrors } from './lib/dispatcher'
import * as clipboard from './lib/platform/clipboard'
import * as platformFs from './lib/platform/fs'
import * as ipcEngine from './lib/platform/ipc-engine'
import * as ipcOs from './lib/platform/ipc-os'
import * as paths from './lib/platform/paths'
import * as platformWindow from './lib/platform/window'

// Perf optimization: Needed immediately, so do not lazy load it below
import TorrentListController from './controllers/torrent-list-controller'

// These used to be lazy require() calls inside the createGetter thunks below.
// ESM has no synchronous equivalent -- import() is async and does not fit the
// synchronous controllers map -- so they are static imports now. The thunks
// still defer *construction*; only module loading moved to startup.
import AudioTracksController from './controllers/audio-tracks-controller'
import CastController from './controllers/cast-controller'
import FolderWatcherController from './controllers/folder-watcher-controller'
import MediaController from './controllers/media-controller'
import PlaybackController from './controllers/playback-controller'
import PrefsController from './controllers/prefs-controller'
import SubtitlesController from './controllers/subtitles-controller'
import TorrentController from './controllers/torrent-controller'
import UpdateController from './controllers/update-controller'

import App from './pages/app'

console.time('init')

// This used to sit above the module's other require() calls, so that the
// asynchronous config file read overlapped with them. ESM hoists every import
// to the top of the module, so that overlap is no longer expressible here.
bootstrap()

// The host answers first, and that ordering is load-bearing. In a
// webview `src/config.js` cannot resolve where the user's data lives
// -- it has no `$HOME` and no platform convention -- so `CONFIG_PATH`
// and its siblings are empty strings until `app_paths` lands in
// `config.useHostPaths` (US-054, US-072). A `State.load()` that ran
// first would read and write `./config.json`, relative to whatever the
// webview considers its working directory: not an error, just the
// wrong profile, invisibly.
//
// No `catch`. There is no UI to report into at this point -- `onError`
// writes into `state`, which `onState` below is what creates -- and a
// failure here leaves nothing to continue with, since every path the
// app would touch is still the empty string. The rejection surfaces in
// the webview console carrying the host's own message.
async function bootstrap () {
  useHostPaths(await paths.appPaths())
  State.load(onState)
}

// Yo-yo pattern: state object lives here and percolates down thru all the views.
// Events come back up from the views via dispatch(...)
setDispatch(dispatch)

// From dispatch(...), events are sent to one of the controllers
let controllers = null

// All state lives in state.js. `state.saved` is read from and written to a file.
// All other state is ephemeral. First we load state.saved then initialize the app.
let state

// Root React component
let app

// Called once when the application loads. (Not once per window.)
// Connects to the torrent networks, sets up the UI and OS integrations like
// the dock icon and drag+drop.
function onState (err, _state) {
  if (err) return onError(err)

  // Make available for easier debugging
  state = window.state = _state
  window.dispatch = dispatch

  sound.init(state)

  // Create controllers. createGetter still defers construction until the first
  // dispatch that needs the controller.
  controllers = {
    media: createGetter(() => new MediaController(state)),
    playback: createGetter(() => new PlaybackController(state, config, update)),
    prefs: createGetter(() => new PrefsController(state, config)),
    subtitles: createGetter(() => new SubtitlesController(state)),
    audioTracks: createGetter(() => new AudioTracksController(state)),
    cast: createGetter(() => new CastController(state, update)),
    torrent: createGetter(() => new TorrentController(state)),
    torrentList: createGetter(() => new TorrentListController(state)),
    update: createGetter(() => new UpdateController(state)),
    folderWatcher: createGetter(() => new FolderWatcherController())
  }

  // Add first page to location history
  state.location.go({
    url: 'home',
    setup: (cb) => {
      state.window.title = config.APP_WINDOW_TITLE
      cb(null)
    }
  })

  // Give global trackers
  setGlobalTrackers()

  // Restart everything we were torrenting last time the app ran
  resumeTorrents()

  // Initialize ReactDOM
  ReactDOM.render(
    <App state={state} ref={elem => { app = elem }} />,
    document.querySelector('#body')
  )

  // Calling update() updates the UI given the current state
  // Do this at least once a second to give every file in every torrentSummary
  // a progress bar and to keep the cursor in sync when playing a video
  setInterval(update, 1000)

  // Listen for messages from the main process
  reportErrors(setupIpc())

  // Drag and drop files/text to start torrenting or seeding
  dragDrop('body', {
    onDrop: onOpen,
    onDropText: onOpen
  })

  // ...same thing if you paste a torrent
  document.addEventListener('paste', onPaste)

  // Add YouTube style hotkey shortcuts
  window.addEventListener('keydown', onKeydown)

  const debouncedFullscreenToggle = debounce(() => {
    dispatch('toggleFullScreen')
  }, 1000, true)

  document.addEventListener('wheel', event => {
    // ctrlKey detects pinch to zoom, http://crbug.com/289887
    if (event.ctrlKey) {
      event.preventDefault()
      debouncedFullscreenToggle()
    }
  })

  // ...focus and blur. Needed to show correct dock icon text ('badge') in OSX
  window.addEventListener('focus', onFocus)
  window.addEventListener('blur', onBlur)

  // Async now, so the startup sound trails the rest of onState by a
  // tick. Nothing below depends on it. (This line used to throw --
  // `electron.remote` was removed in Electron 14 -- which silently
  // aborted the rest of onState, including delayedInit.)
  platformWindow.isVisible()
    .then(visible => { if (visible) sound.play('STARTUP') })
    .catch(err => dispatch('error', err))

  // To keep app startup fast, some code is delayed.
  window.setTimeout(delayedInit, config.DELAYED_INIT)

  // Done! Ideally we want to get here < 500ms after the user clicks the app
  console.timeEnd('init')
}

// Runs a few seconds after the app loads, to avoid slowing down startup time
function delayedInit () {
  // Warn if the download dir is gone, eg b/c an external drive is unplugged
  checkDownloadPath()

  // ...window visibility state.
  document.addEventListener('webkitvisibilitychange', onVisibilityChange)
  onVisibilityChange()

  // Search the local network for Chromecast, DLNA and AirPlay receivers.
  // The scan runs on the host since US-079, so this costs the renderer
  // nothing -- but it is still traffic that can wait for startup.
  controllers.cast().start()
}

// React loop:
// 1. update() - recompute the virtual DOM, diff, apply to the real DOM
// 2. event - might be a click or other DOM event, or something external
// 3. dispatch - the event handler calls dispatch(), main.js sends it to a controller
// 4. controller - the controller handles the event, changing the state object
function update () {
  controllers.playback().showOrHidePlayerControls()
  app.setState(state)
  updateElectron()
}

// Some state changes can't be reflected in the DOM, instead we have to
// tell the platform to update the window or OS integrations. This runs
// on a 1s timer as well as after every dispatch, so the `state.prev`
// guards matter: they are what keeps it from re-sending unchanged
// values, and they are set before the (async) shim call, not after it.
function updateElectron () {
  if (state.window.title !== state.prev.title) {
    state.prev.title = state.window.title
    reportErrors(ipcOs.setTitle(state.window.title))
  }
  if (state.dock.progress.toFixed(2) !== state.prev.progress.toFixed(2)) {
    state.prev.progress = state.dock.progress
    reportErrors(ipcOs.setProgress(state.dock.progress))
  }
  if (state.dock.badge !== state.prev.badge) {
    state.prev.badge = state.dock.badge
    reportErrors(ipcOs.setBadge(state.dock.badge || 0))
  }
}

const dispatchHandlers = {
  // Torrent list: creating, deleting, selecting torrents
  openTorrentFile: () => reportErrors(ipcOs.openTorrentFileDialog()),
  /* shows the open file dialog */
  openFiles: () => reportErrors(ipcOs.openFilesDialog()),
  openTorrentAddress: () => { state.modal = { id: 'open-torrent-address-modal' } },

  addTorrent: (torrentId) => controllers.torrentList().addTorrent(torrentId),
  showCreateTorrent: (paths) => controllers.torrentList().showCreateTorrent(paths),
  createTorrent: (options) => controllers.torrentList().createTorrent(options),
  toggleTorrent: (infoHash) => controllers.torrentList().toggleTorrent(infoHash),
  pauseAllTorrents: () => controllers.torrentList().pauseAllTorrents(),
  resumeAllTorrents: () => controllers.torrentList().resumeAllTorrents(),
  toggleTorrentFile: (infoHash, index) =>
    controllers.torrentList().toggleTorrentFile(infoHash, index),
  confirmDeleteTorrent: (infoHash, deleteData) =>
    controllers.torrentList().confirmDeleteTorrent(infoHash, deleteData),
  deleteTorrent: (infoHash, deleteData) =>
    controllers.torrentList().deleteTorrent(infoHash, deleteData),
  openTorrentListContextMenu: () => onPaste(),
  confirmDeleteAllTorrents: (deleteData) =>
    controllers.torrentList().confirmDeleteAllTorrents(deleteData),
  deleteAllTorrents: (deleteData) =>
    controllers.torrentList().deleteAllTorrents(deleteData),
  toggleSelectTorrent: (infoHash) =>
    controllers.torrentList().toggleSelectTorrent(infoHash),
  openTorrentContextMenu: (infoHash) =>
    controllers.torrentList().openTorrentContextMenu(infoHash),
  startTorrentingSummary: (torrentKey) =>
    controllers.torrentList().startTorrentingSummary(torrentKey),
  saveTorrentFileAs: (torrentKey) =>
    controllers.torrentList().saveTorrentFileAs(torrentKey),
  prioritizeTorrent: (infoHash) => controllers.torrentList().prioritizeTorrent(infoHash),
  resumePausedTorrents: () => controllers.torrentList().resumePausedTorrents(),

  // Playback
  playFile: (infoHash, index) => controllers.playback().playFile(infoHash, index),
  playPause: () => controllers.playback().playPause(),
  nextTrack: () => controllers.playback().nextTrack(),
  previousTrack: () => controllers.playback().previousTrack(),
  skip: (time) => controllers.playback().skip(time),
  skipTo: (time) => controllers.playback().skipTo(time),
  preview: (x) => controllers.playback().preview(x),
  clearPreview: () => controllers.playback().clearPreview(),
  changePlaybackRate: (dir) => controllers.playback().changePlaybackRate(dir),
  changeVolume: (delta) => controllers.playback().changeVolume(delta),
  setVolume: (vol) => controllers.playback().setVolume(vol),
  openPath: (infoHash, index) => controllers.playback().openPath(infoHash, index),

  // Subtitles
  openSubtitles: () => controllers.subtitles().openSubtitles(),
  selectSubtitle: (index) => controllers.subtitles().selectSubtitle(index),
  toggleSubtitlesMenu: () => controllers.subtitles().toggleSubtitlesMenu(),
  checkForSubtitles: () => controllers.subtitles().checkForSubtitles(),
  addSubtitles: (files, autoSelect) => controllers.subtitles().addSubtitles(files, autoSelect),

  // Audio Tracks
  selectAudioTrack: (index) => controllers.audioTracks().selectAudioTrack(index),
  toggleAudioTracksMenu: () => controllers.audioTracks().toggleAudioTracksMenu(),

  // Local media: <video>, <audio>, external players
  checkMediaPlayability: () => controllers.media().checkMediaPlayability(),
  mediaStalled: () => controllers.media().mediaStalled(),
  mediaError: (err) => controllers.media().mediaError(err),
  mediaSuccess: () => controllers.media().mediaSuccess(),
  mediaTimeUpdate: () => controllers.media().mediaTimeUpdate(),
  mediaMouseMoved: () => controllers.media().mediaMouseMoved(),
  mediaControlsMouseEnter: () => controllers.media().controlsMouseEnter(),
  mediaControlsMouseLeave: () => controllers.media().controlsMouseLeave(),
  openExternalPlayer: () => controllers.media().openExternalPlayer(),
  externalPlayerNotFound: () => controllers.media().externalPlayerNotFound(),

  // Remote casting: Chromecast, Airplay, etc
  toggleCastMenu: (deviceType) => controllers.cast().toggleMenu(deviceType),
  selectCastDevice: (index) => controllers.cast().selectDevice(index),
  stopCasting: () => controllers.cast().stop(),

  // Preferences screen
  preferences: () => controllers.prefs().show(),
  updatePreferences: (key, value) => controllers.prefs().update(key, value),
  checkDownloadPath,
  updateGlobalTrackers: (trackers) => setGlobalTrackers(trackers),
  startFolderWatcher: () => controllers.folderWatcher().start(),
  stopFolderWatcher: () => controllers.folderWatcher().stop(),

  // Update (check for new versions on Linux, where there's no auto updater)
  updateAvailable: (version) => controllers.update().updateAvailable(version),
  skipVersion: (version) => controllers.update().skipVersion(version),

  // Navigation between screens (back, forward, ESC, etc)
  exitModal: () => { state.modal = null },
  backToList,
  escapeBack,
  back: () => state.location.back(),
  forward: () => state.location.forward(),
  cancel: () => state.location.cancel(),

  // Controlling the window
  setDimensions,
  toggleFullScreen: (setTo) => reportErrors(ipcOs.toggleFullScreen(setTo)),
  setTitle: (title) => { state.window.title = title },
  resetTitle: () => { state.window.title = config.APP_WINDOW_TITLE },

  // Everything else
  onOpen,
  error: onError,
  // The main process dispatches this; surface it in the devtools console
  uncaughtError: (proc, err) => console.error(`Uncaught error in ${proc}`, err),
  stateSave: () => State.save(state),
  stateSaveImmediate: () => State.saveImmediate(state),
  update: () => {} // No-op, just trigger an update
}

// Events from the UI never modify state directly. Instead they call dispatch()
function dispatch (action, ...args) {
  // Log dispatch calls, for debugging, but don't spam
  if (!['mediaMouseMoved', 'mediaTimeUpdate', 'update'].includes(action)) {
    console.log('dispatch: %s %o', action, args)
  }

  const handler = dispatchHandlers[action]
  if (handler) handler(...args)
  else console.error('Missing dispatch handler: ' + action)

  // Update the virtual DOM, unless it's just a mouse move event
  if (action !== 'mediaMouseMoved' ||
      controllers.playback().showOrHidePlayerControls()) {
    update()
  }
}

// Listen to events from the main and webtorrent processes.
//
// Async, because every shim registration resolves to an unsubscribe
// function (FR-10). The Electron implementation registers
// synchronously before it resolves, but a non-Electron host is free
// not to, so `ipcReady` -- which is what tells the main process the
// renderer is listening -- waits for all of them. Nothing here is ever
// unsubscribed: these listeners live as long as the window does, so
// the returned unsubscribes are deliberately dropped.
async function setupIpc () {
  const tc = controllers.torrent()

  await Promise.all([
    ipcOs.onLog((...args) => console.log(...args)),
    ipcOs.onError((...args) => console.error(...args)),

    ipcOs.onDispatch((...args) => dispatch(...args)),

    ipcOs.onFullscreenChanged(onFullscreenChanged),
    ipcOs.onWindowBoundsChanged(onWindowBoundsChanged),

    ipcEngine.onTorrentParsed((...args) => tc.torrentParsed(...args)),
    ipcEngine.onTorrentMetadata((...args) => tc.torrentMetadata(...args)),
    ipcEngine.onTorrentDone((...args) => tc.torrentDone(...args)),
    ipcEngine.onTorrentDone(() =>
      controllers.torrentList().resumePausedTorrents()),
    ipcEngine.onTorrentWarning((...args) => tc.torrentWarning(...args)),
    ipcEngine.onTorrentError((...args) => tc.torrentError(...args)),

    ipcEngine.onProgress((...args) => tc.torrentProgress(...args)),
    ipcEngine.onFileModtimes((...args) => tc.torrentFileModtimes(...args)),
    ipcEngine.onTorrentFileSaved((...args) => tc.torrentFileSaved(...args)),
    ipcEngine.onAudioMetadata((...args) => tc.torrentAudioMetadata(...args)),
    ipcEngine.onServerRunning((...args) => tc.torrentServerRunning(...args))
  ])

  await ipcOs.signalReady()

  State.on('stateSaved', () => reportErrors(ipcOs.signalStateSaved()))
}

// Quits any modal popovers and returns to the torrent list screen
function backToList () {
  // Exit any modals and screens with a back button
  state.modal = null
  state.location.backToFirst(() => {
    // If we were already on the torrent list, scroll to the top
    const contentTag = document.querySelector('.content')
    if (contentTag) contentTag.scrollTop = 0
  })
}

// Quits modals, full screen, or goes back. Happens when the user hits ESC
function escapeBack () {
  if (state.modal) {
    dispatch('exitModal')
  } else if (state.window.isFullScreen) {
    dispatch('toggleFullScreen')
  } else {
    dispatch('back')
  }
}

function setGlobalTrackers () {
  controllers.torrentList().setGlobalTrackers(state.getGlobalTrackers())
}

// Starts all torrents that aren't paused on program startup
function resumeTorrents () {
  state.saved.torrents
    .map((torrentSummary) => {
      // Torrent keys are ephemeral, reassigned each time the app runs.
      // On startup, give all torrents a key, even the ones that are paused.
      torrentSummary.torrentKey = state.nextTorrentKey++
      return torrentSummary
    })
    .filter((s) => s.status !== 'paused')
    .forEach((s) => controllers.torrentList().startTorrentingSummary(s.torrentKey))
}

// Set window dimensions to match video dimensions or fill the screen.
//
// The rectangle and the maximize check are one host read, so they
// describe one instant even though the save lands a tick later (see
// docs/platform-shim.md). The rectangle used to be four DOM reads of
// the page's screen position and outer size, taken synchronously ahead
// of an async maximize check, which is what kept the two together
// under Electron -- but a webview's DOM does not know the OS window's
// rectangle at all, so the reads moved to the host rather than moving
// earlier. Nothing reads
// state.window.bounds synchronously after a dispatch('setDimensions')
// -- restoreBounds() runs when the player is closed.
function setDimensions (dimensions) {
  platformWindow.getBounds()
    .then(({ maximized, ...bounds }) =>
      applyDimensions(dimensions, bounds, maximized))
    .catch(err => dispatch('error', err))
}

function applyDimensions (dimensions, bounds, maximized) {
  // Don't modify the window size if it's already maximized
  if (maximized) {
    state.window.bounds = null
    return
  }

  // Save the bounds of the window for later. See restoreBounds()
  state.window.bounds = bounds
  // Reached only when the window is not maximized, so this is always
  // false now. It used to be assigned `.isMaximized` (the function
  // itself, uncalled) and so was always truthy. Nothing reads it.
  state.window.wasMaximized = maximized

  // Limit window size to screen size
  const screenWidth = window.screen.width
  const screenHeight = window.screen.height
  const aspectRatio = dimensions.width / dimensions.height
  const scaleFactor = Math.min(
    Math.min(screenWidth / dimensions.width, 1),
    Math.min(screenHeight / dimensions.height, 1)
  )
  const width = Math.max(
    Math.floor(dimensions.width * scaleFactor),
    config.WINDOW_MIN_WIDTH
  )
  const height = Math.max(
    Math.floor(dimensions.height * scaleFactor),
    config.WINDOW_MIN_HEIGHT
  )

  reportErrors(ipcOs.setAspectRatio(aspectRatio))
  reportErrors(ipcOs.setBounds(
    { contentBounds: true, x: null, y: null, width, height }
  ))
  state.playing.aspectRatio = aspectRatio
  // dispatch()'s own update() already ran before this resolved.
  update()
}

// Called when the user adds files (.torrent, files to seed, subtitles) to the app
// via any method (drag-drop, drag to app icon, command line)
function onOpen (files) {
  if (!Array.isArray(files)) files = [files]

  // File API seems to transform "magnet:?foo" in "magnet:///?foo"
  // this is a sanitization
  files = files.map(file => {
    if (typeof file !== 'string') return file
    return file.replace(/^magnet:\/+\?/i, 'magnet:?')
  })

  const url = state.location.url()
  const allTorrents = files.every(TorrentPlayer.isTorrent)
  const allSubtitles = files.every(controllers.subtitles().isSubtitle)

  if (allTorrents) {
    // Drop torrents onto the app: go to home screen, add torrents, no matter what
    dispatch('backToList')
    // All .torrent files? Add them.
    files.forEach((file) => controllers.torrentList().addTorrent(file))
  } else if (url === 'player' && allSubtitles) {
    // Drop subtitles onto a playing video: add subtitles
    controllers.subtitles().addSubtitles(files, true)
  } else if (url === 'home') {
    // Drop files onto home screen: show Create Torrent
    state.modal = null
    controllers.torrentList().showCreateTorrent(files)
  } else {
    // Drop files onto any other screen: show error
    return onError('Please go back to the torrent list before creating a new torrent.')
  }

  update()
}

function onError (err) {
  console.error(err.stack || err)
  sound.play('ERROR')
  state.errors.push({
    time: new Date().getTime(),
    message: err.message || err
  })

  update()
}

const editableHtmlTags = new Set(['input', 'textarea'])

function onPaste (e) {
  if (e && editableHtmlTags.has(e.target.tagName.toLowerCase())) return
  clipboard.readText().then((text) => {
    controllers.torrentList().addTorrent(text)
    update()
  }).catch((err) => dispatch('error', err))
}

function onKeydown (e) {
  // prevent event fire on user input elements
  if (editableHtmlTags.has(e.target.tagName.toLowerCase())) return

  const key = e.key

  if (key === 'ArrowLeft') {
    dispatch('skip', -5)
  } else if (key === 'ArrowRight') {
    dispatch('skip', 5)
  } else if (key === 'ArrowUp') {
    dispatch('changeVolume', 0.1)
  } else if (key === 'ArrowDown') {
    dispatch('changeVolume', -0.1)
  } else if (key === 'j') {
    dispatch('skip', -10)
  } else if (key === 'l') {
    dispatch('skip', 10)
  } else if (key === 'k') {
    dispatch('playPause')
  } else if (key === '>') {
    dispatch('changePlaybackRate', 1)
  } else if (key === '<') {
    dispatch('changePlaybackRate', -1)
  } else if (key === 'f') {
    dispatch('toggleFullScreen')
  }

  update()
}

function onFocus (e) {
  state.window.isFocused = true
  state.dock.badge = 0
  update()
}

function onBlur () {
  state.window.isFocused = false
  update()
}

function onVisibilityChange () {
  state.window.isVisible = !document.hidden
}

// The shim strips the Electron event object, so these two take only
// the payload now.
function onFullscreenChanged (isFullScreen) {
  state.window.isFullScreen = isFullScreen
  if (!isFullScreen) {
    // Aspect ratio gets reset in fullscreen mode, so restore it (Mac)
    reportErrors(ipcOs.setAspectRatio(state.playing.aspectRatio))
  }

  update()
}

function onWindowBoundsChanged (newBounds) {
  if (state.location.url() !== 'player') {
    state.saved.bounds = newBounds
    dispatch('stateSave')
  }
}

function checkDownloadPath () {
  // The shim's stat resolves a plain object, so `isDirectory` is a
  // boolean rather than a method.
  platformFs.stat(state.saved.prefs.downloadPath)
    .then(stat => {
      state.downloadPathStatus = stat.isDirectory ? 'ok' : 'missing'
    })
    .catch(err => {
      state.downloadPathStatus = 'missing'
      console.error(err)
    })
}
