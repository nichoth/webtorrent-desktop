/**
 * Platform shim: reading the current window's state.
 *
 * This module covers only the *reads* that `@electron/remote`
 * supplies today. Everything that *changes* the window (title,
 * bounds, aspect ratio, full screen, dock badge) already goes to the
 * main process over IPC and therefore lives in `ipc-os.js`.
 *
 * Current-window access is the module's own business: it resolves
 * the window per call and never hands the handle out, because a
 * `BrowserWindow` proxy is not serialisable and would put an
 * Electron object back in front of the callers this shim exists to
 * keep clean (FR-12). The two reads below are the whole surface.
 *
 * Implemented in US-024; call sites are migrated in US-027. See
 * docs/platform-shim.md.
 */

import { getCurrentWindow } from '@electron/remote'

/**
 * Whether the current window is visible (not hidden or minimised).
 *
 * @returns {Promise<boolean>}
 */
export async function isVisible () {
  return getCurrentWindow().isVisible()
}

/**
 * Whether the current window is maximised.
 *
 * @returns {Promise<boolean>}
 */
export async function isMaximized () {
  return getCurrentWindow().isMaximized()
}
