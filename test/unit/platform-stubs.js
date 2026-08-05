const test = require('tape')
const fs = require('fs')
const path = require('path')

// What the shim does not implement yet.
//
// ADR-014 planned for the window to be partly broken for most of Phase
// 4: an export whose host side has not been written throws a named
// `NotImplementedError` rather than returning `undefined`, so an
// unported concern is one console line rather than a plausible value
// that fails somewhere unrelated.
//
// This file was `platform-tauri.js` until US-072, where it checked
// that the Electron and Tauri trees exported the same names with the
// same arities and that the `WT_HOST` resolver swapped one for the
// other. There is one tree now, so the parity half has nothing to
// compare and the resolver is gone. What survives is the half that is
// still load-bearing: the register below, and the sweep that keeps it
// honest in both directions.
//
// **Adding a name here is not how a story finishes.** The register
// shrinks; it never grows. Each entry names the story that owes it.

const REPO = path.join(__dirname, '..', '..')
const SRC_SHIM = path.join(REPO, 'src', 'renderer', 'lib', 'platform')
const BUILT_SHIM = path.join(
  REPO, 'build', 'renderer', 'lib', 'platform'
)

// Not shim modules: the barrel and the shared failure helper.
const HELPERS = ['index.js', 'not-implemented.js']

const UNIMPLEMENTED = {
  'ipc-os.js': [
    // US-065: the file and magnet open events, and the two signals the
    // host waits on before it shows the window and before it quits.
    'signalReady',
    'signalStateSaved',
    'openTorrentFileDialog',
    'openFilesDialog',
    // US-064: registering as the .torrent and magnet handler.
    'setDefaultFileHandler',
    // The host's log and error channels. `src-tauri/src/log.rs` writes
    // the host's own; nothing emits these to the renderer yet.
    'onLog',
    'onError'
  ]
}

const { NOT_IMPLEMENTED } = require(
  path.join(BUILT_SHIM, 'not-implemented')
)

function modules () {
  return fs.readdirSync(SRC_SHIM)
    .filter((name) => name.endsWith('.js') && !HELPERS.includes(name))
    .sort()
}

function unimplemented (name) {
  return UNIMPLEMENTED[name] || []
}

// The source is the authority on which exports are stubs; the register
// above is the claim about it. Comparing the two is what makes a story
// that implements an export -- or regresses one -- fail here.
function stubsIn (name) {
  const source = fs.readFileSync(path.join(SRC_SHIM, name), 'utf8')
  const found = []
  const re = /export (?:async )?function (\w+)\s*\([^)]*\)\s*\{([^}]*)\}/g
  let m
  while ((m = re.exec(source))) {
    if (m[2].includes('notImplemented(')) found.push(m[1])
  }
  return found.sort()
}

test('the register lists exactly the stubs in the source', function (t) {
  const names = modules()
  t.ok(names.length > 5, 'walked the shim')
  for (const name of names) {
    t.deepEqual(stubsIn(name), unimplemented(name).slice().sort(),
      `${name}: the register matches the source`)
  }
  t.end()
})

test('the register names no module that does not exist', function (t) {
  for (const name of Object.keys(UNIMPLEMENTED)) {
    t.ok(fs.existsSync(path.join(SRC_SHIM, name)),
      `${name} is a shim module`)
  }
  t.end()
})

for (const name of modules()) {
  test(`every unported ${name} export rejects as not implemented`,
    async function (t) {
      const mod = require(path.join(BUILT_SHIM, name))
      const stubs = unimplemented(name)
      if (stubs.length === 0) {
        t.pass(`${name} is fully implemented`)
        t.end()
        return
      }
      for (const key of stubs) {
        t.equal(typeof mod[key], 'function', `${key} is exported`)
        const result = mod[key]()
        t.ok(result instanceof Promise, `${key}() returns a promise`)
        try {
          await result
          t.fail(`${key}() resolved instead of throwing`)
        } catch (err) {
          t.equal(err.code, NOT_IMPLEMENTED, `${key}() is not implemented`)
          t.ok(err.message.includes(key), `${key}() names itself`)
        }
      }
      t.end()
    })
}

test('every implemented export is implemented, not a stub',
  async function (t) {
    for (const name of modules()) {
      const mod = require(path.join(BUILT_SHIM, name))
      const stubs = unimplemented(name)
      for (const key of Object.keys(mod)) {
        if (key === '__esModule' || stubs.includes(key)) continue
        t.equal(typeof mod[key], 'function', `${name}.${key} is callable`)
      }
    }
    t.end()
  })
