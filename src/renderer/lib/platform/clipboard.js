/**
 * Platform shim: system clipboard.
 *
 * Electron's clipboard is synchronous and available in the renderer,
 * so both exports are thin async wrappers -- a host that has to cross
 * a process boundary can fill them in without a caller changing
 * (FR-10).
 *
 * Implemented in US-022; call sites are migrated in US-026. See
 * docs/platform-shim.md.
 */

import { clipboard } from 'electron'

/**
 * Read the clipboard's plain-text contents.
 *
 * @returns {Promise<string>}
 */
export async function readText () {
  return clipboard.readText()
}

/**
 * Replace the clipboard's plain-text contents.
 *
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function writeText (text) {
  clipboard.writeText(text)
}
