#!/usr/bin/env node

/**
 * Assembles the directory that becomes the bundle's
 * `Contents/Resources` (US-047).
 *
 * `engine::Runtime::resolve` branches on `!cfg!(debug_assertions)`: a
 * release build looks for `<resource_dir>/node` and
 * `<resource_dir>/build/engine/index.js` and runs the child with
 * `<resource_dir>` as its working directory. That layout is already
 * stated in Rust and asserted by a Rust test, so this script does not
 * choose it -- it satisfies it.
 *
 * A `cargo build` without the bundler is a debug build, so how the
 * host *resolves* the sidecar is untouched: `node` off the `PATH`, the
 * repository's own `build/`. It does not run this script either --
 * `src-tauri/build.rs` only creates the staging root so that
 * `bundle.resources` has a path to point at, and an empty one copies
 * nothing.
 */

const fs = require('fs')
const path = require('path')

const { fetchNode, extractNodeBinary } = require('./fetch-node')
const { PLATFORM, resolveClosure } = require('./sidecar-closure')

const ROOT_PATH = path.join(__dirname, '..')

// The directory name is duplicated in five other places -- .gitignore,
// nodemon's --ignore list, depcheck's --ignore-dirs, bin/clean.js and
// src-tauri/build.rs -- because none of those can require this module.
// `tauri-host.js` holds them together.
const OUT_DIR = 'build-sidecar'

// Repo-relative paths from the Babel output, copied in the same layout
// they have here. `build/config.js` because the entry point imports it
// for APP_VERSION; `build/shared` for the wire envelope.
const COPY = [
  path.join('build', 'config.js'),
  path.join('build', 'engine'),
  path.join('build', 'shared')
]

module.exports = { COPY, OUT_DIR, PLATFORM, assertHost, stage }

if (require.main === module) {
  stage()
    .then(() => console.log(`Assembled ${OUT_DIR}/ for ${PLATFORM}`))
    .catch(err => {
      console.error(err.message)
      process.exit(1)
    })
}

/**
 * Every part of the staged tree is `PLATFORM`-specific -- the Node
 * binary this downloads and the `utp-native` prebuild the closure
 * keeps. Nothing downstream re-checks: on an x64 or a Linux host this
 * would assemble happily, and the mismatch would first be visible as
 * `Engine: failed to spawn` out of a shipped build, which is the
 * symptom this whole branch exists to remove.
 *
 * @param {string} [host] the running machine's, as a parameter only so
 *   that a test on a matching host can still exercise the refusal.
 */
function assertHost (host = `${process.platform}-${process.arch}`) {
  if (host !== PLATFORM) {
    throw new Error(
      `bin/stage-sidecar.js stages ${PLATFORM} and this host is ` +
      `${host} -- cross-staging would ship a runtime the app cannot run`
    )
  }
}

/**
 * @param {object} [options]
 * @param {string} [options.outPath] the directory to assemble; the
 *   repository's own staging root by default.
 * @param {(outPath: string) => Promise<void>} [options.installRuntime]
 *   puts the Node binary at `<outPath>/node`; downloads and extracts
 *   the pinned tarball by default. The seam is there so a test can
 *   assemble a tree without a 50MB download.
 */
async function stage ({
  outPath = path.join(ROOT_PATH, OUT_DIR),
  installRuntime = installNodeRuntime
} = {}) {
  assertHost()
  fs.rmSync(outPath, { recursive: true, force: true })

  for (const entry of COPY) {
    const fromPath = path.join(ROOT_PATH, entry)
    if (!fs.existsSync(fromPath)) {
      throw new Error(
        `${entry} does not exist -- run 'npm run build' first`
      )
    }
    fs.cpSync(fromPath, path.join(outPath, entry), { recursive: true })
  }

  writeManifest(outPath)
  copyClosure(outPath)
  await installRuntime(outPath)
}

async function installNodeRuntime (outPath) {
  const tarball = await fetchNode(PLATFORM)
  extractNodeBinary(tarball, path.join(outPath, 'node'))
}

/**
 * `build/config.js` requires `../package.json` and reads `version`
 * from it as APP_VERSION, which the engine folds into its peer ID.
 * Staged without one the sidecar dies on load with
 * `Cannot find module '../package.json'`.
 *
 * Generated rather than copied: the repository's dependency and script
 * maps describe a tree the packaged app does not have.
 */
function writeManifest (outPath) {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT_PATH, 'package.json'), 'utf8')
  )
  fs.writeFileSync(
    path.join(outPath, 'package.json'),
    JSON.stringify(
      { name: pkg.name, version: pkg.version, private: true }, null, 2
    ) + '\n'
  )
}

/** Each package at the same relative path it has in this repository. */
function copyClosure (outPath) {
  for (const entry of resolveClosure(ROOT_PATH)) {
    for (const file of entry.files) {
      const to = path.join(outPath, entry.relative, file)
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.copyFileSync(path.join(entry.dir, file), to)
    }
  }
}
