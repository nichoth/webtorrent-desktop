/**
 * Platform shim: reading the current window's state.
 *
 * This module covers only the *reads* that `@electron/remote`
 * supplies today. Everything that *changes* the window (title,
 * bounds, aspect ratio, full screen, dock badge) already goes to the
 * main process over IPC and therefore lives in `ipc-os.js`.
 *
 * Design-only stubs (US-018). Implemented in US-024, call sites
 * migrated in US-027. See docs/platform-shim.md.
 */

const NOT_IMPLEMENTED = 'platform/window: not implemented yet (US-024)'

/**
 * Whether the current window is visible (not hidden or minimised).
 *
 * @returns {Promise<boolean>}
 */
export async function isVisible () {
  throw new Error(NOT_IMPLEMENTED)
}

/**
 * Whether the current window is maximised.
 *
 * @returns {Promise<boolean>}
 */
export async function isMaximized () {
  throw new Error(NOT_IMPLEMENTED)
}
