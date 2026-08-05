const test = require('tape')

// US-072: the notification sounds are bundled files, so they are
// addressed the way every other bundled file is now -- through
// `lib/static-asset.js`, relative to the document -- rather than as
// `'file://' + path.join(config.STATIC_PATH, ...)`.
//
// Three separate things were wrong with the old spelling in a webview,
// and only the first is visible in a diff: `STATIC_PATH` is derived
// from `__dirname` and there is none; `file://` is not the protocol
// the window is served over; and in a packaged build the files are
// embedded in the binary rather than unpacked beside it, so no
// filesystem path names them at all.
//
// The failure this guards against is a silent one. `audio.src` accepts
// any string, a `play()` on a source that 404s rejects a promise
// nobody awaits, and the app carries on without a sound -- so "the
// notifications went quiet" is not something a launch check surfaces.

const SOUND = require.resolve('../../build/renderer/lib/sound')

// What the real window reports: the Tauri asset protocol, serving the
// document root, with the page itself inside `static/`.
const BASE_URI = 'tauri://localhost/static/main.html'

// Enough of a webview for the module under test: a document to resolve
// against, and an `Audio` that records what it was pointed at instead
// of decoding it.
//
// The module is re-required rather than reused, because it caches one
// `Audio` element per sound for the life of the process and every test
// below is about the element's construction. A fresh copy per test is
// also what the app has -- one per launch.
function withWebview (baseURI, fn) {
  const previousDocument = global.document
  const previousWindow = global.window
  const previousModule = require.cache[SOUND]
  const built = []

  global.document = { baseURI }
  global.window = {
    Audio: function Audio () {
      const element = {
        volume: 1,
        currentTime: 0,
        plays: 0,
        play () { this.plays++ }
      }
      built.push(element)
      return element
    }
  }
  delete require.cache[SOUND]

  try {
    return fn(require(SOUND), built)
  } finally {
    if (previousDocument === undefined) delete global.document
    else global.document = previousDocument
    if (previousWindow === undefined) delete global.window
    else global.window = previousWindow
    if (previousModule) require.cache[SOUND] = previousModule
    else delete require.cache[SOUND]
  }
}

// `play()` returns early unless the preference is on, so every test
// needs a state.
function enabled () {
  return { saved: { prefs: { soundNotifications: true } } }
}

test('every sound resolves against the running document',
  function (t) {
    withWebview(BASE_URI, function (sound, built) {
      sound.init(enabled())
      const names = Object.keys(sound.sounds)
      t.ok(names.length >= 8, `there are ${names.length} sounds`)
      for (const name of names) sound.play(name)

      t.equal(built.length, names.length, 'one Audio element per sound')
      for (const element of built) {
        t.ok(element.src.startsWith('tauri://localhost/static/sound/'),
          `served from the document root: ${element.src}`)
        t.ok(element.src.endsWith('.wav'), 'and is a .wav')
      }
    })
    t.end()
  })

test('no sound is addressed as a filesystem path', function (t) {
  // The specific regression: a `file://` URL loaded off `__dirname`
  // under Electron and loads nothing at all under the asset protocol.
  withWebview(BASE_URI, function (sound, built) {
    sound.init(enabled())
    sound.play('STARTUP')
    t.equal(built.length, 1, 'built one')
    t.notOk(/^file:/.test(built[0].src), 'not a file:// URL')
    t.notOk(/undefined|\/\/\//.test(built[0].src),
      `no empty path segment: ${built[0].src}`)
  })
  t.end()
})

test('the URL follows the document rather than a constant',
  function (t) {
    // Why `url()` resolves against `document.baseURI`: a `file://`
    // document during development and a `tauri://` one in the app both
    // have to work, and neither is written down anywhere.
    withWebview('file:///repo/build-tauri/static/main.html',
      function (sound, built) {
        sound.init(enabled())
        sound.play('ADD')
        t.equal(built[0].src,
          'file:///repo/build-tauri/static/sound/add.wav',
          'followed the document')
      })
    t.end()
  })

test('an unknown sound still throws', function (t) {
  // Unchanged behaviour, asserted because the lookup moved: the names
  // are dispatched from a dozen call sites as bare strings, so a typo
  // has to fail loudly rather than resolve to a URL that 404s.
  withWebview(BASE_URI, function (sound) {
    sound.init(enabled())
    t.throws(() => sound.play('NO-SUCH-SOUND'), /NO-SUCH-SOUND/,
      'names the sound it could not find')
  })
  t.end()
})

test('playing is still gated on the preference', function (t) {
  withWebview(BASE_URI, function (sound, built) {
    sound.init({ saved: { prefs: { soundNotifications: false } } })
    sound.play('DONE')
    t.deepEqual(built, [], 'nothing was constructed')
  })
  t.end()
})

test('the element is reused on the second play', function (t) {
  // The cache is what makes playback instant, and it is also why each
  // test above gets its own copy of the module.
  withWebview(BASE_URI, function (sound, built) {
    sound.init(enabled())
    sound.play('ERROR')
    sound.play('ERROR')
    t.equal(built.length, 1, 'one element')
    t.equal(built[0].plays, 2, 'played twice')
  })
  t.end()
})
