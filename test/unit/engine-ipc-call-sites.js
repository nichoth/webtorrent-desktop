const test = require('tape')
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')

// US-032: the four engine-facing controllers, routed through
// `lib/platform/ipc-engine.js`.
//
// `test/unit/platform-boundary.js` proves the `wt-*` channel strings
// are gone from the sources. This file proves the replacements do the
// same work: that each controller method reaches the right shim export
// with the right arguments, that the dynamic `wt-ready-${infoHash}`
// subscription goes through `onTorrentReadyFor` rather than a
// hand-built channel string, and that a rejected shim promise reaches
// `dispatch('error', ...)` rather than floating.
//
// Controllers are excluded from `build:main`, so each one under test is
// compiled here with the repo's own Babel config and emitted into
// `build/renderer/controllers/`, where its `../lib/...` imports resolve
// against the real built `build/renderer/lib/**`. See test/AGENTS.md.

const ROOT = path.join(__dirname, '..', '..')
const RENDERER = path.join(ROOT, 'src', 'renderer')
const BUILT = path.join(ROOT, 'build', 'renderer')
const OUT_DIR = path.join(BUILT, 'controllers')

fs.mkdirSync(OUT_DIR, { recursive: true })

// Two other unit files compile controllers into the same directory, and
// `require.cache` is keyed by path -- whichever file loads first would
// otherwise hand its stubs to the others. Emit under a suffixed name so
// each file gets its own module instance; the directory is what makes
// the controller's `../lib/...` imports resolve, not the file name.
function compile (name) {
  const src = path.join(RENDERER, 'controllers', name)
  const out = path.join(OUT_DIR, name.replace(/\.js$/, '.engine-test.js'))
  fs.writeFileSync(
    out, babel.transformFileSync(src, { root: ROOT, cwd: ROOT }).code
  )
  return out
}

const TORRENT = compile('torrent-controller.js')
const LIST = compile('torrent-list-controller.js')
const PLAYBACK = compile('playback-controller.js')
const MEDIA = compile('media-controller.js')

// Recording state. Every stub below is a stable object reading from
// here, because Babel binds each stub's `exports` object once
// (test/AGENTS.md).
let record = null

// When set, every recorded shim call rejects with this instead of
// resolving, so the error path can be exercised.
let rejectWith = null

const { setDispatch } = require(path.join(BUILT, 'lib', 'dispatcher'))

function reset () {
  record = {
    engine: [], listeners: [], unsubscribed: [], dispatches: [], os: []
  }
  rejectWith = null
  // `lib/dispatcher` holds one process-wide dispatch; register per test
  // rather than once at require time (test/AGENTS.md).
  setDispatch((...args) => record.dispatches.push(args))
}

// The commands the four controllers are expected to send, and the
// events they subscribe to. Named explicitly rather than proxied, so a
// controller reaching for an export that does not exist fails loudly.
const ENGINE_COMMANDS = [
  'setGlobalTrackers',
  'startTorrenting',
  'stopTorrenting',
  'createTorrent',
  'saveTorrentFile',
  'generateTorrentPoster',
  'getAudioMetadata',
  'startServer',
  'stopServer',
  'selectFiles'
]

const ENGINE_LISTENERS = ['onTorrentReadyFor', 'onServerRunning']

const ipcEngineStub = { __esModule: true }

for (const name of ENGINE_COMMANDS) {
  ipcEngineStub[name] = async (...args) => {
    record.engine.push([name, ...args])
    if (rejectWith) throw rejectWith
  }
}

for (const name of ENGINE_LISTENERS) {
  ipcEngineStub[name] = async (...args) => {
    const listener = args.find((a) => typeof a === 'function')
    const rest = args.filter((a) => typeof a !== 'function')
    record.listeners.push({ name, args: rest, listener })
    if (rejectWith) throw rejectWith
    return () => record.unsubscribed.push(name)
  }
}

// `require.cache` is process-wide and `tape test/unit/*.js` is one
// process, so a stub left in place is a stub the next file inherits --
// `platform-ipc-engine.js` tests the real module. Each stub therefore
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

stub(path.join(BUILT, 'lib', 'platform', 'ipc-engine'), ipcEngineStub)

// The OS shim is not under test here; record its calls so they can be
// told apart from the engine ones.
const ipcOsStub = new Proxy({ __esModule: true }, {
  get (target, name) {
    if (name in target) return target[name]
    if (typeof name !== 'string') return undefined
    return async (...args) => { record.os.push([name, ...args]) }
  }
})

stub(path.join(BUILT, 'lib', 'platform', 'ipc-os'), ipcOsStub)

