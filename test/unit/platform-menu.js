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

// -- the Tauri tree (US-061) -----------------------------------------
//
// The same contract against the other host: descriptors in, the item
// the user chose back, and the caller's `click` invoked with no
// arguments. Under Tauri there is no host object to hide, only a
// process boundary to cross, so what is asserted is that nothing but
// plain data goes over it -- no `click` in the payload -- and that a
// choice arriving on the host's event finds the callback the shim
// kept.
//
// Stubs seeded at `@tauri-apps/api/core` and `.../event`, the route
// every Tauri shim test uses; they are held in locals because
// `require.cache` by then belongs to whichever file loaded last
// (test/AGENTS.md).

const corePath = require.resolve('@tauri-apps/api/core')
const tauriEventPath = require.resolve('@tauri-apps/api/event')

let invocations = []
const listeners = []

require.cache[corePath] = {
  id: corePath,
  filename: corePath,
  loaded: true,
  exports: {
    __esModule: true,
    async invoke (command, args) {
      invocations.push({ command, args })
      return null
    }
  }
}

require.cache[tauriEventPath] = {
  id: tauriEventPath,
  filename: tauriEventPath,
  loaded: true,
  exports: {
    __esModule: true,
    async listen (name, handler) {
      listeners.push({ name, handler })
      return () => {}
    },
    async once (name, handler) {
      listeners.push({ name, handler, once: true })
      return () => {}
    }
  }
}

const tauriMenu = require('../../build/renderer/lib/platform/tauri/menu')

// The listener list is deliberately not cleared: the shim subscribes
// once for the life of the page -- a renderer that never opens a
// context menu never asks the host for anything, and one that opens a
// hundred asks once -- so clearing it here would leave every test
// after the first delivering choices to nobody.
function resetTauri () {
  invocations = []
}

/** Deliver the host's click event for the menu that was just sent. */
function choose (index) {
  const sent = invocations[invocations.length - 1].args
  for (const listener of listeners) {
    listener.handler({
      event: 'contextMenuClick',
      payload: { menu: sent.menu, item: index }
    })
  }
}

test('tauri showContextMenu sends the descriptors to the host',
  async function (t) {
    resetTauri()
    const descriptors = torrentContextMenu()
    await tauriMenu.showContextMenu(descriptors)

    t.equal(invocations.length, 1, 'one command')
    t.equal(invocations[0].command, 'show_context_menu', 'named the command')

    const sent = invocations[0].args.items
    t.equal(sent.length, descriptors.length, 'one item per descriptor')
    t.deepEqual(
      sent.map(item => item.label),
      descriptors.map(d => d.label),
      'labels in order, separators included'
    )
    t.equal(typeof invocations[0].args.menu, 'number',
      'the menu carries an id, so a late click can be told apart')
    t.end()
  })

test('tauri showContextMenu sends plain data and nothing else',
  async function (t) {
    resetTauri()
    await tauriMenu.showContextMenu([
      { label: 'Pick me', click: () => {} },
      { type: 'separator' }
    ])

    const sent = invocations[0].args.items
    t.equal(sent[0].click, undefined, 'no callback crosses the boundary')
    t.deepEqual(Object.keys(sent[0]).sort(), ['enabled', 'label', 'type'],
      'a normal item is a type, a label and a flag')
    t.deepEqual(sent[1], { type: 'separator' }, 'a separator is bare')
    t.doesNotThrow(() => JSON.parse(JSON.stringify(sent)),
      'the whole payload survives serialisation')
    t.end()
  })

test('tauri enabled defaults to true and false is passed through',
  async function (t) {
    resetTauri()
    await tauriMenu.showContextMenu([
      { label: 'Default', click: () => {} },
      { label: 'Off', click: () => {}, enabled: false },
      { label: 'On', click: () => {}, enabled: true }
    ])

    t.deepEqual(
      invocations[0].args.items.map(item => item.enabled),
      [true, false, true],
      'omitted enabled means enabled'
    )
    t.end()
  })

test('tauri choosing an item calls the descriptor click with no arguments',
  async function (t) {
    resetTauri()
    const calls = []
    await tauriMenu.showContextMenu([
      { label: 'One', click: () => {} },
      { label: 'Two', click: (...args) => calls.push(args) }
    ])

    choose(1)
    t.equal(calls.length, 1, 'the descriptor callback ran')
    t.deepEqual(calls[0], [], 'no host object is handed to the caller')
    t.end()
  })

test('tauri a click for a menu that is gone is ignored', async function (t) {
  resetTauri()
  const stale = []
  await tauriMenu.showContextMenu([
    { label: 'Old', click: () => stale.push('old') }
  ])
  const first = invocations[0].args.menu

  await tauriMenu.showContextMenu([
    { label: 'New', click: () => stale.push('new') }
  ])
  t.notEqual(invocations[1].args.menu, first, 'a new menu, a new id')

  for (const listener of listeners) {
    listener.handler({ payload: { menu: first, item: 0 } })
  }
  t.deepEqual(stale, [], 'the dismissed menu\'s callback did not run')

  choose(0)
  t.deepEqual(stale, ['new'], 'the open menu\'s did')
  t.end()
})

test('tauri a separator carries no label and no click', async function (t) {
  resetTauri()
  await tauriMenu.showContextMenu([{ type: 'separator' }])

  const sent = invocations[0].args.items[0]
  t.equal(sent.type, 'separator', 'type is passed through')
  t.equal(sent.label, undefined, 'a separator carries no label')
  t.equal(sent.click, undefined, 'a separator carries no click')
  t.end()
})

test('tauri a non-separator descriptor without a label is rejected',
  async function (t) {
    resetTauri()
    try {
      await tauriMenu.showContextMenu([{ click: () => {} }])
      t.fail('should have rejected')
    } catch (err) {
      t.ok(/label/.test(err.message), 'the error names the problem')
    }
    t.equal(invocations.length, 0, 'nothing reached the host')
    t.end()
  })

test('tauri an unknown descriptor type is rejected', async function (t) {
  resetTauri()
  try {
    await tauriMenu.showContextMenu([{ type: 'checkbox', label: 'Nope' }])
    t.fail('should have rejected')
  } catch (err) {
    t.ok(/checkbox/.test(err.message), 'the error names the type')
  }
  t.equal(invocations.length, 0, 'nothing reached the host')
  t.end()
})

test('tauri menu exports only showContextMenu, and it is async',
  function (t) {
    resetTauri()
    const names = Object.keys(tauriMenu).filter(k => k !== '__esModule')
    t.deepEqual(names, ['showContextMenu'], 'one export')
    const returned = tauriMenu.showContextMenu([])
    t.ok(returned instanceof Promise, 'showContextMenu returns a promise')
    returned.then(() => t.end(), () => t.end())
  })
