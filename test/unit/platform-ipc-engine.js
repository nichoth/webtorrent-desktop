const fs = require('fs')
const path = require('path')
const test = require('tape')

// US-044: `ipc-engine.js` is a WebSocket client now, not an
// `ipcRenderer` consumer. The engine runs as a sidecar (ADR-012), so
// this module owns the socket to it: the endpoint comes from
// `ipc-os.getEngineEndpoint()`, frames are `src/shared/wire.js`, and
// the pre-connect queue and the reconnect loop that ADR-012 puts on
// the UI side live here.
//
// Two things are stubbed and nothing else. `globalThis.WebSocket` is
// replaced by a fake the test drives frame by frame -- the real thing
// needs a server and this file is about the client's own state machine
// (queue, reconnect, unsubscribe, one-shot). And `ipc-os` is stubbed
// because it imports Electron; the endpoint it hands back is plain
// data.
const { decode, encode } = require('../../build/shared/wire')

const OS_PATH = require.resolve('../../build/renderer/lib/platform/ipc-os')

// What the stubbed `getEngineEndpoint` resolves to. Reassigned per
// test; the stub function itself is stable, because Babel binds the
// module object once (see test/AGENTS.md).
let endpoint = { url: 'ws://127.0.0.1:6881', token: 'sekrit' }
let endpointCalls = 0

const previousOs = require.cache[OS_PATH]
require.cache[OS_PATH] = {
  id: OS_PATH,
  filename: OS_PATH,
  loaded: true,
  exports: {
    __esModule: true,
    async getEngineEndpoint () {
      endpointCalls++
      return endpoint
    }
  }
}

// Every socket the module has constructed, oldest first.
const sockets = []

const realWebSocket = globalThis.WebSocket

class FakeSocket {
  constructor (url) {
    this.url = url
    this.sent = []
    this.readyState = 0 // CONNECTING
    this.onopen = null
    this.onclose = null
    this.onerror = null
    this.onmessage = null
    sockets.push(this)
  }

  send (frame) {
    if (this.readyState !== 1) throw new Error('socket is not open')
    this.sent.push(frame)
  }

  close () {
    this.readyState = 3
  }

  // -- test controls, not part of the WebSocket API -----------------

  /** The server accepted the connection. */
  accept () {
    this.readyState = 1
    if (this.onopen) this.onopen({})
  }

  /** The engine sent one frame. */
  deliver (channel, ...args) {
    this.onmessage({ data: encode(channel, args) })
  }

  /** The connection went away. */
  drop () {
    this.readyState = 3
    if (this.onclose) this.onclose({})
  }

  /** The frames this socket carried, decoded. */
  frames () {
    return this.sent.map(decode)
  }
}

globalThis.WebSocket = FakeSocket

const ipcEngine = require('../../build/renderer/lib/platform/ipc-engine')

// Withdrawn immediately: `platform-ipc-os.js` tests the real module and
// `tape test/unit/*.js` is one process. Babel has already bound the
// stub inside `ipc-engine`.
if (previousOs) require.cache[OS_PATH] = previousOs
else delete require.cache[OS_PATH]

const INFO_HASH = 'aabbccddeeff00112233445566778899aabbccdd'

function exportNames () {
  return Object.keys(ipcEngine).filter(
    (k) => typeof ipcEngine[k] === 'function'
  )
}

function waitFor (predicate, what) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 3000
    const poll = () => {
      if (predicate()) return resolve()
      if (Date.now() > deadline) return reject(new Error('timed out: ' + what))
      setTimeout(poll, 5)
    }
    poll()
  })
}

// The module connects lazily and asynchronously (the endpoint is one
// IPC round trip away), so every test that wants a socket waits for it.
// `before` is the socket count from *before* whatever triggered the
// connect: the endpoint promise can settle in the same microtask as the
// call that asked for it, so a baseline taken here would already be
// stale.
async function nextSocket (before = sockets.length) {
  await waitFor(() => sockets.length > before, 'a socket was constructed')
  return sockets[sockets.length - 1]
}

// One connected socket, with the previous one dropped so the module is
// not holding it. Every test starts from a known-quiet state.
async function connected () {
  const live = sockets[sockets.length - 1]
  if (live && live.readyState === 1) return live
  const socket = live && live.readyState === 0 ? live : await nextSocket()
  socket.accept()
  return socket
}

test('every export is async', function (t) {
  const names = exportNames()
  t.ok(names.length > 0, 'module exports functions')
  const sync = names.filter(
    (n) => ipcEngine[n].constructor.name !== 'AsyncFunction'
  )
  t.deepEqual(sync, [], 'no synchronous exports')
  t.end()
})

