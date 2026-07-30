/**
 * Tauri shim.
 *
 * Opening paths, files and URLs with the OS, to be backed by the
 * `opener` plugin. Implemented in US-059.
 *
 * One of the two interchangeable shim trees ADR-014 describes. Exactly
 * one of them is in a given bundle: `WT_HOST=tauri` selects this one,
 * and the default selects `../shell.js`. The two trees must export the
 * same names with the same arities -- `test/unit/platform-tauri.js`
 * holds that. `docs/platform-shim.md` is the contract each export is
 * being written against.
 */

import { notImplemented } from './not-implemented'

export async function openExternal (url) {
  notImplemented('shell', 'openExternal')
}

export async function showItemInFolder (path) {
  notImplemented('shell', 'showItemInFolder')
}

export async function openPath (path) {
  notImplemented('shell', 'openPath')
}

export async function moveItemToTrash (path) {
  notImplemented('shell', 'moveItemToTrash')
}
