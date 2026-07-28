/**
 * Platform shim: OS-facing IPC.
 *
 * Per FR-9 this module covers every renderer<->main channel *except*
 * the `wt-*` engine protocol, which lives in `ipc-engine.js`. The two
 * modules share no exports. It also does not export the four
 * path/URL channels owned by `shell.js`.
 *
 * Channel names never reach a caller: each one gets a named function,
 * because a non-Electron host has to implement them one by one and a
 * generic `send(channel, ...)` would just move the string literals
 * around.
 *
 * Every listener registration resolves to an unsubscribe function, so
 * no caller ever touches `removeListener`.
 *
 * Implemented in US-020; call sites are migrated in US-030 and
 * US-031. See docs/platform-shim.md.
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

// -- Window chrome and OS integration -------------------------------

/**
 * Set the window title.
 *
 * @param {string} title
 * @returns {Promise<void>}
 */
export async function setTitle (title) {
  ipcRenderer.send('setTitle', title)
}

/**
 * Set the dock/taskbar progress bar, 0..1. Negative hides it.
 *
 * @param {number} progress
 * @returns {Promise<void>}
 */
export async function setProgress (progress) {
  ipcRenderer.send('setProgress', progress)
}

/**
 * Set the dock/taskbar badge count.
 *
 * @param {number} count
 * @returns {Promise<void>}
 */
export async function setBadge (count) {
  ipcRenderer.send('setBadge', count)
}

/**
 * @typedef {object} WindowBounds
 * @property {number|null} [x]
 * @property {number|null} [y]
 * @property {number} [width]
 * @property {number} [height]
 * @property {boolean} [contentBounds] Treat the bounds as the content
 *   area rather than the whole window.
 */

/**
 * Move and resize the window.
 *
 * @param {WindowBounds} bounds
 * @param {boolean} [maximize] Whether to restore a maximised window.
 * @returns {Promise<void>}
 */
export async function setBounds (bounds, maximize) {
  ipcRenderer.send('setBounds', bounds, maximize)
}

/**
 * Lock the window to an aspect ratio. `0` unlocks it.
 *
 * @param {number} aspectRatio
 * @returns {Promise<void>}
 */
export async function setAspectRatio (aspectRatio) {
  ipcRenderer.send('setAspectRatio', aspectRatio)
}

/**
 * Enter or leave full screen.
 *
 * @param {boolean} [setTo] Toggles when omitted.
 * @returns {Promise<void>}
 */
export async function toggleFullScreen (setTo) {
  ipcRenderer.send('toggleFullScreen', setTo)
}

/**
 * Show and focus the main window.
 *
 * @returns {Promise<void>}
 */
export async function show () {
  ipcRenderer.send('show')
}

// -- Renderer lifecycle ---------------------------------------------

/**
 * Tell the main process the UI is ready to receive events
 * (the `ipcReady` channel).
 *
 * @returns {Promise<void>}
 */
export async function signalReady () {
  ipcRenderer.send('ipcReady')
}

/**
 * Tell the main process saved state has been flushed to disk
 * (the `stateSaved` channel).
 *
 * @returns {Promise<void>}
 */
export async function signalStateSaved () {
  ipcRenderer.send('stateSaved')
}

// -- Dialogs owned by the main process ------------------------------

/**
 * Ask the main process to show its "open torrent file" dialog. The
 * result comes back as a `dispatch` event, not a return value.
 *
 * @returns {Promise<void>}
 */
export async function openTorrentFileDialog () {
  ipcRenderer.send('openTorrentFile')
}

/**
 * Ask the main process to show its "open files" dialog. The result
 * comes back as a `dispatch` event, not a return value.
 *
 * @returns {Promise<void>}
 */
export async function openFilesDialog () {
  ipcRenderer.send('openFiles')
}

// -- Preferences ----------------------------------------------------

/**
 * Allow or block in-window navigation, used while a preferences
 * field is focused.
 *
 * @param {boolean} allow
 * @returns {Promise<void>}
 */
export async function setAllowNav (allow) {
  ipcRenderer.send('setAllowNav', allow)
}

/**
 * Register or deregister the app as the OS handler for torrent files
 * and magnet links.
 *
 * @param {boolean} isFileHandler
 * @returns {Promise<void>}
 */
export async function setDefaultFileHandler (isFileHandler) {
  ipcRenderer.send('setDefaultFileHandler', isFileHandler)
}

/**
 * Enable or disable launching the app at login.
 *
 * @param {boolean} startup
 * @returns {Promise<void>}
 */
