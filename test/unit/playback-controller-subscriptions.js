const test = require('tape')
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')

// A play arms one-shot engine subscriptions ("torrent ready", "server
// running", and the audio-metadata wait deferred until ready). Closing
// the player has to withdraw every one of them, a delivery that races
// the close must not reach the next play, and the player releases a
// server hold only if this play took one -- otherwise it would release
// a poster job's.
//
// Compiled and emitted under a suffix of its own, for the reasons given
// in test/AGENTS.md and `media-controller-playability.js`.

const ROOT = path.join(__dirname, '..', '..')
const SRC = path.join(
  ROOT, 'src', 'renderer', 'controllers', 'playback-controller.js'
)
const BUILT = path.join(ROOT, 'build', 'renderer')
const OUT_DIR = path.join(BUILT, 'controllers')
const OUT = path.join(OUT_DIR, 'playback-controller.subscriptions-test.js')

fs.mkdirSync(OUT_DIR, { recursive: true })
fs.writeFileSync(
  OUT, babel.transformFileSync(SRC, { root: ROOT, cwd: ROOT }).code
)

const { setDispatch } = require(path.join(BUILT, 'lib', 'dispatcher'))

let record = null

function reset () {
  // `hold` keeps each subscription's promise pending until `answer()`,
  // which models a close that arrives before the shim has answered.
  record = {
    engine: [], live: [], dispatches: [], hold: false, pending: []
  }
  setDispatch((...args) => record.dispatches.push(args))
}

function answer () {
  record.pending.splice(0).forEach((resolve) => resolve())
}

function subscribe (name) {
  return (infoHash, listener) => {
    const sub = { name, infoHash, listener }
    record.live.push(sub)
    const unsubscribe = () => {
      record.live = record.live.filter((s) => s !== sub)
    }
    if (!record.hold) return Promise.resolve(unsubscribe)
    return new Promise((resolve) => {
      record.pending.push(() => resolve(unsubscribe))
    })
  }
}

function command (name) {
  return async (...args) => { record.engine.push([name, ...args]) }
}

function inert () {
  return new Proxy({ __esModule: true }, {
    get (target, prop) {
      if (prop in target) return target[prop]
      if (typeof prop !== 'string') return undefined
      return async () => {}
    }
  })
}

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

const LIB = path.join(BUILT, 'lib')

stub(path.join(LIB, 'platform', 'ipc-engine'), {
  __esModule: true,
  onTorrentReadyFor: subscribe('onTorrentReadyFor'),
  onServerRunningFor: subscribe('onServerRunningFor'),
  startServer: command('startServer'),
  stopServer: command('stopServer'),
  getAudioMetadata: command('getAudioMetadata')
})

// Everything else the controller graph reaches is stubbed rather than
// loaded, so no real shim or `config` binds this file's stubs for the
// rest of the run (test/AGENTS.md).
for (const name of ['ipc-os', 'cast', 'shell']) {
  stub(path.join(LIB, 'platform', name), inert())
}
stub(path.join(LIB, 'sound'), { __esModule: true, play () {} })
stub(path.join(LIB, 'cast-mirror'), {
  __esModule: true, canSetRate: () => false
})
stub(path.join(LIB, 'torrent-summary'), {
  __esModule: true,
  getByKey: (state, key) => state.saved.torrents.find(
    (t) => t.infoHash === key || t.torrentKey === key)
})
stub(path.join(LIB, 'playlist'), {
  __esModule: true,
  hasNext: () => true,
  hasPrevious: () => true,
  getNextIndex: (state) => state.playing.fileIndex + 1,
  getPreviousIndex: (state) => state.playing.fileIndex - 1
})
stub(path.join(LIB, 'state'), {
  __esModule: true,
  default: { getDefaultPlayState: () => ({ location: 'local' }) }
})

const PlaybackController = require(OUT).default

for (const restore of undo) restore()

const INFO_HASH = 'a'.repeat(40)

function makeState (status) {
  return {
    playing: { location: 'local', volume: 1 },
    server: null,
    location: { url: () => 'player' },
    window: { isFullScreen: false, bounds: null, title: '' },
    saved: {
      prefs: {},
      torrents: [{
        infoHash: INFO_HASH,
        torrentKey: 1,
        status,
        files: [
          { name: 'one.mp3' }, { name: 'two.mp3' }, { name: 'three.mp3' }
        ]
      }]
    }
  }
}

function open (state, index = 1) {
  const controller = new PlaybackController(state, {}, () => {})
  controller.openPlayer(INFO_HASH, index, () => {})
  return controller
}

