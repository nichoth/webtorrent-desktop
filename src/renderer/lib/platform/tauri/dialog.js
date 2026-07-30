/**
 * Tauri shim.
 *
 * Native open and save dialogs, to be backed by the `dialog` plugin.
 * Implemented in US-058.
 *
 * One of the two interchangeable shim trees ADR-014 describes. Exactly
 * one of them is in a given bundle: `WT_HOST=tauri` selects this one,
 * and the default selects `../dialog.js`. The two trees must export the
 * same names with the same arities -- `test/unit/platform-tauri.js`
 * holds that. `docs/platform-shim.md` is the contract each export is
 * being written against.
 */

import { notImplemented } from './not-implemented'

export async function showOpenDialog (options) {
  notImplemented('dialog', 'showOpenDialog')
}

export async function showSaveDialog (options) {
  notImplemented('dialog', 'showSaveDialog')
}
