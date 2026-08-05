const test = require('tape')

// US-075: the cast surface, behind the shim (ADR-015).
//
// This module is the interface the host implementations land behind,
// and the host it talks to today answers an empty device list and a
// not-implemented error for every device command. What is asserted
// here is the shim's side of that contract -- the command names, the
// argument keys the host reads, and the unsubscribe function every
// listener export resolves to -- against a fake invoke.
//
// US-079 deleted `src/renderer/lib/cast.js`, which drove the three
// protocols in the renderer through three npm packages, so this is now
// the only route to a receiver. Its callers are covered by
// `test/unit/cast-call-sites.js` and `test/unit/cast-mirror.js`.
//
// Same `require.cache` stub route as the other shim tests; see
// `test/AGENTS.md`. The stub's exports object is bound once, at the
// first require of the module under test, so the recording state
// lives behind stable functions rather than being rebuilt.
//
// This file is the first in the directory's glob order to seed
// `@tauri-apps/api/core` and `@tauri-apps/api/event`; the later ones
// overwrite the `require.cache` entries, so both stubs are held in
// locals here rather than read back out of the cache.

const corePath = require.resolve('@tauri-apps/api/core')
const eventPath = require.resolve('@tauri-apps/api/event')

let invocations = []
let answer
let failure

let subscriptions = []
let unsubscribe = () => {}

require.cache[corePath] = {
  id: corePath,
  filename: corePath,
  loaded: true,
  exports: {
    __esModule: true,
    async invoke (command, args) {
      invocations.push({ command, args })
      if (failure) throw failure
      return answer
    }
  }
}

require.cache[eventPath] = {
  id: eventPath,
  filename: eventPath,
  loaded: true,
  exports: {
    __esModule: true,
    async listen (name, handler) {
      subscriptions.push({ api: 'listen', name, handler })
      return unsubscribe
    },
    async once (name, handler) {
      subscriptions.push({ api: 'once', name, handler })
      return unsubscribe
    }
  }
}

const cast = require('../../build/renderer/lib/platform/cast')

function reset (value) {
  invocations = []
  subscriptions = []
  answer = value
  failure = null
}

test('the shim exports exactly the surface ADR-015 names', function (t) {
  const found = Object.keys(cast).filter((key) => key !== '__esModule')
  t.deepEqual(found.sort(), [
    'connect',
    'getDevices',
    'getStatus',
    'onDevices',
    'onError',
    'onStatus',
    'pause',
    'play',
    'seek',
    'setRate',
    'setVolume',
    'startDiscovery',
    'stop',
    'stopDiscovery'
  ], 'no export appeared or vanished')
  t.end()
})

// One call of each export, with arguments of the documented shape.
const CALLS = {
  startDiscovery: [],
  stopDiscovery: [],
  getDevices: [],
  onDevices: [() => {}],
  onStatus: [() => {}],
  onError: [() => {}],
  connect: ['chromecast:1', {
    url: 'http://192.168.1.5:8080/0',
    title: 'Sintel',
    contentType: 'video/mp4'
  }],
  play: [],
  pause: [],
  stop: [],
  seek: [30],
  setVolume: [0.5],
  setRate: [1.5],
  getStatus: []
}

test('every export is async and passes plain data only',
  async function (t) {
    reset([])
    for (const key of Object.keys(cast)) {
      if (key === '__esModule') continue
      t.ok(CALLS[key], `${key} is covered here`)
      const result = cast[key](...CALLS[key])
      t.ok(result instanceof Promise, `${key}() returns a promise`)
      await result
    }
    for (const { command, args } of invocations) {
      if (args === undefined) continue
      t.deepEqual(JSON.parse(JSON.stringify(args)), args,
        `${command} passed plain JSON`)
    }
    t.end()
  })

test('discovery is two commands that take nothing', async function (t) {
  reset(undefined)
  await cast.startDiscovery()
  await cast.stopDiscovery()

  t.deepEqual(invocations.map((c) => c.command),
    ['cast_start_discovery', 'cast_stop_discovery'], 'named the commands')
  t.deepEqual(invocations.map((c) => c.args), [undefined, undefined],
    'neither takes an argument')
  t.end()
})

test('getDevices resolves to the host list', async function (t) {
  const devices = [
    {
      id: 'chromecast:1',
      protocol: 'chromecast',
      name: 'Living Room',
      capabilities: ['play', 'pause', 'seek', 'volume']
    }
  ]
  reset(devices)
  const found = await cast.getDevices()

  t.deepEqual(found, devices, 'resolves to what the host answered')
  t.equal(invocations.length, 1, 'one command')
  t.equal(invocations[0].command, 'cast_get_devices', 'named the command')
  t.end()
})

