/**
 * Platform shim.
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
 * `docs/platform-shim.md` is the contract each export is written
 * against. Until US-072 there was a second, Electron tree beside
 * this one and a build flag to pick between them (ADR-014); the
 * cutover deleted both, so this module is the shim.
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
