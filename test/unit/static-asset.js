const test = require('tape')
const fs = require('fs')
const path = require('path')

// US-072: the app's own bundled files -- the five default torrents,
// their posters, the notification sounds -- are addressed as URLs now
// rather than as filesystem paths.
//
// Under Electron they were read off disk: `config.STATIC_PATH` was
// `<repo>/static`, and `lib/state.js` copied out of it with the fs
// shim while `lib/sound.js` built `file://` URLs out of it. Neither
// works in a webview. There is no `__dirname` to anchor the path to,
// `file://` is not the protocol the window is served over, and in a
// packaged build the files are embedded in the binary rather than
// unpacked next to it -- so no path names them at all.
//
// What does name them is the document they are shipped alongside.
// `static/main.html` and the five torrents are siblings in the
// document root that `bin/build-tauri.js` assembles, so a relative URL
// resolves to them under the asset protocol, in a `cargo build` run
// and in a bundle alike. That is what this module wraps.

const { url, read } = require('../../build/renderer/lib/static-asset')

const REPO = path.join(__dirname, '..', '..')
const RENDERER = path.join(REPO, 'src', 'renderer')

// What the real window reports: the Tauri asset protocol, serving the
// document root, with the page itself inside `static/`.
const BASE_URI = 'tauri://localhost/static/main.html'

function withDocument (baseURI, fn) {
  const previous = global.document
  global.document = { baseURI }
  try {
    return fn()
  } finally {
    if (previous === undefined) delete global.document
    else global.document = previous
  }
}

function withFetch (impl, fn) {
  const previous = global.fetch
  global.fetch = impl
  try {
    return fn()
  } finally {
    global.fetch = previous
  }
}

test('url() resolves a bundled name against the document', function (t) {
  withDocument(BASE_URI, function () {
    t.equal(url('bigBuckBunny.torrent'),
      'tauri://localhost/static/bigBuckBunny.torrent',
      'a sibling of the page')
    t.equal(url('sound/add.wav'),
      'tauri://localhost/static/sound/add.wav',
      'a nested one keeps its subdirectory')
  })
  t.end()
})

test('url() is relative to wherever the page is served from',
  function (t) {
    // The point of resolving against the document rather than against
    // a constant: a `file://` document during development and a
    // `tauri://` one in the app must both work, and neither is
    // hard-coded anywhere.
    withDocument('file:///repo/build-tauri/static/main.html', function () {
      t.equal(url('sintel.jpg'),
        'file:///repo/build-tauri/static/sintel.jpg',
        'follows the document')
    })
    t.end()
  })

test('read() fetches the bundled file and answers with bytes',
  async function (t) {
    const asked = []
    const body = Uint8Array.from([1, 2, 3, 4])

    await withDocument(BASE_URI, () => withFetch(
      async (requested) => {
        asked.push(String(requested))
        return { ok: true, status: 200, arrayBuffer: async () => body.buffer }
      },
      async function () {
        const bytes = await read('wiredCd.torrent')
        t.deepEqual(asked, ['tauri://localhost/static/wiredCd.torrent'],
          'fetched the resolved URL')
        t.ok(bytes instanceof Uint8Array, 'a Uint8Array, as the fs shim gives')
        t.deepEqual(Array.from(bytes), [1, 2, 3, 4], 'the bytes are the bytes')
      }
    ))
    t.end()
  })

test('read() rejects rather than resolving to an error page',
  async function (t) {
    // The failure that matters: a name that is not in the document
    // root answers 404 with an HTML body, and `fetch` calls that a
    // success. Resolving it would write a web page into the profile as
    // if it were a .torrent file.
    await withDocument(BASE_URI, () => withFetch(
      async () => ({
        ok: false,
        status: 404,
        arrayBuffer: async () => new ArrayBuffer(9)
      }),
      async function () {
        try {
          await read('nothing-here.torrent')
          t.fail('resolved on a 404')
        } catch (err) {
          t.ok(/nothing-here\.torrent/.test(err.message), 'names the file')
          t.ok(/404/.test(err.message), 'and the status')
        }
      }
    ))
    t.end()
  })

// -- and that the old spelling is really gone -------------------------

function rendererSources () {
  const out = []
  ;(function walk (dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js')) out.push(full)
    }
  })(RENDERER)
  return out
}

test('no renderer source reads a static path any more', function (t) {
  // `config.STATIC_PATH` was deleted rather than left pointing
  // somewhere harmless, because a path that resolves to `../static`
  // in a webview is the kind of value that fails silently: the copy
  // it feeds rejects, the rejection surfaces as a failed profile
  // creation, and nothing says which of the two was wrong.
  const offenders = []
  for (const file of rendererSources()) {
    const source = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    if (/STATIC_PATH/.test(source)) offenders.push(path.relative(RENDERER, file))
  }
  t.deepEqual(offenders, [], 'use lib/static-asset.js instead')
  t.end()
})

test('config.js exports no STATIC_PATH', function (t) {
  const config = require('../../build/config')
  t.equal(config.STATIC_PATH, undefined, 'the named export is gone')
  t.equal(config.default.STATIC_PATH, undefined, 'and so is the object key')
  t.end()
})
