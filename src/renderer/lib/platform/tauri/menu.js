/**
 * Tauri shim.
 *
 * Context menus, built in Rust from the descriptors this module is
 * handed (US-061). The descriptors are already host-neutral (FR-12),
 * so nothing about the contract changes here -- but under Tauri they
 * genuinely cross a process boundary, which is what ADR-007 was
 * written for. A `click` is a function and cannot go: the callbacks
 * stay here, the host answers with the index of what the user chose,
 * and this module calls the one that matches.
 *
 * The application menu is not here. It is the host's, exactly as it
 * is the Electron main process's (`src/main/menu.js`), and it is built
 * from descriptors of the same shape in `src-tauri/src/menu.rs`. What
 * the renderer keeps of it is `ipcOs.setAllowNav` and the player
 * notifications.
 *
 * One of the two interchangeable shim trees ADR-014 describes. Exactly
 * one of them is in a given bundle: `WT_HOST=tauri` selects this one,
 * and the default selects `../menu.js`. The two trees must export the
 * same names with the same arities -- `test/unit/platform-tauri.js`
 * holds that. `docs/platform-shim.md` is the contract each export is
 * being written against.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

/**
 * The event the host reports a choice on. It carries `{ menu, item }`
 * -- which menu, and which of its items -- and nothing else.
 */
const CLICK_EVENT = 'contextMenuClick'

/**
 * The menu the user is looking at: its id, and the callbacks that
 * belong to it. Only one context menu can be open at a time, so the
 * previous one's callbacks are dropped rather than accumulated.
 *
 * The id is what makes a late click safe. A menu dismissed without a
 * choice reports nothing, so there is no event that says "forget
 * these"; a click naming an id that is no longer open is ignored
 * instead.
 */
let open = null

/** The next menu's id. Monotonic for the life of the page. */
let nextMenu = 0

/**
 * The standing subscription, registered on first use rather than at
 * import: a renderer that never opens a context menu never asks the
 * host for anything.
 */
let subscription = null

/**
 * @typedef {object} MenuItemDescriptor
 * @property {'normal'|'separator'} [type] Defaults to `'normal'`.
 * @property {string} [label]    Required unless `type` is
 *   `'separator'`.
 * @property {() => void} [click] Invoked if the user picks the item.
 * @property {boolean} [enabled] Defaults to `true`.
 */

/**
 * Translate one descriptor into what the host is sent: plain data, and
 * no more of it than the host needs.
 *
 * @param {MenuItemDescriptor} descriptor
 * @returns {object}
 */
function toHostItem (descriptor) {
  const { type = 'normal', label, enabled } = descriptor

  if (type === 'separator') return { type: 'separator' }
  if (type !== 'normal') {
    throw new Error(`platform/menu: unsupported item type '${type}'`)
  }
  if (typeof label !== 'string') {
    throw new Error('platform/menu: an item needs a label')
  }

  return { type, label, enabled: enabled !== false }
}

/**
 * Call the chosen item's `click`, if the menu it belongs to is still
 * the open one.
 *
 * @param {{ menu: number, item: number }} choice
 */
function chose (choice) {
  if (!open || !choice || choice.menu !== open.menu) return
  const click = open.clicks[choice.item]
  if (click) click()
}

/**
 * Subscribe to the host's click event, once.
 *
 * @returns {Promise<void>}
 */
async function subscribe () {
  if (!subscription) {
    subscription = listen(CLICK_EVENT, (event) => chose(event.payload))
  }
  await subscription
}

/**
 * Pop a context menu up at the pointer, parented to the window the
 * command reaches the host from.
 *
 * @param {MenuItemDescriptor[]} items
 * @returns {Promise<void>} Resolves once the menu has been shown.
 *   It does not wait for the user's choice; the chosen item's
 *   `click` fires independently, as it does under Electron.
 */
export async function showContextMenu (items) {
  // Validated before anything is sent, so a bad descriptor rejects
  // rather than producing a half-built menu (ADR-007).
  const hostItems = items.map(toHostItem)
  const menu = nextMenu++

  await subscribe()
  open = { menu, clicks: items.map((item) => item.click) }

  return invoke('show_context_menu', { menu, items: hostItems })
}
