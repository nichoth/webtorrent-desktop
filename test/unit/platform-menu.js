const test = require('tape')

// US-061: the context menu, behind the shim (FR-8).
//
// Descriptors in, the item the user chose back, and the caller's
// `click` invoked with no arguments. There is no host object to hide,
// only a process boundary to cross, so what is asserted is that
// nothing but plain data goes over it -- no `click` in the payload --
// and that a choice arriving on the host's event finds the callback
// the shim kept.
//
// Stubs seeded at `@tauri-apps/api/core` and `.../event`, the route
// every shim test uses; they are held in locals because
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

const tauriMenu = require('../../build/renderer/lib/platform/menu')

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
