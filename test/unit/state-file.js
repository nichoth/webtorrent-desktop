const test = require('tape')
const fs = require('fs')
const os = require('os')
const path = require('path')
const applicationConfig = require('application-config')

// US-055: the saved-state file belongs to the renderer. `State.load`
// and `State.saveImmediate` read and write it through
// `lib/platform/fs.js` rather than through `application-config`.
//
// Four halves:
//
//   1. routing -- every read and write of config.json goes through
//      the fs shim, so the Tauri tree can back it (US-060);
//   2. format -- what we write is byte-identical to what
//      `application-config` (write-json-file) wrote, so a config
//      saved by the current version loads unchanged;
//   3. migrations -- they run on a fresh profile and on an existing
//      one, with no `process.type` test in the way.
//
// There was a fourth: the Electron main process read the same file for
// itself, read-only, in `src/main/saved-state.js`. US-072 deleted the
// main process, and the Rust host reads its window bounds through
// `src-tauri/src/window.rs`, so that half of the story is asserted in
// `tauri-host.js` now.

const ROOT = path.join(__dirname, '..', '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-state-'))

// `require.cache` is process-wide and `migrations.js` seeds the built
// config with a temp-dir copy of its own, so each stub below is put in
// place only for the one `require()` that has to bind it and the
// previous entry is put straight back.
function withConfig (CONFIG, fn) {
  const configPath = require.resolve('../../build/config')
  const previous = require.cache[configPath]
  require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: { __esModule: true, default: CONFIG, ...CONFIG }
  }
  try {
    return fn()
  } finally {
    if (previous) require.cache[configPath] = previous
    else delete require.cache[configPath]
  }
}

// --- the renderer's state module -------------------------------------

const RENDERER_CONFIG = {
  APP_VERSION: '9.9.9',
  APP_WINDOW_TITLE: 'WebTorrent',
  CONFIG_PATH: path.join(TMP, 'Config'),
  DEFAULT_DOWNLOAD_PATH: path.join(TMP, 'Downloads'),
  DEFAULT_TORRENTS: [{
    testID: 'bbb',
    name: 'Big Buck Bunny',
    posterFileName: 'bigBuckBunny.jpg',
    torrentFileName: 'bigBuckBunny.torrent'
  }],
  POSTER_PATH: path.join(TMP, 'Posters'),
  STATIC_PATH: path.join(ROOT, 'static'),
  TORRENT_PATH: path.join(TMP, 'Torrents')
}

const STATE_FILE = path.join(RENDERER_CONFIG.CONFIG_PATH, 'config.json')

// A recording wrapper around a filesystem-backed stand-in for the
// shim, so the assertions are about real filesystem behaviour and
// about the routing at the same time. Anything reaching for `fs`
// directly leaves no trace here.
//
// It was the real shim until US-072, when the shim became nine Tauri
// commands and stopped having a filesystem under it outside a running
// host. `test/fs-shim.js` holds the contract those commands answer,
// and `platform-fs.js` is what holds the shim to it.
const shimPath = require.resolve('../../build/renderer/lib/platform/fs')
const backing = require('../fs-shim')
const shimCalls = []
const recordingShim = { __esModule: true }
for (const name of Object.keys(backing)) {
  if (typeof backing[name] !== 'function') continue
  recordingShim[name] = async (...args) => {
    shimCalls.push([name, ...args])
    return await backing[name](...args)
  }
}

const previousShim = require.cache[shimPath]
require.cache[shimPath] = {
  id: shimPath,
  filename: shimPath,
  loaded: true,
  exports: recordingShim
}

const State = withConfig(
  RENDERER_CONFIG,
  () => require('../../build/renderer/lib/state').default
)

// Withdrawn now that `state` has bound it: `platform-fs.js` later in
// the same run tests the real module at this path.
if (previousShim) require.cache[shimPath] = previousShim
else delete require.cache[shimPath]

function load () {
  return new Promise((resolve, reject) => {
    State.load((err, state) => err ? reject(err) : resolve(state))
  })
}

function calls (name) {
  return shimCalls.filter((call) => call[0] === name)
}

function readState () {
  return fs.readFileSync(STATE_FILE, 'utf8')
}

test('load() creates a fresh profile through the fs shim', async (t) => {
  fs.rmSync(RENDERER_CONFIG.CONFIG_PATH, { recursive: true, force: true })
  fs.rmSync(RENDERER_CONFIG.POSTER_PATH, { recursive: true, force: true })
  fs.rmSync(RENDERER_CONFIG.TORRENT_PATH, { recursive: true, force: true })
  shimCalls.length = 0

  const state = await load()

  t.ok(
    calls('readFile').some(([, p]) => p === STATE_FILE),
    'the missing config file was looked for through the shim'
  )
  t.deepEqual(
    calls('mkdir').map(([, p]) => p).sort(),
    [RENDERER_CONFIG.POSTER_PATH, RENDERER_CONFIG.TORRENT_PATH].sort(),
    'the profile directories were created through the shim'
  )
  t.equal(
    state.saved.prefs.downloadPath,
    RENDERER_CONFIG.DEFAULT_DOWNLOAD_PATH,
    'the default prefs are in place'
  )
  t.equal(state.saved.torrents.length, 1, 'the default torrent was added')
  t.equal(
    fs.readdirSync(RENDERER_CONFIG.POSTER_PATH).length, 1,
    'its poster was copied into the profile'
  )
  t.equal(
    fs.readdirSync(RENDERER_CONFIG.TORRENT_PATH).length, 1,
    'its torrent file was copied into the profile'
  )
  t.equal(
    state.saved.version, RENDERER_CONFIG.APP_VERSION,
    'migrations ran and left the config on the current version'
  )
  t.end()
})

