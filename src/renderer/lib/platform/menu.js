/**
 * Platform shim: data-driven context menus (FR-12).
 *
 * Callers describe the menu as an array of plain objects and never
 * construct `MenuItem` instances, so the descriptors survive being
 * serialised across a process boundary. The `click` callbacks stay in
 * the renderer; the shim is responsible for invoking the one the user
 * chose.
 *
 * Design-only stubs (US-018). Implemented in US-025, the torrent
 * context menu is rewritten against it in US-029. See
 * docs/platform-shim.md.
 */

const NOT_IMPLEMENTED = 'platform/menu: not implemented yet (US-025)'

/**
 * @typedef {object} MenuItemDescriptor
 * @property {'normal'|'separator'} [type] Defaults to `'normal'`.
 * @property {string} [label]    Required unless `type` is
 *   `'separator'`.
 * @property {() => void} [click] Invoked if the user picks the item.
 * @property {boolean} [enabled] Defaults to `true`.
 */

/**
 * Pop up a context menu at the pointer, parented to the current
 * window.
 *
 * @param {MenuItemDescriptor[]} items
 * @returns {Promise<void>} Resolves once the menu has been shown.
 *   It does not wait for the user's choice; the chosen item's
 *   `click` fires independently, as it does today.
 */
export async function showContextMenu (items) {
  throw new Error(NOT_IMPLEMENTED)
}
