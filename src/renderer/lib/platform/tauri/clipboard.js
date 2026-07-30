/**
 * Tauri shim.
 *
 * System clipboard (US-059).
 *
 * Two host commands over the clipboard-manager plugin's *Rust* API
 * rather than its JS one, which is what keeps the renderer's capability
 * at `core:default`: the JS plugin would need
 * `clipboard-manager:allow-read-text` and `allow-write-text` granted to
 * the whole webview. `src-tauri/src/clipboard.rs` is the other half,
 * and is also where an empty clipboard -- an error in the underlying
 * library, `''` under Electron -- is turned back into a string.
 *
 * One of the two interchangeable shim trees ADR-014 describes. Exactly
 * one of them is in a given bundle: `WT_HOST=tauri` selects this one,
 * and the default selects `../clipboard.js`. The two trees must export the
 * same names with the same arities -- `test/unit/platform-tauri.js`
 * holds that. `docs/platform-shim.md` is the contract each export is
 * being written against.
 */

import { invoke } from '@tauri-apps/api/core'

/**
 * Read the clipboard's plain-text contents.
 *
 * Electron's synchronous `clipboard.readText()` answers `''` for an
 * empty clipboard and for one holding something that is not text, so
 * the contract is a string and never `null` -- the same normalising
 * `../dialog.js` does for a cancelled dialog.
 *
 * @returns {Promise<string>}
 */
export async function readText () {
  const text = await invoke('clipboard_read_text')
  return text == null ? '' : text
}

/**
 * Replace the clipboard's plain-text contents.
 *
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function writeText (text) {
  await invoke('clipboard_write_text', { text })
}
