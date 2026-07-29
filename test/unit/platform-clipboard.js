const test = require('tape')

// See `platform-ipc-os.js` for why seeding `require.cache` is enough
// to stub `electron` here.
const electronPath = require.resolve('electron')

function makeClipboardStub () {
  return {
    text: '',
    writes: [],
    readText () {
      return this.text
    },
    writeText (text) {
      this.writes.push(text)
      this.text = text
    }
  }
}

let clipboard = makeClipboardStub()
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    get clipboard () { return clipboard }
  }
}

const platformClipboard =
  require('../../build/renderer/lib/platform/clipboard')

test('clipboard.readText resolves with the clipboard contents',
  async function (t) {
    clipboard = makeClipboardStub()
    clipboard.text = 'magnet:?xt=urn:btih:abc'
    const text = await platformClipboard.readText()
    t.equal(text, 'magnet:?xt=urn:btih:abc', 'read through')
    t.end()
  })

test('clipboard.writeText replaces the clipboard contents',
  async function (t) {
    clipboard = makeClipboardStub()
    await platformClipboard.writeText('https://instant.io/#abc')
    t.deepEqual(clipboard.writes, ['https://instant.io/#abc'],
      'written through')
    t.equal(await platformClipboard.readText(), 'https://instant.io/#abc',
      'readable afterwards')
    t.end()
  })

test('every clipboard export is async', function (t) {
  clipboard = makeClipboardStub()
  t.ok(platformClipboard.readText() instanceof Promise,
    'readText returns a promise')
  t.ok(platformClipboard.writeText('x') instanceof Promise,
    'writeText returns a promise')
  t.end()
})
