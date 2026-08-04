/**
 * Tauri shim.
 *
 * The OS-facing command surface, to be backed by Tauri commands and
 * events in `src-tauri/`.
 *
 * This is the widest module in the tree, and many Phase 4 stories
 * fill it in rather than one: window state (US-056, US-057), dock
 * and taskbar progress (US-063), the power save blocker (US-066),
 * file and magnet open events (US-065), the folder watcher (US-068),
 * launch-on-login (US-069) and the sidecar endpoint (US-070).
 *
 * One of the two interchangeable shim trees ADR-014 describes. Exactly
 * one of them is in a given bundle: `WT_HOST=tauri` selects this one,
 * and the default selects `../ipc-os.js`. The two trees must export the
 * same names with the same arities -- `test/unit/platform-tauri.js`
 * holds that. `docs/platform-shim.md` is the contract each export is
 * being written against.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, once } from '@tauri-apps/api/event'
import { notImplemented } from './not-implemented'

/**
 * Register a listener on a host event, hiding both the Tauri event
 * envelope and the unsubscribe bookkeeping from the caller.
 *
 * The Electron sibling's `listen()` drops an event object and spreads
 * the rest of the arguments; a Tauri event carries exactly one
 * payload, so the wrapper unwraps `event.payload` instead. Both hand
 * the caller the same thing: the value the host sent, and a function
 * that stops the subscription.
 *
 * @param {string} event
 * @param {(payload: any) => void} listener
 * @param {{ once?: boolean }} [options]
 * @returns {Promise<() => void>}
 */
function subscribe (event, listener, options) {
  const register = options && options.once ? once : listen
  return register(event, (received) => listener(received.payload))
}

/**
 * An optional argument, as a Tauri command reads it.
 *
 * `undefined` is dropped by JSON serialisation, and a dropped key is
 * not the same thing as an argument the caller left out on purpose:
 * `toggleFullScreen()` with no flag means *toggle*, and the host has
 * to be told that rather than left to guess from a missing key.
 *
 * @param {any} value
 * @returns {any}
 */
function optional (value) {
  return value === undefined ? null : value
}

/**
 * Set the window title (US-057).
 *
 * @param {string} title
 * @returns {Promise<void>}
 */
export async function setTitle (title) {
  return invoke('set_title', { title })
}

/**
 * Set the taskbar progress bar, 0..1. Negative hides it, above 1 is
 * indeterminate -- the host reads those the way Electron does, so the
 * number crosses unchanged (US-057).
 *
 * @param {number} progress
 * @returns {Promise<void>}
 */
export async function setProgress (progress) {
  return invoke('set_progress', { progress })
}

/**
 * Set the dock badge to a download count, or clear it with `0`
 * (US-063).
 *
 * The count crosses as the caller computed it and the host decides
 * what it means: on macOS and Linux it is drawn, on Windows there is
 * no badge and the command does nothing. See `src-tauri/src/dock.rs`.
 *
 * @param {number} count
 * @returns {Promise<void>}
 */
export async function setBadge (count) {
  return invoke('set_badge', { count })
}

/**
 * Move and resize the window (US-057).
 *
 * @param {object} bounds `{ x, y, width, height, contentBounds }`,
 *   any of which may be absent; `x` and `y` are null together to mean
 *   "centre on the current display".
 * @param {boolean} [maximize] Whether to maximise or restore.
 * @returns {Promise<void>}
 */
export async function setBounds (bounds, maximize) {
  return invoke('set_bounds', { bounds, maximize: optional(maximize) })
}

/**
 * Lock the window to an aspect ratio -- **not supported under Tauri**.
 *
 * The host has no aspect-ratio API to call, so this reaches a command
 * that does nothing. The visible consequence, on macOS only: dragging
 * the player window's edge no longer snaps to the video's shape, and
 * the video letterboxes inside whatever rectangle the drag makes. The
 * window still *opens* at the video's shape, because every caller in
 * `src/renderer/main.js` follows this with a `setBounds`. See the
 * command's own comment in `src-tauri/src/main.rs`.
 *
 * @param {number} aspectRatio
 * @returns {Promise<void>}
 */
export async function setAspectRatio (aspectRatio) {
  return invoke('set_aspect_ratio', { aspectRatio })
}

/**
 * Enter or leave full screen (US-057).
 *
 * @param {boolean} [setTo] Toggles when omitted.
 * @returns {Promise<void>}
 */
export async function toggleFullScreen (setTo) {
  return invoke('toggle_full_screen', { setTo: optional(setTo) })
}

/**
 * Show and focus the main window (US-057).
 *
 * @returns {Promise<void>}
 */
export async function show () {
  return invoke('show')
}

export async function signalReady () {
  notImplemented('ipc-os', 'signalReady')
}

export async function signalStateSaved () {
  notImplemented('ipc-os', 'signalStateSaved')
}

export async function openTorrentFileDialog () {
  notImplemented('ipc-os', 'openTorrentFileDialog')
}

export async function openFilesDialog () {
  notImplemented('ipc-os', 'openFilesDialog')
}

/**
 * Allow or block opening another screen on top of the current one,
 * which is the File and Preferences items of the host's menu
 * (US-061). The menu is the host's, so this is a command rather than
 * anything the renderer can do itself.
 *
 * @param {boolean} allow
 * @returns {Promise<void>}
 */
