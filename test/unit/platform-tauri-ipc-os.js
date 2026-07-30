const test = require('tape')

// US-056: the first Tauri shim export with a host behind it.
//
// `onWindowBoundsChanged` is the renderer's half of the window
// restore loop: the Rust host emits the rectangle on the same event
// name the Electron main process sends it on, and the renderer saves
// what it receives. What is asserted here is the shim's side of that
// contract -- the event name, the payload the caller sees, and the
// unsubscribe function every listener export resolves to.
//
// Same `require.cache` stub route as `platform-dialog.js`; see
// `test/AGENTS.md`. The stub's exports object is bound once, at the
// first require of the module under test, so the recording state
// lives behind stable functions rather than being rebuilt.

const eventPath = require.resolve('@tauri-apps/api/event')

let calls = []
let unsubscribe = () => {}

require.cache[eventPath] = {
  id: eventPath,
  filename: eventPath,
  loaded: true,
  exports: {
    __esModule: true,
    async listen (name, handler) {
      calls.push({ api: 'listen', name, handler })
      return unsubscribe
    },
    async once (name, handler) {
      calls.push({ api: 'once', name, handler })
      return unsubscribe
    }
  }
}

const ipcOs = require('../../build/renderer/lib/platform/tauri/ipc-os')

function reset () {
  calls = []
  unsubscribe = () => {}
}

test('onWindowBoundsChanged subscribes to the host event',
  async function (t) {
    reset()
    await ipcOs.onWindowBoundsChanged(() => {})

    t.equal(calls.length, 1, 'registered once')
    t.equal(calls[0].api, 'listen', 'a standing subscription by default')
    t.equal(calls[0].name, 'windowBoundsChanged',
      'the same event name the Electron host sends')
    t.end()
  })

test('onWindowBoundsChanged hands the caller the payload alone',
  async function (t) {
    reset()
    const received = []
    await ipcOs.onWindowBoundsChanged((bounds) => received.push(bounds))

    const bounds = { x: 1, y: 2, width: 500, height: 638 }
    calls[0].handler({ event: 'windowBoundsChanged', id: 7, payload: bounds })

    t.deepEqual(received, [bounds],
      'the rectangle, not the Tauri event envelope')
    t.end()
  })

test('onWindowBoundsChanged resolves to an unsubscribe function',
  async function (t) {
    reset()
    let stopped = 0
    unsubscribe = () => { stopped++ }

    const stop = await ipcOs.onWindowBoundsChanged(() => {})
    t.equal(typeof stop, 'function', 'resolved to a function')
    stop()
    t.equal(stopped, 1, 'it is the host unsubscribe')
    t.end()
  })

test('onWindowBoundsChanged honours { once: true }', async function (t) {
  reset()
  await ipcOs.onWindowBoundsChanged(() => {}, { once: true })

  t.equal(calls[0].api, 'once', 'a one-shot subscription')
  t.equal(calls[0].name, 'windowBoundsChanged', 'on the same event')
  t.end()
})

test('onWindowBoundsChanged returns a promise', function (t) {
  reset()
  t.ok(ipcOs.onWindowBoundsChanged(() => {}) instanceof Promise,
    'every shim export is async (FR-10)')
  t.end()
})
