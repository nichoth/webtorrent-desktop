const test = require('tape')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  OUT_DIR, PLATFORM, assertHost, stage
} = require('../../bin/stage-sidecar')

const REPO = path.join(__dirname, '..', '..')

// US-047: `stage()` is the only thing that decides where a staged file
// lands, and `engine::Runtime::resolve` is the only thing that decides
// where the packaged host looks for it. Nothing but a bundle brings
// the two together, so a transposed `path.join` here would pass every
// other test on the branch and surface as `Engine: failed to spawn`
// out of a shipped app.

// The staged tree is arm64 macOS throughout and `stage()` refuses to
// assemble anywhere else, which is the point of the guard below. CI
// runs on Linux, so the assembly test states what it needs rather than
// failing for the want of it.
const HOST = `${process.platform}-${process.arch}`

function tempDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stage-sidecar-'))
}

test('staging refuses to cross-compile the runtime', function (t) {
  // Both halves matter: an x64 Node beside the arm64 `utp-native`
  // prebuild is a sidecar that dies at require time, and a Linux Node
  // in a .app never spawns at all. Neither failure is visible until
  // the bundle runs.
  t.throws(
    () => assertHost('darwin-x64'), /darwin-x64/,
    'the wrong arch on the right platform is refused'
  )
  t.throws(
    () => assertHost('linux-arm64'), /linux-arm64/,
    'the wrong platform on the right arch is refused'
  )
  t.doesNotThrow(
    () => assertHost(PLATFORM), 'the staged platform is allowed'
  )
  t.end()
})

test('staging assembles the layout the Rust host resolves',
  { skip: HOST !== PLATFORM && `${HOST} cannot stage ${PLATFORM}` },
  async function (t) {
    const outPath = tempDir()

    try {
      // The real fetch is a 50MB download and a `tar` shell-out, and
      // neither is what this test is about: `bin/fetch-node.js` has
      // its own coverage. What matters here is that the runtime lands
      // at `<resource_dir>/node`, which the stub can state exactly.
      await stage({
        outPath,
        installRuntime: async dir => {
          fs.writeFileSync(path.join(dir, 'node'), '#!/bin/sh\n')
        }
      })

      // `src-tauri/src/engine.rs` joins these onto the resource
      // directory. They are the paths a release launch fails on.
      for (const relative of [
        'node',
        'package.json',
        path.join('build', 'config.js'),
        path.join('build', 'engine', 'index.js'),
        path.join('build', 'shared', 'wire.js'),
        path.join('node_modules', 'webtorrent', 'package.json')
      ]) {
        t.ok(
          fs.existsSync(path.join(outPath, relative)),
          `${relative} is staged`
        )
      }

      // Staged without one the sidecar dies on load: `build/config.js`
      // requires `../package.json` for APP_VERSION.
      const manifest = JSON.parse(fs.readFileSync(
        path.join(outPath, 'package.json'), 'utf8'
      ))
      const pkg = JSON.parse(fs.readFileSync(
        path.join(REPO, 'package.json'), 'utf8'
      ))
      t.equal(
        manifest.version, pkg.version,
        'the generated manifest carries the app version'
      )

      // Resolution in the bundle is resolution here only if each
      // package keeps the path it has in this repository. Flattening
      // would put one `debug` where a dozen versions are needed.
      const nested = path.join(
        'node_modules', 'music-metadata', 'node_modules', 'debug'
      )
      t.ok(
        fs.existsSync(path.join(outPath, nested, 'package.json')),
        'a nested copy is staged at its own path'
      )
    } finally {
      fs.rmSync(outPath, { recursive: true, force: true })
    }
  })

test('staging clears whatever was there before',
  { skip: HOST !== PLATFORM && `${HOST} cannot stage ${PLATFORM}` },
  async function (t) {
    const outPath = tempDir()
    const stale = path.join(outPath, 'build', 'engine', 'gone.js')

    try {
      fs.mkdirSync(path.dirname(stale), { recursive: true })
      fs.writeFileSync(stale, '// left over from an older tree\n')

      await stage({
        outPath,
        installRuntime: async dir => {
          fs.writeFileSync(path.join(dir, 'node'), '#!/bin/sh\n')
        }
      })

      // The bundler copies the directory wholesale, so anything left
      // behind ships. A renamed module would otherwise be in the app
      // twice, under both names.
      t.notOk(fs.existsSync(stale), 'the stale file is gone')
      t.ok(
        fs.existsSync(path.join(outPath, 'build', 'engine', 'index.js')),
        `and ${OUT_DIR}/ was rebuilt rather than merely emptied`
      )
    } finally {
      fs.rmSync(outPath, { recursive: true, force: true })
    }
  })
