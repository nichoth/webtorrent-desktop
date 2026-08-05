const test = require('tape')
const fs = require('fs')
const os = require('os')
const path = require('path')

// `lib/migrations.js` reads its paths from `src/config`, so seeding
// `require.cache` for the *built* config with a temp-dir copy lets the
// migrations run for real against a throwaway profile. The stub has to
// look like a Babel-compiled ES module (`__esModule` plus `default`),
// because migrations imports it as a default import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-migrations-'))
const CONFIG = {
  APP_VERSION: '9.9.9',
  POSTER_PATH: path.join(TMP, 'Posters'),
  TORRENT_PATH: path.join(TMP, 'Torrents')
}
fs.mkdirSync(CONFIG.POSTER_PATH, { recursive: true })
fs.mkdirSync(CONFIG.TORRENT_PATH, { recursive: true })

const configPath = require.resolve('../../build/config')
require.cache[configPath] = {
  id: configPath,
  filename: configPath,
  loaded: true,
  exports: { __esModule: true, default: CONFIG }
}

// There used to be a `STATIC_PATH` in the config above, which the
// migrations joined paths onto. Since US-072 the bundled defaults are
// fetched relative to the document through `lib/static-asset.js` --
// in a packaged build they are embedded in the binary and no
// filesystem path names them. Stubbed here with the same contract over
// the repo's real `static/`, so the copies below are still real ones.
const assetPath = require.resolve('../../build/renderer/lib/static-asset')
const previousAsset = require.cache[assetPath]
const assetReads = []
require.cache[assetPath] = {
  id: assetPath,
  filename: assetPath,
  loaded: true,
  exports: {
    __esModule: true,
    url: (name) => 'tauri://localhost/static/' + name,
    read: async (name) => {
      assetReads.push(name)
      return new Uint8Array(
        fs.readFileSync(path.join(__dirname, '..', '..', 'static', name))
      )
    }
  }
}

// Since US-030 the file-handler reinstall goes through the OS IPC shim
// rather than `ipcRenderer` directly, so the stub sits on the shim.
const sent = []
const ipcOsPath = require.resolve(
  '../../build/renderer/lib/platform/ipc-os'
)
require.cache[ipcOsPath] = {
  id: ipcOsPath,
  filename: ipcOsPath,
  loaded: true,
  exports: {
    __esModule: true,
    async setDefaultFileHandler (...args) {
      sent.push(['setDefaultFileHandler', ...args])
    }
  }
}

// Since US-072 the fs shim is nine Tauri commands, which need a
// running host. `test/fs-shim.js` is the filesystem-backed stand-in
// that lets the real migrations run against the throwaway profile
// above; `platform-fs.js` holds the real shim to the same contract.
const fsShimPath = require.resolve(
  '../../build/renderer/lib/platform/fs'
)
const previousFsShim = require.cache[fsShimPath]
require.cache[fsShimPath] = {
  id: fsShimPath,
  filename: fsShimPath,
  loaded: true,
  exports: require('../fs-shim')
}

const migrations = require('../../build/renderer/lib/migrations')

// `require.cache` is process-wide, so every stub is withdrawn now that
// `migrations` has bound it -- `platform-ipc-os.js`, `platform-fs.js`
// and `static-asset.js` later in the same run test the real modules.
delete require.cache[ipcOsPath]
if (previousFsShim) require.cache[fsShimPath] = previousFsShim
else delete require.cache[fsShimPath]
if (previousAsset) require.cache[assetPath] = previousAsset
else delete require.cache[assetPath]

const PLAIN_HASH = 'aaaabbbbccccddddeeeeffff0000111122223333'
const OTHER_HASH = '4444555566667777888899990000aaaabbbbcccc'
const OLD_HASH = '3ba219a8634bf7bae3d848192b2da75ae995589d'
const NEW_HASH = 'a88fda5954e89178c372716a6a78b8180ed4dad3'

// A pre-0.7.0 config: `version: 1`, no `prefs` at all, and torrents
// that still carry `torrentPath`/`posterURL` for migrate_0_7_0 to copy
// into the profile directory.
function preSemverState () {
  return {
    saved: {
      version: 1,
      torrents: [{
        infoHash: PLAIN_HASH,
        torrentPath: 'sintel.torrent',
        posterURL: 'sintel.jpg'
      }]
    }
  }
}

// A 0.17.0 config holding the WIRED CD torrent, which migrate_0_17_2
// renames, re-copies and rehashes. It cannot be combined with the
// state above: migrate_0_7_0 deletes `ts.files`, which 0_17_2 needs.
function wiredCdState () {
  return {
    saved: {
      version: '0.17.0',
      prefs: { isFileHandler: true },
      torrents: [{
        infoHash: OLD_HASH,
        name: 'The WIRED CD - Rip. Sample. Mash. Share.',
        magnetURI: 'magnet:?xt=urn:btih:' + OLD_HASH,
        posterFileName: OLD_HASH + '.jpg',
        torrentFileName: OLD_HASH + '.torrent',
        files: [{ path: 'The WIRED CD - Rip. Sample. Mash. Share./a.mp3' }]
      }]
    }
  }
}

