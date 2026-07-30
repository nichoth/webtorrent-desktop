const test = require('tape')

// Same `require.cache` stub route as `platform-dialog.js`; see the
// comment there and `test/AGENTS.md`.
const remotePath = require.resolve('@electron/remote')

function makeWindowStub (visible, maximized) {
  return {
    calls: [],
    isVisible () {
      this.calls.push('isVisible')
      return visible
    },
    isMaximized () {
      this.calls.push('isMaximized')
      return maximized
    }
  }
}

let currentWindow = makeWindowStub()
let windowCalls = 0
require.cache[remotePath] = {
  id: remotePath,
  filename: remotePath,
  loaded: true,
  exports: {
    __esModule: true,
    getCurrentWindow () {
      windowCalls++
      return currentWindow
    }
  }
}

const platformWindow = require('../../build/renderer/lib/platform/window')

function reset (visible, maximized) {
  currentWindow = makeWindowStub(visible, maximized)
  windowCalls = 0
}

test('window.isVisible reads the current window', async function (t) {
  reset(true, false)
  const result = await platformWindow.isVisible()
  t.equal(result, true, 'resolves to the window state')
  t.equal(windowCalls, 1, 'resolved the current window itself')
  t.deepEqual(currentWindow.calls, ['isVisible'], 'called isVisible')
  t.end()
})

test('window.isVisible resolves false when hidden', async function (t) {
  reset(false, false)
  t.equal(await platformWindow.isVisible(), false, 'false when hidden')
  t.end()
})

test('window.isMaximized reads the current window', async function (t) {
  reset(false, true)
  const result = await platformWindow.isMaximized()
  t.equal(result, true, 'resolves to the window state')
  t.equal(windowCalls, 1, 'resolved the current window itself')
  t.deepEqual(currentWindow.calls, ['isMaximized'], 'called isMaximized')
  t.end()
})

test('window.isMaximized resolves the value, never the method',
  async function (t) {
    reset(false, false)
    const result = await platformWindow.isMaximized()
    t.equal(result, false, 'false, not a function')
    t.equal(typeof result, 'boolean', 'a boolean crosses the boundary')
    t.end()
  })

test('window exports no current-window handle', function (t) {
  const names = Object.keys(platformWindow).filter(k => k !== '__esModule')
  t.deepEqual(names.sort(), ['isMaximized', 'isVisible'],
    'only the two reads; the window object stays inside the shim')
  t.end()
})

test('every window export is async', function (t) {
  for (const name of ['isVisible', 'isMaximized']) {
    reset(true, true)
    const returned = platformWindow[name]()
    t.ok(returned instanceof Promise, `${name} returns a promise`)
  }
  t.end()
})

// -- the same contract, against the Tauri tree (US-057) --------------
//
// The two reads are host commands under Tauri rather than
// `@electron/remote` calls, so what is asserted is the command name,
// the absence of arguments, and that the host's answer reaches the
// caller unchanged. The stub is seeded the same way, at
// `@tauri-apps/api/core`; this file is the first to require
// `tauri/window`, so its recorder is the one that module binds (see
// test/AGENTS.md).

const corePath = require.resolve('@tauri-apps/api/core')

let invocations = []
let answer = null

require.cache[corePath] = {
  id: corePath,
  filename: corePath,
  loaded: true,
  exports: {
    __esModule: true,
    async invoke (command, args) {
      invocations.push({ command, args })
      return answer
    }
  }
}

const tauriWindow = require(
  '../../build/renderer/lib/platform/tauri/window'
)

function resetTauri (value) {
  invocations = []
  answer = value
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

test('the two trees answer the same questions', function (t) {
  const electron = Object.keys(platformWindow).filter(k => k !== '__esModule')
  const tauri = Object.keys(tauriWindow).filter(k => k !== '__esModule')

  t.deepEqual(tauri.sort(), electron.sort(),
    'the same two reads, and still no window handle')
  t.end()
})

test('every tauri window export is async and rejects on host failure',
  async function (t) {
    for (const name of ['isVisible', 'isMaximized']) {
      resetTauri(false)
      t.ok(tauriWindow[name]() instanceof Promise, `${name} is async`)
    }

    const failing = require.cache[corePath].exports.invoke
    require.cache[corePath].exports.invoke = async () => {
      throw new Error('no window')
    }
    try {
      await tauriWindow.isVisible()
      t.fail('resolved over a host failure')
    } catch (err) {
      t.equal(err.message, 'no window', 'the host error reaches the caller')
    }
    require.cache[corePath].exports.invoke = failing
    t.end()
  })
