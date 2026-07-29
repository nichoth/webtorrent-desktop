const test = require('tape')

// Same stubbing route as `platform-ipc-os.js`: `ipc-engine.js` compiles
// to `var _electron = require('electron')` plus a lazy
// `_electron.ipcRenderer` at each call site, so seeding `require.cache`
// before the first require of the module under test stubs the whole
// thing. See `test/AGENTS.md`.
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
      listeners.get(channel).push({ fn, once: false })
    },
    once (channel, fn) {
      if (!listeners.has(channel)) listeners.set(channel, [])
      listeners.get(channel).push({ fn, once: true })
    },
    removeListener (channel, fn) {
      const all = listeners.get(channel) || []
      const i = all.findIndex((l) => l.fn === fn)
      if (i !== -1) all.splice(i, 1)
    },
    // Pretend the engine sent an event on `channel`.
    emit (channel, ...args) {
      const all = (listeners.get(channel) || []).slice()
      for (const l of all) {
        if (l.once) stub.removeListener(channel, l.fn)
        l.fn({ channel }, ...args)
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

const ipcEngine = require('../../build/renderer/lib/platform/ipc-engine')

const INFO_HASH = 'aabbccddeeff00112233445566778899aabbccdd'

function reset () {
  ipc = makeIpcStub()
}

function exportNames () {
  return Object.keys(ipcEngine).filter(
    (k) => typeof ipcEngine[k] === 'function'
  )
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

test('every export touches a wt-* channel and only wt-*', async function (t) {
  reset()
  // The mirror image of the ipc-os assertion: this module is the
  // engine seam, so nothing here may reach an OS channel (FR-9).
  for (const name of exportNames()) {
    if (name.endsWith('For')) {
      await ipcEngine[name](INFO_HASH, () => {})
    } else if (name.startsWith('on')) {
      await ipcEngine[name](() => {})
    } else {
      await ipcEngine[name]()
    }
  }
  const channels = ipc.sent.map((s) => s.channel)
    .concat([...ipc.listeners.keys()])
  t.equal(channels.length, exportNames().length, 'one channel per export')
  t.deepEqual(
    channels.filter((c) => !c.startsWith('wt-')),
    [],
    'no non-wt-* channel touched'
  )
  t.end()
})

test('startTorrenting sends every argument through', async function (t) {
  reset()
  const modtimes = { 'a.mkv': 1 }
  const selections = [true, false]
  await ipcEngine.startTorrenting(
    'key1', 'magnet:?xt=1', '/downloads', modtimes, selections
  )
  t.deepEqual(ipc.sent, [{
    channel: 'wt-start-torrenting',
    args: ['key1', 'magnet:?xt=1', '/downloads', modtimes, selections]
  }])
  t.end()
})

test('stopServer sends with no arguments', async function (t) {
  reset()
  await ipcEngine.stopServer()
  t.deepEqual(ipc.sent, [{ channel: 'wt-stop-server', args: [] }])
  t.end()
})

test('onProgress receives events without the event object',
  async function (t) {
    reset()
    const seen = []
    await ipcEngine.onProgress((...args) => seen.push(args))
    const progress = { active: 1 }
    ipc.emit('wt-progress', progress)
    t.deepEqual(seen, [[progress]], 'listener got the payload only')
    t.end()
  })

test('onProgress unsubscribe stops delivery', async function (t) {
  reset()
  const seen = []
  const unsubscribe = await ipcEngine.onProgress((...args) => seen.push(args))
  t.equal(typeof unsubscribe, 'function', 'resolves to a function')
  ipc.emit('wt-progress', 'first')
  unsubscribe()
  ipc.emit('wt-progress', 'second')
  t.deepEqual(seen, [['first']], 'nothing delivered after unsubscribe')
  t.equal(ipc.count('wt-progress'), 0, 'listener removed from ipcRenderer')
  t.end()
})

test('onProgress honours { once: true }', async function (t) {
  reset()
  const seen = []
  await ipcEngine.onProgress((...args) => seen.push(args), { once: true })
  ipc.emit('wt-progress', 'first')
  ipc.emit('wt-progress', 'second')
  t.deepEqual(seen, [['first']], 'only the first event delivered')
  t.end()
})

test('onTorrentReadyFor listens on the per-torrent channel',
  async function (t) {
    reset()
    const seen = []
    await ipcEngine.onTorrentReadyFor(INFO_HASH, (...args) => seen.push(args))
    t.deepEqual(
      [...ipc.listeners.keys()],
      ['wt-ready-' + INFO_HASH],
      'info hash appended inside the module'
    )
    ipc.emit('wt-ready-' + INFO_HASH, 'key1', { name: 'a' })
    ipc.emit('wt-ready-0000', 'key2', { name: 'b' })
    t.deepEqual(seen, [['key1', { name: 'a' }]], 'only its own torrent')
    t.end()
  })

test('onTorrentReadyFor unsubscribe stops delivery', async function (t) {
  reset()
  const seen = []
  const unsubscribe = await ipcEngine.onTorrentReadyFor(
    INFO_HASH, (...args) => seen.push(args)
  )
  ipc.emit('wt-ready-' + INFO_HASH, 'key1')
  unsubscribe()
  ipc.emit('wt-ready-' + INFO_HASH, 'key2')
  t.deepEqual(seen, [['key1']], 'nothing delivered after unsubscribe')
  t.equal(ipc.count('wt-ready-' + INFO_HASH), 0, 'listener removed')
  t.end()
})

test('onServerRunningFor listens on the per-torrent channel',
  async function (t) {
    reset()
    const seen = []
    await ipcEngine.onServerRunningFor(INFO_HASH, (...args) => seen.push(args))
    t.deepEqual(
      [...ipc.listeners.keys()],
      ['wt-server-' + INFO_HASH],
      'info hash appended inside the module'
    )
    ipc.emit('wt-server-' + INFO_HASH, { localURL: 'http://localhost:1' })
    t.deepEqual(seen, [[{ localURL: 'http://localhost:1' }]])
    t.end()
  })

test('ipc-engine shares no exports with ipc-os', function (t) {
  const ipcOs = require('../../build/renderer/lib/platform/ipc-os')
  const shared = exportNames().filter((n) => n in ipcOs)
  t.deepEqual(shared, [], 'the two IPC modules are disjoint')
  t.end()
})
