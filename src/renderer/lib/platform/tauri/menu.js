/**
 * Tauri shim.
 *
 * Context menus, to be built in Rust from the descriptors this
 * module is handed. The descriptors are already host-neutral
 * (FR-12), so nothing about the contract changes here. Implemented
 * in US-061.
 *
 * One of the two interchangeable shim trees ADR-014 describes. Exactly
 * one of them is in a given bundle: `WT_HOST=tauri` selects this one,
 * and the default selects `../menu.js`. The two trees must export the
 * same names with the same arities -- `test/unit/platform-tauri.js`
 * holds that. `docs/platform-shim.md` is the contract each export is
 * being written against.
 */

import { notImplemented } from './not-implemented'

export async function showContextMenu (items) {
  notImplemented('menu', 'showContextMenu')
}
