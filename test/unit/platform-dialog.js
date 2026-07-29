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
