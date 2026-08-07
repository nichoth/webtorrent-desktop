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
 * A `cargo build` without the bundler is a debug build, so the
 * development path is untouched: `node` off the `PATH`, the
 * repository's own `build/`.
 */

const fs = require('fs')
const path = require('path')

const { fetchNode, extractNodeBinary } = require('./fetch-node')
const { resolveClosure } = require('./sidecar-closure')

const ROOT_PATH = path.join(__dirname, '..')

// The directory name is duplicated in four other places -- .gitignore,
// nodemon's --ignore list, depcheck's --ignore-dirs and bin/clean.js --
// because none of those can require this module. `tauri-host.js` holds
// them together.
const OUT_DIR = 'build-sidecar'

// Repo-relative paths from the Babel output, copied in the same layout
// they have here. `build/config.js` because the entry point imports it
// for APP_VERSION; `build/shared` for the wire envelope.
const COPY = [
  path.join('build', 'config.js'),
  path.join('build', 'engine'),
  path.join('build', 'shared')
]

const PLATFORM = 'darwin-arm64'

// Only what another file names, as `bin/build-tauri.js` does.
module.exports = { COPY, OUT_DIR, PLATFORM }

if (require.main === module) {
  stage().catch(err => {
    console.error(err.message)
    process.exit(1)
  })
}

async function stage () {
  const outPath = path.join(ROOT_PATH, OUT_DIR)
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

  const tarball = await fetchNode(PLATFORM)
  extractNodeBinary(tarball, path.join(outPath, 'node'))

  console.log(`Assembled ${OUT_DIR}/ for ${PLATFORM}`)
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
