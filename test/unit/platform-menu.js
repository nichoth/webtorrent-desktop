const test = require('tape')

// Same `require.cache` stub route as `platform-window.js`; see the
// comment there and `test/AGENTS.md`.
const remotePath = require.resolve('@electron/remote')

// The stub's exports object is bound once, when Babel's
// `require('@electron/remote')` runs at first require of the module
// under test, so the classes below have to be stable. Only the
// recording state is swapped between tests.
let record = null
const currentWindow = { id: 'current-window' }

class MenuItem {
  constructor (options) {
    this.options = options
  }
}

class Menu {
  constructor () {
    this.items = []
    record.items = this.items
  }

  append (item) {
    this.items.push(item)
  }

  popup (options) {
    record.popups.push(options)
  }
}

require.cache[remotePath] = {
  id: remotePath,
  filename: remotePath,
  loaded: true,
  exports: {
    __esModule: true,
    Menu,
    MenuItem,
    getCurrentWindow () {
      record.windowCalls++
      return currentWindow
    }
  }
}

const menu = require('../../build/renderer/lib/platform/menu')

function reset () {
  record = { items: [], popups: [], windowCalls: 0 }
}

// The real menu from controllers/torrent-list-controller.js, as
// descriptors. The `torrentSummary.files` branch is present, which is
// the longer of the two shapes the controller builds.
function torrentContextMenu () {
  const noop = () => {}
  return [
    { label: 'Remove From List', click: noop },
    { label: 'Remove Data File', click: noop },
    { type: 'separator' },
    { label: 'Show in Finder', click: noop },
    { type: 'separator' },
    { label: 'Copy Magnet Link to Clipboard', click: noop },
    { label: 'Copy Instant.io Link to Clipboard', click: noop },
    { label: 'Save Torrent File As...', click: noop, enabled: false },
    { type: 'separator' },
    { label: 'Sort by Name', click: noop }
  ]
}

test('showContextMenu builds one menu item per descriptor',
  async function (t) {
    reset()
    const descriptors = torrentContextMenu()
    await menu.showContextMenu(descriptors)
    const built = record.items
    t.equal(built.length, descriptors.length,
      'the torrent context menu produces one item per descriptor')
    t.deepEqual(
      built.map(i => i.options.label),
      descriptors.map(d => d.label),
      'labels are preserved in order, separators included'
    )
    t.end()
  })

test('showContextMenu shows the menu on the current window',
  async function (t) {
    reset()
    await menu.showContextMenu([{ label: 'One', click: () => {} }])
    t.equal(record.popups.length, 1, 'popped the menu up once')
    t.equal(record.popups[0].window, currentWindow,
      'parented to the current window')
    t.equal(record.windowCalls, 1,
      'the shim resolves the window itself')
    t.end()
  })

test('separator descriptors become separator items', async function (t) {
  reset()
  await menu.showContextMenu([{ type: 'separator' }])
  const options = record.items[0].options
  t.equal(options.type, 'separator', 'type is passed through')
  t.equal(options.label, undefined, 'a separator carries no label')
  t.equal(options.click, undefined, 'a separator carries no click')
  t.end()
})

test('enabled defaults to true and false is passed through',
  async function (t) {
    reset()
    await menu.showContextMenu([
      { label: 'Default', click: () => {} },
      { label: 'Off', click: () => {}, enabled: false },
      { label: 'On', click: () => {}, enabled: true }
    ])
    const enabled = record.items.map(i => i.options.enabled)
    t.deepEqual(enabled, [true, false, true],
      'omitted enabled means enabled')
    t.end()
  })

test('choosing an item calls the descriptor click with no arguments',
  async function (t) {
    reset()
    const calls = []
    await menu.showContextMenu([
      { label: 'Pick me', click: (...args) => calls.push(args) }
    ])
    // Electron calls click with (menuItem, browserWindow, event).
    record.items[0].options.click(
      record.items[0], currentWindow, {}
    )
    t.equal(calls.length, 1, 'the descriptor callback ran')
    t.deepEqual(calls[0], [],
      'no Electron object is handed to the caller')
    t.end()
  })

test('a non-separator descriptor without a label is rejected',
  async function (t) {
    reset()
    try {
      await menu.showContextMenu([{ click: () => {} }])
      t.fail('should have rejected')
    } catch (err) {
      t.ok(/label/.test(err.message), 'the error names the problem')
    }
    t.end()
  })

test('an unknown descriptor type is rejected', async function (t) {
  reset()
  try {
    await menu.showContextMenu([{ type: 'checkbox', label: 'Nope' }])
    t.fail('should have rejected')
  } catch (err) {
    t.ok(/checkbox/.test(err.message), 'the error names the type')
  }
  t.end()
})

test('menu exports only showContextMenu, and it is async',
  function (t) {
    reset()
    const names = Object.keys(menu).filter(k => k !== '__esModule')
    t.deepEqual(names, ['showContextMenu'], 'one export')
    const returned = menu.showContextMenu([])
    t.ok(returned instanceof Promise, 'showContextMenu returns a promise')
    returned.then(() => t.end(), () => t.end())
  })
