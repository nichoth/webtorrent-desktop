/**
 * Platform shim: file system access.
 *
 * Exactly the operations `src/renderer/` performs today, no more. The
 * surface is deliberately callback-free and stream-free: everything
 * returns a promise so a host that has to cross a process boundary
 * can implement it.
 *
 * Two shape changes the migration stories have to absorb:
 *
 * 1. `stat` resolves to a plain object, not a Node `Stats` instance,
 *    so `stat.isDirectory()` becomes `stat.isDirectory`.
 * 2. There is no `createReadStream`. `subtitles-controller.js` reads
 *    the whole subtitle file with `readFile` instead; the file is
 *    small and the existing code concatenates the stream anyway.
 *
 * Design-only stubs (US-018). Implemented in US-023, call sites
 * migrated in US-028. See docs/platform-shim.md.
 */

const NOT_IMPLEMENTED = 'platform/fs: not implemented yet (US-023)'

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
  throw new Error(NOT_IMPLEMENTED)
}

/**
 * Write a whole file, replacing it if it exists.
 *
 * @param {string} path
 * @param {Uint8Array|string} data
 * @returns {Promise<void>}
 */
export async function writeFile (path, data) {
  throw new Error(NOT_IMPLEMENTED)
}

/**
 * Copy a file, overwriting the destination.
 *
 * @param {string} src
 * @param {string} dest
 * @returns {Promise<void>}
 */
export async function copyFile (src, dest) {
  throw new Error(NOT_IMPLEMENTED)
}

/**
 * Create a directory. Always recursive, which is the only mode the
 * renderer uses.
 *
 * @param {string} path
 * @returns {Promise<void>}
 */
export async function mkdir (path) {
  throw new Error(NOT_IMPLEMENTED)
}

/**
 * Rename or move a file.
 *
 * @param {string} oldPath
 * @param {string} newPath
 * @returns {Promise<void>}
 */
export async function rename (oldPath, newPath) {
  throw new Error(NOT_IMPLEMENTED)
}

/**
 * Delete a file.
 *
 * @param {string} path
 * @returns {Promise<void>}
 */
export async function unlink (path) {
  throw new Error(NOT_IMPLEMENTED)
}

/**
 * List a directory's entries, names only.
 *
 * @param {string} path
 * @returns {Promise<string[]>}
 */
export async function readdir (path) {
  throw new Error(NOT_IMPLEMENTED)
}

/**
 * Stat a file or folder. Rejects if the path does not exist.
 *
 * @param {string} path
 * @returns {Promise<FileStats>}
 */
export async function stat (path) {
  throw new Error(NOT_IMPLEMENTED)
}

/**
 * Whether a path exists. Covers the `try { statSync() } catch {}`
 * probes in `lib/migrations.js`.
 *
 * @param {string} path
 * @returns {Promise<boolean>}
 */
export async function exists (path) {
  throw new Error(NOT_IMPLEMENTED)
}
