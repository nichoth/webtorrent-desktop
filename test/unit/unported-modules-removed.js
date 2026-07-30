const test = require('tape')
const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')

// US-053: five modules are deleted rather than ported to the Tauri
// host -- the Windows Squirrel event handler, the Windows thumbnail
// toolbar, the Windows jump list, the remote announcement fetcher and
// the Electron crash reporter. See docs/init.md.
//
// Three halves, same shape as US-045's deletion story:
//
//   1. a source scan proving each file is actually deleted and that
//      nothing in `src/` still names it;
//   2. a scan of the two call-site files for the specific fragments
//      the story calls out;
//   3. a behavioural check that the player IPC handlers survive the
//      thumbar's removal -- `onPlayerUpdate` still reaches
//      `menu.onPlayerUpdate`, and play/pause still drive the power
//      save blocker.

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

function sourceFiles (dir, out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir))) {
    const rel = dir + '/' + entry
    if (fs.statSync(path.join(ROOT, rel)).isDirectory()) sourceFiles(rel, out)
    else if (rel.endsWith('.js')) out.push(rel)
  }
  return out
}

// --- the deleted files ------------------------------------------------

const DELETED = [
  'src/main/squirrel-win32.js',
  'src/main/thumbar.js',
  'src/main/user-tasks.js',
  'src/main/announcement.js',
  'src/crash-reporter.js'
]

test('the unported modules are deleted', function (t) {
  for (const rel of DELETED) {
    t.notOk(exists(rel), rel + ' is gone')
  }
  t.end()
})

// The thumbar's button icons exist for no other caller.
test('the thumbnail toolbar icons are deleted', function (t) {
  for (const icon of [
    'PreviousTrackThumbnailBarButton.png',
    'PlayThumbnailBarButton.png',
    'PauseThumbnailBarButton.png',
    'NextTrackThumbnailBarButton.png'
  ]) {
    t.notOk(exists('static/' + icon), 'static/' + icon + ' is gone')
  }
  t.end()
})

test('nothing under src/ names a deleted module', function (t) {
  const re = /squirrel|thumbar|user-?tasks|announcement|crash-?report/i
  const offenders = []
  for (const rel of sourceFiles('src')) offenders.push(...hits(rel, re))
  t.deepEqual(offenders, [], 'no surviving reference')
  t.end()
})

// --- the specific call sites ------------------------------------------

test('src/main/index.js has no win32 startup branches', function (t) {
  const rel = 'src/main/index.js'
  t.deepEqual(hits(rel, /--squirrel/), [], 'no squirrel argv filtering')
  t.deepEqual(hits(rel, /crashReporter/), [], 'no crash reporter init')
  t.deepEqual(hits(rel, /userTasks/), [], 'no jump list init')
  t.deepEqual(hits(rel, /announcement/i), [], 'no announcement init')
  t.end()
})

test('src/main/ipc.js keeps only the menu half of the player events',
  function (t) {
    const rel = 'src/main/ipc.js'
    t.deepEqual(hits(rel, /thumbar/i), [], 'no thumbar require or call')
    t.ok(hits(rel, /menu\.onPlayerUpdate/).length === 1,
      'menu.onPlayerUpdate survives')
    t.end()
  })

// --- behaviour --------------------------------------------------------

// `ipc.js` destructures `electron` at module scope, so every stub has
// to be seeded before the first require. It is also already cached by
// test/unit/hidden-window-removed.js, which loads first and bound it
// to *its* stubs -- so take a private instance and put the shared one
// back afterwards.

const seeded = []
function seed (id, exports) {
  const filename = require.resolve(id)
  seeded.push({ filename, prev: require.cache[filename] })
  require.cache[filename] = { id: filename, filename, loaded: true, exports }
}

function withdraw () {
  let entry
  while ((entry = seeded.pop())) {
    if (entry.prev) require.cache[entry.filename] = entry.prev
    else delete require.cache[entry.filename]
  }
}

const ipcMain = new EventEmitter()
const app = new EventEmitter()

const calls = []
const record = name => (...args) => calls.push([name, ...args])

const menuStub = {
  setAllowNav: record('menu.setAllowNav'),
  togglePlaybackControls: record('menu.togglePlaybackControls'),
  onPlayerUpdate: record('menu.onPlayerUpdate')
}

const windowsStub = {
  main: {
    send: record('windows.main.send'),
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

const ipcFilename = require.resolve('../../build/main/ipc')
const sharedIpc = require.cache[ipcFilename]
delete require.cache[ipcFilename]

seed('electron', { app, ipcMain })
seed('../../build/main/log', logStub)
seed('../../build/main/menu', menuStub)
seed('../../build/main/windows', windowsStub)

const ipc = require(ipcFilename)

withdraw()
if (sharedIpc) require.cache[ipcFilename] = sharedIpc
else delete require.cache[ipcFilename]

// `power-save-blocker` and `shortcuts` are required lazily, inside the
// handlers, so their stubs have to still be in place when the event
// fires. Seeded for the behavioural tests only and withdrawn straight
// after -- the tape process is shared with every other unit file.
test('seed the lazily-required player modules', function (t) {
  seed('../../build/main/power-save-blocker', {
    enable: record('powerSaveBlocker.enable'),
    disable: record('powerSaveBlocker.disable')
  })
  seed('../../build/main/shortcuts', {
    enable: record('shortcuts.enable'),
    disable: record('shortcuts.disable')
  })
  ipc.init()
  t.pass('ipc.init() registered its listeners')
  t.end()
})

test('onPlayerUpdate reaches the menu and nothing else', function (t) {
  calls.length = 0
  ipcMain.emit('onPlayerUpdate', {}, true, false)
  t.deepEqual(calls, [['menu.onPlayerUpdate', true, false]],
    'the menu got hasNext and hasPrevious')
  t.end()
})

test('opening and closing the player still toggles the menu items',
  function (t) {
    calls.length = 0
    ipcMain.emit('onPlayerOpen', {})
    t.deepEqual(calls, [
      ['menu.togglePlaybackControls', true],
      ['powerSaveBlocker.enable'],
      ['shortcuts.enable']
    ], 'open enables the playback controls')

    calls.length = 0
    ipcMain.emit('onPlayerClose', {})
    t.deepEqual(calls, [
      ['menu.togglePlaybackControls', false],
      ['powerSaveBlocker.disable'],
      ['shortcuts.disable']
    ], 'close disables them again')
    t.end()
  })

test('play and pause still drive the power save blocker', function (t) {
  calls.length = 0
  ipcMain.emit('onPlayerPlay', {})
  t.deepEqual(calls, [['powerSaveBlocker.enable']], 'play blocks sleep')

  calls.length = 0
  ipcMain.emit('onPlayerPause', {})
  t.deepEqual(calls, [['powerSaveBlocker.disable']], 'pause releases it')
  t.end()
})

test('handing off to an external player still releases the playback UI',
  function (t) {
    seed('../../build/main/external-player', {
      spawn: record('externalPlayer.spawn')
    })
    calls.length = 0
    ipcMain.emit('openExternalPlayer', {}, 'vlc')
    t.deepEqual(calls, [
      ['menu.togglePlaybackControls', false],
      ['shortcuts.disable'],
      ['externalPlayer.spawn', 'vlc']
    ], 'no thumbar call between them')
    t.end()
  })

test('withdraw the lazily-required player stubs', function (t) {
  withdraw()
  t.pass('require.cache restored')
  t.end()
})