// The rest of the shim is inert here. Stubbing these rather than
// letting them load keeps the real `electron` / `@electron/remote` out
// of the picture entirely -- `@electron/remote` throws outside Electron,
// and a real built shim module loaded here would bind *this* file's
// `electron` stub for the whole run, breaking `platform-clipboard.js`
// and friends further down the glob (test/AGENTS.md).
for (const name of ['clipboard', 'dialog', 'fs', 'menu', 'shell']) {
  stub(path.join(BUILT, 'lib', 'platform', name), new Proxy(
    { __esModule: true },
    {
      get (target, prop) {
        if (prop in target) return target[prop]
        if (typeof prop !== 'string') return undefined
        return async (...args) => { record.os.push([name + '.' + prop, ...args]) }
      }
    }
  ))
}

// `playback-controller` imports `lib/state`, which pulls in
// `lib/migrations` -- and loading either here would bind this file's
// stubs into them for the whole run, which is exactly what
// `test/unit/migrations.js` then tests against.
stub(path.join(BUILT, 'lib', 'state'), {
  __esModule: true,
  default: { getDefaultPlayState: () => ({}) }
})

const TorrentController = require(TORRENT).default
const TorrentListController = require(LIST).default
const PlaybackController = require(PLAYBACK).default
const MediaController = require(MEDIA).default

for (const restore of undo) restore()

// A promise that settles after the shim's own microtasks have run.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

// -- Static check: every member resolves to a real export ------------

function exportsOfShim () {
  const source = fs.readFileSync(
    path.join(RENDERER, 'lib', 'platform', 'ipc-engine.js'), 'utf8')
  return new Set(
    [...source.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)]
      .map((m) => m[1])
  )
}

const CONTROLLERS = [
  'torrent-controller.js',
  'torrent-list-controller.js',
  'playback-controller.js',
  'media-controller.js'
]

test('every ipcEngine member the controllers use exists', function (t) {
  const available = exportsOfShim()
  const used = new Set()
  for (const name of CONTROLLERS) {
    const source = fs.readFileSync(
      path.join(RENDERER, 'controllers', name), 'utf8')
    for (const m of source.matchAll(/\bipcEngine\.(\w+)/g)) used.add(m[1])
  }
  t.ok(used.size > 0, 'the controllers use the engine shim')
  t.deepEqual([...used].filter((name) => !available.has(name)).sort(), [],
    'every ipcEngine.x resolves to an export of ipc-engine.js')
  t.end()
})

// -- torrent-controller ----------------------------------------------

test('a duplicate torrent is stopped through the shim',
  async function (t) {
    reset()
    const state = { saved: { torrents: [{ infoHash: 'abc' }] } }
    new TorrentController(state).torrentParsed('key1', 'abc', 'magnet:?x')
    await flush()
    t.deepEqual(record.engine, [['stopTorrenting', 'abc']],
      'the duplicate goes out as stopTorrenting')
    t.deepEqual(record.dispatches, [['error', 'Cannot add duplicate torrent']],
      'and the user is told')
    t.end()
  })

test('new metadata asks the engine to save the file and the poster',
  async function (t) {
    reset()
    const summary = { torrentKey: 'key1', status: 'new' }
    const state = { saved: { torrents: [summary] } }
    new TorrentController(state)
      .torrentMetadata('key1', { name: 'n', path: '/tmp/dl', files: [] })
    await flush()
    t.deepEqual(record.engine, [
      ['saveTorrentFile', 'key1'],
      ['generateTorrentPoster', 'key1']
    ], 'both requests go through the shim')
    t.end()
  })

// -- torrent-list-controller -----------------------------------------

test('adding a torrent starts it through the shim', async function (t) {
  reset()
  const state = {
    nextTorrentKey: 7,
    saved: { prefs: { downloadPath: '/tmp/dl' } }
  }
  new TorrentListController(state).addTorrent('  magnet:?xt=x  ')
  await flush()
  t.deepEqual(record.engine,
    [['startTorrenting', 7, 'magnet:?xt=x', '/tmp/dl']],
    'key, id and path are passed through')
  t.end()
})

test('creating a torrent goes through the shim', async function (t) {
  reset()
  let cancelled = false
  const state = {
    nextTorrentKey: 3,
    location: { cancel () { cancelled = true } }
  }
  new TorrentListController(state).createTorrent({ files: [] })
  await flush()
  t.deepEqual(record.engine, [['createTorrent', 3, { files: [] }]],
    'key and options are passed through')
  t.ok(cancelled, 'and the create-torrent page is dismissed')
  t.end()
})

