const test = require('tape')
const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')

// US-045: the hidden WebTorrent window and the relay that fed it are
// gone. The UI talks to the sidecar over a WebSocket (US-044,
// ADR-012), so there is no second renderer to host an engine and no
// engine-shaped traffic through `ipcMain` any more.
//
// Two halves, same as the other deletion stories:
//
//   1. a source scan proving each piece of the old topology is
//      actually deleted rather than merely unreachable;
//   2. a behavioural check that `ipc.init()` leaves `ipcMain.emit`
//      alone, so an engine-prefixed event is delivered to its
//      listener instead of being routed on a window title.

const ROOT = path.join(__dirname, '..', '..')

function exists (rel) {
  return fs.existsSync(path.join(ROOT, rel))
}

// Comment lines are dropped before matching: a file that *explains*
// what it no longer does must not fail its own check.
function codeLines (rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => !/^(\/\/|\*|\/\*)/.test(line))
}

function hits (rel, re) {
  return codeLines(rel)
    .filter(({ line }) => re.test(line))
    .map(({ line, n }) => rel + ':' + n + ': ' + line)
}

// --- the deleted files ------------------------------------------------

test('the hidden window and the engine it hosted are deleted',
  function (t) {
    for (const rel of [
      'static/webtorrent.html',
      'src/main/windows/webtorrent.js',
      'src/renderer/webtorrent.js',
      'src/engine/bus-electron.js'
    ]) {
      t.notOk(exists(rel), rel + ' is gone')
    }
    t.end()
  })

test('windows/index.js exports only the two real windows', function (t) {
  t.deepEqual(hits('src/main/windows/index.js', /webtorrent/i), [],
    'no webtorrent export')
  t.ok(exists('src/main/windows/about.js'), 'about.js survives')
  t.ok(exists('src/main/windows/main.js'), 'main.js survives')
  t.end()
})

// --- the relay --------------------------------------------------------

test('the ipcMain relay is gone from src/main/ipc.js', function (t) {
  const rel = 'src/main/ipc.js'
  t.deepEqual(hits(rel, /ipcMain\.emit/), [], 'no ipcMain.emit override')
  t.deepEqual(hits(rel, /messageQueueMainToWebTorrent/), [],
    'no queue for the hidden window')
  t.deepEqual(hits(rel, /ipcReadyWebTorrent/), [],
    'no hidden-window handshake')
  t.deepEqual(hits(rel, /windows\.webtorrent/), [],
    'nothing sends to the hidden window')
  t.deepEqual(hits(rel, /wt-/), [],
    'no engine channel name reaches the host process')
  t.end()
})

test('nothing creates or reveals the hidden window', function (t) {
  t.deepEqual(hits('src/main/index.js', /windows\.webtorrent/), [],
    'src/main/index.js does not init it')
  t.deepEqual(hits('src/main/menu.js', /windows\.webtorrent/), [],
    'the menu has no devtools item for it')
  t.deepEqual(hits('src/config.js', /WINDOW_WEBTORRENT/), [],
    'config no longer resolves its HTML entry point')
  t.end()
})

// --- build wiring -----------------------------------------------------

test('every path in the build:main --ignore list exists', function (t) {
  const script = require(path.join(ROOT, 'package.json')).scripts['build:main']
  const match = script.match(/--ignore\s+"([^"]+)"/)
  t.ok(match, 'found the --ignore list')

  const globs = match[1].split(',')
  t.ok(globs.length > 0, 'the list is not empty')
  for (const glob of globs) {
    // Each entry is either a file or a `dir/**/*` glob; the directory
    // prefix is what has to exist either way.
    const rel = glob.replace(/\/\*\*.*$/, '')
    t.ok(exists(rel), rel + ' exists')
  }
  t.end()
})

// --- webPreferences ---------------------------------------------------

// `nodeIntegration` and `enableBlinkFeatures: 'AudioVideoTracks'` are
// still load-bearing under Electron -- the CJS renderer bundle's
// `require()` externals need the first (ADR-004) and `player-page.js`
// enumerates `mediaElement.audioTracks` with the second. Only
// `enableRemoteModule`, a no-op since Electron 14, can go now.
test('no window asks for the remote module in its webPreferences',
  function (t) {
    const offenders = []
    const walk = (dir) => {
      for (const entry of fs.readdirSync(path.join(ROOT, dir))) {
        const rel = dir + '/' + entry
        if (fs.statSync(path.join(ROOT, rel)).isDirectory()) walk(rel)
        else if (rel.endsWith('.js')) {
          offenders.push(...hits(rel, /enableRemoteModule/))
        }
      }
    }
    walk('src/main')
    t.deepEqual(offenders, [], 'enableRemoteModule is gone from src/main/')
    t.end()
  })

// --- behaviour --------------------------------------------------------

// `ipc.js` destructures `electron` at module scope, so every stub has
// to be seeded before the first require. Previous entries are restored
// rather than deleted: the tape process is shared and a later-loaded
// file may be relying on a seed an earlier one placed.
const ipcMain = new EventEmitter()
const app = new EventEmitter()

const sent = []
const windowsStub = {
  main: {
    send: (...args) => sent.push(args),
    setAspectRatio () {},
    setBounds () {},
    setProgress () {},
    setTitle () {},
    show () {},
    toggleFullScreen () {}
  },
  about: {}
}

const logStub = () => {}
logStub.error = () => {}

const seeded = []
function seed (id, exports) {
  const filename = require.resolve(id)
  seeded.push({ filename, prev: require.cache[filename] })
  require.cache[filename] = { id: filename, filename, loaded: true, exports }
}

seed('electron', { app, ipcMain })
seed('../../build/main/log', logStub)
seed('../../build/main/menu', { setAllowNav () {}, togglePlaybackControls () {} })
seed('../../build/main/windows', windowsStub)

const ipc = require('../../build/main/ipc')

for (const { filename, prev } of seeded) {
  if (prev) require.cache[filename] = prev
  else delete require.cache[filename]
}

test('ipc.init() does not replace ipcMain.emit', function (t) {
  const before = ipcMain.emit
  ipc.init()
  t.equal(ipcMain.emit, before, 'emit is still EventEmitter.prototype.emit')
  t.end()
})

test('an engine-prefixed event reaches its own listener', function (t) {
  // The old relay swallowed anything matching the engine prefix and
  // routed it on the sending window's title instead.
  const seen = []
  ipcMain.on('wt-progress', (e, ...args) => seen.push(args))
  ipcMain.emit('wt-progress', { sender: { getTitle: () => 'Main Window' } }, 0.5)

  t.deepEqual(seen, [[0.5]], 'the listener saw the payload')
  t.deepEqual(sent, [], 'nothing was forwarded to a window')
  t.end()
})
