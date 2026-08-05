const test = require('tape')
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')

// US-079: the cast call sites, routed through `lib/platform/cast.js`.
//
// `test/unit/platform-boundary.js` proves `src/renderer/lib/cast.js`
// and its three npm packages are gone from the sources, and
// `test/unit/cast-mirror.js` covers the folds that survived it. This
// file proves the wiring in between: that `controllers/cast-
// controller.js` drives a session through the shim and writes the
// state `player-page.js` reads, and that the five commands
// `playback-controller.js` used to send straight to `Cast.*` now go to
// the shim -- and only while a device is actually connected.
//
// Nothing here needs a receiver on the network. The shim is stubbed,
// so what is asserted is the command, its arguments and the state
// either side of it; the protocols themselves are host code, covered
// by US-076 to US-078 and the manual pass.
//
// Controllers are excluded from `build:main`, so each one under test is
// compiled here with the repo's own Babel config and emitted into
// `build/renderer/controllers/`, where its `../lib/...` imports resolve
// against the real built `build/renderer/lib/**`. See test/AGENTS.md.

const ROOT = path.join(__dirname, '..', '..')
const BUILT = path.join(ROOT, 'build', 'renderer')
const OUT_DIR = path.join(BUILT, 'controllers')

fs.mkdirSync(OUT_DIR, { recursive: true })

// Three unit files compile controllers into this directory and
// `require.cache` is keyed by path, so whichever loaded first would
// otherwise hand its stubs to the others. Emit under a suffixed name
// so each file gets its own module instance; the directory is what
// makes the controller's `../lib/...` imports resolve, not the name.
function compile (name) {
  const src = path.join(ROOT, 'src', 'renderer', 'controllers', name)
  const out = path.join(OUT_DIR, name.replace(/\.js$/, '.cast-test.js'))
  fs.writeFileSync(
    out, babel.transformFileSync(src, { root: ROOT, cwd: ROOT }).code
  )
  return out
}

const CAST = compile('cast-controller.js')
const PLAYBACK = compile('playback-controller.js')

// Recording state. Every stub below is a stable object reading from
// here, because Babel binds each stub's `exports` object once
// (test/AGENTS.md).
let record = null

// When set, every recorded cast call rejects with this instead of
// resolving, so the error path can be exercised.
let rejectWith = null

const { setDispatch } = require(path.join(BUILT, 'lib', 'dispatcher'))
const { CastingError } = require(path.join(BUILT, 'lib', 'errors'))
const CastMirror = require(path.join(BUILT, 'lib', 'cast-mirror'))

function reset () {
  record = { cast: [], listeners: {}, dispatches: [], os: [], updates: 0 }
  rejectWith = null
  // `lib/dispatcher` holds one process-wide dispatch and every unit
  // file that requires it registers its own. Re-register per test
  // rather than once at require time, or whichever file loads last
  // wins for the whole run.
  setDispatch((...args) => record.dispatches.push(args))
}

// The cast shim, recorded. Named explicitly rather than proxied, so a
// controller reaching for an export that does not exist fails loudly.
const CAST_COMMANDS = [
  'startDiscovery', 'stopDiscovery', 'connect', 'play', 'pause', 'stop',
  'seek', 'setVolume', 'setRate'
]

const castStub = { __esModule: true }

for (const name of CAST_COMMANDS) {
  castStub[name] = async (...args) => {
    record.cast.push([name, ...args])
    if (rejectWith) throw rejectWith
  }
}

// The two request/response exports. `getDevices` answers from here so
// a test can say what the host already found; nothing calls
// `getStatus` -- the controller takes its status from the event stream
// -- but it is stubbed rather than left out, so a caller that appears
// records a call instead of throwing on `undefined`.
let hostDevices = []
const hostStatus = {}

castStub.getDevices = async () => {
  record.cast.push(['getDevices'])
  if (rejectWith) throw rejectWith
  return hostDevices
}

castStub.getStatus = async () => {
  record.cast.push(['getStatus'])
  if (rejectWith) throw rejectWith
  return hostStatus
}

