const test = require('tape')

// `@electron/remote` sets `__esModule` and exposes `dialog` as a lazy
// getter, so the shim imports it by name and Babel emits a per-call
// `_remote.dialog` / `(0, _remote.getCurrentWindow)()` read. Seeding
// `require.cache` with getters therefore stubs the whole module and
// lets the stubs be swapped between tests -- the same route as
// `platform-shell.js`, just a different specifier.
const remotePath = require.resolve('@electron/remote')

const CURRENT_WINDOW = { id: 'current-window' }

function makeDialogStub (openResult, saveResult) {
  return {
    calls: [],
    showOpenDialogSync (win, options) {
      this.calls.push({ method: 'showOpenDialogSync', win, options })
      return openResult
    },
    showSaveDialogSync (win, options) {
      this.calls.push({ method: 'showSaveDialogSync', win, options })
      return saveResult
    }
  }
}

let dialog = makeDialogStub()
let windowCalls = 0
require.cache[remotePath] = {
  id: remotePath,
  filename: remotePath,
  loaded: true,
  exports: {
    __esModule: true,
    get dialog () { return dialog },
    getCurrentWindow () {
      windowCalls++
      return CURRENT_WINDOW
    }
  }
}

const platformDialog = require('../../build/renderer/lib/platform/dialog')

function reset (openResult, saveResult) {
  dialog = makeDialogStub(openResult, saveResult)
  windowCalls = 0
}

test('dialog.showOpenDialog resolves to the selected paths',
  async function (t) {
    reset(['/tmp/a.torrent', '/tmp/b.torrent'])
    const opts = { title: 'Pick one', properties: ['openFile'] }
    const result = await platformDialog.showOpenDialog(opts)
    t.deepEqual(result, ['/tmp/a.torrent', '/tmp/b.torrent'],
      'resolves to the paths the dialog returned')
    t.equal(dialog.calls.length, 1, 'called the sync dialog once')
    t.equal(dialog.calls[0].method, 'showOpenDialogSync',
      'used showOpenDialogSync')
    t.equal(dialog.calls[0].options, opts, 'forwarded the options')
    t.end()
  })

test('dialog.showOpenDialog parents the dialog to the current window',
  async function (t) {
    reset([])
    await platformDialog.showOpenDialog({})
    t.equal(windowCalls, 1, 'asked for the current window itself')
    t.equal(dialog.calls[0].win, CURRENT_WINDOW,
      'passed the current window as the parent')
    t.end()
  })

test('dialog.showOpenDialog resolves to an empty array on cancel',
  async function (t) {
    reset(undefined)
    const result = await platformDialog.showOpenDialog({})
    t.deepEqual(result, [], 'empty array, not undefined')
    t.end()
  })

test('dialog.showSaveDialog resolves to the chosen path',
  async function (t) {
    reset(undefined, '/tmp/out.torrent')
    const opts = { title: 'Save As' }
    const result = await platformDialog.showSaveDialog(opts)
    t.equal(result, '/tmp/out.torrent', 'resolves to the chosen path')
    t.equal(dialog.calls.length, 1, 'called the sync dialog once')
    t.equal(dialog.calls[0].method, 'showSaveDialogSync',
      'used showSaveDialogSync')
    t.equal(dialog.calls[0].options, opts, 'forwarded the options')
    t.equal(dialog.calls[0].win, CURRENT_WINDOW,
      'passed the current window as the parent')
    t.end()
  })

test('dialog.showSaveDialog resolves to null on cancel',
  async function (t) {
    reset(undefined, undefined)
    const result = await platformDialog.showSaveDialog({})
    t.equal(result, null, 'null, not undefined')
    t.end()
  })

test('every dialog export is async', function (t) {
  const names = ['showOpenDialog', 'showSaveDialog']
  for (const name of names) {
    reset([], '/tmp/out.torrent')
    const returned = platformDialog[name]({})
    t.ok(returned instanceof Promise, `${name} returns a promise`)
  }
  t.end()
})

// -- the same contract, against the Tauri tree (US-058) --------------
//
// Under Tauri each dialog is one host command: the picker itself, the
// options mapping and the parent window all live in
// `src-tauri/src/dialog.rs`, for the same reason the window operations
// do (see docs/platform-shim.md). So what is asserted here is the
// command name, the argument object that reaches the host, and that
// the host's answer is normalised into the shape callers already
// handle -- `[]` and `null` on cancel.
//
// The stub is seeded at `@tauri-apps/api/core`, and this file is the
// first of the three that stub that subpath to load, so `tauri/dialog`
// binds this object (see test/AGENTS.md). It is held in a local
// rather than reached for through `require.cache`, which by the time
// the tests run belongs to whichever file loaded last.

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

