const test = require('tape')
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')

// US-029: the torrent row context menu, built as descriptors and handed
// to `lib/platform/menu.js`.
//
// Controllers are excluded from `build:main` (see the `--ignore` list in
// package.json), so unlike every other unit test here there is no
// prebuilt copy to require. We run the same Babel config over the one
// controller under test and emit it into `build/renderer/controllers/`,
// where its relative imports resolve against the real built
// `build/renderer/lib/**`. See test/AGENTS.md.

const ROOT = path.join(__dirname, '..', '..')
const SRC = path.join(
  ROOT, 'src', 'renderer', 'controllers', 'torrent-list-controller.js'
)
const OUT_DIR = path.join(ROOT, 'build', 'renderer', 'controllers')
const OUT = path.join(OUT_DIR, 'torrent-list-controller.js')

fs.mkdirSync(OUT_DIR, { recursive: true })
fs.writeFileSync(
  OUT, babel.transformFileSync(SRC, { root: ROOT, cwd: ROOT }).code
)

// Recording state. Every stub below is a stable object whose behaviour
// reads from here, because Babel binds each stub's `exports` object once
// (test/AGENTS.md).
let record = null

function reset (platform = 'darwin') {
  record = {
    menus: [], dispatches: [], sent: [], copied: [], shell: [], platform
  }
  // `lib/dispatcher` holds one process-wide dispatch and every unit
  // test file that requires it registers its own. Re-register per test
  // rather than once at require time, or whichever file loads last
  // wins for the whole run.
  setDispatch((...args) => record.dispatches.push(args))
}

function stub (modulePath, exports) {
  const id = require.resolve(modulePath)
  require.cache[id] = { id, filename: id, loaded: true, exports }
}

stub('electron', {
  __esModule: true,
  ipcRenderer: {
    send (...args) { record.sent.push(args) },
    on () {},
    once () {},
    removeListener () {}
  }
})

// The controller pulls in the dialog and window shims transitively;
// they only need to be requirable here, never called.
stub('@electron/remote', {
  __esModule: true,
  dialog: {},
  getCurrentWindow: () => ({}),
  Menu: class { append () {} popup () {} },
  MenuItem: class {}
})

const BUILT = path.join(ROOT, 'build', 'renderer')
const { setDispatch } = require(path.join(BUILT, 'lib', 'dispatcher'))

stub(path.join(BUILT, 'lib', 'platform', 'menu'), {
  __esModule: true,
  async showContextMenu (items) { record.menus.push(items) }
})
stub(path.join(BUILT, 'lib', 'platform', 'clipboard'), {
  __esModule: true,
  async writeText (text) { record.copied.push(text) }
})
// US-030 moved the reveal and trash channels onto the shell shim.
stub(path.join(BUILT, 'lib', 'platform', 'shell'), {
  __esModule: true,
  async showItemInFolder (p) { record.shell.push(['showItemInFolder', p]) },
  async moveItemToTrash (p) { record.shell.push(['moveItemToTrash', p]) }
})

// US-072: the reveal item's label is the one string in this menu that
// depends on the OS, and the controller reads it from `lib/os.js` now
// rather than from `process.platform` -- the webview it runs in has no
// such global. It is stubbed rather than left to answer for itself so
// that both labels are exercised on every machine: read live it would
// report whichever OS the suite happens to run on, and under plain
// Node it reports the fallback, so the macOS branch would go
// unasserted everywhere.
stub(path.join(BUILT, 'lib', 'os'), {
  __esModule: true,
  platform: () => record.platform,
  isDarwin: () => record.platform === 'darwin',
  isWindows: () => record.platform === 'win32',
  isLinux: () => record.platform === 'linux'
})

const TorrentListController = require(OUT).default

const INFO_HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

// A torrent summary with files, a saved .torrent file and a magnet URI:
// the longest of the two menu shapes, with every item enabled.
function makeState (overrides = {}) {
  const summary = Object.assign({
    torrentKey: 7,
    infoHash: INFO_HASH,
    name: 'Test Torrent',
    magnetURI: 'magnet:?xt=urn:btih:' + INFO_HASH,
    torrentFileName: 'test.torrent',
    path: '/tmp/downloads',
    files: [{ path: 'Test Torrent/one.mp4', length: 10 }]
  }, overrides.summary || {})

  return {
    saved: {
      torrents: [summary],
      prefs: {
        downloadPath: '/tmp/downloads',
        sortByName: overrides.sortByName === true
      }
    },
    location: { url: () => 'home' }
  }
}

function openMenu (overrides = {}) {
  reset(overrides.platform)
  const controller = new TorrentListController(makeState(overrides))
  controller.openTorrentContextMenu(INFO_HASH)
  return record.menus[0]
}

function itemNamed (items, label) {
  return items.find((item) => item.label === label)
}

test('the context menu is handed to the menu shim as descriptors',
  function (t) {
    const items = openMenu()
    t.equal(record.menus.length, 1, 'showContextMenu called exactly once')
    t.ok(Array.isArray(items), 'it is passed an array')
    for (const item of items) {
      t.equal(Object.getPrototypeOf(item), Object.prototype,
        'every entry is a plain object, not a MenuItem')
    }
    t.end()
  })

