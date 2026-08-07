#!/usr/bin/env node

/**
 * The Node runtime the packaged sidecar runs on (US-047).
 *
 * Not the build machine's `node`: Homebrew's is dynamically linked
 * against some eighteen dylibs under `/opt/homebrew/opt/`, including
 * `@rpath/libnode.141.dylib`, so a bundle carrying it runs only where
 * an identical Homebrew install exists. The official tarballs are
 * self-contained.
 *
 * The version and its digest are pinned in `bin/node-runtime.json`.
 * The digest is committed rather than read from the `SHASUMS256.txt`
 * beside the download, because a checksum fetched from the host that
 * served the file proves the file arrived intact, not that it is the
 * file that was intended. Committing it makes changing the shipped
 * runtime a reviewable diff.
 */

const { execFileSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const MANIFEST = require('./node-runtime.json')

// Outside the repository, so `bin/clean.js` does not delete it and a
// rebuild does not re-download 50MB.
const CACHE_PATH = path.join(
  os.homedir(), '.cache', 'webtorrent-desktop', 'node'
)

module.exports = {
  MANIFEST,
  extractNodeBinary,
  fetchNode,
  tarballName,
  tarballUrl,
  verifyTarball
}

function tarballName (manifest, platform) {
  return `node-v${manifest.version}-${platform}.tar.gz`
}

function tarballUrl (manifest, platform) {
  return `https://nodejs.org/dist/v${manifest.version}/` +
    tarballName(manifest, platform)
}

/**
 * @returns {string} the hex digest, when it matches the pin.
 * @throws when the platform is unpinned or the bytes do not match.
 */
function verifyTarball (manifest, platform, bytes) {
  const pinned = (manifest.platforms[platform] || {}).sha256
  if (!pinned) {
    throw new Error(`bin/node-runtime.json pins no ${platform} build`)
  }

  const actual = crypto.createHash('sha256').update(bytes).digest('hex')
  if (actual !== pinned) {
    throw new Error(
      `${tarballName(manifest, platform)} checksum mismatch\n` +
      `  pinned ${pinned}\n` +
      `  actual ${actual}`
    )
  }
  return actual
}

/**
 * The verified tarball's path, downloading it if the cache is cold.
 */
async function fetchNode (platform, manifest = MANIFEST) {
  const cached = path.join(CACHE_PATH, tarballName(manifest, platform))

  if (fs.existsSync(cached)) {
    try {
      verifyTarball(manifest, platform, fs.readFileSync(cached))
      return cached
    } catch (err) {
      // A cached copy that no longer matches is either a corrupted
      // download or a bumped pin. Either way it must not be trusted,
      // and leaving it would fail the same way on every future run.
      fs.rmSync(cached)
      throw new Error(
        `${err.message}\n\nRemoved the cached copy -- run again.`
      )
    }
  }

  const url = tarballUrl(manifest, platform)
  console.log(`Fetching ${url}`)

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())

  // Verified before it is written, so a bad download is never
  // something a later run can pick up and trust.
  verifyTarball(manifest, platform, bytes)

  fs.mkdirSync(CACHE_PATH, { recursive: true })
  fs.writeFileSync(cached, bytes)
  return cached
}

/**
 * Extract just `bin/node` from the tarball to `destPath`.
 *
 * Shells out to the `tar` macOS ships rather than adding an npm
 * dependency that `depcheck` would then have to be told about.
 */
function extractNodeBinary (tarball, destPath) {
  const stem = path.basename(tarball, '.tar.gz')
  const destDir = path.dirname(destPath)
  fs.mkdirSync(destDir, { recursive: true })

  execFileSync('tar', [
    '-xzf', tarball,
    '-C', destDir,
    '--strip-components', '2',
    `${stem}/bin/node`
  ], { stdio: 'inherit' })

  // Stated rather than inherited. The executable bit is the whole
  // point of this file, and a spawn failure for the want of it reads
  // as "engine failed to spawn" with no hint why.
  fs.chmodSync(destPath, 0o755)
}