const tauriDialog = require(
  '../../build/renderer/lib/platform/tauri/dialog'
)

function resetTauri (answer) {
  invocations = []
  handler = async () => answer
}

test('tauri dialog.showOpenDialog asks the host for the paths',
  async function (t) {
    resetTauri(['/tmp/a.torrent', '/tmp/b.torrent'])
    const opts = { title: 'Pick one', properties: ['openFile'] }
    const result = await tauriDialog.showOpenDialog(opts)

    t.deepEqual(result, ['/tmp/a.torrent', '/tmp/b.torrent'],
      'resolves to the paths the host returned')
    t.equal(invocations.length, 1, 'one command')
    t.equal(invocations[0].command, 'show_open_dialog', 'named the command')
    t.deepEqual(invocations[0].args, { options: opts },
      'forwarded the options under the key the host names them')
    t.end()
  })

test('tauri dialog.showOpenDialog resolves to an empty array on cancel',
  async function (t) {
    // What the host actually answers when the picker is dismissed.
    resetTauri([])
    t.deepEqual(await tauriDialog.showOpenDialog({}), [],
      'empty array from the host stays an empty array')

    // And the same guard the Electron tree's `Array.isArray` check is:
    // nothing but an array ever reaches a caller.
    resetTauri(null)
    t.deepEqual(await tauriDialog.showOpenDialog({}), [],
      'empty array, not null')
    t.end()
  })

test('tauri dialog.showSaveDialog asks the host for the path',
  async function (t) {
    resetTauri('/tmp/out.torrent')
    const opts = { title: 'Save As', buttonLabel: 'Save' }
    const result = await tauriDialog.showSaveDialog(opts)

    t.equal(result, '/tmp/out.torrent', 'resolves to the chosen path')
    t.equal(invocations.length, 1, 'one command')
    t.equal(invocations[0].command, 'show_save_dialog', 'named the command')
    t.deepEqual(invocations[0].args, { options: opts },
      'forwarded the options')
    t.end()
  })

test('tauri dialog.showSaveDialog resolves to null on cancel',
  async function (t) {
    resetTauri(null)
    const result = await tauriDialog.showSaveDialog({})
    t.equal(result, null, 'null, not undefined')
    t.end()
  })

test('tauri dialog sends an options object even when called with none',
  async function (t) {
    // A missing key is dropped by JSON, and the host deserialises the
    // options into a struct: `undefined` would arrive as a missing
    // argument and fail the call rather than meaning "no options".
    resetTauri(null)
    await tauriDialog.showOpenDialog()
    await tauriDialog.showSaveDialog()

    t.deepEqual(invocations[0].args, { options: {} },
      'showOpenDialog sends an empty object')
    t.deepEqual(invocations[1].args, { options: {} },
      'showSaveDialog sends an empty object')
    t.end()
  })

test('tauri dialog resolves plain paths, never a host object',
  async function (t) {
    resetTauri(['/tmp/a.torrent'])
    const opened = await tauriDialog.showOpenDialog({})
    t.ok(opened.every((p) => typeof p === 'string'),
      'every opened path is a string')

    resetTauri('/tmp/out.torrent')
    t.equal(typeof await tauriDialog.showSaveDialog({}), 'string',
      'the saved path is a string')
    t.end()
  })

test('the two dialog trees answer the same questions', function (t) {
  const electron = Object.keys(platformDialog).filter(k => k !== '__esModule')
  const tauri = Object.keys(tauriDialog).filter(k => k !== '__esModule')

  t.deepEqual(tauri.sort(), electron.sort(), 'the same two dialogs')
  t.end()
})

test('every tauri dialog export is async and rejects on host failure',
  async function (t) {
    for (const name of ['showOpenDialog', 'showSaveDialog']) {
      resetTauri(null)
      t.ok(tauriDialog[name]({}) instanceof Promise, `${name} is async`)
    }

    handler = async () => { throw new Error('no dialog') }
    for (const name of ['showOpenDialog', 'showSaveDialog']) {
      try {
        await tauriDialog[name]({})
        t.fail(`${name} resolved over a host failure`)
      } catch (err) {
        t.equal(err.message, 'no dialog', 'the host error reaches the caller')
      }
    }
    t.end()
  })
