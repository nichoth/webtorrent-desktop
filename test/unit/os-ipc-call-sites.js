const test = require('tape')
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')

// US-030: the controller-layer OS IPC call sites, routed through
// `lib/platform/ipc-os.js`.
//
// `test/unit/platform-boundary.js` proves the channel strings are gone
// from the sources. This file proves the replacements do the same work:
// that each controller method reaches the right shim export with the
// right arguments, and that a rejected shim promise reaches
// `dispatch('error', ...)` rather than floating.
//
// Controllers are excluded from `build:main`, so each one under test is
// compiled here with the repo's own Babel config and emitted into
// `build/renderer/controllers/`, where its `../lib/...` imports resolve
// against the real built `build/renderer/lib/**`. See test/AGENTS.md.

const ROOT = path.join(__dirname, '..', '..')
const BUILT = path.join(ROOT, 'build', 'renderer')
const OUT_DIR = path.join(BUILT, 'controllers')

fs.mkdirSync(OUT_DIR, { recursive: true })

function compile (name) {
  const src = path.join(ROOT, 'src', 'renderer', 'controllers', name)
  const out = path.join(OUT_DIR, name)
  fs.writeFileSync(
    out, babel.transformFileSync(src, { root: ROOT, cwd: ROOT }).code
  )
  return out
}

const PREFS = compile('prefs-controller.js')
const WATCHER = compile('folder-watcher-controller.js')
const MEDIA = compile('media-controller.js')

// Recording state. Every stub below is a stable object reading from
// here, because Babel binds each stub's `exports` object once
// (test/AGENTS.md).
let record = null

const { setDispatch } = require(path.join(BUILT, 'lib', 'dispatcher'))

function reset () {
  record = { os: [], dispatches: [], engine: [], once: [] }
  rejectWith = null
  // `lib/dispatcher` holds one process-wide dispatch and every unit
  // test file that requires it registers its own. Re-register per test
  // rather than once at require time, or whichever file loads last
  // wins for the whole run.
  setDispatch((...args) => record.dispatches.push(args))
}

// When set, every recorded ipc-os call rejects with this instead of
// resolving, so the error path can be exercised.
let rejectWith = null

// `require.cache` is process-wide and `tape test/unit/*.js` is one
// process, so a stub left in place is a stub the next file inherits --
// `platform-ipc-os.js` tests the real module. Each stub therefore
// returns its own undo, called once the controllers under test have
// been required (Babel binds the imported module object at that first
// require, so they keep talking to the stub afterwards).
const undo = []

function stub (modulePath, exports) {
  const id = require.resolve(modulePath)
  const previous = require.cache[id]
  require.cache[id] = { id, filename: id, loaded: true, exports }
  undo.push(() => {
    if (previous) require.cache[id] = previous
    else delete require.cache[id]
  })
}

// One recorder per ipc-os export the migrated controllers use. Named
// explicitly rather than proxied, so a controller calling an export
// that does not exist fails loudly.
const OS_EXPORTS = [
  'setAllowNav',
  'setDefaultFileHandler',
  'setStartup',
  'startFolderWatcher',
  'stopFolderWatcher',
  'openExternalPlayer'
]

const ipcOsStub = { __esModule: true }
for (const name of OS_EXPORTS) {
  ipcOsStub[name] = async (...args) => {
    record.os.push([name, ...args])
    if (rejectWith) throw rejectWith
  }
}

// `checkForExternalPlayer` is the one request/response export: it
// resolves to whether the player is installed.
let externalPlayerInstalled = true
ipcOsStub.checkForExternalPlayer = async (...args) => {
  record.os.push(['checkForExternalPlayer', ...args])
  if (rejectWith) throw rejectWith
  return externalPlayerInstalled
}

stub(path.join(BUILT, 'lib', 'platform', 'ipc-os'), ipcOsStub)

// Since US-032 media-controller's one engine listener goes through
// `ipc-engine.js`. Stub it here rather than letting the real one load:
// it would bind whatever `electron` stub is current for the whole run,
// and `platform-ipc-engine.js` tests the real module further down the
// glob (test/AGENTS.md).
stub(path.join(BUILT, 'lib', 'platform', 'ipc-engine'), {
  __esModule: true,
  async onServerRunningFor (infoHash, listener, options) {
    record.once.push(['onServerRunningFor', listener, options])
    return () => {}
  }
})

const PrefsController = require(PREFS).default
const FolderWatcherController = require(WATCHER).default
const MediaController = require(MEDIA).default

for (const restore of undo) restore()

// A promise that settles after the shim's own microtasks have run.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

test('the folder watcher starts and stops through the shim',
  async function (t) {
    reset()
    const controller = new FolderWatcherController()

    controller.start()
    await flush()
    t.deepEqual(record.os, [['startFolderWatcher']], 'start goes to the shim')

    reset()
    controller.stop()
    await flush()
    t.deepEqual(record.os, [['stopFolderWatcher']], 'stop goes to the shim')
    t.deepEqual(record.engine, [], 'nothing went out to the engine')
    t.end()
  })