export async function setStartup (startup) {
  ipcRenderer.send('setStartup', startup)
}

// -- Folder watcher -------------------------------------------------

/**
 * Start watching the configured torrents folder.
 *
 * @returns {Promise<void>}
 */
export async function startFolderWatcher () {
  ipcRenderer.send('startFolderWatcher')
}

/**
 * Stop watching the configured torrents folder.
 *
 * @returns {Promise<void>}
 */
export async function stopFolderWatcher () {
  ipcRenderer.send('stopFolderWatcher')
}

// -- External media player ------------------------------------------

/**
 * Check whether an external player is installed at `path`. Collapses
 * today's send-then-`once` pair into one round trip.
 *
 * @param {string} path Empty string means "use the OS default".
 * @returns {Promise<boolean>}
 */
export async function checkForExternalPlayer (path) {
  return await new Promise(resolve => {
    ipcRenderer.once('checkForExternalPlayer',
      (e, isInstalled) => resolve(isInstalled))
    ipcRenderer.send('checkForExternalPlayer', path)
  })
}

/**
 * Launch the external player.
 *
 * @param {string} path Empty string means "use the OS default".
 * @param {string} url  Media URL to play.
 * @param {string} title Window title to pass through.
 * @returns {Promise<void>}
 */
export async function openExternalPlayer (path, url, title) {
  ipcRenderer.send('openExternalPlayer', path, url, title)
}

/**
 * Quit the external player if it is running.
 *
 * @returns {Promise<void>}
 */
export async function quitExternalPlayer () {
  ipcRenderer.send('quitExternalPlayer')
}

// -- Player state notifications -------------------------------------

/**
 * Notify the main process that playback started.
 *
 * @returns {Promise<void>}
 */
export async function notifyPlayerPlay () {
  ipcRenderer.send('onPlayerPlay')
}

/**
 * Notify the main process that playback paused.
 *
 * @returns {Promise<void>}
 */
export async function notifyPlayerPause () {
  ipcRenderer.send('onPlayerPause')
}

/**
 * Notify the main process that the player opened.
 *
 * @returns {Promise<void>}
 */
export async function notifyPlayerOpen () {
  ipcRenderer.send('onPlayerOpen')
}

/**
 * Notify the main process which playlist controls are available.
 *
 * @param {boolean} hasNext
 * @param {boolean} hasPrevious
 * @returns {Promise<void>}
 */
export async function notifyPlayerUpdate (hasNext, hasPrevious) {
  ipcRenderer.send('onPlayerUpdate', hasNext, hasPrevious)
}

/**
 * Notify the main process that the player closed.
 *
 * @returns {Promise<void>}
 */
export async function notifyPlayerClose () {
  ipcRenderer.send('onPlayerClose')
}

/**
 * Notify the main process that a download finished, so it can show
 * the OS notification and bounce the dock.
 *
 * @param {string} path
 * @returns {Promise<void>}
 */
export async function notifyDownloadFinished (path) {
  ipcRenderer.send('downloadFinished', path)
}

// -- Inbound events -------------------------------------------------

/**
 * Console output forwarded from the main process.
 *
 * @param {(...args: any[]) => void} listener
 * @param {ListenOptions} [options]
 * @returns {Promise<Unsubscribe>}
 */
export async function onLog (listener, options) {
  return listen('log', listener, options)
}

/**
 * Errors forwarded from the main process.
 *
 * @param {(...args: any[]) => void} listener
 * @param {ListenOptions} [options]
 * @returns {Promise<Unsubscribe>}
 */
export async function onError (listener, options) {
  return listen('error', listener, options)
}

/**
 * Actions the main process wants the renderer to dispatch, for
 * example from the application menu.
 *
 * @param {(action: string, ...args: any[]) => void} listener
 * @param {ListenOptions} [options]
 * @returns {Promise<Unsubscribe>}
 */
export async function onDispatch (listener, options) {
  return listen('dispatch', listener, options)
}

/**
 * The window entered or left full screen.
 *
 * @param {(isFullScreen: boolean) => void} listener
 * @param {ListenOptions} [options]
 * @returns {Promise<Unsubscribe>}
 */
export async function onFullscreenChanged (listener, options) {
  return listen('fullscreenChanged', listener, options)
}

/**
 * The window was moved or resized.
 *
 * @param {(bounds: WindowBounds) => void} listener
 * @param {ListenOptions} [options]
 * @returns {Promise<Unsubscribe>}
 */
export async function onWindowBoundsChanged (listener, options) {
  return listen('windowBoundsChanged', listener, options)
}
