/**
 * Tauri shim.
 *
 * File access (US-060).
 *
 * Nine host commands rather than the `fs` plugin's JS API, for the
 * reason every other Phase 4 module is a command: an app command needs
 * no capability, so `src-tauri/capabilities/default.json` stays at
 * `core:default` and the webview never carries file access of its own.
 * The `fs` plugin's alternative is `fs:allow-read-file` and its
 * siblings granted to the whole webview, scoped by a glob list written
 * in JSON -- which cannot express "the config directory, wherever it
 * is on this platform" or "the folder the user just picked". The host
 * knows both, so the allowlist lives there: `src-tauri/src/fs.rs`.
 *
 * A path outside that allowlist is refused by the host and the promise
 * rejects with the reason, which is a difference from `../fs.js` --
 * there, every path the renderer can name is a path it can read.
 * `exists` is the one export that does not surface the refusal,
 * because its contract has no channel for one: any failure is `false`.
 *
 * Bytes cross in both directions as bytes. `readFile` gets an
 * `ArrayBuffer` back (the host answers with `tauri::ipc::Response`,
 * which does not JSON-encode the file), and `writeFile` sends a plain
 * array, because a `Uint8Array` JSONifies to `{"0":4,"1":5}` and would
 * reach the host as an object it cannot deserialize into a `Vec<u8>`.
 *
 * One of the two interchangeable shim trees ADR-014 describes. Exactly
 * one of them is in a given bundle: `WT_HOST=tauri` selects this one,
 * and the default selects `../fs.js`. The two trees must export the
 * same names with the same arities -- `test/unit/platform-tauri.js`
 * holds that. `docs/platform-shim.md` is the contract each export is
 * being written against.
 */

import { invoke } from '@tauri-apps/api/core'

/**
 * @typedef {object} FileStats
 * @property {number} size        Size in bytes.
 * @property {boolean} isDirectory
 * @property {boolean} isFile
 */

/**
 * Read a whole file.
 *
 * @param {string} path
 * @returns {Promise<Uint8Array>}
 */
export async function readFile (path) {
  return bytes(await invoke('fs_read_file', { path }))
}

/**
 * Write a whole file, replacing it if it exists.
 *
 * @param {string} path
 * @param {Uint8Array|string} data
 * @returns {Promise<void>}
 */
export async function writeFile (path, data) {
  await invoke('fs_write_file', { path, data: Array.from(encode(data)) })
}

/**
 * Copy a file, overwriting the destination.
 *
 * @param {string} src
 * @param {string} dest
 * @returns {Promise<void>}
 */
export async function copyFile (src, dest) {
  await invoke('fs_copy_file', { src, dest })
}

/**
 * Create a directory. Always recursive, which is the only mode the
 * renderer uses.
 *
 * @param {string} path
 * @returns {Promise<void>}
 */
export async function mkdir (path) {
  await invoke('fs_mkdir', { path })
}

/**
 * Rename or move a file.
 *
 * @param {string} oldPath
 * @param {string} newPath
 * @returns {Promise<void>}
 */
export async function rename (oldPath, newPath) {
  await invoke('fs_rename', { oldPath, newPath })
}

/**
 * Delete a file.
 *
 * @param {string} path
 * @returns {Promise<void>}
 */
export async function unlink (path) {
  await invoke('fs_unlink', { path })
}

/**
 * List a directory's entries, names only.
 *
 * @param {string} path
 * @returns {Promise<string[]>}
 */
export async function readdir (path) {
  return await invoke('fs_readdir', { path })
}

/**
 * Stat a file or folder. Rejects if the path does not exist.
 *
 * @param {string} path
 * @returns {Promise<FileStats>}
 */
export async function stat (path) {
  return await invoke('fs_stat', { path })
}

/**
 * Whether a path exists. Covers the `try { statSync() } catch {}`
 * probes in `lib/migrations.js`, so any failure -- not just a missing
 * file, and including a path the host refuses -- reads as "not there",
 * matching what those probes do.
 *
 * @param {string} path
 * @returns {Promise<boolean>}
 */
export async function exists (path) {
  try {
    return await invoke('fs_exists', { path })
  } catch (err) {
    return false
  }
}

/**
 * The bytes of a file, however the host sent them.
 *
 * An `ArrayBuffer` is the normal answer. A plain array is what a
 * serialized `Vec<u8>` would be, and the caller cannot tell the two
 * apart, so neither does this.
 *
 * @param {ArrayBuffer|number[]|Uint8Array} data
 * @returns {Uint8Array}
 */
function bytes (data) {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return Uint8Array.from(data)
}

/**
 * The bytes to write. The host writes bytes, so a string is encoded
 * here -- as UTF-8, which is what `fs.writeFile` defaults to and what
 * `lib/state.js` reads back with a `TextDecoder`.
 *
 * @param {Uint8Array|string} data
 * @returns {Uint8Array}
 */
function encode (data) {
  return typeof data === 'string' ? new TextEncoder().encode(data) : data
}