// The preferences screen blocks in-window navigation while it is open,
// so `setAllowNav` has to run on both halves of the route's lifecycle.
test('the preferences route toggles navigation through the shim',
  async function (t) {
    reset()
    let route = null
    const state = {
      window: {},
      location: { go (r) { route = r } },
      saved: { prefs: {} }
    }

    new PrefsController(state, {}).show()
    t.ok(route, 'the controller went to a route')

    route.setup(() => {})
    await flush()
    t.deepEqual(record.os, [['setAllowNav', false]],
      'entering preferences blocks navigation')

    reset()
    route.destroy()
    await flush()
    t.deepEqual(record.os, [['setAllowNav', true]],
      'leaving preferences unblocks it')
    t.end()
  })

test('preference updates reach the OS through the shim',
  async function (t) {
    const cases = [
      ['isFileHandler', true, [['setDefaultFileHandler', true]]],
      ['startup', false, [['setStartup', false]]],
      ['downloadPath', '/tmp/x', []]
    ]

    for (const [property, value, expected] of cases) {
      reset()
      const state = { saved: { prefs: {} } }
      new PrefsController(state, {}).update(property, value)
      await flush()
      t.deepEqual(record.os, expected, property + ' reaches the right export')
      t.equal(state.saved.prefs[property], value, property + ' is saved')
      t.deepEqual(record.dispatches.map((d) => d[0]),
        ['stateSaveImmediate', 'checkDownloadPath'],
        property + ' still triggers a save and a download-path check')
    }
    t.end()
  })

test('a rejected shim promise is reported, not left floating',
  async function (t) {
    reset()
    rejectWith = new Error('no IPC host')
    new PrefsController({ saved: { prefs: {} } }, {})
      .update('startup', true)
    await flush()
    t.deepEqual(record.dispatches.filter((d) => d[0] === 'error'),
      [['error', rejectWith]], 'the rejection became dispatch(error)')
    reset()
    t.end()
  })

test('a media error asks the shim whether an external player exists',
  async function (t) {
    reset()
    externalPlayerInstalled = true
    const state = {
      location: { url: () => 'player' },
      playing: {},
      saved: { prefs: { externalPlayerPath: '/usr/bin/vlc' } }
    }

    new MediaController(state).mediaError('boom')
    t.equal(state.playing.location, 'error', 'the player shows the error')
    t.deepEqual(record.os, [['checkForExternalPlayer', '/usr/bin/vlc']],
      'the check goes out with the configured path')

    await flush()
    t.equal(state.modal.id, 'unsupported-media-modal', 'the modal opened')
    t.equal(state.modal.error, 'boom', 'it carries the error')
    t.equal(state.modal.externalPlayerInstalled, true,
      'it carries the shim\'s answer')
    t.deepEqual(record.dispatches, [['update']],
      'and the late answer gets its own render')

    reset()
    externalPlayerInstalled = false
    new MediaController(state).mediaError('boom')
    await flush()
    t.equal(state.modal.externalPlayerInstalled, false,
      'a negative answer comes through too')
    t.end()
  })

test('launching the external player goes through the shim',
  async function (t) {
    reset()
    const state = {
      playing: { fileIndex: 2, fileName: 'a b.mp4' },
      server: { localURL: 'http://localhost:5000' },
      window: { title: 'Some Torrent' },
      saved: { prefs: { externalPlayerPath: '/usr/bin/vlc' } }
    }

    new MediaController(state).openExternalPlayer()
    await flush()
    t.equal(state.playing.location, 'external', 'the player is external')
    t.deepEqual(record.os, [[
      'openExternalPlayer',
      '/usr/bin/vlc',
      'http://localhost:5000/2/a%20b.mp4',
      'Some Torrent'
    ]], 'path, media URL and title are passed through')
    t.deepEqual(record.once, [], 'no wait was needed, the server was up')
    t.end()
  })

// The server-running wait is engine protocol, so it belongs to the
// other shim -- but it must still gate the OS-facing launch call.
test('with no server yet, the player waits for the engine',
  async function (t) {
    reset()
    const state = {
      playing: { fileIndex: 0, fileName: 'x.mp4' },
      server: null,
      window: { title: 'T' },
      saved: { prefs: { externalPlayerPath: '' } }
    }

    new MediaController(state).openExternalPlayer()
    await flush()
    t.deepEqual(record.os, [], 'nothing launched yet')
    t.equal(record.once.length, 1, 'one listener was registered')
    t.equal(record.once[0][0], 'onServerRunningFor', 'on the engine shim')
    t.deepEqual(record.once[0][2], { once: true }, 'as a one-shot')
    t.end()
  })
