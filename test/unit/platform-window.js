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
