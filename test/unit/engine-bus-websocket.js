const test = require('tape')
const WebSocket = require('ws')

// US-040: the sidecar's transport. `bus-websocket.js` is the second
// implementation of the bus surface US-039 introduced -- the same
// `send(channel, ...args)` and `on(channel, handler)`, over a localhost
// WebSocket server instead of `ipcRenderer` (ADR-012).
//
// Everything here runs against a real `ws` client and a real server on
// 127.0.0.1:0. There is nothing to fake: the point of the story is that
// the engine is reachable by a plain socket, so a stub would test the
// stub. Frames are checked through `src/shared/wire.js`, which is the
// only codec either side is allowed to use.

const { createWebSocketBus } = require('../../build/engine/bus-websocket')
const { encode, decode } = require('../../build/shared/wire')

// One bus, one connected client, plus the bookkeeping every test needs:
// the frames the client received and the errors the bus reported.
async function connectedPair (options = {}) {
  const errors = []
  const bus = createWebSocketBus({
    onError: (err) => errors.push(err),
    ...options
  })
  const port = await bus.listen()

  const query = options.token ? '?token=' + options.token : ''
  const client = new WebSocket('ws://127.0.0.1:' + port + '/' + query)
  const frames = []
  client.on('message', (data) => frames.push(decode(data)))
  await new Promise((resolve, reject) => {
    client.on('open', resolve)
    client.on('error', reject)
  })

  const closed = async () => {
    client.close()
    await bus.close()
  }

  return { bus, client, port, frames, errors, closed }
}

// The client has no read-side flush, so wait for the frames to arrive
// rather than guessing at a delay.
function nextFrame (frames, count = 1) {
  return waitFor(() => frames.length >= count)
}

test('the bus listens on 127.0.0.1 and reports its port', async function (t) {
  const bus = createWebSocketBus()
  const port = await bus.listen()

  t.equal(typeof port, 'number', 'listen resolves to a number')
  t.ok(port > 0, 'the kernel assigned a port (' + port + ')')
  t.equal(bus.address().address, '127.0.0.1', 'bound to loopback only')
  t.equal(await bus.listen(), port, 'listen is idempotent')

  await bus.close()
  t.end()
})

test('bus.send reaches the client as a wire frame', async function (t) {
  const p = await connectedPair()

  p.bus.send('wt-ready', 42, { infoHash: 'abc', files: [] })
  await nextFrame(p.frames)

  t.deepEqual(p.frames, [
    { channel: 'wt-ready', args: [42, { infoHash: 'abc', files: [] }] }
  ], 'channel and arguments arrive verbatim')

  await p.closed()
  t.end()
})

test('bus.send preserves null, undefined and binary', async function (t) {
  const p = await connectedPair()

  // `wt-warning` sends a real `null` torrentKey; `wt-progress` carries
  // a bitfield buffer.
  p.bus.send('wt-warning', null, 'a warning')
  p.bus.send('wt-progress', { bitfield: new Uint8Array([1, 2, 255]) })
  p.bus.send('wt-metadata', 1, undefined)
  await nextFrame(p.frames, 3)

  t.deepEqual(p.frames[0].args, [null, 'a warning'], 'null survives')
  const bitfield = p.frames[1].args[0].bitfield
  t.ok(bitfield instanceof Uint8Array, 'the buffer is still a byte array')
  t.deepEqual([...bitfield], [1, 2, 255], 'its bytes are unchanged')
  t.equal(p.frames[2].args.length, 2, 'the trailing argument kept its slot')
  t.equal(p.frames[2].args[1], undefined, 'undefined did not become null')

  await p.closed()
  t.end()
})

test('bus.on hands the handler the payload only', async function (t) {
  const p = await connectedPair()
  const calls = []
  p.bus.on('wt-start-torrenting', (...args) => calls.push(args))
  p.bus.on('wt-stop-server', (...args) => calls.push(args))

  p.client.send(encode('wt-start-torrenting',
    [7, 'magnet:?xt=1', '/tmp', null, [true]]))
  p.client.send(encode('wt-stop-server'))
  await waitFor(() => calls.length === 2)

  t.deepEqual(calls[0], [7, 'magnet:?xt=1', '/tmp', null, [true]],
    'no socket or event object in front of the arguments')
  t.deepEqual(calls[1], [], 'a no-argument channel calls with no arguments')

  await p.closed()
  t.end()
})