function sent (name) {
  return record.engine.filter((args) => args[0] === name)
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

test('closing a paused play withdraws its waits', async function (t) {
  reset()
  const state = makeState('paused')
  const controller = open(state)
  await flush()
  t.ok(record.live.length > 0, 'the play is waiting on the engine')

  controller.closePlayer()
  await flush()
  t.deepEqual(record.live, [], 'no subscription is left')
  t.end()
})

test('closing before the shim answers still withdraws the waits',
  async function (t) {
    reset()
    record.hold = true
    const state = makeState('paused')
    const controller = open(state)
    controller.closePlayer()

    answer()
    await flush()
    t.deepEqual(record.live, [], 'the late unsubscribes are called')
    t.end()
  })

test('a next or previous file change is withdrawn on close too',
  async function (t) {
    reset()
    const state = makeState('paused')
    const controller = open(state)
    controller.nextTrack()
    controller.previousTrack()
    await flush()

    controller.closePlayer()
    await flush()
    t.deepEqual(record.live, [], 'no subscription is left')
    t.end()
  })

test('closing a running play withdraws its server wait',
  async function (t) {
    reset()
    const state = makeState('downloading')
    const controller = open(state)
    await flush()
    t.equal(record.live.length, 1, 'the play waits for its server')

    controller.closePlayer()
    await flush()
    t.deepEqual(record.live, [], 'no subscription is left')
    t.end()
  })

test('a ready delivery after close starts no server', async function (t) {
  reset()
  record.hold = true
  const state = makeState('paused')
  const controller = open(state)
  const waits = record.live.slice()
  controller.closePlayer()
  const next = state.playing

  // The delivery races the withdrawal: it lands before the shim has
  // handed back the unsubscribe.
  waits.forEach((sub) => sub.listener(INFO_HASH, {}))
  answer()
  await flush()

  t.deepEqual(sent('startServer'), [], 'no server is requested')
  t.deepEqual(sent('getAudioMetadata'), [], 'no metadata is requested')
  t.equal(state.playing, next, 'the play state is not replaced')
  t.deepEqual(next, { location: 'local' }, 'and not written to')
  t.end()
})

test('a server-running delivery after close changes nothing',
  async function (t) {
    reset()
    record.hold = true
    const state = makeState('downloading')
    const controller = open(state)
    const waits = record.live.slice()
    controller.closePlayer()
    const next = state.playing

    waits.forEach((sub) => sub.listener({ localURL: 'http://localhost:1' }))
    answer()
    await flush()

    t.deepEqual(next, { location: 'local' }, 'the next play is untouched')
    t.end()
  })

test('a server-running delivery during the play marks it ready',
  async function (t) {
    reset()
    const state = makeState('downloading')
    open(state)
    await flush()

    record.live[0].listener({ localURL: 'http://localhost:1' })
    t.equal(state.playing.isReady, true, 'the play is ready')
    t.end()
  })

test('closing a play that never started a server stops none',
  async function (t) {
    reset()
    const state = makeState('paused')
    const controller = open(state)
    await flush()

    controller.closePlayer()
    await flush()
    t.deepEqual(sent('startServer'), [], 'no server was started')
    t.deepEqual(sent('stopServer'), [], 'so none is stopped')
    t.end()
  })

test('closing a play that started a server stops it once',
  async function (t) {
    reset()
    const state = makeState('downloading')
    const controller = open(state)
    await flush()

    controller.closePlayer()
    await flush()
    t.deepEqual(sent('stopServer'), [['stopServer', INFO_HASH]],
      'its hold is released by info hash')
    t.end()
  })

test('a paused play that became ready stops the server it started',
  async function (t) {
    reset()
    const state = makeState('paused')
    const controller = open(state)
    await flush()

    record.live
      .filter((sub) => sub.name === 'onTorrentReadyFor')
      .forEach((sub) => sub.listener(INFO_HASH, {}))
    await flush()
    t.deepEqual(sent('startServer'), [['startServer', INFO_HASH]],
      'the ready event starts the server')

    controller.closePlayer()
    await flush()
    t.deepEqual(sent('stopServer'), [['stopServer', INFO_HASH]],
      'and closing releases it')
    t.end()
  })

// `location-history` calls a page's `destroy` only once its setup has
// succeeded, so a play whose setup fails never reaches `closePlayer`.
// Such a play must not have taken anything `closePlayer` would release.
for (const status of ['downloading', 'paused']) {
  test(`opening an unplayable file (${status}) takes nothing`,
    async function (t) {
      reset()
      const state = makeState(status)
      state.saved.torrents[0].files.push({ name: 'notes.txt' })
      const controller = new PlaybackController(state, {}, () => {})
      let error = null
      controller.openPlayer(INFO_HASH, 3, (err) => { error = err })
      await flush()

      t.ok(error, 'the setup fails')
      t.deepEqual(sent('startServer'), [], 'no server is requested')
      t.deepEqual(record.live, [], 'no subscription is armed')
      t.end()
    })
}

// `playFile` falls back to `findIndex(isPlayable)`, which is -1 for a
// torrent with nothing playable in it.
test('opening a file the torrent does not have takes nothing',
  async function (t) {
    reset()
    const state = makeState('downloading')
    const controller = new PlaybackController(state, {}, () => {})
    let error = null
    controller.openPlayer(INFO_HASH, -1, (err) => { error = err })
    await flush()

    t.ok(error, 'the setup fails')
    t.deepEqual(sent('startServer'), [], 'no server is requested')
    t.deepEqual(record.live, [], 'no subscription is armed')
    t.end()
  })
