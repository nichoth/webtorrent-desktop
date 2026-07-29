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
  STATIC_PATH: path.join(__dirname, '..', '..', 'static'),
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

const migrations = require('../../build/renderer/lib/migrations')

// `require.cache` is process-wide, so the shim stub is withdrawn now
// that `migrations` has bound it -- `platform-ipc-os.js` later in the
// same run tests the real module.
delete require.cache[ipcOsPath]

const PLAIN_HASH = 'aaaabbbbccccddddeeeeffff0000111122223333'
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

test('migrations finish their filesystem work before resolving',
  async function (t) {
    const state = preSemverState()
    await migrations.run(state)

    t.ok(
      fs.existsSync(path.join(CONFIG.TORRENT_PATH, PLAIN_HASH + '.torrent')),
      'migrate_0_7_0 copied the torrent file'
    )
    t.ok(
      fs.existsSync(path.join(CONFIG.POSTER_PATH, PLAIN_HASH + '.jpg')),
      'migrate_0_7_0 copied the poster'
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
