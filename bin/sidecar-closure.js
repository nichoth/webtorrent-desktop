#!/usr/bin/env node

/**
 * The engine sidecar's dependency closure, as the list of package
 * directories a bundle has to carry (US-047).
 *
 * The closure is 190 package directories rather than the six bare
 * specifiers visible in `build/engine/`, and it is not cleanly
 * hoisted: `debug` resolves to twelve different directories at
 * differing versions and `readable-stream` to ten. So each package is
 * recorded by its path relative to the repository root and staged at
 * that same path, which makes resolution in the bundle identical to
 * resolution here. Flattening by name would silently pick one `debug`
 * for every consumer.
 *
 * This module reads the filesystem and writes nothing. The copying is
 * `bin/stage-sidecar.js`, so that what decides *which* files ship is
 * testable without producing a bundle.
 */

const fs = require('fs')
const path = require('path')

const ROOT_PATH = path.join(__dirname, '..')

// The bare specifiers the Babel output under `build/` requires --
// `music-metadata`, `network-address`, `webtorrent` and `ws` from
// `build/engine/`, and `application-config` and `arch` through
// `build/config.js`, which the entry point imports for APP_VERSION.
// `test/unit/sidecar-closure.js` re-derives this list from the built
// files and fails if anything here is missing.
const ROOTS = [
  'application-config',
  'arch',
  'music-metadata',
  'network-address',
  'webtorrent',
  'ws'
]

// Optional native addons that only accelerate ws's frame masking and
// UTF-8 validation. ws falls back to its JS implementations without
// them, and the engine's only WebSocket is a localhost control channel
// carrying small JSON envelopes -- so they buy nothing here, and each
// is a nested Mach-O that notarization would have to sign (US-083).
const EXCLUDED = new Set(['bufferutil', 'utf-8-validate'])

// The one platform this branch stages, spelled the way both the Node
// tarball name and `utp-native`'s prebuild directories spell it.
// `bin/stage-sidecar.js` imports it from here rather than repeating
// it: an x64 Node beside an arm64 addon is a bundle that dies at
// require time, and the two strings drifting apart is how that
// happens. `utp-native` ships a prebuild per platform and an
// arm64-only bundle needs exactly one; the other four are dead weight.
const PLATFORM = 'darwin-arm64'

module.exports = { PLATFORM, packageDir, resolveClosure }

/**
 * Where `require(name)` from `fromDir` would find its package.
 *
 * Node's own algorithm: look in `<dir>/node_modules/<name>`, then walk
 * up a level and look again. Spelled out rather than delegated to
 * `require.resolve(`${name}/package.json`)`, which a package whose
 * `exports` map declines to expose its manifest defeats -- a real
 * hazard across 190 of them.
 *
 * @returns {string|null} null when nothing resolves.
 */
function packageDir (name, fromDir) {
  let dir = fromDir
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name)
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return candidate
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Every package directory the sidecar needs, and the files to take
 * from each.
 */
function resolveClosure (repoRoot = ROOT_PATH) {
  const found = new Map()
  const queue = ROOTS.map(name => ({ name, from: repoRoot }))

  while (queue.length > 0) {
    const { name, from } = queue.shift()
    if (EXCLUDED.has(name)) continue

    const dir = packageDir(name, from)
    if (dir === null) {
      throw new Error(
        `Cannot resolve ${name} from ` +
        `${path.relative(repoRoot, from) || '.'} -- run npm install`
      )
    }
    if (found.has(dir)) continue

    found.set(dir, {
      name,
      dir,
      relative: path.relative(repoRoot, dir),
      files: filesFor(name, dir)
    })

    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, 'package.json'), 'utf8')
    )
    const deps = Object.keys(manifest.dependencies || {})
      .concat(Object.keys(manifest.optionalDependencies || {}))
    for (const dep of deps) queue.push({ name: dep, from: dir })
  }

  return [...found.values()]
}

/** One package's files, relative to its own directory. */
function filesFor (name, dir) {
  const files = []

  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)

      if (entry.isDirectory()) {
        // A nested dependency is its own entry in the closure, at its
        // own path, so that the staged tree matches this one.
        if (entry.name === 'node_modules') continue
        walk(full)
        continue
      }

      const relative = path.relative(dir, full)
      if (name === 'utp-native' && !keepPrebuild(relative)) continue
      files.push(relative)
    }
  }

  walk(dir)

  if (name === 'utp-native') {
    const wanted = `prebuilds${path.sep}${PLATFORM}${path.sep}`
    if (!files.some(file => file.startsWith(wanted))) {
      throw new Error(
        `utp-native carries no ${PLATFORM} prebuild -- staging it ` +
        'would drop the sidecar to TCP-only peers with nothing but a ' +
        'console warning to say so'
      )
    }
  }

  return files
}

function keepPrebuild (relative) {
  const parts = relative.split(path.sep)
  if (parts[0] !== 'prebuilds') return true
  return parts[1] === PLATFORM
}
