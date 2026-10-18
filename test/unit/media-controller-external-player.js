const test = require('tape')
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')

// Opening a file in the external player before the server is up waits
// for "server running". Leaving the player has to cancel that wait, and
// a reply that arrives after leaving must never open the external
// player (it would be handed an empty URL).
//
// Compiled and emitted under a suffix of its own, for the reasons given
// in test/AGENTS.md and `media-controller-playability.js`.

const ROOT = path.join(__dirname, '..', '..')
const SRC = path.join(
  ROOT, 'src', 'renderer', 'controllers', 'media-controller.js'
)
const OUT_DIR = path.join(ROOT, 'build', 'renderer', 'controllers')
const OUT = path.join(OUT_DIR, 'media-controller.external-player-test.js')

fs.mkdirSync(OUT_DIR, { recursive: true })
fs.writeFileSync(
  OUT, babel.transformFileSync(SRC, { root: ROOT, cwd: ROOT }).code
)

const BUILT = path.join(ROOT, 'build', 'renderer')
const { setDispatch } = require(path.join(BUILT, 'lib', 'dispatcher'))

let record = null

function reset () {
  // `subscribed` resolves each subscription; a test that holds it back
  // models a user leaving before the shim has answered.
  record = { dispatches: [], opened: [], live: [], hold: false, pending: [] }
  setDispatch((...args) => record.dispatches.push(args))
}

function stub (modulePath, exports) {
  const id = require.resolve(modulePath)
  const previous = require.cache[id]
  require.cache[id] = { id, filename: id, loaded: true, exports }
  return () => {
    if (previous) require.cache[id] = previous
    else delete require.cache[id]
  }
}

const withdraw = [
  stub(path.join(BUILT, 'lib', 'platform', 'ipc-os'), {
    __esModule: true,
    async checkForExternalPlayer () { return true },
    async openExternalPlayer (playerPath, url, title) {
      record.opened.push(url)
    }
  }),
  stub(path.join(BUILT, 'lib', 'platform', 'ipc-engine'), {
    __esModule: true,
    onServerRunningFor (infoHash, listener) {
      const sub = { infoHash, listener }
      record.live.push(sub)
      const unsubscribe = () => {
        record.live = record.live.filter((s) => s !== sub)
      }
      if (!record.hold) return Promise.resolve(unsubscribe)
      return new Promise((resolve) => {
        record.pending.push(() => resolve(unsubscribe))
      })
    }
  }),
  stub(path.join(BUILT, 'lib', 'playlist'), {
    __esModule: true,
    getCurrentLocalURL: (state) => state.server
      ? state.server.localURL + '/0'
      : ''
  })
]

const MediaController = require(OUT).default

withdraw.forEach((undo) => undo())

const INFO_HASH = 'a'.repeat(40)

function makeState () {
  return {
    playing: { location: 'local', infoHash: INFO_HASH },
    server: null,
    location: { url: () => 'player' },
    saved: { prefs: { externalPlayerPath: '/vlc' } },
    window: { title: 'The Movie' },
    modal: null
  }
}

// What `closePlayer` does to the play state, as far as this controller
// can see.
function leave (state, controller) {
  controller.playerClosed()
  state.playing = { location: 'local' }
  state.server = null
}

function tick () {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

test('the wait is armed while the player is open', async function (t) {
  reset()
  const state = makeState()
  new MediaController(state).openExternalPlayer()
  await tick()

  t.equal(record.live.length, 1, 'one subscription waits for the server')
  t.equal(record.live[0].infoHash, INFO_HASH, 'for the playing torrent')
  t.end()
})

test('leaving the player cancels the external player wait', async function (t) {
  reset()
  const state = makeState()
  const controller = new MediaController(state)
  controller.openExternalPlayer()
  await tick()

  leave(state, controller)
  await tick()

  t.equal(record.live.length, 0, 'no subscription is left armed')
  t.end()
})

test('leaving before the shim answers still cancels the wait',
  async function (t) {
    reset()
    record.hold = true
    const state = makeState()
    const controller = new MediaController(state)
    controller.openExternalPlayer()
    leave(state, controller)

    record.pending.forEach((answer) => answer())
    await tick()

    t.equal(record.live.length, 0, 'the late unsubscribe is called')
    t.end()
  })

test('a server reply after leaving never opens the external player',
  async function (t) {
    reset()
    record.hold = true
    const state = makeState()
    const controller = new MediaController(state)
    controller.openExternalPlayer()
    const [sub] = record.live
    leave(state, controller)

    // The reply races the unsubscribe: it is delivered before the
    // subscription has been withdrawn.
    sub.listener({ localURL: 'http://localhost:1' })
    record.pending.forEach((answer) => answer())
    await tick()

    t.deepEqual(record.opened, [], 'the external player is not opened')
    t.notOk(state.playing.isReady, 'the new play state is not touched')
    t.end()
  })

test('a server reply while the player is open opens it', async function (t) {
  reset()
  const state = makeState()
  new MediaController(state).openExternalPlayer()
  await tick()

  state.server = { localURL: 'http://localhost:1' }
  record.live[0].listener(state.server)
  await tick()

  t.deepEqual(record.opened, ['http://localhost:1/0'],
    'the external player is opened on the server URL')
  t.ok(state.playing.isReady, 'the play is ready')
  t.end()
})
