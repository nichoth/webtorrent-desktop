const test = require('tape')

// US-059: the clipboard, behind the shim (FR-8).
//
// Two host commands over the clipboard-manager plugin's *Rust* API,
// which is what keeps the renderer's capability at `core:default` --
// the JS plugin would need `clipboard-manager:allow-read-text` and
// `allow-write-text` granted to the whole webview. See
// `src-tauri/src/clipboard.rs`.
//
// This file is the first in the directory's glob order to seed
// `@tauri-apps/api/core`; the later ones overwrite the `require.cache`
// entry, so the stub is held in a local (test/AGENTS.md).

const corePath = require.resolve('@tauri-apps/api/core')

let invocations = []
let handler = async () => ''

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

const tauriClipboard = require(
  '../../build/renderer/lib/platform/clipboard'
)

function resetTauri (answer) {
  invocations = []
  handler = async () => answer
}

test('tauri clipboard.readText asks the host for the text',
  async function (t) {
    resetTauri('magnet:?xt=urn:btih:abc')
    const text = await tauriClipboard.readText()

    t.equal(text, 'magnet:?xt=urn:btih:abc', 'resolves to the host answer')
    t.equal(invocations.length, 1, 'one command')
    t.equal(invocations[0].command, 'clipboard_read_text', 'named the command')
    t.end()
  })

test('tauri clipboard.readText always resolves to a string',
  async function (t) {
    // An empty clipboard is an error in the underlying library and the
    // host turns it into `''`; this is the belt to that braces, so no
    // caller ever gets `null` where Electron hands it `''`.
    resetTauri(null)
    t.equal(await tauriClipboard.readText(), '',
      'null becomes the empty string')

    resetTauri('')
    t.equal(await tauriClipboard.readText(), '', 'an empty answer stays empty')
    t.end()
  })

test('tauri clipboard.writeText hands the text to the host',
  async function (t) {
    resetTauri(null)
    const result = await tauriClipboard.writeText('https://instant.io/#abc')

    t.equal(invocations.length, 1, 'one command')
    t.equal(invocations[0].command, 'clipboard_write_text', 'named the command')
    t.deepEqual(invocations[0].args, { text: 'https://instant.io/#abc' },
      'forwarded the text under the key the host names it')
    t.equal(result, undefined, 'resolves with nothing')
    t.end()
  })

test('the shim exports exactly the clipboard surface',
  function (t) {
    const found = Object.keys(tauriClipboard)
      .filter(k => k !== '__esModule')
    t.deepEqual(found.sort(), ['readText', 'writeText'],
      'no export appeared or vanished')
    t.end()
  })

test('every tauri clipboard export is async and rejects on host failure',
  async function (t) {
    resetTauri('')
    t.ok(tauriClipboard.readText() instanceof Promise, 'readText is async')
    t.ok(tauriClipboard.writeText('x') instanceof Promise, 'writeText is async')

    handler = async () => { throw new Error('no clipboard') }
    for (const name of ['readText', 'writeText']) {
      try {
        await tauriClipboard[name]('x')
        t.fail(`${name} resolved over a host failure`)
      } catch (err) {
        t.equal(err.message, 'no clipboard',
          'the host error reaches the caller')
      }
    }
    t.end()
  })
