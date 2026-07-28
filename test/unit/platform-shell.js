const test = require('tape')

// Same stubbing route as `platform-ipc-os.js`: Babel compiles the
// named imports to lazy `_electron.shell` / `_electron.ipcRenderer`
// property reads, so seeding `require.cache` with getters stubs the
// whole module and lets the stubs be swapped between tests.
const electronPath = require.resolve('electron')

function makeShellStub () {
  return {
    calls: [],
    openExternal (url) {
      this.calls.push({ method: 'openExternal', args: [url] })
      return Promise.resolve()
    }
  }
}

function makeIpcStub () {
  return {
    sent: [],
    send (channel, ...args) {
      this.sent.push({ channel, args })
    }
  }
}

let shell = makeShellStub()
let ipc = makeIpcStub()
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    get shell () { return shell },
    get ipcRenderer () { return ipc }
  }
}

const platformShell = require('../../build/renderer/lib/platform/shell')

function reset () {
  shell = makeShellStub()
  ipc = makeIpcStub()
}

test('shell.openExternal hands the URL to the OS', async function (t) {
  reset()
  const result = await platformShell.openExternal('https://example.com')
  t.deepEqual(shell.calls, [
    { method: 'openExternal', args: ['https://example.com'] }
  ], 'forwarded to electron shell')
  t.equal(result, undefined, 'resolves with nothing')
  t.equal(ipc.sent.length, 0, 'does not go over IPC')
  t.end()
})

test('shell.showItemInFolder relays the path to the main process',
  async function (t) {
    reset()
    await platformShell.showItemInFolder('/tmp/a.mkv')
    t.deepEqual(ipc.sent, [
      { channel: 'showItemInFolder', args: ['/tmp/a.mkv'] }
    ], 'sent on the showItemInFolder channel')
    t.end()
  })

test('shell.openPath relays the path to the main process',
  async function (t) {
    reset()
    await platformShell.openPath('/tmp/a.mkv')
    t.deepEqual(ipc.sent, [
      { channel: 'openPath', args: ['/tmp/a.mkv'] }
    ], 'sent on the openPath channel')
    t.end()
  })

test('shell.moveItemToTrash relays the path to the main process',
  async function (t) {
    reset()
    await platformShell.moveItemToTrash('/tmp/a.mkv')
    t.deepEqual(ipc.sent, [
      { channel: 'moveItemToTrash', args: ['/tmp/a.mkv'] }
    ], 'sent on the moveItemToTrash channel')
    t.end()
  })

test('every shell export is async', function (t) {
  const names = ['openExternal', 'showItemInFolder', 'openPath',
    'moveItemToTrash']
  for (const name of names) {
    reset()
    const returned = platformShell[name]('/tmp/a.mkv')
    t.ok(returned instanceof Promise, `${name} returns a promise`)
  }
  t.end()
})
