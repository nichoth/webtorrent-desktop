const test = require('tape')

// US-072: the renderer's user-data paths come from the host.
//
// `src/config.js` resolved them itself under Electron, by asking
// `application-config` where the platform keeps application support
// directories -- which reads `os.platform()` and `process.env.HOME`.
// The webview has neither, so the answer has to cross the shim, and
// `src-tauri/src/paths.rs` has been the one resolving it since US-054.
//
// The stub is seeded at `@tauri-apps/api/core`, the route every shim
// test in this directory uses (test/AGENTS.md).

const corePath = require.resolve('@tauri-apps/api/core')

let invocations = []
let handler = async () => null

const coreStub = {
  __esModule: true,
  async invoke (command, args) {
    invocations.push({ command, args })
    return handler(command, args)
  }
}

require.cache[corePath] = {
  id: corePath,
  filename: corePath,
  loaded: true,
  exports: coreStub
}

const paths = require('../../build/renderer/lib/platform/paths')

// What `AppPaths` serializes to. The Rust struct carries
// `#[serde(rename_all = "camelCase")]`, so these are the keys that
// actually arrive -- spelled here rather than derived, because a
// rename on either side is exactly the regression this catches.
const HOST_PATHS = {
  configPath: '/home/tester/.config/WebTorrent',
  torrentPath: '/home/tester/.config/WebTorrent/Torrents',
  posterPath: '/home/tester/.config/WebTorrent/Posters',
  tempPath: '/tmp',
  defaultDownloadPath: '/home/tester/Downloads',
  isPortable: false
}

function resetTauri (value) {
  invocations = []
  handler = async () => value
}

test('appPaths asks the host and nothing else', async function (t) {
  resetTauri(HOST_PATHS)
  const result = await paths.appPaths()

  t.equal(invocations.length, 1, 'one command')
  t.equal(invocations[0].command, 'app_paths', 'named the command')
  t.equal(invocations[0].args, undefined, 'it takes no arguments')
  t.deepEqual(result, HOST_PATHS, 'the layout reaches the caller unchanged')
  t.end()
})

test('appPaths is async and rejects on host failure', async function (t) {
  resetTauri(HOST_PATHS)
  t.ok(paths.appPaths() instanceof Promise, 'appPaths is async')

  handler = async () => { throw new Error('no host') }
  try {
    await paths.appPaths()
    t.fail('resolved over a host failure')
  } catch (err) {
    t.equal(err.message, 'no host', 'the host error reaches the caller')
  }
  t.end()
})

test('the shim exports exactly the paths surface', function (t) {
  const found = Object.keys(paths).filter((k) => k !== '__esModule')
  t.deepEqual(found.sort(), ['appPaths'], 'no export appeared or vanished')
  t.end()
})

test('the barrel re-exports it', function (t) {
  // The barrel is how a caller that needs several concerns finds them,
  // and a module missing from it is invisible there while every direct
  // import keeps working -- so nothing else would notice.
  const shim = require('../../build/renderer/lib/platform')
  t.equal(typeof shim.paths, 'object', 'platform.paths exists')
  t.equal(typeof shim.paths.appPaths, 'function', 'and carries appPaths')
  t.end()
})
