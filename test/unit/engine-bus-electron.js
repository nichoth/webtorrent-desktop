const test = require('tape')
const fs = require('fs')
const path = require('path')

// US-039: the engine talks to an injected bus instead of `ipcRenderer`.
// This file covers both halves of that seam:
//
//   1. the Electron bus implementation (`src/engine/bus-electron.js`),
//      exercised against a stubbed `electron` through the usual
//      `require.cache` route -- see `test/AGENTS.md`;
//   2. a source scan proving `src/renderer/webtorrent.js` holds no
//      `ipcRenderer` reference and routes every send and every
//      subscription through the bus.
//
// The second half is what keeps the seam a seam. The bus exists so
// US-044 can substitute a WebSocket implementation without touching
// engine logic (ADR-012), and that only holds while the engine names
// no transport API of its own.

const electronPath = require.resolve('electron')

function makeIpcStub () {
  const listeners = new Map()
  const stub = {
    sent: [],
    listeners,
    send (channel, ...args) {
      stub.sent.push({ channel, args })
    },
    on (channel, fn) {
      if (!listeners.has(channel)) listeners.set(channel, [])
      listeners.get(channel).push(fn)
    },
    removeListener (channel, fn) {
      const all = listeners.get(channel) || []
      const i = all.indexOf(fn)
      if (i !== -1) all.splice(i, 1)
    },
    // Pretend the main process delivered `channel`. Electron always
    // passes an event object as the first argument.
    emit (channel, ...args) {
      for (const fn of (listeners.get(channel) || []).slice()) {
        fn({ channel, sender: 'main' }, ...args)
      }
    },
    count (channel) {
      return (listeners.get(channel) || []).length
    }
  }
  return stub
}

let ipc = makeIpcStub()
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    get ipcRenderer () { return ipc }
  }
}

const { createElectronBus } = require('../../build/engine/bus-electron')

function reset () {
  ipc = makeIpcStub()
  return createElectronBus()
}

test('bus.send forwards the channel and every argument', function (t) {
  const bus = reset()

  bus.send('wt-progress', { progress: 0.5 })
  bus.send('wt-ready', 42, { infoHash: 'abc' })
  bus.send('ipcReadyWebTorrent')

  t.deepEqual(ipc.sent, [
    { channel: 'wt-progress', args: [{ progress: 0.5 }] },
    { channel: 'wt-ready', args: [42, { infoHash: 'abc' }] },
    { channel: 'ipcReadyWebTorrent', args: [] }
  ], 'each send arrives verbatim')
  t.end()
})

test('bus.send preserves a null argument', function (t) {
  const bus = reset()

  // `wt-warning` and `wt-error` send a real `null` torrentKey.
  bus.send('wt-warning', null, 'a warning')

  t.deepEqual(ipc.sent, [
    { channel: 'wt-warning', args: [null, 'a warning'] }
  ], 'null is not dropped or coerced')
  t.end()
})

test('bus.on strips the Electron event object', function (t) {
  const bus = reset()
  const calls = []

  bus.on('wt-start-torrenting', (...args) => calls.push(args))
  ipc.emit('wt-start-torrenting', 7, 'magnet:?xt=1', '/tmp', null, [true])

  t.deepEqual(calls, [[7, 'magnet:?xt=1', '/tmp', null, [true]]],
    'the handler sees the payload only')
  t.end()
})

test('bus.on with no payload calls the handler with no arguments',
  function (t) {
    const bus = reset()
    const calls = []

    bus.on('wt-stop-server', (...args) => calls.push(args))
    ipc.emit('wt-stop-server')

    t.deepEqual(calls, [[]], 'no stray event object leaks through')
    t.end()
  })

test('bus.on registers one listener per subscription', function (t) {
  const bus = reset()
  const seen = []

  bus.on('wt-select-files', (infoHash) => seen.push('a:' + infoHash))
  bus.on('wt-select-files', (infoHash) => seen.push('b:' + infoHash))

  t.equal(ipc.count('wt-select-files'), 2, 'both reached ipcRenderer')
  ipc.emit('wt-select-files', 'abc')
  t.deepEqual(seen, ['a:abc', 'b:abc'], 'both handlers ran')
  t.end()
})

test('bus.on returns an unsubscribe function', function (t) {
  const bus = reset()
  const seen = []

  const off = bus.on('wt-progress', (p) => seen.push(p))
  t.equal(typeof off, 'function', 'subscription resolves to a function')

  ipc.emit('wt-progress', 1)
  off()
  ipc.emit('wt-progress', 2)

  t.equal(ipc.count('wt-progress'), 0, 'the listener was removed')
  t.deepEqual(seen, [1], 'nothing arrives after unsubscribing')
  t.end()
})

// --- the engine side of the seam -------------------------------------

const ENGINE_SRC = path.join(
  __dirname, '..', '..', 'src', 'renderer', 'webtorrent.js'
)

function engineLines () {
  return fs.readFileSync(ENGINE_SRC, 'utf8').split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
}

function hits (re) {
  return engineLines()
    .filter(({ line }) => re.test(line))
    .map(({ line, n }) => n + ': ' + line)
}

test('webtorrent.js names no Electron transport API', function (t) {
  t.deepEqual(hits(/\bipcRenderer\b/), [],
    'no ipcRenderer reference anywhere in the engine')
  t.deepEqual(hits(/['"]electron['"]/), [],
    'the engine does not import electron')
  t.end()
})

test('webtorrent.js constructs the bus exactly once', function (t) {
  t.deepEqual(hits(/createElectronBus\s*\(/).length, 1,
    'a single bus construction site')
  t.end()
})

test('every engine send goes through the bus', function (t) {
  const sends = hits(/\.send\s*\(/)
  t.ok(sends.length > 10, 'found the engine sends (' + sends.length + ')')
  t.deepEqual(sends.filter((h) => !/\bbus\.send\s*\(/.test(h)), [],
    'no send bypasses the bus')
  t.end()
})

test('every engine subscription goes through the bus', function (t) {
  const subs = hits(/^bus\.on\s*\(|\.on\s*\(\s*['"]wt-/)
  t.ok(subs.length > 5, 'found the engine subscriptions')
  t.deepEqual(subs.filter((h) => !/\bbus\.on\s*\(/.test(h)), [],
    'no subscription bypasses the bus')
  t.end()
})
