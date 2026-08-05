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

/**
 * The window's own rectangle, in logical pixels, plus whether it is
 * maximized.
 *
 * A host read rather than four DOM reads, and that is the whole point
 * of it. `window.screenX`/`screenY`/`outerWidth`/`outerHeight`
 * describe the OS window only when the page *is* the OS window, which
 * it was under Electron and is not under Tauri: the outer dimensions
 * come back as 0 and the screen coordinates are the content area's,
 * one title bar below the window's. `setDimensions()` in
 * `src/renderer/main.js` saves this rectangle when a video opens and
 * `restoreBounds()` asks the host to restore it when the player
 * closes, so a rectangle no window was ever at is a window that
 * vanishes off the edge of the screen.
 *
 * The maximize flag comes back with it because that caller needs the
 * two to describe one instant -- see `docs/platform-shim.md` and
 * `WindowRect` in `src-tauri/src/window.rs`.
 *
 * @returns {Promise<{x:number, y:number, width:number, height:number,
 *   maximized:boolean}>}
 */
export async function getBounds () {
  return invoke('window_bounds')
}