test('load() migrates an existing profile', async (t) => {
  fs.mkdirSync(RENDERER_CONFIG.CONFIG_PATH, { recursive: true })
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    version: '0.22.0',
    prefs: { isFileHandler: false, downloadPath: '/tmp/downloads' },
    torrents: [{ infoHash: 'abc', name: 'Old' }]
  }))
  shimCalls.length = 0

  const state = await load()

  t.ok(
    calls('readFile').some(([, p]) => p === STATE_FILE),
    'the config file was read through the shim'
  )
  t.equal(
    state.saved.prefs.downloadPath, '/tmp/downloads',
    'the saved prefs survived the load'
  )
  t.equal(state.saved.torrents.length, 1, 'the saved torrent survived')
  t.notEqual(
    state.saved.version, '0.22.0',
    'migrations ran, with no process.type test in the way'
  )
  t.end()
})

test('saveImmediate() writes through the shim', async (t) => {
  fs.rmSync(RENDERER_CONFIG.CONFIG_PATH, { recursive: true, force: true })
  shimCalls.length = 0

  const saved = {
    version: '9.9.9',
    prefs: { downloadPath: '/tmp/downloads' },
    torrents: [
      { infoHash: 'abc', name: 'Keep', progress: 0.5, torrentKey: 3, error: 'x' },
      { name: 'Pending, no infoHash' }
    ]
  }

  const emitted = []
  State.on('stateSaved', () => emitted.push(true))
  await State.saveImmediate({ saved })

  t.ok(
    calls('mkdir').some(([, p]) => p === RENDERER_CONFIG.CONFIG_PATH),
    'the config directory was created through the shim'
  )
  t.ok(
    calls('writeFile').some(([, p]) => p === STATE_FILE),
    'the config file was written through the shim'
  )
  t.equal(emitted.length, 1, 'stateSaved was emitted')

  const written = JSON.parse(readState())
  t.equal(written.torrents.length, 1, 'the torrent with no infoHash was dropped')
  t.deepEqual(
    written.torrents[0], { infoHash: 'abc', name: 'Keep' },
    'progress, torrentKey and error were not saved'
  )
  t.deepEqual(written.prefs, saved.prefs, 'the prefs were saved')
  t.end()
})

test('saveImmediate() writes the format application-config wrote', async (t) => {
  fs.rmSync(RENDERER_CONFIG.CONFIG_PATH, { recursive: true, force: true })

  const saved = {
    version: '9.9.9',
    prefs: { downloadPath: '/tmp/downloads', globalTrackers: ['a', 'b'] },
    torrents: [{ infoHash: 'abc', name: 'Keep', files: [{ path: 'a/b.mp4' }] }],
    torrentsToResume: []
  }
  await State.saveImmediate({ saved })

  // The reference: what `application-config` -- which is still a
  // direct dependency, for `src/config.js` -- would have written for
  // the same object.
  const reference = applicationConfig('WebTorrent')
  reference.filePath = path.join(TMP, 'reference.json')
  await reference.write(saved)

  t.equal(
    readState(),
    fs.readFileSync(reference.filePath, 'utf8'),
    'the file is byte-identical to the one the old writer produced'
  )
  t.end()
})

test('a config written by application-config loads unchanged', async (t) => {
  fs.rmSync(RENDERER_CONFIG.CONFIG_PATH, { recursive: true, force: true })

  const saved = {
    version: '9.9.9',
    prefs: { downloadPath: '/tmp/downloads', isFileHandler: false },
    torrents: [{ infoHash: 'abc', name: 'Keep' }],
    torrentsToResume: []
  }
  const writer = applicationConfig('WebTorrent')
  writer.filePath = STATE_FILE
  await writer.write(saved)

  const state = await load()

  t.deepEqual(state.saved, saved, 'the saved state round-trips')
  t.end()
})

// --- source scans ----------------------------------------------------

// Comment lines are dropped before matching: a file that *explains*
// what it no longer does must not fail its own check.
function codeLines (rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => !/^(\/\/|\*|\/\*)/.test(line))
}

function hits (rel, re) {
  return codeLines(rel)
    .filter(({ line }) => re.test(line))
    .map(({ line, n }) => rel + ':' + n + ': ' + line)
}

test('lib/state.js writes only through the shim', (t) => {
  t.deepEqual(
    hits('src/renderer/lib/state.js', /application-config/), [],
    'application-config is gone from lib/state.js'
  )
  t.deepEqual(
    hits('src/renderer/lib/state.js', /process\.type/), [],
    'the process.type test around migrations is gone'
  )
  t.end()
})
