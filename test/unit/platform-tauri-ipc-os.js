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
const corePath = require.resolve('@tauri-apps/api/core')

let calls = []
let unsubscribe = () => {}

let invocations = []
let answer

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

// US-057 added the window-control half, which is commands rather than
// events. This file requires `tauri/ipc-os` first in the glob, so this
// is the `invoke` that module binds for the whole run -- a later file
// seeding its own core stub (`platform-window.js` does) gets a fresh
// entry for its own module and leaves this one alone.
//
// The reference is kept here rather than read back out of
// `require.cache` at use, because that later file overwrites the
// entry: the cache holds *its* stub by then, and `ipc-os` holds this
// one.
const core = {
  __esModule: true,
  async invoke (command, args) {
    invocations.push({ command, args })
    return answer
  }
}

require.cache[corePath] = {
  id: corePath,
  filename: corePath,
  loaded: true,
  exports: core
}

const ipcOs = require('../../build/renderer/lib/platform/tauri/ipc-os')

function reset () {
  calls = []
  unsubscribe = () => {}
  invocations = []
  answer = undefined
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

// -- the window controls (US-057) ------------------------------------
//
// Each of these is one command in `src-tauri/src/main.rs`, and the
// contract asserted here is the command name and the arguments: the
// Rust side names its parameters in snake_case and Tauri accepts them
// as camelCase, so a renamed key here is a silently ignored argument
// rather than a failure. The behaviour behind each command (the
// fullscreen guard, the centring, the progress mapping) is tested in
// Rust, where it lives.

test('setTitle sends the title to the host', async function (t) {
  reset()
  await ipcOs.setTitle('WebTorrent - 42%')

  t.deepEqual(invocations, [{
    command: 'set_title',
    args: { title: 'WebTorrent - 42%' }
  }], 'one command, carrying the title')
  t.end()
})

test('setProgress sends the fraction unchanged', async function (t) {
  reset()
  await ipcOs.setProgress(0.5)
  await ipcOs.setProgress(-1)

  t.deepEqual(invocations.map(c => c.command), ['set_progress', 'set_progress'])
  t.deepEqual(invocations.map(c => c.args.progress), [0.5, -1],
    'the out-of-range values keep their meaning for the host to read')
  t.end()
})

test('setBounds sends the rectangle and the maximize flag',
  async function (t) {
    reset()
    const bounds = { contentBounds: true, x: null, y: null, width: 640, height: 480 }
    await ipcOs.setBounds(bounds, false)

    t.equal(invocations.length, 1, 'one command')
    t.equal(invocations[0].command, 'set_bounds', 'named the command')
    t.deepEqual(invocations[0].args.bounds, bounds,
      'the rectangle crosses as the caller wrote it, nulls and all')
    t.equal(invocations[0].args.maximize, false, 'and the flag')
    t.end()
  })

test('setBounds sends null rather than undefined for no flag',
  async function (t) {
    reset()
    await ipcOs.setBounds({ width: 500, height: 638 })

    t.equal(invocations[0].args.maximize, null,
      'an omitted flag is JSON null, which the host reads as "leave it"')
    t.end()
  })

test('setAspectRatio asks the host, which does not support it',
  async function (t) {
    reset()
    await ipcOs.setAspectRatio(1.78)

    t.deepEqual(invocations, [{
      command: 'set_aspect_ratio',
      args: { aspectRatio: 1.78 }
    }], 'still one call per track, so the day Tauri gains the API ' +
      'there is one place to fill in')
    t.end()
  })

test('toggleFullScreen carries the flag, and null when omitted',
  async function (t) {
    reset()
    await ipcOs.toggleFullScreen(true)
    await ipcOs.toggleFullScreen()

    t.deepEqual(invocations.map(c => c.command),
      ['toggle_full_screen', 'toggle_full_screen'])
    t.equal(invocations[0].args.setTo, true, 'the explicit flag')
    t.equal(invocations[1].args.setTo, null,
      'no flag means toggle, which the host decides')
    t.end()
  })

test('show asks the host to show the window', async function (t) {
  reset()
  await ipcOs.show()

  t.deepEqual(invocations, [{ command: 'show', args: undefined }],
    'one command, no arguments')
  t.end()
})

test('a failing command rejects the caller', async function (t) {
  reset()
  const real = core.invoke
  core.invoke = async () => { throw new Error('no window') }

  try {
    await ipcOs.setTitle('x')
    t.fail('resolved over a host failure')
  } catch (err) {
    t.equal(err.message, 'no window', 'the host error reaches the caller')
  }

  core.invoke = real
  t.end()
})

test('onFullscreenChanged subscribes to the host event',
  async function (t) {
    reset()
    const received = []
    const stop = await ipcOs.onFullscreenChanged((on) => received.push(on))

    t.equal(calls.length, 1, 'registered once')
    t.equal(calls[0].api, 'listen', 'a standing subscription')
    t.equal(calls[0].name, 'fullscreenChanged',
      'the same event name the Electron host sends')

    calls[0].handler({ event: 'fullscreenChanged', id: 3, payload: true })
    t.deepEqual(received, [true], 'the flag alone, not the event envelope')
    t.equal(typeof stop, 'function', 'resolved to an unsubscribe')
    t.end()
  })

test('onFullscreenChanged honours { once: true }', async function (t) {
  reset()
  await ipcOs.onFullscreenChanged(() => {}, { once: true })

  t.equal(calls[0].api, 'once', 'a one-shot subscription')
  t.end()
})

// -- the application menu's renderer half (US-061) --------------------
//
// The menu itself is the host's, built in `src-tauri/src/menu.rs` from
// descriptors that never cross the boundary. What the renderer keeps
// is these four commands -- the calls that enable and disable items --
// and the event the host reports a click on. The menu's own contents
// are asserted in Rust; what is asserted here is the boundary.

test('setAllowNav sends the flag to the host', async function (t) {
  reset()
  await ipcOs.setAllowNav(false)
  await ipcOs.setAllowNav(true)

  t.deepEqual(invocations, [
    { command: 'set_allow_nav', args: { allow: false } },
    { command: 'set_allow_nav', args: { allow: true } }
  ], 'one command per call, carrying the flag')
  t.end()
})

test('the player open and close notifications take no arguments',
  async function (t) {
    reset()
    await ipcOs.notifyPlayerOpen()
    await ipcOs.notifyPlayerClose()

    t.deepEqual(invocations.map(c => c.command),
      ['notify_player_open', 'notify_player_close'],
      'the two commands that turn the Playback items on and off')
    t.deepEqual(invocations.map(c => c.args), [undefined, undefined],
      'neither carries anything')
    t.end()
  })

// US-066: the two the power save blocker is the whole content of.
// `notifyPlayerOpen` and `notifyPlayerClose` reach commands that do the
// same thing among others, which is how `src/main/ipc.js` has it.
test('the play and pause notifications take no arguments either',
  async function (t) {
    reset()
    await ipcOs.notifyPlayerPlay()
    await ipcOs.notifyPlayerPause()

    t.deepEqual(invocations.map(c => c.command),
      ['notify_player_play', 'notify_player_pause'],
      'the two commands that hold the display awake and let it go')
    t.deepEqual(invocations.map(c => c.args), [undefined, undefined],
      'neither carries anything')
    t.end()
  })

test('notifyPlayerUpdate carries both playlist flags', async function (t) {
  reset()
  await ipcOs.notifyPlayerUpdate(true, false)

  t.deepEqual(invocations, [{
    command: 'notify_player_update',
    args: { hasNext: true, hasPrevious: false }
  }], 'camelCase keys, which is how the host reads its snake_case ones')
  t.end()
})

test('onDispatch subscribes to the host event', async function (t) {
  reset()
  const stop = await ipcOs.onDispatch(() => {})

  t.equal(calls.length, 1, 'registered once')
  t.equal(calls[0].api, 'listen', 'a standing subscription by default')
  t.equal(calls[0].name, 'dispatch',
    'the same event name the Electron host sends')
  t.equal(typeof stop, 'function', 'resolved to an unsubscribe')
  t.end()
})

test('onDispatch spreads the action and its arguments', async function (t) {
  reset()
  const received = []
  await ipcOs.onDispatch((...args) => received.push(args))

  // A Tauri event carries one payload, so the host sends the whole
  // argument list as an array; the caller's signature is Electron's
  // `(action, ...args)` either way.
  calls[0].handler({ event: 'dispatch', payload: ['changeVolume', 0.1] })
  calls[0].handler({ event: 'dispatch', payload: ['playPause'] })

  t.deepEqual(received, [['changeVolume', 0.1], ['playPause']],
    'the action first, then whatever the menu item passes')
  t.end()
})

test('onDispatch honours { once: true }', async function (t) {
  reset()
  await ipcOs.onDispatch(() => {}, { once: true })

  t.equal(calls[0].api, 'once', 'a one-shot subscription')
  t.equal(calls[0].name, 'dispatch', 'on the same event')
  t.end()
})

// -- the dock and the taskbar (US-063) --------------------------------
//
// `setProgress` above is the third of the three, and was already the
// window's own. These two are `src/main/dock.js`. What the host does
// with either -- which platforms draw a badge, what a zero means, which
// have a Downloads stack -- is decided and asserted in
// `src-tauri/src/dock.rs`; the contract here is that the value crosses
// unchanged, so that the decision is made in exactly one place.

test('setBadge sends the count to the host', async function (t) {
  reset()
  await ipcOs.setBadge(3)
  await ipcOs.setBadge(0)

  t.deepEqual(invocations, [
    { command: 'set_badge', args: { count: 3 } },
    { command: 'set_badge', args: { count: 0 } }
  ], 'one command per call, and zero is sent rather than skipped')
  t.end()
})

test('notifyDownloadFinished sends the path to the host',
  async function (t) {
    reset()
    await ipcOs.notifyDownloadFinished('/Users/me/Downloads/movie.mp4')

    t.deepEqual(invocations, [{
      command: 'download_finished',
      args: { path: '/Users/me/Downloads/movie.mp4' }
    }], 'the path alone -- the Dock decides whether it is in a stack')
    t.end()
  })

test('neither dock command swallows a host failure', async function (t) {
  reset()
  const real = core.invoke
  core.invoke = async () => { throw new Error('no dock') }

  for (const call of [
    () => ipcOs.setBadge(1),
    () => ipcOs.notifyDownloadFinished('/tmp/x')
  ]) {
    try {
      await call()
      t.fail('resolved over a host failure')
    } catch (err) {
      t.equal(err.message, 'no dock', 'the host error reaches the caller')
    }
  }

  core.invoke = real
  t.end()
})
