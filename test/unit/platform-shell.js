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

// -- the same contract, against the Tauri tree (US-059) --------------
//
// Under Tauri all four are host commands rather than plugin calls from
// the webview, for the reason the window and dialog operations are:
// three of them are already the Electron *main* process's behaviour,
// and an app command needs no capability, so the renderer stays at
// `core:default`. The opener plugin and the trash crate are reached
// from `src-tauri/src/shell.rs`, never from here.
//
// So what is asserted here is the command name and the argument object
// that reaches the host. The stub is seeded at `@tauri-apps/api/core`,
// which several files in this directory do; it is held in a local
// rather than reached for through `require.cache`, which by the time
// the tests run belongs to whichever file loaded last (test/AGENTS.md).

const corePath = require.resolve('@tauri-apps/api/core')

let invocations = []
let handler = async () => null

const coreStub = {
  __esModule: true,
  async invoke (command, args) {
    invocations.push({ command, args })
    return handler(command, args)
  }
}

require.cache[corePath] = {
  id: corePath,
  filename: corePath,
  loaded: true,
  exports: coreStub
}

const tauriShell = require('../../build/renderer/lib/platform/tauri/shell')

function resetTauri () {
  invocations = []
  handler = async () => null
}

// The command name each export sends, and the key its one argument
// arrives under. A Rust parameter is camelCased on the JS side, so a
// mistyped key is a silently ignored argument rather than an error --
// which is why the argument object is asserted rather than just the
// command.
const COMMANDS = [
  ['openExternal', 'open_external', 'url', 'https://example.com'],
  ['showItemInFolder', 'show_item_in_folder', 'path', '/tmp/a.mkv'],
  ['openPath', 'open_path', 'path', '/tmp/a.mkv'],
  ['moveItemToTrash', 'move_item_to_trash', 'path', '/tmp/a.mkv']
]

for (const [name, command, key, value] of COMMANDS) {
  test(`tauri shell.${name} asks the host`, async function (t) {
    resetTauri()
    const result = await tauriShell[name](value)

    t.equal(invocations.length, 1, 'one command')
    t.equal(invocations[0].command, command, 'named the command')
    t.deepEqual(invocations[0].args, { [key]: value },
      'forwarded the argument under the key the host names it')
    t.equal(result, undefined, 'resolves with nothing')
    t.end()
  })
}

test('the two shell trees answer the same questions', function (t) {
  const electron = Object.keys(platformShell).filter(k => k !== '__esModule')
  const tauri = Object.keys(tauriShell).filter(k => k !== '__esModule')

  t.deepEqual(tauri.sort(), electron.sort(), 'the same four operations')
  t.end()
})

test('every tauri shell export is async and rejects on host failure',
  async function (t) {
    for (const [name] of COMMANDS) {
      resetTauri()
      t.ok(tauriShell[name]('/tmp/a.mkv') instanceof Promise,
        `${name} is async`)
    }

    handler = async () => { throw new Error('no opener') }
    for (const [name] of COMMANDS) {
      try {
        await tauriShell[name]('/tmp/a.mkv')
        t.fail(`${name} resolved over a host failure`)
      } catch (err) {
        t.equal(err.message, 'no opener', 'the host error reaches the caller')
      }
    }
    t.end()
  })