test('bus.on supports two handlers and unsubscribing', async function (t) {
  const p = await connectedPair()
  const seen = []

  const off = p.bus.on('wt-select-files', (h) => seen.push('a:' + h))
  p.bus.on('wt-select-files', (h) => seen.push('b:' + h))
  t.equal(typeof off, 'function', 'subscription resolves to a function')

  p.client.send(encode('wt-select-files', ['abc']))
  await waitFor(() => seen.length === 2)
  t.deepEqual(seen, ['a:abc', 'b:abc'], 'both handlers ran')

  off()
  p.client.send(encode('wt-select-files', ['def']))
  await waitFor(() => seen.length === 3)
  t.deepEqual(seen, ['a:abc', 'b:abc', 'b:def'],
    'the unsubscribed handler stopped hearing the channel')

  await p.closed()
  t.end()
})

test('a malformed frame is reported, not thrown or dispatched',
  async function (t) {
    const p = await connectedPair()
    const calls = []
    p.bus.on('wt-progress', (...args) => calls.push(args))

    p.client.send('this is not a wire frame')
    await waitFor(() => p.errors.length === 1)
    t.equal(p.errors.length, 1, 'the bus reported the bad frame')
    t.ok(p.errors[0] instanceof Error, 'it reported an Error')
    t.deepEqual(calls, [], 'nothing was dispatched')

    // The connection has to survive it: one bad frame from a buggy UI
    // must not take the engine's socket down.
    p.client.send(encode('wt-progress', [1]))
    await waitFor(() => calls.length === 1)
    t.deepEqual(calls, [[1]], 'the next good frame still arrived')

    await p.closed()
    t.end()
  })

test('a handler that throws is reported, not fatal', async function (t) {
  const p = await connectedPair()
  const calls = []
  p.bus.on('wt-select-files', () => { throw new Error('boom') })
  p.bus.on('wt-progress', (...args) => calls.push(args))

  p.client.send(encode('wt-select-files', ['abc']))
  await waitFor(() => p.errors.length === 1)
  t.equal(p.errors[0].message, 'boom', 'the handler error was reported')

  p.client.send(encode('wt-progress', [1]))
  await waitFor(() => calls.length === 1)
  t.deepEqual(calls, [[1]], 'the socket is still live')

  await p.closed()
  t.end()
})

test('sending with nobody connected drops the message', async function (t) {
  const bus = createWebSocketBus()
  await bus.listen()

  t.doesNotThrow(() => bus.send('wt-progress', { progress: 0 }),
    'no client is not an error')

  await bus.close()
  t.end()
})

test('a configured token gates the upgrade', async function (t) {
  const bus = createWebSocketBus({ token: 's3cret' })
  const port = await bus.listen()

  const rejected = await connectFails(
    'ws://127.0.0.1:' + port + '/?token=wrong')
  t.ok(rejected, 'the wrong token cannot connect: ' + rejected.message)

  const missing = await connectFails('ws://127.0.0.1:' + port + '/')
  t.ok(missing, 'no token cannot connect either')

  const ok = new WebSocket('ws://127.0.0.1:' + port + '/?token=s3cret')
  await new Promise((resolve, reject) => {
    ok.on('open', resolve)
    ok.on('error', reject)
  })
  t.pass('the right token connects')
  ok.close()

  await bus.close()
  t.end()
})

function connectFails (url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.on('error', (err) => resolve(err))
    ws.on('open', () => {
      ws.close()
      reject(new Error('expected the upgrade to be refused: ' + url))
    })
  })
}

function waitFor (predicate) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = setInterval(() => {
      if (predicate()) {
        clearInterval(poll)
        resolve()
      } else if (Date.now() - started > 5000) {
        clearInterval(poll)
        reject(new Error('condition never became true'))
      }
    }, 5)
  })
}