// AC: the module imports no Electron module. Comment lines are dropped
// first -- the file's own header explains what it no longer uses.
test('ipc-engine.js imports nothing from Electron', function (t) {
  const src = path.join(
    __dirname, '..', '..', 'src', 'renderer', 'lib', 'platform',
    'ipc-engine.js'
  )
  const code = fs.readFileSync(src, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')

  t.equal(
    /['"](electron|@electron\/remote)['"]/.test(code), false,
    'no electron import remains'
  )
  t.equal(
    /\bipcRenderer\b/.test(code), false,
    'no ipcRenderer use remains'
  )
  t.end()
})

test('the socket goes to the endpoint ipc-os reports, with its token',
  async function (t) {
    const asked = endpointCalls
    const before = sockets.length
    await ipcEngine.setGlobalTrackers([])
    const socket = await nextSocket(before)

    t.ok(endpointCalls > asked, 'the endpoint was asked for')
    const url = new URL(socket.url)
    t.equal(url.protocol, 'ws:', 'a WebSocket URL')
    t.equal(url.host, '127.0.0.1:6881', 'the host the endpoint named')
    t.equal(url.searchParams.get('token'), 'sekrit', 'the token is presented')

    socket.accept()
    t.end()
  })

test('every command sends one wt-* frame and only wt-*',
  async function (t) {
    const socket = await connected()
    const before = socket.sent.length
    const commands = exportNames().filter((n) => !n.startsWith('on'))

    for (const name of commands) await ipcEngine[name]()

    const frames = socket.frames().slice(before)
    t.equal(frames.length, commands.length, 'one frame per command')
    t.deepEqual(
      frames.map((f) => f.channel).filter((c) => !c.startsWith('wt-')),
      [],
      'no non-wt-* channel sent'
    )
    t.end()
  })

// The mirror image, inbound: this module is the engine seam (FR-9), so
// an OS channel arriving on the socket reaches nobody.
test('an inbound non-wt-* frame reaches no listener', async function (t) {
  const socket = await connected()
  const seen = []
  const off = await ipcEngine.onProgress((...args) => seen.push(args))

  socket.deliver('setTitle', 'nope')
  socket.deliver('log', 'nope')

  t.deepEqual(seen, [], 'nothing delivered')
  off()
  t.end()
})

test('startTorrenting sends every argument through', async function (t) {
  const socket = await connected()
  const before = socket.sent.length
  const modtimes = { 'a.mkv': 1 }
  const selections = [true, false]

  await ipcEngine.startTorrenting(
    7, 'magnet:?xt=1', '/downloads', modtimes, selections
  )

  t.deepEqual(socket.frames().slice(before), [{
    channel: 'wt-start-torrenting',
    args: [7, 'magnet:?xt=1', '/downloads', modtimes, selections]
  }])
  t.end()
})

test('stopServer names the torrent to release', async function (t) {
  const socket = await connected()
  const before = socket.sent.length
  await ipcEngine.stopServer('abc')
  t.deepEqual(socket.frames().slice(before),
    [{ channel: 'wt-stop-server', args: ['abc'] }])
  t.end()
})

// AC: sends issued before the socket is open are queued and flushed on
// open, in order. This is the pre-ready queue `main.js` relies on.
test('sends before the socket opens are queued, then flushed in order',
  async function (t) {
    const live = await connected()
    const before = sockets.length
    live.drop()

    await ipcEngine.setGlobalTrackers(['udp://tracker'])
    await ipcEngine.startTorrenting(1, 'magnet:?xt=1')

    const socket = await nextSocket(before)
    t.deepEqual(socket.sent, [], 'nothing sent while connecting')

    socket.accept()
    await waitFor(() => socket.sent.length === 2, 'the queue flushed')
    t.deepEqual(socket.frames(), [
      { channel: 'wt-set-global-trackers', args: [['udp://tracker']] },
      {
        channel: 'wt-start-torrenting',
        // The optional parameters are still sent, as they were under
        // `ipcRenderer.send`: the export's arity is the protocol's.
        args: [1, 'magnet:?xt=1', undefined, undefined, undefined]
      }
    ], 'both frames arrived, in the order they were issued')
    t.end()
  })

test('onProgress receives events without the transport event object',
  async function (t) {
    const socket = await connected()
    const seen = []
    const off = await ipcEngine.onProgress((...args) => seen.push(args))

    socket.deliver('wt-progress', { active: 1 })

    t.deepEqual(seen, [[{ active: 1 }]], 'listener got the payload only')
    off()
    t.end()
  })

test('onProgress unsubscribe stops delivery', async function (t) {
  const socket = await connected()
  const seen = []
  const unsubscribe = await ipcEngine.onProgress((...args) => seen.push(args))
  t.equal(typeof unsubscribe, 'function', 'resolves to a function')

  socket.deliver('wt-progress', 'first')
  unsubscribe()
  socket.deliver('wt-progress', 'second')

  t.deepEqual(seen, [['first']], 'nothing delivered after unsubscribe')
  t.end()
})

test('onProgress honours { once: true }', async function (t) {
  const socket = await connected()
  const seen = []
  await ipcEngine.onProgress((...args) => seen.push(args), { once: true })

  socket.deliver('wt-progress', 'first')
  socket.deliver('wt-progress', 'second')

  t.deepEqual(seen, [['first']], 'only the first event delivered')
  t.end()
})

test('onTorrentReadyFor listens on the per-torrent channel',
  async function (t) {
    const socket = await connected()
    const seen = []
    const off = await ipcEngine.onTorrentReadyFor(
      INFO_HASH, (...args) => seen.push(args)
    )

    socket.deliver('wt-ready-' + INFO_HASH, 'key1', { name: 'a' })
    socket.deliver('wt-ready-0000', 'key2', { name: 'b' })

    t.deepEqual(seen, [['key1', { name: 'a' }]], 'only its own torrent')
    off()
    t.end()
  })

test('onServerRunningFor listens on the per-torrent channel',
  async function (t) {
    const socket = await connected()
    const seen = []
    const off = await ipcEngine.onServerRunningFor(
      INFO_HASH, (...args) => seen.push(args)
    )

    socket.deliver('wt-server-' + INFO_HASH, { localURL: 'http://localhost:1' })
    socket.deliver('wt-server-0000', { localURL: 'http://localhost:2' })

    t.deepEqual(seen, [[{ localURL: 'http://localhost:1' }]])
    off()
    t.end()
  })

// AC: a dropped connection reconnects, every listener is still
// subscribed on the new socket, and the unsubscribe functions handed
// out before the drop still work afterwards.
test('a dropped connection reconnects with every listener intact',
  async function (t) {
    const first = await connected()
    const before = sockets.length
    const progress = []
    const ready = []
    const offProgress = await ipcEngine.onProgress((p) => progress.push(p))
    const offReady = await ipcEngine.onTorrentReadyFor(
      INFO_HASH, (key) => ready.push(key)
    )

    first.drop()

    // A command issued while the engine is away waits for the new
    // socket rather than being dropped.
    await ipcEngine.stopTorrenting(INFO_HASH)

    const second = await nextSocket(before)
    t.notEqual(second, first, 'a new socket was constructed')
    second.accept()
    await waitFor(() => second.sent.length === 1, 'the queue flushed')
    t.deepEqual(second.frames(),
      [{ channel: 'wt-stop-torrenting', args: [INFO_HASH] }])

    second.deliver('wt-progress', 'after')
    second.deliver('wt-ready-' + INFO_HASH, 'key1')
    t.deepEqual(progress, ['after'], 'onProgress still subscribed')
    t.deepEqual(ready, ['key1'], 'the per-torrent listener too')

    offProgress()
    offReady()
    second.deliver('wt-progress', 'ignored')
    second.deliver('wt-ready-' + INFO_HASH, 'ignored')
    t.deepEqual(progress, ['after'], 'the old unsubscribe still works')
    t.deepEqual(ready, ['key1'], 'for the per-torrent listener too')
    t.end()
  })

// The host reports `null` while the sidecar is restarting. That is a
// wait, not a failure: the client keeps asking and delivers once an
// endpoint appears.
test('no endpoint yet is retried rather than dropped', async function (t) {
  const live = await connected()
  const real = endpoint
  const asked = endpointCalls
  const before = sockets.length
  endpoint = null
  live.drop()

  await waitFor(() => endpointCalls > asked, 'the host was asked again')
  t.equal(sockets.length, before, 'no socket without an endpoint')
  endpoint = real

  const socket = await nextSocket()
  socket.accept()
  const seen = []
  const off = await ipcEngine.onTorrentDone((key) => seen.push(key))
  socket.deliver('wt-done', 'key9')
  t.deepEqual(seen, ['key9'], 'events flow on the new socket')
  off()
  t.end()
})

test('ipc-engine shares no exports with ipc-os', function (t) {
  const ipcOs = require('../../build/renderer/lib/platform/ipc-os')
  const shared = exportNames().filter((n) => n in ipcOs)
  t.deepEqual(shared, [], 'the two IPC modules are disjoint')
  t.end()
})

// Leave the module holding one open socket and hand the global back:
// a reconnect timer left pending would keep the whole tape run alive.
test('teardown: the module is left quiet', async function (t) {
  const socket = await connected()
  t.equal(socket.readyState, 1, 'a socket is open, so nothing is retrying')
  globalThis.WebSocket = realWebSocket
  t.end()
})
