/**
 * Tauri shim.
 *
 * Reading the current window's state, to be backed by Tauri's
 * window API. Implemented in US-057.
 *
 * One of the two interchangeable shim trees ADR-014 describes. Exactly
 * one of them is in a given bundle: `WT_HOST=tauri` selects this one,
 * and the default selects `../window.js`. The two trees must export the
 * same names with the same arities -- `test/unit/platform-tauri.js`
 * holds that. `docs/platform-shim.md` is the contract each export is
 * being written against.
 */

import { notImplemented } from './not-implemented'

export async function isVisible () {
  notImplemented('window', 'isVisible')
}

export async function isMaximized () {
  notImplemented('window', 'isMaximized')
}