test('resuming a summary passes modtimes and selections',
  async function (t) {
    reset()
    const summary = {
      torrentKey: 'k',
      infoHash: 'abc',
      magnetURI: 'magnet:?xt=abc',
      path: '/tmp/dl',
      fileModtimes: { 'a.mp4': 1 },
      selections: [true]
    }
    const state = { saved: { torrents: [summary], prefs: {} } }
    new TorrentListController(state).startTorrentingSummary('k')
    await flush()
    t.equal(record.engine.length, 1, 'one command went out')
    t.equal(record.engine[0][0], 'startTorrenting', 'it is startTorrenting')
    t.deepEqual(record.engine[0].slice(3),
      ['/tmp/dl', { 'a.mp4': 1 }, [true]],
      'path, modtimes and selections all survive')
    t.end()
  })

test('trackers, pausing and file selection go through the shim',
  async function (t) {
    reset()
    const summary = {
      torrentKey: 'k',
      infoHash: 'abc',
      status: 'downloading',
      selections: [true, false]
    }
    const state = { saved: { torrents: [summary], prefs: {} } }
    const controller = new TorrentListController(state)

    controller.setGlobalTrackers(['udp://one'])
    await flush()
    t.deepEqual(record.engine, [['setGlobalTrackers', ['udp://one']]],
      'the tracker list goes out')

    reset()
    controller.pauseTorrent(summary, false)
    await flush()
    t.deepEqual(record.engine, [['stopTorrenting', 'abc']],
      'pausing stops the torrent')

    reset()
    summary.status = 'downloading'
    controller.toggleTorrentFile('abc', 1)
    await flush()
    t.deepEqual(record.engine, [['selectFiles', 'abc', [true, true]]],
      'the new selection goes out')
    t.end()
  })

test('a rejected engine promise is reported, not left floating',
  async function (t) {
    reset()
    rejectWith = new Error('no engine')
    new TorrentListController({
      nextTorrentKey: 1,
      saved: { prefs: {} }
    }).addTorrent('magnet:?xt=x')
    await flush()
    t.deepEqual(record.dispatches.filter((d) => d[0] === 'error'),
      [['error', rejectWith]], 'the rejection became dispatch(error)')
    reset()
    t.end()
  })

// -- playback-controller ---------------------------------------------

test('a running torrent starts its server through the shim',
  async function (t) {
    reset()
    const state = { playing: {} }
    new PlaybackController(state).startServer({
      infoHash: 'abc', torrentKey: 'k', status: 'downloading'
    })
    await flush()
    t.deepEqual(record.engine, [['startServer', 'abc']],
      'the server request goes out')
    t.deepEqual(record.listeners.map((l) => l.name), ['onServerRunning'],
      'and one server listener was registered')
    record.listeners[0].listener({})
    t.equal(state.playing.isReady, true, 'the reply marks playback ready')
    t.end()
  })

// The dynamic `wt-ready-${infoHash}` channel: the controller must pass
// the info hash to the shim, never build the channel string itself.
test('a paused torrent waits on the dynamic ready channel',
  async function (t) {
    reset()
    const state = { playing: {} }
    new PlaybackController(state).startServer({
      infoHash: 'abc', torrentKey: 'k', status: 'paused'
    })
    await flush()
    t.deepEqual(record.engine, [], 'nothing started yet')
    t.deepEqual(record.dispatches, [['startTorrentingSummary', 'k']],
      'the torrent is resumed first')
    t.equal(record.listeners.length, 1, 'one listener was registered')
    t.equal(record.listeners[0].name, 'onTorrentReadyFor',
      'through the dynamic-channel API')
    t.deepEqual(record.listeners[0].args, ['abc', { once: true }],
      'addressed by info hash, one-shot')

    record.listeners[0].listener('k', {})
    await flush()
    t.deepEqual(record.engine, [['startServer', 'abc']],
      'the ready event starts the server')
    t.end()
  })

test('closing the player stops the server through the shim',
  async function (t) {
    reset()
    const state = {
      playing: { location: 'local', volume: 1 },
      window: { isFullScreen: false, bounds: null },
      saved: { prefs: {} }
    }
    new PlaybackController(state, {}, () => {}).closePlayer()
    await flush()
    t.deepEqual(record.engine, [['stopServer']],
      'the server is stopped through the shim')
    t.end()
  })

// -- media-controller ------------------------------------------------

test('with no server yet, the external player waits through the shim',
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
    t.equal(record.listeners.length, 1, 'one listener was registered')
    t.equal(record.listeners[0].name, 'onServerRunning',
      'on the engine shim, not ipcRenderer')
    t.deepEqual(record.listeners[0].args, [{ once: true }], 'one-shot')
    t.end()
  })
