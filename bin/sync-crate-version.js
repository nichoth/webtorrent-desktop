#!/usr/bin/env node

/**
 * Copies `version` from package.json into the crate's Cargo.toml and
 * its entry in Cargo.lock.
 *
 * Run as the npm `version` lifecycle script: npm calls it after bumping
 * package.json and before the version commit and tag, and the script
 * line in package.json stages what this writes so the tag covers it.
 * Tauri takes the bundle version from the crate (tauri.conf.json sets
 * none), so without this the .app and the .dmg keep the old number
 * while the sidecar reports the new one.
 *
 * The files are edited as text rather than through `cargo` so that a
 * version bump does not need a Rust toolchain.
 */

const fs = require('fs')
const path = require('path')

const ROOT_PATH = path.join(__dirname, '..')
const TAURI_DIR = path.join(ROOT_PATH, 'src-tauri')
const MANIFEST_PATH = path.join(TAURI_DIR, 'Cargo.toml')
const LOCK_PATH = path.join(TAURI_DIR, 'Cargo.lock')

const CRATE = 'webtorrent-desktop'

/** Rewrites `version` in the `[package]` table, and only there. */
function setManifestVersion (text, version) {
  const table = text.match(/^\[package\]\n[\s\S]*?(?=^\[|(?![\s\S]))/m)
  const line = /^version = "[^"]*"/m
  if (!table || !line.test(table[0])) {
    throw new Error('Cargo.toml has no [package] version')
  }

  const start = table.index
  const end = start + table[0].length
  return text.slice(0, start) +
    table[0].replace(line, `version = "${version}"`) +
    text.slice(end)
}

/** Rewrites the version of this crate's `[[package]]` entry. */
function setLockVersion (text, version) {
  const entry = new RegExp(
    `^(name = "${CRATE}"\\nversion = ")[^"]*(")`, 'm'
  )
  if (!entry.test(text)) {
    throw new Error(`Cargo.lock has no entry for ${CRATE}`)
  }
  return text.replace(entry, `$1${version}$2`)
}

function main () {
  const { version } = JSON.parse(
    fs.readFileSync(path.join(ROOT_PATH, 'package.json'), 'utf8')
  )

  const manifest = fs.readFileSync(MANIFEST_PATH, 'utf8')
  fs.writeFileSync(MANIFEST_PATH, setManifestVersion(manifest, version))

  const lock = fs.readFileSync(LOCK_PATH, 'utf8')
  fs.writeFileSync(LOCK_PATH, setLockVersion(lock, version))

  console.log(`${CRATE} crate version set to ${version}`)
}

if (require.main === module) main()

module.exports = { CRATE, setManifestVersion, setLockVersion }
