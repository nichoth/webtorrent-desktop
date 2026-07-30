/**
 * Tauri shim.
 *
 * Reading the current window's state (US-057).
 *
 * Under Electron these are `@electron/remote` calls into the main
 * process; under Tauri they are host commands, for the same reason
 * every other window operation is one -- see the block above the
 * window commands in `src-tauri/src/main.rs`. The window handle stays
 * inside the host either way, which is the whole point of the module
 * (FR-12).
 *
 * One of the two interchangeable shim trees ADR-014 describes. Exactly
 * one of them is in a given bundle: `WT_HOST=tauri` selects this one,
 * and the default selects `../window.js`. The two trees must export the
 * same names with the same arities -- `test/unit/platform-tauri.js`
 * holds that. `docs/platform-shim.md` is the contract each export is
 * being written against.
 */

import { invoke } from '@tauri-apps/api/core'

/**
 * Whether the current window is visible (not hidden or minimised).
 *
 * @returns {Promise<boolean>}
 */
export async function isVisible () {
  return invoke('window_is_visible')
}

/**
 * Whether the current window is maximised.
 *
 * @returns {Promise<boolean>}
 */
export async function isMaximized () {
  return invoke('window_is_maximized')
}
