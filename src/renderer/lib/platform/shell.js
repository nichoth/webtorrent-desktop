/**
 * Platform shim: handing paths and URLs to the host OS.
 *
 * `openExternal` is the only one of these the renderer performs
 * directly today; the other three are already relayed to the main
 * process over IPC. They live here rather than in `ipc-os.js` because
 * they are one concern -- "ask the OS to do something with this
 * path" -- and a non-Electron host will implement all four the same
 * way. `ipc-os.js` deliberately exports none of them (FR-9 keeps
 * engine and OS IPC apart; this keeps OS IPC grouped by concern).
 *
 * `openExternal` goes straight to Electron's `shell`, which the
 * renderer already has; the other three keep their existing trip to
 * the main process, because `moveItemToTrash` is main-only and the
 * three main-side handlers already exist (`src/main/ipc.js`).
 *
 * Implemented in US-022; call sites are migrated in US-026. See
 * docs/platform-shim.md.
 */

import { ipcRenderer, shell } from 'electron'

/**
 * Open a URL in the user's default browser.
 *
 * @param {string} url
 * @returns {Promise<void>}
 */
export async function openExternal (url) {
  await shell.openExternal(url)
}

/**
 * Reveal a file or folder in the OS file manager.
 *
 * @param {string} path
 * @returns {Promise<void>}
 */
export async function showItemInFolder (path) {
  ipcRenderer.send('showItemInFolder', path)
}

/**
 * Open a file in whichever application the OS associates with it.
 *
 * @param {string} path
 * @returns {Promise<void>}
 */
export async function openPath (path) {
  ipcRenderer.send('openPath', path)
}

/**
 * Move a file to the OS trash. Resolves even when the path is
 * already gone, matching today's fire-and-forget IPC behaviour.
 *
 * @param {string} path
 * @returns {Promise<void>}
 */
export async function moveItemToTrash (path) {
  ipcRenderer.send('moveItemToTrash', path)
}
