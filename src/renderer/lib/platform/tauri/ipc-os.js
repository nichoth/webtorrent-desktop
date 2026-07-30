/**
 * Tauri shim.
 *
 * The OS-facing command surface, to be backed by Tauri commands and
 * events in `src-tauri/`.
 *
 * This is the widest module in the tree, and many Phase 4 stories
 * fill it in rather than one: window state (US-056, US-057), dock
 * and taskbar progress (US-063), file and magnet open events
 * (US-065), the power save blocker (US-066), the folder watcher
 * (US-068), launch-on-login (US-069) and the sidecar endpoint
 * (US-070).
 *
 * One of the two interchangeable shim trees ADR-014 describes. Exactly
 * one of them is in a given bundle: `WT_HOST=tauri` selects this one,
 * and the default selects `../ipc-os.js`. The two trees must export the
 * same names with the same arities -- `test/unit/platform-tauri.js`
 * holds that. `docs/platform-shim.md` is the contract each export is
 * being written against.
 */

import { notImplemented } from './not-implemented'

export async function setTitle (title) {
  notImplemented('ipc-os', 'setTitle')
}

export async function setProgress (progress) {
  notImplemented('ipc-os', 'setProgress')
}

export async function setBadge (count) {
  notImplemented('ipc-os', 'setBadge')
}

export async function setBounds (bounds, maximize) {
  notImplemented('ipc-os', 'setBounds')
}

export async function setAspectRatio (aspectRatio) {
  notImplemented('ipc-os', 'setAspectRatio')
}

export async function toggleFullScreen (setTo) {
  notImplemented('ipc-os', 'toggleFullScreen')
}

export async function show () {
  notImplemented('ipc-os', 'show')
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

export async function setAllowNav (allow) {
  notImplemented('ipc-os', 'setAllowNav')
}

export async function setDefaultFileHandler (isFileHandler) {
  notImplemented('ipc-os', 'setDefaultFileHandler')
}

export async function setStartup (startup) {
  notImplemented('ipc-os', 'setStartup')
}

export async function startFolderWatcher () {
  notImplemented('ipc-os', 'startFolderWatcher')
}

export async function stopFolderWatcher () {
  notImplemented('ipc-os', 'stopFolderWatcher')
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

export async function notifyPlayerPlay () {
  notImplemented('ipc-os', 'notifyPlayerPlay')
}

export async function notifyPlayerPause () {
  notImplemented('ipc-os', 'notifyPlayerPause')
}

export async function notifyPlayerOpen () {
  notImplemented('ipc-os', 'notifyPlayerOpen')
}

export async function notifyPlayerUpdate (hasNext, hasPrevious) {
  notImplemented('ipc-os', 'notifyPlayerUpdate')
}

export async function notifyPlayerClose () {
  notImplemented('ipc-os', 'notifyPlayerClose')
}

export async function notifyDownloadFinished (path) {
  notImplemented('ipc-os', 'notifyDownloadFinished')
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

export async function onDispatch (listener, options) {
  notImplemented('ipc-os', 'onDispatch')
}

export async function onFullscreenChanged (listener, options) {
  notImplemented('ipc-os', 'onFullscreenChanged')
}

export async function onWindowBoundsChanged (listener, options) {
  notImplemented('ipc-os', 'onWindowBoundsChanged')
}
