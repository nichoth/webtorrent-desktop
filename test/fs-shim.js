/**
 * A filesystem-backed stand-in for `lib/platform/fs.js`.
 *
 * Until US-072 the fs shim *was* this: a thin wrapper over
 * `fs/promises`, which is what let `migrations.js` and `state-file.js`
 * run the real migration and the real save/load loop against a
 * throwaway profile directory. The cutover replaced it with nine host
 * commands, and a host command needs a running Tauri process, so those
 * tests would otherwise have nothing underneath them.
 *
 * So the implementation moved here. It is the same contract the shim
 * documents -- promises, plain `Uint8Array` out of `readFile`, a plain
 * object out of `stat`, `exists` swallowing every stat failure -- and
 * `test/unit/platform-fs.js` is what holds the real shim to it. Seed
 * this at `build/renderer/lib/platform/fs` and a module that reads or
 * writes through the shim can be exercised for real.
 *
 * It lives in `test/` rather than `test/unit/` because
 * `npm run test-unit` globs `test/unit/*.js` as test files.
 */

const fsp = require('fs/promises')

async function readFile (path) {
  const buffer = await fsp.readFile(path)
  // A view, not a copy: `Buffer` is a `Uint8Array` subclass, and
  // nothing that crosses this boundary should be a Node object.
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}

async function writeFile (path, data) {
  await fsp.writeFile(path, data)
}

async function copyFile (src, dest) {
  await fsp.copyFile(src, dest)
}

async function mkdir (path) {
  await fsp.mkdir(path, { recursive: true })
}

async function rename (oldPath, newPath) {
  await fsp.rename(oldPath, newPath)
}

async function unlink (path) {
  await fsp.unlink(path)
}

async function readdir (path) {
  return await fsp.readdir(path)
}

async function stat (path) {
  const stats = await fsp.stat(path)
  return {
    size: stats.size,
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile()
  }
}

async function exists (path) {
  try {
    await fsp.stat(path)
    return true
  } catch (err) {
    return false
  }
}

module.exports = {
  __esModule: true,
  copyFile,
  exists,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile
}