// The three event streams. Each records the listener so a test can
// push a host event through it, and resolves to an unsubscribe like
// the real module does.
for (const [name, event] of [
  ['onDevices', 'castDevices'],
  ['onStatus', 'castStatus'],
  ['onError', 'castError']
]) {
  castStub[name] = async (listener) => {
    record.cast.push([name])
    record.listeners[event] = listener
    if (rejectWith) throw rejectWith
    return () => record.cast.push(['unsubscribe', event])
  }
}

// `require.cache` is process-wide and `tape test/unit/*.js` is one
// process, so a stub left in place is a stub the next file inherits --
// `platform-cast.js` tests the real module. Each stub therefore
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

stub(path.join(BUILT, 'lib', 'platform', 'cast'), castStub)

// The rest of the shim is inert here. Stubbing rather than letting it
// load keeps the real `electron` / `@electron/remote` out of the
// picture entirely, and stops this file's stubs being bound into a
// real shim module for the whole run (test/AGENTS.md).
for (const name of ['ipc-engine', 'ipc-os', 'shell']) {
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
// stubs into them for the whole run, which is what
// `test/unit/migrations.js` then tests against.
stub(path.join(BUILT, 'lib', 'state'), {
  __esModule: true,
  default: { getDefaultPlayState: () => ({ location: 'local' }) }
})

const CastController = require(CAST).default
const PlaybackController = require(PLAYBACK).default

for (const fn of undo) fn()

function device (id, protocol, capabilities) {
  return { id, protocol, name: id + '-name', capabilities }
}

// A state with the fields the two controllers touch, and nothing else.
function makeState (devices) {
  return {
    devices: CastMirror.mirrorDevices(devices || [], {}),
    errors: [],
    playing: {
      location: 'local',
      infoHash: 'abc',
      fileIndex: 0,
      currentTime: 0,
      volume: 1,
      isPaused: true,
      playbackRate: 1,
      subtitles: { selectedIndex: -1, tracks: [] }
    },
    server: { networkURL: 'http://10.0.0.2:8080' },
    saved: { torrents: [{ infoHash: 'abc', name: 'Sintel' }], prefs: {} },
    window: { isFullScreen: false, bounds: null }
  }
}

function castController (state) {
  return new CastController(state, () => { record.updates++ })
}

function playbackController (state) {
  return new PlaybackController(state, {}, () => { record.updates++ })
}

// Everything the controllers do is `reportErrors(promise)`, so the
// assertions come one microtask turn after the call.
function settled () {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function commands () {
  return record.cast.map((c) => c[0])
}

test('start() listens before it looks, then seeds from the host',
  async function (t) {
    reset()
    hostDevices = [device('a', 'chromecast')]
    const state = makeState()
    castController(state).start()
    await settled()

    const names = commands()
    t.deepEqual(names.slice(0, 3).sort(),
      ['onDevices', 'onError', 'onStatus'],
      'all three streams are subscribed first')
    t.deepEqual(names.slice(3), ['startDiscovery', 'getDevices'],
      'and only then is the network scanned')
    t.deepEqual(state.devices.chromecast.getDevices().map((d) => d.id), ['a'],
      'a device the host already knew about is not missed')
    t.end()
  })

test('discovery starts once however often start() is called',
  async function (t) {
    reset()
    hostDevices = []
    const controller = castController(makeState())
    controller.start()
    controller.start()
    await settled()

    t.equal(commands().filter((c) => c === 'startDiscovery').length, 1,
      'the second call is a no-op')
    t.end()
  })

test('a device event from the host rebuilds the mirror',
  async function (t) {
    reset()
    hostDevices = []
    const state = makeState()
    castController(state).start()
    await settled()

    record.listeners.castDevices([device('a', 'dlna'), device('b', 'dlna')])
    t.deepEqual(state.devices.dlna.getDevices().map((d) => d.id), ['a', 'b'],
      'both renderers are in the list the UI counts')

    record.listeners.castDevices([device('b', 'dlna')])
    t.deepEqual(state.devices.dlna.getDevices().map((d) => d.id), ['b'],
      'and one that went away is gone, which cast.js could not do')
    t.end()
  })

test('a status event from the host folds into state.playing',
  async function (t) {
    reset()
    hostDevices = []
    const state = makeState()
    castController(state).start()
    await settled()

    record.listeners.castStatus({ isPaused: false, currentTime: 12 })
    t.equal(state.playing.isPaused, false, 'the receiver is playing')
    t.equal(state.playing.currentTime, 12, 'and says where it has got to')
    t.end()
  })

test('an error event from the host becomes a message, not a throw',
  async function (t) {
    reset()
    hostDevices = []
    const state = makeState()
    castController(state).start()
    await settled()

    record.listeners.castError('mDNS is unavailable')
    t.equal(state.errors.length, 1, 'one error for the corner of the screen')
    t.equal(state.errors[0].message, 'mDNS is unavailable',
      'carrying the host message')
    t.deepEqual(record.dispatches, [],
      "and nothing dispatched, so it does not make the app's error sound")
    t.end()
  })

test('the device menu opens, closes, and refuses a second session',
  function (t) {
    reset()
    const state = makeState([device('a', 'chromecast')])
    const controller = castController(state)

    controller.toggleMenu('chromecast')
    t.equal(state.devices.castMenu.location, 'chromecast', 'the menu is up')
    t.deepEqual(state.devices.castMenu.devices.map((d) => d.id), ['a'],
      'listing what the host found')

    controller.toggleMenu('chromecast')
    t.equal(state.devices.castMenu, null, 'the same button closes it')

    t.throws(() => controller.toggleMenu('dlna'), CastingError,
      'a protocol with no devices has nothing to show')

    state.playing.location = 'chromecast'
    t.throws(() => controller.toggleMenu('chromecast'), CastingError,
      'and never two devices at once')
    t.end()
  })

test('selecting a device connects, via the Connecting... screen',
  async function (t) {
    reset()
    const state = makeState([device('a', 'chromecast')])
    state.playing.currentTime = 90
    const controller = castController(state)

    controller.toggleMenu('chromecast')
    controller.selectDevice(0)

    t.equal(state.devices.castMenu, null, 'the menu closes')
    t.equal(state.playing.castName, 'a-name', 'the screen names the device')
    t.equal(state.playing.location, 'chromecast-pending',
      'and waits on the receiver rather than claiming to be casting')
    t.equal(state.devices.chromecast.device.id, 'a',
      'the mirrored player is connected, so player-page ticks it')

    await settled()
    t.deepEqual(record.cast[0], ['connect', 'a', {
      url: 'http://10.0.0.2:8080/0',
      title: 'WebTorrent - Sintel',
      contentType: 'video/mp4',
      subtitlesVtt: undefined,
      startTime: 90
    }], 'the device id and the media description the host plays')
    t.equal(state.playing.location, 'chromecast',
      'and the session is up once the host answers')
    t.end()
  })

test('a receiver that refuses the session leaves nothing connected',
  async function (t) {
    reset()
    rejectWith = new Error('no route to host')
    const state = makeState([device('a', 'airplay')])
    const controller = castController(state)

    controller.toggleMenu('airplay')
    controller.selectDevice(0)
    await settled()

    t.equal(state.playing.location, 'local', 'playback comes back here')
    t.equal(state.devices.airplay.device, null, 'and the device is released')
    t.equal(state.errors.length, 1, 'the user is told')
    t.ok(state.errors[0].message.includes('a-name'),
      'which device it was: ' + state.errors[0].message)
    t.ok(state.errors[0].message.includes('no route to host'),
      'and why')
    t.end()
  })

test('stopping a session brings the video back where the receiver left it',
  async function (t) {
    reset()
    const state = makeState([device('a', 'dlna')])
    const controller = castController(state)
    controller.toggleMenu('dlna')
    controller.selectDevice(0)
    await settled()
    reset()

    state.playing.currentTime = 137
    controller.stop()
    await settled()

    t.deepEqual(commands(), ['stop'], 'the host drops the session')
    t.equal(state.playing.location, 'local', 'playback is local again')
    t.equal(state.playing.jumpToTime, 137, 'resuming where the receiver was')
    t.equal(state.devices.dlna.device, null, 'and nothing is connected')
    t.end()
  })

test('stopping when nothing is casting asks the host for nothing',
  async function (t) {
    reset()
    const state = makeState([device('a', 'dlna')])
    castController(state).stop()
    await settled()

    t.deepEqual(commands(), [], 'no session, no command')
    t.equal(state.playing.location, 'local', 'and playback stays local')
    t.end()
  })

// The five commands that only forward a value stayed in
// `playback-controller.js` when the session moved to its own
// controller, because everything they do to a session is already in
// `state` (US-079).

test('play and pause reach the receiver, but only while casting',
  async function (t) {
    reset()
    const state = makeState([device('a', 'chromecast')])
    const controller = playbackController(state)

    controller.play()
    controller.pause()
    await settled()
    t.deepEqual(commands(), [], 'local playback tells the host nothing')

    state.playing.location = 'chromecast'
    state.playing.isPaused = true
    controller.play()
    controller.pause()
    await settled()
    t.deepEqual(commands(), ['play', 'pause'], 'a session gets both')
    t.end()
  })

test('seeking goes to the receiver instead of the local video',
  async function (t) {
    reset()
    const state = makeState([device('a', 'chromecast')])
    const controller = playbackController(state)

    controller.skipTo(30)
    await settled()
    t.equal(state.playing.jumpToTime, 30, 'the local video is told to jump')
    t.deepEqual(commands(), [], 'and the host is not')

    state.playing.jumpToTime = null
    state.playing.location = 'chromecast'
    controller.skipTo(45)
    await settled()
    t.deepEqual(record.cast, [['seek', 45]], 'the receiver seeks')
    t.equal(state.playing.jumpToTime, null,
      'and the local video is left alone')
    t.end()
  })

test('the volume goes to the receiver instead of the local video',
  async function (t) {
    reset()
    const state = makeState([device('a', 'chromecast')])
    const controller = playbackController(state)

    controller.setVolume(0.5)
    await settled()
    t.equal(state.playing.setVolume, 0.5, 'the local video is turned down')
    t.deepEqual(commands(), [], 'and the host is not asked')

    state.playing.location = 'chromecast'
    controller.setVolume(0.25)
    await settled()
    t.deepEqual(record.cast, [['setVolume', 0.25]], 'the receiver is')
    t.end()
  })

// `Cast.setRate()` used to answer synchronously with whether the
// device could do it at all. The shim call is a promise, so the answer
// comes off the device's capabilities instead (US-079).
test('a receiver that takes a playback rate is sent one',
  async function (t) {
    reset()
    const state = makeState([device('a', 'airplay', ['seek', 'rate'])])
    state.devices.airplay.device = state.devices.airplay.getDevices()[0]
    state.playing.location = 'airplay'

    playbackController(state).changePlaybackRate(1)
    await settled()

    t.deepEqual(record.cast, [['setRate', 1.25]], 'the rate is forwarded')
    t.equal(state.playing.playbackRate, 1.25, 'and the UI shows it')
    t.end()
  })

test('a receiver that cannot change rate plays at normal speed',
  async function (t) {
    reset()
    const state = makeState([device('a', 'chromecast', ['seek', 'volume'])])
    state.devices.chromecast.device = state.devices.chromecast.getDevices()[0]
    state.playing.location = 'chromecast'

    playbackController(state).changePlaybackRate(1)
    await settled()

    t.deepEqual(commands(), [], 'nothing is sent to a device that cannot')
    t.equal(state.playing.playbackRate, 1,
      'and the UI says normal speed rather than lying about 1.25x')
    t.end()
  })

// Ending a session also drops the mirrored device, which is state
// `playback-controller.js` does not own -- so closing the player goes
// through the cast controller rather than straight at the shim.
test('closing the player ends the session through the cast controller',
  async function (t) {
    reset()
    const state = makeState([device('a', 'chromecast')])
    state.playing.location = 'chromecast'
    playbackController(state).closePlayer()
    await settled()

    t.deepEqual(commands(), [], 'closePlayer does not command the host itself')
    t.deepEqual(record.dispatches.filter((d) => d[0] === 'stopCasting'),
      [['stopCasting']], 'it dispatches stopCasting, which does')
    t.end()
  })

test('closing the player while playing locally casts nothing',
  async function (t) {
    reset()
    const state = makeState()
    playbackController(state).closePlayer()
    await settled()

    t.deepEqual(record.dispatches.filter((d) => d[0] === 'stopCasting'), [],
      'no session, nothing to stop')
    t.end()
  })
