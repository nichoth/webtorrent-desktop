/**
 * Tauri shim.
 *
 * Handing paths and URLs to the host OS (US-059).
 *
 * All four are host commands rather than plugin calls from the webview,
 * for the reason the window and dialog operations are: three of them
 * are the Electron *main* process's behaviour already (`src/main/
 * shell.js`, reached over IPC), and an app command needs no capability,
 * so `src-tauri/capabilities/default.json` stays at `core:default`. The
 * opener plugin and the trash crate are reached from
 * `src-tauri/src/shell.rs`.
 *
 * One difference from the Electron tree, recorded in
 * docs/platform-shim.md: there, three of these are `ipcRenderer.send`
 * and so resolve whatever the OS did with them. Here the host answers,
 * so a genuine failure rejects. `moveItemToTrash` still resolves for a
 * path that is already gone, which is the contract `../shell.js`
 * documents.
 *
 * One of the two interchangeable shim trees ADR-014 describes. Exactly
 * one of them is in a given bundle: `WT_HOST=tauri` selects this one,
 * and the default selects `../shell.js`. The two trees must export the
 * same names with the same arities -- `test/unit/platform-tauri.js`
 * holds that. `docs/platform-shim.md` is the contract each export is
 * being written against.
 */

import { invoke } from '@tauri-apps/api/core'

/**
 * Open a URL in the user's default browser.
 *
 * @param {string} url
 * @returns {Promise<void>}
 */
export async function openExternal (url) {
  await invoke('open_external', { url })
}

/**
 * Reveal a file or folder in the OS file manager.
 *
 * @param {string} path
 * @returns {Promise<void>}
 */
export async function showItemInFolder (path) {
  await invoke('show_item_in_folder', { path })
}

/**
 * Open a file in whichever application the OS associates with it.
 *
 * @param {string} path
 * @returns {Promise<void>}
 */
export async function openPath (path) {
  await invoke('open_path', { path })
}

/**
 * Move a file to the OS trash. Resolves even when the path is already
 * gone, matching the Electron tree's fire-and-forget IPC behaviour --
 * the host makes that decision, in `shell::plan_trash`.
 *
 * @param {string} path
 * @returns {Promise<void>}
 */
export async function moveItemToTrash (path) {
  await invoke('move_item_to_trash', { path })
}
