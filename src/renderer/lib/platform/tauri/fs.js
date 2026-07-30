/**
 * Tauri shim.
 *
 * Filesystem access, to be backed by the `fs` plugin.
 * Every path the UI passes has to fall inside a capability scope in
 * Tauri 2, so this module is where that translation belongs rather
 * than in the callers. Implemented in US-060.
 *
 * One of the two interchangeable shim trees ADR-014 describes. Exactly
 * one of them is in a given bundle: `WT_HOST=tauri` selects this one,
 * and the default selects `../fs.js`. The two trees must export the
 * same names with the same arities -- `test/unit/platform-tauri.js`
 * holds that. `docs/platform-shim.md` is the contract each export is
 * being written against.
 */

import { notImplemented } from './not-implemented'

export async function readFile (path) {
  notImplemented('fs', 'readFile')
}

export async function writeFile (path, data) {
  notImplemented('fs', 'writeFile')
}

export async function copyFile (src, dest) {
  notImplemented('fs', 'copyFile')
}

export async function mkdir (path) {
  notImplemented('fs', 'mkdir')
}

export async function rename (oldPath, newPath) {
  notImplemented('fs', 'rename')
}

export async function unlink (path) {
  notImplemented('fs', 'unlink')
}

export async function readdir (path) {
  notImplemented('fs', 'readdir')
}

export async function stat (path) {
  notImplemented('fs', 'stat')
}

export async function exists (path) {
  notImplemented('fs', 'exists')
}
