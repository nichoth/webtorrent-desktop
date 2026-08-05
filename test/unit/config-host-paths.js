const test = require('tape')

// US-072: `src/config.js` learns its user-data paths from the host.
//
// Under Electron the renderer resolved them itself, through
// `application-config`, which reads `os.platform()` and
// `process.env.HOME`. A webview has neither, so `getConfigPath()`
// returns `''` there and every path derived from it is a relative one
// that matches nothing -- which is not a broken feature but a dead
// app: `State.load` cannot read or create `config.json`, the failure
// reaches `onError` before there is a state to record it in, and the
// window stays blank.
//
// The host has resolved the same layout since US-054
// (`src-tauri/src/paths.rs`); `useHostPaths` is where its answer lands.
// `src/renderer/main.js` calls it once, before `State.load`.
//
// The module is a singleton in `require.cache` and this file mutates
// it, so every test restores what it found. Nothing else in the suite
// reads the real config -- `state-file.js` and `migrations.js` seed
// stubs of their own -- but that is not a property to rely on.

const config = require('../../build/config')

// What `AppPaths` serializes to, camelCased by serde. Deliberately not
// the platform's real answer: the point of the call is that the
// renderer cannot compute one.
const HOST = {
  configPath: '/host/Application Support/WebTorrent',
  torrentPath: '/host/Application Support/WebTorrent/Torrents',
  posterPath: '/host/Application Support/WebTorrent/Posters',
  tempPath: '/host/tmp',
  defaultDownloadPath: '/host/Downloads',
  isPortable: false
}

// Every key `useHostPaths` is allowed to move, and the host key each
// one comes from.
const MOVED = {
  CONFIG_PATH: 'configPath',
  TORRENT_PATH: 'torrentPath',
  POSTER_PATH: 'posterPath',
  DEFAULT_DOWNLOAD_PATH: 'defaultDownloadPath',
  IS_PORTABLE: 'isPortable'
}

function snapshot () {
  const before = {}
  for (const key of Object.keys(MOVED)) {
    before[key] = { named: config[key], object: config.default[key] }
  }
  return before
}

function restore (before) {
  const undo = {}
  for (const key of Object.keys(MOVED)) undo[key] = before[key].named
  config.useHostPaths({
    configPath: undo.CONFIG_PATH,
    torrentPath: undo.TORRENT_PATH,
    posterPath: undo.POSTER_PATH,
    defaultDownloadPath: undo.DEFAULT_DOWNLOAD_PATH,
    isPortable: undo.IS_PORTABLE
  })
}

function withHostPaths (paths, fn) {
  const before = snapshot()
  config.useHostPaths(paths)
  try {
    return fn(before)
  } finally {
    restore(before)
  }
}

test('useHostPaths moves every path the host owns', function (t) {
  withHostPaths(HOST, function () {
    for (const [key, hostKey] of Object.entries(MOVED)) {
      t.equal(config.default[key], HOST[hostKey],
        `config.${key} is the host's ${hostKey}`)
    }
  })
  t.end()
})

test('both spellings of the same value stay in sync', function (t) {
  // `src/config.js` exports every value twice -- as a named export and
  // as a key of the default object -- and its own header says the two
  // must be kept in sync. Half the codebase reads `config.CONFIG_PATH`
  // and the engine destructures; a bootstrap that updated only one
  // would give the two halves different answers with nothing failing.
  withHostPaths(HOST, function () {
    for (const [key, hostKey] of Object.entries(MOVED)) {
      t.equal(config[key], HOST[hostKey], `the named ${key} moved too`)
      t.equal(config[key], config.default[key], `${key} agrees with itself`)
    }
  })
  t.end()
})

test('nothing else moves', function (t) {
  // The bootstrap is a path bootstrap. An `Object.assign` of the whole
  // payload would quietly add `tempPath` and any future field of
  // `AppPaths` as config keys nobody declared.
  const before = { ...config.default }
  withHostPaths(HOST, function () {
    const after = config.default
    for (const key of Object.keys(before)) {
      if (key in MOVED) continue
      t.deepEqual(after[key], before[key], `${key} is untouched`)
    }
    const added = Object.keys(after).filter((k) => !(k in before))
    t.deepEqual(added, [], 'no new keys appeared')
  })
  t.end()
})

test('the paths are restored afterwards', function (t) {
  // Guarding the guard: if `restore` did not work, every assertion
  // above would be leaking a fake path into the rest of the run.
  const before = snapshot()
  withHostPaths(HOST, function () {})
  for (const key of Object.keys(MOVED)) {
    t.equal(config[key], before[key].named, `${key} came back`)
    t.equal(config.default[key], before[key].object, 'and so did the key')
  }
  t.end()
})