test('migrations.run is awaitable', function (t) {
  const result = migrations.run(preSemverState())
  t.equal(typeof result.then, 'function', 'returns a promise')
  result.then(() => t.end(), (err) => t.end(err))
})

// The same config as `preSemverState`, in the older of the two
// relative spellings the comment in `migrate_0_7_0` lists. Both named
// a default torrent; the difference is only which release wrote it.
function preSemverStateWithRepoPaths () {
  return {
    saved: {
      version: 1,
      torrents: [{
        infoHash: PLAIN_HASH,
        torrentPath: '../static/sintel.torrent',
        posterURL: '../static/sintel.jpg'
      }]
    }
  }
}

test('migrations finish their filesystem work before resolving',
  async function (t) {
    const state = preSemverState()
    assetReads.length = 0
    await migrations.run(state)

    t.ok(
      fs.existsSync(path.join(CONFIG.TORRENT_PATH, PLAIN_HASH + '.torrent')),
      'migrate_0_7_0 copied the torrent file'
    )
    t.ok(
      fs.existsSync(path.join(CONFIG.POSTER_PATH, PLAIN_HASH + '.jpg')),
      'migrate_0_7_0 copied the poster'
    )
    t.deepEqual(
      assetReads.slice().sort(),
      ['sintel.jpg', 'sintel.torrent'],
      'both came from the bundle, by name'
    )
    t.end()
  })

test('a default named by an old repo-relative path still migrates',
  async function (t) {
    // `'../static/sintel.torrent'` was resolved against the working
    // directory under Electron, which a webview does not have either.
    // Both relative spellings name the same bundled file, so both are
    // read from the bundle now -- the leading `../static/` is a fact
    // about the repository layout in 2016, not about the user's disk.
    const state = preSemverStateWithRepoPaths()
    fs.rmSync(path.join(CONFIG.TORRENT_PATH, PLAIN_HASH + '.torrent'),
      { force: true })
    assetReads.length = 0

    await migrations.run(state)

    t.deepEqual(
      assetReads.slice().sort(),
      ['sintel.jpg', 'sintel.torrent'],
      'the directory prefix was dropped, not looked up'
    )
    t.ok(
      fs.existsSync(path.join(CONFIG.TORRENT_PATH, PLAIN_HASH + '.torrent')),
      'and the torrent landed in the profile'
    )
    t.end()
  })

test('an absolute path is still copied off the filesystem',
  async function (t) {
    // The third spelling: a real file of the user's, which is a path
    // and stays one. Only the bundled defaults moved.
    const source = path.join(TMP, 'user-supplied.torrent')
    fs.copyFileSync(
      path.join(__dirname, '..', '..', 'static', 'sintel.torrent'),
      source
    )
    assetReads.length = 0

    await migrations.run({
      saved: {
        version: 1,
        torrents: [{ infoHash: OTHER_HASH, torrentPath: source }]
      }
    })

    t.deepEqual(assetReads, [], 'the bundle was not consulted')
    t.ok(
      fs.existsSync(path.join(CONFIG.TORRENT_PATH, OTHER_HASH + '.torrent')),
      'the user\'s own file was copied through the fs shim'
    )
    t.end()
  })

test('the WIRED CD migration completes before run() resolves',
  async function (t) {
    const state = wiredCdState()
    await migrations.run(state)

    t.ok(
      fs.existsSync(path.join(CONFIG.TORRENT_PATH, NEW_HASH + '.torrent')),
      'migrate_0_17_2 copied the fixed WIRED CD torrent'
    )
    const ts = state.saved.torrents[0]
    t.equal(ts.infoHash, NEW_HASH, 'torrent was rehashed')
    t.equal(ts.name, 'The WIRED CD - Rip. Sample. Mash. Share',
      'trailing dot was stripped')
    t.end()
  })

test('migrations run in version order', async function (t) {
  // migrate_0_7_2 creates `saved.prefs`; migrate_0_11_0 and everything
  // after it read through it. Out of order, the later ones would throw
  // on undefined.
  const state = preSemverState()
  await migrations.run(state)

  t.equal(state.saved.prefs.isFileHandler, true,
    'migrate_0_11_0 ran after migrate_0_7_2 created prefs')
  t.equal(state.saved.prefs.soundNotifications, true,
    'migrate_0_21_0 ran too')
  t.equal(state.saved.prefs.externalPlayerPath, '',
    'migrate_0_22_0 ran too')
  t.equal(state.saved.version, CONFIG.APP_VERSION,
    'config is stamped with the app version')
  t.end()
})

test('migrations reinstall the file handler on upgrade', async function (t) {
  sent.length = 0
  await migrations.run(wiredCdState())
  t.deepEqual(sent, [['setDefaultFileHandler', true]],
    'setDefaultFileHandler was sent once')
  t.end()
})

test('teardown', function (t) {
  fs.rmSync(TMP, { recursive: true, force: true })
  t.end()
})
