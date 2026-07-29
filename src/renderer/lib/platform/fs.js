/**
 * Platform shim: file system access.
 *
 * Exactly the operations `src/renderer/` performs today, no more. The
 * surface is deliberately callback-free and stream-free: everything
 * returns a promise so a host that has to cross a process boundary
 * can implement it.
 *
 * Three shape changes the migration stories have to absorb:
 *
 * 1. `stat` resolves to a plain object, not a Node `Stats` instance,
 *    so `stat.isDirectory()` becomes `stat.isDirectory`.
 * 2. There is no `createReadStream`. `subtitles-controller.js` reads
 *    the whole subtitle file with `readFile` instead; the file is
 *    small and the existing code concatenates the stream anyway.
 * 3. `readFile` resolves to a plain `Uint8Array`, not a `Buffer`, so
 *    text callers decode it themselves (`new TextDecoder().decode`).
 *    `JSON.parse(await readFile(p))` does NOT work the way
 *    `JSON.parse(readFileSync(p))` did.
 *
 * Backed by `fs/promises` here; US-028 migrates the call sites. See
 * docs/platform-shim.md.
 */

import {
  copyFile as nodeCopyFile,
  mkdir as nodeMkdir,
  readFile as nodeReadFile,
  readdir as nodeReaddir,
  rename as nodeRename,
  stat as nodeStat,
  unlink as nodeUnlink,
  writeFile as nodeWriteFile
} from 'fs/promises'

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
  const buffer = await nodeReadFile(path)
  // A view, not a copy: `Buffer` is a `Uint8Array` subclass, and
  // nothing that crosses this boundary should be a Node object.
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}

/**
 * Write a whole file, replacing it if it exists.
 *
 * @param {string} path
 * @param {Uint8Array|string} data
 * @returns {Promise<void>}
 */
export async function writeFile (path, data) {
  await nodeWriteFile(path, data)
}

/**
 * Copy a file, overwriting the destination.
 *
 * @param {string} src
 * @param {string} dest
 * @returns {Promise<void>}
 */
export async function copyFile (src, dest) {
  await nodeCopyFile(src, dest)
}

/**
 * Create a directory. Always recursive, which is the only mode the
 * renderer uses.
 *
 * @param {string} path
 * @returns {Promise<void>}
 */
export async function mkdir (path) {
  await nodeMkdir(path, { recursive: true })
}

/**
 * Rename or move a file.
 *
 * @param {string} oldPath
 * @param {string} newPath
 * @returns {Promise<void>}
 */
export async function rename (oldPath, newPath) {
  await nodeRename(oldPath, newPath)
}

/**
 * Delete a file.
 *
 * @param {string} path
 * @returns {Promise<void>}
 */
export async function unlink (path) {
  await nodeUnlink(path)
}

/**
 * List a directory's entries, names only.
 *
 * @param {string} path
 * @returns {Promise<string[]>}
 */
export async function readdir (path) {
  return await nodeReaddir(path)
}

/**
 * Stat a file or folder. Rejects if the path does not exist.
 *
 * @param {string} path
 * @returns {Promise<FileStats>}
 */
export async function stat (path) {
  const stats = await nodeStat(path)
  return {
    size: stats.size,
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile()
  }
}

/**
 * Whether a path exists. Covers the `try { statSync() } catch {}`
 * probes in `lib/migrations.js`, so any stat failure -- not just
 * ENOENT -- reads as "not there", matching what those probes do.
 *
 * @param {string} path
 * @returns {Promise<boolean>}
 */
export async function exists (path) {
  try {
    await nodeStat(path)
    return true
  } catch (err) {
    return false
  }
}
