const test = require('tape')

// US-057: reading the current window's state, behind the shim (FR-8).
//
// Both reads are host commands, so what is asserted is the command
// name, the absence of arguments, and that the host's answer reaches
// the caller unchanged.
//
// The stub is seeded at `@tauri-apps/api/core`, the route every shim
// test in this directory uses. It is held in a local rather than
// reached for through `require.cache`, which by the time the tests run
// belongs to whichever file loaded last (test/AGENTS.md).

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

const tauriWindow = require(
  '../../build/renderer/lib/platform/window'
)

function resetTauri (value) {
  invocations = []
  handler = async () => value
}

test('tauri window.isVisible asks the host', async function (t) {
  resetTauri(true)
  const result = await tauriWindow.isVisible()

  t.equal(result, true, 'resolves to the window state')
  t.equal(invocations.length, 1, 'one command')
  t.equal(invocations[0].command, 'window_is_visible', 'named the command')
  t.end()
})

test('tauri window.isVisible resolves false when hidden',
  async function (t) {
    resetTauri(false)
    t.equal(await tauriWindow.isVisible(), false, 'false when hidden')
    t.end()
  })

test('tauri window.isMaximized asks the host', async function (t) {
  resetTauri(true)
  const result = await tauriWindow.isMaximized()

  t.equal(result, true, 'resolves to the window state')
  t.equal(invocations.length, 1, 'one command')
  t.equal(invocations[0].command, 'window_is_maximized', 'named the command')
  t.end()
})

// The window's own rectangle, which the renderer used to take from
// `window.screenX`/`outerWidth`. Those describe the OS window under
// Chromium and describe nothing under a webview -- `outerWidth` is 0
// and `screenX`/`screenY` are the content area's origin, a title bar
// below the window's -- so the rectangle comes from the host, like
// every other window read here. The maximize flag rides along because
// its caller needs the two to describe one instant.
test('tauri window.getBounds asks the host', async function (t) {
  const rect = { x: 12, y: 34, width: 500, height: 638, maximized: false }
  resetTauri(rect)
  const result = await tauriWindow.getBounds()

  t.deepEqual(result, rect, 'the host rectangle reaches the caller')
  t.equal(invocations.length, 1, 'one command')
  t.equal(invocations[0].command, 'window_bounds', 'named the command')
  t.end()
})

test('tauri window.getBounds reports a maximized window', async function (t) {
  resetTauri({ x: 0, y: 0, width: 2560, height: 1440, maximized: true })
  const result = await tauriWindow.getBounds()

  t.equal(result.maximized, true, 'the flag comes back with the rectangle')
  t.end()
})

test('the shim exports exactly the window surface',
  function (t) {
    const found = Object.keys(tauriWindow)
      .filter(k => k !== '__esModule')
    t.deepEqual(found.sort(), ['getBounds', 'isMaximized', 'isVisible'],
      'no export appeared or vanished')
    t.end()
  })

test('every tauri window export is async and rejects on host failure',
  async function (t) {
    for (const name of ['isVisible', 'isMaximized', 'getBounds']) {
      resetTauri(false)
      t.ok(tauriWindow[name]() instanceof Promise, `${name} is async`)
    }

    handler = async () => { throw new Error('no window') }
    try {
      await tauriWindow.isVisible()
      t.fail('resolved over a host failure')
    } catch (err) {
      t.equal(err.message, 'no window', 'the host error reaches the caller')
    }
    t.end()
  })
