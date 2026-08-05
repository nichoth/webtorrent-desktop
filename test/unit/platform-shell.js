const test = require('tape')

// US-059: handing paths and URLs to the OS, behind the shim (FR-8).
//
// All four are host commands rather than plugin calls from the
// webview: three of them were the Electron main process's behaviour
// already, and an app command needs no capability, so the renderer
// stays at `core:default`. The opener plugin and the trash crate are
// reached from `src-tauri/src/shell.rs`, never from here.
//
// So what is asserted here is the command name and the argument object
// that reaches the host. The stub is seeded at `@tauri-apps/api/core`,
// which several files in this directory do; it is held in a local
// rather than reached for through `require.cache`, which by the time
// the tests run belongs to whichever file loaded last (test/AGENTS.md).

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

const tauriShell = require('../../build/renderer/lib/platform/shell')

function resetTauri () {
  invocations = []
  handler = async () => null
}

// The command name each export sends, and the key its one argument
// arrives under. A Rust parameter is camelCased on the JS side, so a
// mistyped key is a silently ignored argument rather than an error --
// which is why the argument object is asserted rather than just the
// command.
const COMMANDS = [
  ['openExternal', 'open_external', 'url', 'https://example.com'],
  ['showItemInFolder', 'show_item_in_folder', 'path', '/tmp/a.mkv'],
  ['openPath', 'open_path', 'path', '/tmp/a.mkv'],
  ['moveItemToTrash', 'move_item_to_trash', 'path', '/tmp/a.mkv']
]

for (const [name, command, key, value] of COMMANDS) {
  test(`tauri shell.${name} asks the host`, async function (t) {
    resetTauri()
    const result = await tauriShell[name](value)

    t.equal(invocations.length, 1, 'one command')
    t.equal(invocations[0].command, command, 'named the command')
    t.deepEqual(invocations[0].args, { [key]: value },
      'forwarded the argument under the key the host names it')
    t.equal(result, undefined, 'resolves with nothing')
    t.end()
  })
}

test('the shim exports exactly the shell surface',
  function (t) {
    const found = Object.keys(tauriShell)
      .filter(k => k !== '__esModule')
    t.deepEqual(found.sort(), ['moveItemToTrash', 'openExternal', 'openPath', 'showItemInFolder'],
      'no export appeared or vanished')
    t.end()
  })

test('every tauri shell export is async and rejects on host failure',
  async function (t) {
    for (const [name] of COMMANDS) {
      resetTauri()
      t.ok(tauriShell[name]('/tmp/a.mkv') instanceof Promise,
        `${name} is async`)
    }

    handler = async () => { throw new Error('no opener') }
    for (const [name] of COMMANDS) {
      try {
        await tauriShell[name]('/tmp/a.mkv')
        t.fail(`${name} resolved over a host failure`)
      } catch (err) {
        t.equal(err.message, 'no opener', 'the host error reaches the caller')
      }
    }
    t.end()
  })
