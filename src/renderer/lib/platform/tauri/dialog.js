/**
 * Tauri shim.
 *
 * Native open and save dialogs (US-058).
 *
 * Under Electron these are `@electron/remote` calls, which is the main
 * process's dialog parented to the current window; under Tauri they
 * are host commands, for the same reason the window operations are --
 * and with the same consequence, that the renderer needs no capability
 * for them. The dialog plugin is reached from Rust, never from here.
 *
 * The options object crosses unchanged: `src-tauri/src/dialog.rs`
 * translates Electron's `properties`, `filters` and `defaultPath` into
 * the plugin's spellings, and records the two options it cannot
 * honour. Callers see exactly the contract `../dialog.js` documents --
 * plain paths, `[]` and `null` on cancel -- so no call site knows
 * which host it is on.
 *
 * One of the two interchangeable shim trees ADR-014 describes. Exactly
 * one of them is in a given bundle: `WT_HOST=tauri` selects this one,
 * and the default selects `../dialog.js`. The two trees must export the
 * same names with the same arities -- `test/unit/platform-tauri.js`
 * holds that. `docs/platform-shim.md` is the contract each export is
 * being written against.
 */

import { invoke } from '@tauri-apps/api/core'

/**
 * Show a native open dialog.
 *
 * @param {object} options See `../dialog.js` for the shape.
 * @returns {Promise<string[]>} Selected paths, or an empty array if
 *   the user cancelled.
 */
export async function showOpenDialog (options) {
  const filenames = await invoke('show_open_dialog', { options: args(options) })
  return filenames === null ? [] : filenames
}

/**
 * Show a native save dialog.
 *
 * @param {object} options See `../dialog.js` for the shape.
 * @returns {Promise<string|null>} The chosen path, or `null` if the
 *   user cancelled.
 */
export async function showSaveDialog (options) {
  const savePath = await invoke('show_save_dialog', { options: args(options) })
  return savePath === undefined ? null : savePath
}

/**
 * The host deserialises the options into a struct, so the argument has
 * to be an object even when the caller passed nothing: `undefined` is
 * dropped by JSON and arrives as a missing argument, which fails the
 * call rather than meaning "no options".
 */
function args (options) {
  return options || {}
}
