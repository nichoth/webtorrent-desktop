#!/usr/bin/env node

/**
 * Build-time selection between the two platform shim trees (ADR-014).
 *
 * `src/renderer/lib/platform/*.js` is the Electron implementation and
 * `src/renderer/lib/platform/tauri/*.js` is the Tauri one. Exactly one
 * of them is in a given bundle: with `WT_HOST=tauri` every resolution
 * that lands on a module in the first tree is redirected to its
 * counterpart in the second, and with anything else (including
 * nothing, which is the default) the resolution is left alone.
 *
 * Two properties this has to have, both of them the reason it is a
 * resolver rather than a `resolve.alias` entry:
 *
 * - It matches the *resolved file*, not the import specifier. The
 *   specifiers that matter are relative -- `./clipboard` from the
 *   barrel -- and an alias list would silently miss them and ship a
 *   bundle with half of each tree in it. That failure builds cleanly,
 *   which makes it the worst one available.
 * - It cannot recurse. An import made from inside `tauri/` is left
 *   alone, so `export * from '../ipc-engine'` there reaches the
 *   sibling instead of bending back on itself.
 *
 * It is a plain CommonJS module with no bundler types in it so that
 * `vite.config.js` and `test/unit/platform-tauri.js` can both use it,
 * and so the decision is unit-testable without running a build.
 */

const path = require('path')

const ELECTRON = 'electron'
const TAURI = 'tauri'

// Repo-relative, as POSIX segments: the caller resolves it against
// wherever the repo is checked out.
const SHIM_SEGMENTS = ['src', 'renderer', 'lib', 'platform']

/**
 * The host a build targets. One environment variable with two values
 * and a default that matches today's behaviour, so a forgotten flag
 * produces the Electron build rather than a broken one.
 *
 * @param {object} [env] defaults to `process.env`
 * @returns {string} `'electron'` or `'tauri'`
 */
function host (env) {
  const value = (env || process.env).WT_HOST
  if (!value) return ELECTRON
  if (value !== ELECTRON && value !== TAURI) {
    throw new Error(
      `WT_HOST=${value} is not a host: expected ` +
      `'${ELECTRON}' or '${TAURI}' (ADR-014).`
    )
  }
  return value
}

/**
 * Where the two trees live, given the repo root.
 *
 * @param {string} root absolute path to the repo
 */
function shimDir (root) {
  return path.join(root, ...SHIM_SEGMENTS)
}

/**
 * Decide what a resolved module id becomes.
 *
 * @param {object} options
 * @param {string} options.root absolute path to the repo
 * @param {string} options.id the resolved absolute path
 * @param {string} [options.importer] the file the import was made from
 * @param {string} options.host `'electron'` or `'tauri'`
 * @returns {string|null} the replacement id, or `null` to leave it be
 */
function redirect ({ root, id, importer, host }) {
  if (host !== TAURI) return null

  const dir = shimDir(root)
  const tauriDir = path.join(dir, TAURI)

  // An import made from inside the Tauri tree is already there.
  if (importer && path.dirname(stripQuery(importer)) === tauriDir) {
    return null
  }

  const file = stripQuery(id)
  if (path.dirname(file) !== dir) return null
  if (path.extname(file) !== '.js') return null

  return path.join(tauriDir, path.basename(file))
}

// Vite appends `?v=`, `?commonjs-proxy` and friends to ids.
function stripQuery (id) {
  return id.split('?')[0]
}

module.exports = { ELECTRON, TAURI, host, redirect, shimDir }
