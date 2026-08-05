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

test('the shim exports exactly the window surface',
  function (t) {
    const found = Object.keys(tauriWindow)
      .filter(k => k !== '__esModule')
    t.deepEqual(found.sort(), ['isMaximized', 'isVisible'],
      'no export appeared or vanished')
    t.end()
  })

test('every tauri window export is async and rejects on host failure',
  async function (t) {
    for (const name of ['isVisible', 'isMaximized']) {
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
