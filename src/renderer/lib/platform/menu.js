/**
 * Platform shim: data-driven context menus (FR-12).
 *
 * Callers describe the menu as an array of plain objects and never
 * construct `MenuItem` instances, so the descriptors survive being
 * serialised across a process boundary. The `click` callbacks stay in
 * the renderer; the shim is responsible for invoking the one the user
 * chose.
 *
 * The descriptor vocabulary is exactly what the renderer's one
 * context menu needs (`controllers/torrent-list-controller.js`):
 * labels, `click` handlers, an `enabled` flag and separators. There is
 * no submenu type because no menu here has a submenu; add one when a
 * menu needs it rather than in advance.
 *
 * Implemented in US-025; the torrent context menu is rewritten
 * against it in US-029. See docs/platform-shim.md.
 */

import { Menu, MenuItem, getCurrentWindow } from '@electron/remote'

/**
 * @typedef {object} MenuItemDescriptor
 * @property {'normal'|'separator'} [type] Defaults to `'normal'`.
 * @property {string} [label]    Required unless `type` is
 *   `'separator'`.
 * @property {() => void} [click] Invoked if the user picks the item.
 * @property {boolean} [enabled] Defaults to `true`.
 */

/**
 * Translate one descriptor into `MenuItem` options.
 *
 * The caller's `click` is wrapped so Electron's
 * `(menuItem, browserWindow, event)` arguments stop here: handing a
 * `MenuItem` or a `BrowserWindow` back to the renderer would put the
 * object this shim exists to hide in front of the caller again.
 *
 * @param {MenuItemDescriptor} descriptor
 * @returns {object} Options for `MenuItem`.
 */
function toMenuItemOptions (descriptor) {
  const { type = 'normal', label, click, enabled } = descriptor

  if (type === 'separator') return { type: 'separator' }
  if (type !== 'normal') {
    throw new Error(`platform/menu: unsupported item type '${type}'`)
  }
  if (typeof label !== 'string') {
    throw new Error('platform/menu: an item needs a label')
  }

  const options = { label, enabled: enabled !== false }
  if (click) options.click = () => click()
  return options
}

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
  const options = items.map(toMenuItemOptions)
  const menu = new Menu()
  for (const item of options) menu.append(new MenuItem(item))
  menu.popup({ window: getCurrentWindow() })
}