export async function setAllowNav (allow) {
  return invoke('set_allow_nav', { allow })
}

export async function setDefaultFileHandler (isFileHandler) {
  notImplemented('ipc-os', 'setDefaultFileHandler')
}

export async function setStartup (startup) {
  notImplemented('ipc-os', 'setStartup')
}

/**
 * Start watching the configured torrents folder (US-068).
 *
 * No argument, as the Electron sibling has none: which folder, and
 * whether the preference is on at all, is in the saved state, and the
 * host reads it for itself. A torrent that appears there arrives back
 * as `addTorrent` on the `onDispatch` channel above.
 *
 * @returns {Promise<void>}
 */
export async function startFolderWatcher () {
  return invoke('start_folder_watcher')
}

/**
 * Stop watching the configured torrents folder (US-068).
 *
 * @returns {Promise<void>}
 */
export async function stopFolderWatcher () {
  return invoke('stop_folder_watcher')
}

export async function checkForExternalPlayer (path) {
  notImplemented('ipc-os', 'checkForExternalPlayer')
}

export async function openExternalPlayer (path, url, title) {
  notImplemented('ipc-os', 'openExternalPlayer')
}

export async function quitExternalPlayer () {
  notImplemented('ipc-os', 'quitExternalPlayer')
}

/**
 * Playback started: hold the display awake until it stops (US-066).
 *
 * @returns {Promise<void>}
 */
export async function notifyPlayerPlay () {
  return invoke('notify_player_play')
}

/**
 * Playback paused: let the display sleep again. The player is still
 * open, which is what makes this different from `notifyPlayerClose`
 * (US-066).
 *
 * @returns {Promise<void>}
 */
export async function notifyPlayerPause () {
  return invoke('notify_player_pause')
}

/**
 * The player opened, so the Playback menu applies to something
 * (US-061) and the display is to stay awake (US-066).
 *
 * Electron's handler also starts the media keys; those land on the
 * same command when they are ported (US-067), so the renderer's side
 * of it does not change again.
 *
 * @returns {Promise<void>}
 */
export async function notifyPlayerOpen () {
  return invoke('notify_player_open')
}

/**
 * Which playlist controls apply: Skip Next and Skip Previous follow
 * these two flags (US-061).
 *
 * @param {boolean} hasNext
 * @param {boolean} hasPrevious
 * @returns {Promise<void>}
 */
export async function notifyPlayerUpdate (hasNext, hasPrevious) {
  return invoke('notify_player_update', { hasNext, hasPrevious })
}

/**
 * The player closed: nothing in the Playback menu applies (US-061)
 * and the display may sleep (US-066).
 *
 * @returns {Promise<void>}
 */
export async function notifyPlayerClose () {
  return invoke('notify_player_close')
}

/**
 * A torrent finished downloading to `path`, which bounces the macOS
 * Downloads stack if that is where it landed (US-063).
 *
 * A no-op on Windows and Linux, neither of which has a Downloads
 * stack -- the same platforms `src/main/dock.js` returns early on.
 *
 * @param {string} path
 * @returns {Promise<void>}
 */
export async function notifyDownloadFinished (path) {
  return invoke('download_finished', { path })
}

export async function getEngineEndpoint () {
  notImplemented('ipc-os', 'getEngineEndpoint')
}

export async function onLog (listener, options) {
  notImplemented('ipc-os', 'onLog')
}

export async function onError (listener, options) {
  notImplemented('ipc-os', 'onError')
}

/**
 * Actions the host wants the renderer to dispatch, which is what every
 * application-menu item that is not a role does (US-061).
 *
 * A Tauri event carries one payload where Electron's `send` carries an
 * argument list, so the host sends the list as an array and it is
 * spread here: the caller's signature is `(action, ...args)` against
 * either host.
 *
 * @param {(action: string, ...args: any[]) => void} listener
 * @param {{ once?: boolean }} [options]
 * @returns {Promise<() => void>}
 */
export async function onDispatch (listener, options) {
  return subscribe('dispatch', (args) => listener(...args), options)
}

/**
 * The window entered or left full screen (US-057).
 *
 * Tauri has no enter/leave-fullscreen event, so the host reads the
 * state on every resize and emits only the transitions -- including
 * one the user made from the OS window chrome, which is what Electron
 * reports too. The payload is the same boolean.
 *
 * @param {(isFullScreen: boolean) => void} listener
 * @param {{ once?: boolean }} [options]
 * @returns {Promise<() => void>}
 */
export async function onFullscreenChanged (listener, options) {
  return subscribe('fullscreenChanged', listener, options)
}

/**
 * The window was moved or resized (US-056).
 *
 * The host emits this on the same name the Electron main process
 * sends it on, already debounced and already in logical pixels, so
 * the payload is the `{ x, y, width, height }` the caller saves
 * either way.
 *
 * @param {(bounds: object) => void} listener
 * @param {{ once?: boolean }} [options]
 * @returns {Promise<() => void>}
 */
export async function onWindowBoundsChanged (listener, options) {
  return subscribe('windowBoundsChanged', listener, options)
}
