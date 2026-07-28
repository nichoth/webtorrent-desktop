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
 * Design-only stubs (US-018). Implemented in US-022, call sites
 * migrated in US-026. See docs/platform-shim.md.
 */

const NOT_IMPLEMENTED = 'platform/shell: not implemented yet (US-022)'

/**
 * Open a URL in the user's default browser.
 *
 * @param {string} url
 * @returns {Promise<void>}
 */
export async function openExternal (url) {
  throw new Error(NOT_IMPLEMENTED)
}

/**
 * Reveal a file or folder in the OS file manager.
 *
 * @param {string} path
 * @returns {Promise<void>}
 */
export async function showItemInFolder (path) {
  throw new Error(NOT_IMPLEMENTED)
}

/**
 * Open a file in whichever application the OS associates with it.
 *
 * @param {string} path
 * @returns {Promise<void>}
 */
export async function openPath (path) {
  throw new Error(NOT_IMPLEMENTED)
}

/**
 * Move a file to the OS trash. Resolves even when the path is
 * already gone, matching today's fire-and-forget IPC behaviour.
 *
 * @param {string} path
 * @returns {Promise<void>}
 */
export async function moveItemToTrash (path) {
  throw new Error(NOT_IMPLEMENTED)
}
