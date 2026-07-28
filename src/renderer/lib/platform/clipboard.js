/**
 * Platform shim: system clipboard.
 *
 * Design-only stubs (US-018). Implemented in US-022, call sites
 * migrated in US-026. See docs/platform-shim.md.
 */

const NOT_IMPLEMENTED = 'platform/clipboard: not implemented yet (US-022)'

/**
 * Read the clipboard's plain-text contents.
 *
 * @returns {Promise<string>}
 */
export async function readText () {
  throw new Error(NOT_IMPLEMENTED)
}

/**
 * Replace the clipboard's plain-text contents.
 *
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function writeText (text) {
  throw new Error(NOT_IMPLEMENTED)
}
