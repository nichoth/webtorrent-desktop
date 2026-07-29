const test = require('tape')
const fs = require('fs')
const path = require('path')

// US-031: the renderer entry point's IPC call sites.
//
// `src/renderer/main.js` cannot be required in a unit test -- it pulls
// in React, ReactDOM, every page and the whole controller graph, and
// its module body calls `State.load()` and renders into the DOM. So
// this file checks the call sites statically, the way
// `test/unit/platform-boundary.js` does, but goes one step further than
// a channel-string ban: it resolves every shim member main.js reaches
// for against the shim's actual exports, so a typo'd or invented export
// name fails here rather than silently becoming `undefined` at runtime.
//
// The behaviour behind each export is covered by
// `test/unit/platform-ipc-os.js` and `test/unit/platform-ipc-engine.js`.

const ROOT = path.join(__dirname, '..', '..')
const RENDERER = path.join(ROOT, 'src', 'renderer')
const MAIN = path.join(RENDERER, 'main.js')
const SHIM = path.join(RENDERER, 'lib', 'platform')

const main = fs.readFileSync(MAIN, 'utf8')

function lines (source) {
  return source.split('\n').map((line, i) => ({ line, n: i + 1 }))
}

function hits (source, patterns) {
  return lines(source)
    .filter(({ line }) => patterns.some((re) => re.test(line)))
    .map(({ line, n }) => n + ': ' + line.trim())
}

// The names a shim module actually exports.
function exportsOf (name) {
  const source = fs.readFileSync(path.join(SHIM, name), 'utf8')
  return new Set(
    [...source.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)]
      .map((m) => m[1])
  )
}

// The names main.js reaches for on a given imported namespace.
function membersUsed (namespace) {
  const re = new RegExp('\\b' + namespace + '\\.(\\w+)', 'g')
  return new Set([...main.matchAll(re)].map((m) => m[1]))
}

test('main.js does not reach for electron directly', function (t) {
  t.deepEqual(hits(main, [
    /from\s*['"]electron['"]/,
    /require\s*\(\s*['"]electron['"]\s*\)/,
    /from\s*['"]@electron\/remote['"]/
  ]), [], 'no electron import survives')
  t.deepEqual(hits(main, [/\bipcRenderer\b/]), [],
    'and no ipcRenderer reference survives either')
  t.end()
})

test('main.js imports both IPC shims', function (t) {
  t.ok(/import \* as ipcOs from '\.\/lib\/platform\/ipc-os'/.test(main),
    'the OS shim is imported as a namespace')
  t.ok(/import \* as ipcEngine from '\.\/lib\/platform\/ipc-engine'/
    .test(main), 'the engine shim is imported as a namespace')
  t.end()
})

// The point of the file: every member main.js uses has to exist.
for (const [namespace, file] of
  [['ipcOs', 'ipc-os.js'], ['ipcEngine', 'ipc-engine.js']]) {
  test(namespace + ' members used by main.js all exist', function (t) {
    const available = exportsOf(file)
    const used = [...membersUsed(namespace)].sort()
    t.ok(used.length > 0, 'main.js uses ' + namespace)
    t.deepEqual(used.filter((name) => !available.has(name)), [],
      'every ' + namespace + '.x resolves to an export of ' + file)
    t.end()
  })
}

// Regression guard: the channels main.js spoke before the migration
// each have a named replacement, and dropping one silently would
// otherwise only show up in a manual smoke test.
test('every OS channel main.js used has a shim call', function (t) {
  const used = membersUsed('ipcOs')
  const required = [
    // updateElectron()
    'setTitle', 'setProgress', 'setBadge',
    // dispatch handlers
    'openTorrentFileDialog', 'openFilesDialog', 'toggleFullScreen',
    // applyDimensions() and onFullscreenChanged()
    'setAspectRatio', 'setBounds',
    // setupIpc()
    'signalReady', 'signalStateSaved',
    'onLog', 'onError', 'onDispatch',
    'onFullscreenChanged', 'onWindowBoundsChanged'
  ]
  t.deepEqual(required.filter((name) => !used.has(name)), [],
    'no OS channel was lost in the migration')
  t.end()
})

test('every wt-* listener main.js registered has a shim call',
  function (t) {
    const used = membersUsed('ipcEngine')
    const required = [
      'onTorrentParsed', 'onTorrentMetadata', 'onTorrentDone',
      'onTorrentWarning', 'onTorrentError', 'onProgress',
      'onFileModtimes', 'onTorrentFileSaved', 'onPosterSaved',
      'onAudioMetadata', 'onServerRunning'
    ]
    t.deepEqual(required.filter((name) => !used.has(name)), [],
      'no engine event was lost in the migration')
    t.end()
  })

// `ipcReady` tells the main process the renderer is listening, so it
// must not go out before the listeners are registered. Registration is
// synchronous inside the Electron shim, but the shim's contract is a
// promise, so main.js has to await it -- a non-Electron host is free to
// register asynchronously.
test('main.js awaits its listeners before signalling ready',
  function (t) {
    const ready = main.indexOf('await ipcOs.signalReady()')
    t.ok(ready > 0, 'main.js awaits the ready signal')
    t.ok(/await Promise\.all\(/.test(main.slice(0, ready)),
      'and awaits the listener registrations before it')
    t.end()
  })