test('getDevices always resolves to an array', async function (t) {
  // The stub host answers an empty list and every unimplemented
  // protocol will keep answering one, so `player-page.js`'s
  // `getDevices().length` rule must never meet a null.
  reset(null)
  t.deepEqual(await cast.getDevices(), [], 'null becomes an empty list')

  reset([])
  t.deepEqual(await cast.getDevices(), [], 'an empty answer stays empty')
  t.end()
})

test('connect hands the device and the media to the host',
  async function (t) {
    reset(undefined)
    const media = {
      url: 'http://192.168.1.5:8080/0',
      title: 'Sintel',
      contentType: 'video/mp4',
      subtitlesVtt: 'WEBVTT\n\n00:00.000 --> 00:01.000\nhi\n',
      startTime: 12.5
    }
    await cast.connect('chromecast:1', media)

    t.equal(invocations.length, 1, 'one command')
    t.equal(invocations[0].command, 'cast_connect', 'named the command')
    t.deepEqual(invocations[0].args, { deviceId: 'chromecast:1', media },
      'forwarded both under the keys the host names them')
    t.end()
  })

test('a media description the caller left half-filled crosses as null',
  async function (t) {
    // `undefined` is dropped by JSON serialisation and a dropped key is
    // not the same thing as a track the user did not select, so the
    // optional halves cross explicitly.
    reset(undefined)
    await cast.connect('dlna:2', {
      url: 'http://192.168.1.5:8080/0',
      title: 'Sintel',
      contentType: 'video/mp4'
    })

    t.deepEqual(invocations[0].args.media, {
      url: 'http://192.168.1.5:8080/0',
      title: 'Sintel',
      contentType: 'video/mp4',
      subtitlesVtt: null,
      startTime: null
    }, 'the absent halves are null rather than missing')
    t.end()
  })

test('the transport commands take what the host reads', async function (t) {
  reset(undefined)
  await cast.play()
  await cast.pause()
  await cast.stop()
  await cast.seek(30)
  await cast.setVolume(0.5)
  await cast.setRate(1.5)

  t.deepEqual(invocations, [
    { command: 'cast_play', args: undefined },
    { command: 'cast_pause', args: undefined },
    { command: 'cast_stop', args: undefined },
    { command: 'cast_seek', args: { seconds: 30 } },
    { command: 'cast_set_volume', args: { volume: 0.5 } },
    { command: 'cast_set_rate', args: { rate: 1.5 } }
  ], 'one command each, named the way the host names it')
  t.end()
})

test('getStatus resolves to the host status', async function (t) {
  const status = {
    deviceId: 'chromecast:1',
    isPaused: false,
    currentTime: 42,
    volume: 0.5,
    ended: false
  }
  reset(status)

  t.deepEqual(await cast.getStatus(), status, 'crosses unchanged')
  t.equal(invocations[0].command, 'cast_get_status', 'named the command')
  t.end()
})

test('a host failure rejects at the call site', async function (t) {
  // Which is how the stub host's not-implemented answer reaches the
  // caller, and how a real protocol failure will.
  reset(undefined)
  failure = new Error('cast.play() is not implemented yet (ADR-015)')

  try {
    await cast.play()
    t.fail('resolved instead of rejecting')
  } catch (err) {
    t.match(err.message, /not implemented/, 'the host message survives')
  }
  t.end()
})

test('the three listener exports subscribe to their host events',
  async function (t) {
    reset(undefined)
    const seen = []
    await cast.onDevices((devices) => seen.push(['devices', devices]))
    await cast.onStatus((status) => seen.push(['status', status]))
    await cast.onError((message) => seen.push(['error', message]))

    t.deepEqual(subscriptions.map((s) => s.name),
      ['castDevices', 'castStatus', 'castError'], 'named the events')
    t.deepEqual(subscriptions.map((s) => s.api), ['listen', 'listen', 'listen'],
      'a subscription, not a one-shot')

    // The caller sees the payload, never the Tauri event envelope.
    subscriptions[0].handler({ event: 'castDevices', payload: [] })
    subscriptions[1].handler({ event: 'castStatus', payload: { ended: true } })
    subscriptions[2].handler({ event: 'castError', payload: 'no route' })

    t.deepEqual(seen, [
      ['devices', []],
      ['status', { ended: true }],
      ['error', 'no route']
    ], 'each listener got the payload alone')
    t.end()
  })

test('a listener export resolves to its unsubscribe function',
  async function (t) {
    reset(undefined)
    let stopped = 0
    unsubscribe = () => { stopped++ }

    const off = await cast.onDevices(() => {})
    t.equal(typeof off, 'function', 'resolved to a function')
    off()
    t.equal(stopped, 1, 'calling it unsubscribes')

    unsubscribe = () => {}
    t.end()
  })

test('a listener export honours { once: true }', async function (t) {
  reset(undefined)
  await cast.onStatus(() => {}, { once: true })

  t.equal(subscriptions.length, 1, 'one registration')
  t.equal(subscriptions[0].api, 'once', 'registered as a one-shot')
  t.end()
})