test('a torrent with files gets the full menu, in order', function (t) {
  const items = openMenu()
  t.deepEqual(items.map((i) => i.label || '--separator--'), [
    'Remove From List',
    'Remove Data File',
    '--separator--',
    'Show in Finder',
    '--separator--',
    'Copy Magnet Link to Clipboard',
    'Copy Instant.io Link to Clipboard',
    'Save Torrent File As...',
    '--separator--',
    'Sort by Name'
  ], 'labels and separators are unchanged')
  t.end()
})

// US-072. The label is the only thing that moves, and only the
// reveal item moves it -- asserted item by item rather than as a
// whole-menu deepEqual so a regression says which one changed.
test('the reveal item is named for the platform file manager',
  function (t) {
    for (const [platform, label] of [
      ['darwin', 'Show in Finder'],
      ['win32', 'Show in Folder'],
      ['linux', 'Show in Folder']
    ]) {
      const labels = openMenu({ platform }).map((i) => i.label)
      t.ok(labels.includes(label), `${platform} says ${label}`)
      t.equal(labels.filter(Boolean).length, 7,
        `${platform} gets the same seven items`)
    }
    t.end()
  })

test('a torrent with no files drops the reveal item and its separator',
  function (t) {
    const items = openMenu({ summary: { files: undefined } })
    t.deepEqual(items.map((i) => i.label || '--separator--'), [
      'Remove From List',
      'Remove Data File',
      '--separator--',
      'Copy Magnet Link to Clipboard',
      'Copy Instant.io Link to Clipboard',
      'Save Torrent File As...',
      '--separator--',
      'Sort by Name'
    ], 'only the reveal item and the separator after it are gone')
    t.end()
  })

test('separators carry nothing but their type', function (t) {
  const separators = openMenu().filter((i) => i.type === 'separator')
  t.equal(separators.length, 3, 'three separators')
  for (const sep of separators) {
    t.equal(sep.label, undefined, 'no label')
    t.equal(sep.click, undefined, 'no click')
  }
  t.end()
})

test('Save Torrent File As... is enabled only with a saved .torrent',
  function (t) {
    const withFile = itemNamed(openMenu(), 'Save Torrent File As...')
    t.equal(withFile.enabled, true, 'enabled when torrentFileName is set')

    const without = itemNamed(
      openMenu({ summary: { torrentFileName: undefined } }),
      'Save Torrent File As...'
    )
    t.equal(without.enabled, false, 'disabled when it is missing')
    t.end()
  })

test('no other item sets enabled', function (t) {
  const items = openMenu().filter(
    (i) => i.type !== 'separator' && i.label !== 'Save Torrent File As...'
  )
  t.equal(items.length, 6, 'six unconditionally enabled items')
  for (const item of items) {
    t.equal(item.enabled, undefined, item.label + ' leaves enabled alone')
  }
  t.end()
})

test('Sort by Name shows a check mark when sorting by name is on',
  function (t) {
    t.ok(itemNamed(openMenu({ sortByName: false }), 'Sort by Name'),
      'unchecked when off')
    const items = openMenu({ sortByName: true })
    t.ok(itemNamed(items, '✓ Sort by Name'),
      'checked when on')
    t.end()
  })

test('the remove items dispatch confirmDeleteTorrent', function (t) {
  const items = openMenu()
  reset()
  itemNamed(items, 'Remove From List').click()
  itemNamed(items, 'Remove Data File').click()
  t.deepEqual(record.dispatches, [
    ['confirmDeleteTorrent', INFO_HASH, false],
    ['confirmDeleteTorrent', INFO_HASH, true]
  ], 'the data flag is the only difference')
  t.end()
})

test('the reveal item asks the host to show the file', function (t) {
  // `openMenu()` builds on darwin, so this is the Finder spelling. The
  // click handler behind either label is the same one.
  const items = openMenu()
  reset()
  itemNamed(items, 'Show in Finder').click()
  t.deepEqual(record.shell, [
    ['showItemInFolder', path.join('/tmp/downloads', 'Test Torrent')]
  ], 'sends the torrent folder')
  t.end()
})

test('the copy items write the right text to the clipboard', function (t) {
  const items = openMenu()
  reset()
  itemNamed(items, 'Copy Magnet Link to Clipboard').click()
  itemNamed(items, 'Copy Instant.io Link to Clipboard').click()
  t.deepEqual(record.copied, [
    'magnet:?xt=urn:btih:' + INFO_HASH,
    'https://instant.io/#' + INFO_HASH
  ], 'magnet URI and instant.io link')
  t.end()
})

test('Save Torrent File As... dispatches with the torrent key',
  function (t) {
    const items = openMenu()
    reset()
    itemNamed(items, 'Save Torrent File As...').click()
    t.deepEqual(record.dispatches, [['saveTorrentFileAs', 7]],
      'passes the torrent key, not the info hash')
    t.end()
  })

test('Sort by Name toggles the preference', function (t) {
  const off = openMenu({ sortByName: false })
  reset()
  itemNamed(off, 'Sort by Name').click()
  t.deepEqual(record.dispatches, [['updatePreferences', 'sortByName', true]],
    'turns sorting on')

  const on = openMenu({ sortByName: true })
  reset()
  itemNamed(on, '✓ Sort by Name').click()
  t.deepEqual(record.dispatches, [['updatePreferences', 'sortByName', false]],
    'turns sorting off')
  t.end()
})

test('a click handler takes no arguments from the menu', function (t) {
  const items = openMenu().filter((i) => i.type !== 'separator')
  for (const item of items) {
    t.equal(item.click.length, 0, item.label + ' click takes no parameters')
  }
  t.end()
})
