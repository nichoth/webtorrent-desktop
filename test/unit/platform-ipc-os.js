const test = require('tape')

// `ipc-os.js` compiles to `var _electron = require('electron')` plus a
// lazy `_electron.ipcRenderer` at each call site, so seeding
// `require.cache` for the real resolution of 'electron' is enough to
// stub the whole module. Must happen before the first require of the
// module under test.
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
    // Pretend the main process sent an event on `channel`.
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

const ipcOs = require('../../build/renderer/lib/platform/ipc-os')

function reset () {
  ipc = makeIpcStub()
}

test('every export is async', function (t) {
  const names = Object.keys(ipcOs).filter((k) => typeof ipcOs[k] === 'function')
  t.ok(names.length > 0, 'module exports functions')
  const sync = names.filter(
    (n) => ipcOs[n].constructor.name !== 'AsyncFunction'
  )
  t.deepEqual(sync, [], 'no synchronous exports')
  t.end()
})

test('no export sends on a wt-* channel', async function (t) {
  reset()
  // Call every command with harmless arguments and assert nothing
  // reached an engine channel. Listener registrations are covered by
  // the channel assertion below too.
  const skip = ['checkForExternalPlayer']
  for (const name of Object.keys(ipcOs)) {
    if (typeof ipcOs[name] !== 'function' || skip.includes(name)) continue
    if (name.startsWith('on')) {
      await ipcOs[name](() => {})
    } else {
      await ipcOs[name]()
    }
  }
  const channels = ipc.sent.map((s) => s.channel)
    .concat([...ipc.listeners.keys()])
  t.deepEqual(
    channels.filter((c) => c.startsWith('wt-')),
    [],
    'no wt-* channel touched'
  )
  t.end()
})

test('setTitle sends on the setTitle channel', async function (t) {
  reset()
  await ipcOs.setTitle('a title')
  t.deepEqual(ipc.sent, [{ channel: 'setTitle', args: ['a title'] }])
  t.end()
})

test('setBounds forwards both arguments', async function (t) {
  reset()
  const bounds = { x: 1, y: 2, width: 3, height: 4 }
  await ipcOs.setBounds(bounds, false)
  t.deepEqual(ipc.sent, [{ channel: 'setBounds', args: [bounds, false] }])
  t.end()
})

test('onDispatch receives events without the event object', async function (t) {
  reset()
  const seen = []
  await ipcOs.onDispatch((...args) => seen.push(args))
  ipc.emit('dispatch', 'openFiles', 1)
  t.deepEqual(seen, [['openFiles', 1]], 'listener got the payload only')
  t.end()
})

test('the unsubscribe function stops delivery', async function (t) {
  reset()
  const seen = []
  const unsubscribe = await ipcOs.onDispatch((...args) => seen.push(args))
  t.equal(typeof unsubscribe, 'function', 'resolves to a function')
  ipc.emit('dispatch', 'first')
  unsubscribe()
  ipc.emit('dispatch', 'second')
  t.deepEqual(seen, [['first']], 'nothing delivered after unsubscribe')
  t.equal(ipc.count('dispatch'), 0, 'listener removed from ipcRenderer')
  t.end()
})

test('{ once: true } delivers a single event', async function (t) {
  reset()
  const seen = []
  await ipcOs.onDispatch((...args) => seen.push(args), { once: true })
  ipc.emit('dispatch', 'first')
  ipc.emit('dispatch', 'second')
  t.deepEqual(seen, [['first']], 'only the first event delivered')
  t.end()
})

test('checkForExternalPlayer resolves with the reply', async function (t) {
  reset()
  const pending = ipcOs.checkForExternalPlayer('/bin/vlc')
  t.deepEqual(
    ipc.sent,
    [{ channel: 'checkForExternalPlayer', args: ['/bin/vlc'] }],
    'request sent'
  )
  ipc.emit('checkForExternalPlayer', true)
  t.equal(await pending, true, 'resolves with the reply payload')
  t.equal(ipc.count('checkForExternalPlayer'), 0, 'reply listener removed')
  t.end()
})
