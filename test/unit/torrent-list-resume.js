const test = require('tape')
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')

// The resume list (`state.saved.torrentsToResume`): playback priority
// pauses the other active torrents and records them there, and they
// resume when playback ends. A deleted torrent must never be left in
// it, and a stale entry must never break resuming. Deleting also drops
// the dispatcher's memoized handlers, which are keyed by arguments that
// can name the deleted torrent.
//
// Controllers are outside `build:node`, so the controller is compiled
// here and emitted into `build/renderer/controllers/`, where its
// `../lib/...` imports resolve. It is emitted under a `.resume-test.js`
// suffix so it cannot collide with `torrent-context-menu.js`, which
// compiles the same controller with different stubs. See
// test/AGENTS.md.

const ROOT = path.join(__dirname, '..', '..')
const SRC = path.join(
  ROOT, 'src', 'renderer', 'controllers', 'torrent-list-controller.js'
)
const OUT_DIR = path.join(ROOT, 'build', 'renderer', 'controllers')
const OUT = path.join(OUT_DIR, 'torrent-list-controller.resume-test.js')

fs.mkdirSync(OUT_DIR, { recursive: true })
fs.writeFileSync(
  OUT, babel.transformFileSync(SRC, { root: ROOT, cwd: ROOT }).code
)

let record = null

function reset () {
  record = { dispatches: [], engine: [] }
  setDispatch((...args) => record.dispatches.push(args))
}

const BUILT = path.join(ROOT, 'build', 'renderer')
const { setDispatch, dispatcher } = require(
  path.join(BUILT, 'lib', 'dispatcher')
)

// Every shim module the controller imports is stubbed, then withdrawn
// once the controller has bound it, so the real shims stay intact for
// the files that test them later in the run.
const restore = []
function stub (modulePath, exports) {
  const id = require.resolve(modulePath)
  const previous = require.cache[id]
  require.cache[id] = { id, filename: id, loaded: true, exports }
  restore.push(() => {
    if (previous) require.cache[id] = previous
    else delete require.cache[id]
  })
}

const PLATFORM = path.join(BUILT, 'lib', 'platform')
stub(path.join(PLATFORM, 'ipc-engine'), {
  __esModule: true,
  async startTorrenting (...args) {
    record.engine.push(['startTorrenting', ...args])
  },
  async stopTorrenting (...args) {
    record.engine.push(['stopTorrenting', ...args])
  }
})
stub(path.join(PLATFORM, 'fs'), {
  __esModule: true,
  async unlink () {},
  async stat () { return {} }
})
stub(path.join(PLATFORM, 'shell'), {
  __esModule: true,
  async moveItemToTrash () {},
  async showItemInFolder () {}
})
stub(path.join(PLATFORM, 'clipboard'), {
  __esModule: true,
  async writeText () {}
})
stub(path.join(PLATFORM, 'dialog'), { __esModule: true })
stub(path.join(PLATFORM, 'menu'), {
  __esModule: true,
  async showContextMenu () {}
})

const TorrentListController = require(OUT).default
restore.forEach((fn) => fn())

function hash (c) {
  return c.repeat(40)
}

function makeSummary (c, key, status) {
  return {
    torrentKey: key,
    infoHash: hash(c),
    name: 'Torrent ' + c,
    status,
    path: '/tmp/downloads'
  }
}

function makeState (torrents, torrentsToResume = []) {
  return {
    saved: {
      torrents,
      torrentsToResume,
      prefs: { downloadPath: '/tmp/downloads' }
    },
    location: { url: () => 'home', clearForward () {} }
  }
}

test('deleting a torrent removes its info hash from the resume list',
  function (t) {
    reset()
    const state = makeState([
      makeSummary('a', 1, 'paused'),
      makeSummary('b', 2, 'paused')
    ], [hash('a'), hash('b')])
    const controller = new TorrentListController(state)

    controller.deleteTorrent(hash('a'), false)

    t.deepEqual(state.saved.torrentsToResume, [hash('b')],
      'only the remaining torrent is left to resume')
    t.end()
  })

test('deleting all torrents leaves the resume list empty', function (t) {
  reset()
  const state = makeState([
    makeSummary('a', 1, 'paused'),
    makeSummary('b', 2, 'paused')
  ], [hash('a'), hash('b')])
  const controller = new TorrentListController(state)

  controller.deleteAllTorrents(false)

  t.deepEqual(state.saved.torrentsToResume, [], 'nothing is left to resume')
  t.end()
})

test('resuming skips a missing torrent and resumes the rest',
  function (t) {
    reset()
    const a = makeSummary('a', 1, 'paused')
    const c = makeSummary('c', 3, 'paused')
    // 'b' was deleted before this fix, so a saved profile can still
    // name it.
    const state = makeState([a, c], [hash('a'), hash('b'), hash('c')])
    const controller = new TorrentListController(state)

    t.doesNotThrow(() => controller.resumePausedTorrents(),
      'a stale entry does not throw')

    t.deepEqual(
      record.engine
        .filter(([call]) => call === 'startTorrenting')
        .map(([, key]) => key),
      [1, 3],
      'every torrent still in the list is started again')
    t.notEqual(a.status, 'paused', 'the first torrent is no longer paused')
    t.notEqual(c.status, 'paused', 'the last torrent is no longer paused')
    t.deepEqual(state.saved.torrentsToResume, [], 'the list is reset')
    t.end()
  })

test('prioritizing twice records each paused torrent once', function (t) {
  reset()
  const a = makeSummary('a', 1, 'downloading')
  const b = makeSummary('b', 2, 'downloading')
  const state = makeState([a, b])
  const controller = new TorrentListController(state)

  controller.prioritizeTorrent(hash('a'))
  // The user starts 'b' again by hand while 'a' is still playing, then
  // plays 'a' again.
  b.status = 'downloading'
  controller.prioritizeTorrent(hash('a'))

  t.deepEqual(state.saved.torrentsToResume, [hash('b')],
    'the paused torrent is listed once')
  t.equal(b.status, 'paused', 'and it is paused')
  t.end()
})

test('deleting a torrent drops the memoized handlers', function (t) {
  reset()
  const state = makeState([makeSummary('a', 1, 'paused')])
  const controller = new TorrentListController(state)
  const before = dispatcher('toggleSelectTorrent', 1)

  controller.deleteTorrent(hash('a'), false)

  t.notEqual(dispatcher('toggleSelectTorrent', 1), before,
    'the same arguments get a fresh handler')
  t.end()
})

test('deleting all torrents drops the memoized handlers', function (t) {
  reset()
  const state = makeState([makeSummary('a', 1, 'paused')])
  const controller = new TorrentListController(state)
  const before = dispatcher('toggleSelectTorrent', 1)

  controller.deleteAllTorrents(false)

  t.notEqual(dispatcher('toggleSelectTorrent', 1), before,
    'the same arguments get a fresh handler')
  t.end()
})
