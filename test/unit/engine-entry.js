const test = require('tape')
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const parseTorrent = require('parse-torrent')
const WebSocket = require('ws')

// US-040: the engine as a standalone Node process. This drives
// `build/engine/index.js` the way `src/main/engine-process.js` will in
// US-041 -- spawn it with plain `node`, read the port off stdout,
// connect a WebSocket, and speak `wt-*` -- so what it proves is the
// acceptance criterion itself and not a rehearsal of it.

const { decode, encode } = require('../../build/shared/wire')

const REPO = path.join(__dirname, '..', '..')
const ENTRY = path.join(REPO, 'build', 'engine', 'index.js')
const ENTRY_SRC = path.join(REPO, 'src', 'engine', 'index.js')
const FIXTURE = path.join(REPO, 'static', 'sintel.torrent')
const TOKEN = 'test-token-40'

test('the engine answers wt-start-torrenting under plain node',
  async function (t) {
    const expected = parseTorrent(await fs.promises.readFile(FIXTURE))
    const downloadPath = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'wt-engine-test-')
    )

    const child = spawn(process.execPath, [ENTRY], {
      cwd: REPO,
      // NODE_ENV=test keeps config off the real profile directory.
      env: {
        ...process.env,
        NODE_ENV: 'test',
        WEBTORRENT_ENGINE_TOKEN: TOKEN
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const stdout = []
    const stderr = []
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))

    const fail = (message) => {
      t.fail(message + '\nstdout:\n' + stdout.join('') +
        '\nstderr:\n' + stderr.join(''))
    }

    let client = null
    try {
      const port = await waitFor(() => {
        const lines = stdout.join('').split('\n')
          .filter((line) => line.startsWith('WEBTORRENT_ENGINE_PORT='))
        if (lines.length === 0) return null
        t.equal(lines.length, 1, 'exactly one port line on stdout')
        return Number(lines[0].slice('WEBTORRENT_ENGINE_PORT='.length))
      }, 20000)

      t.ok(Number.isInteger(port) && port > 0,
        'the port line parses to a port (' + port + ')')

      client = new WebSocket(
        'ws://127.0.0.1:' + port + '/?token=' + TOKEN
      )
      const frames = []
      client.on('message', (data) => frames.push(decode(data)))
      await new Promise((resolve, reject) => {
        client.on('open', resolve)
        client.on('error', reject)
      })
      t.pass('the engine accepted a WebSocket connection')

      // Every file deselected: this test is about the protocol, not
      // about moving 1.1 GB of Sintel onto the disk.
      const selections = new Array(expected.files.length).fill(false)
      client.send(encode('wt-start-torrenting',
        [1, FIXTURE, downloadPath, null, selections]))

      const parsed = await waitFor(
        () => frames.find((f) => f.channel === 'wt-parsed'), 20000)
      t.equal(parsed.args[0], 1, 'wt-parsed echoes the torrentKey')
      t.equal(parsed.args[1], expected.infoHash,
        'and carries the fixture infoHash')

      const ready = await waitFor(
        () => frames.find((f) => f.channel === 'wt-ready'), 20000)
      t.equal(ready.args[0], 1, 'wt-ready echoes the torrentKey')
      t.equal(ready.args[1].name, expected.name,
        'the torrent metadata came from the fixture')
      t.equal(ready.args[1].files.length, expected.files.length,
        'every file is described')

      const progress = await waitFor(
        () => frames.find((f) => f.channel === 'wt-progress'), 20000)
      t.equal(progress.args[0].torrents.length, 1,
        'wt-progress reports the one torrent')

      client.send(encode('wt-stop-torrenting', [expected.infoHash]))
    } catch (err) {
      fail(err.message)
    } finally {
      if (client) client.close()
      child.kill()
      await new Promise((resolve) => child.on('exit', resolve))
      await fs.promises.rm(downloadPath, { recursive: true, force: true })
    }

    t.end()
  })

test('the engine entry point names no host or browser API', function (t) {
  const source = fs.readFileSync(ENTRY_SRC, 'utf8')
  // Comments discuss the window the engine is moving out of, so they are
  // not code and are not scanned.
  const lines = source.split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line))

  const hits = (re) => lines
    .filter(({ line }) => re.test(line))
    .map(({ line, n }) => n + ': ' + line.trim())

  t.deepEqual(hits(/['"]electron['"]|\bipcRenderer\b/), [],
    'no Electron module and no ipcRenderer')
  t.deepEqual(hits(/\bwindow\.|\bdocument\.|\bnavigator\./), [],
    'no browser-only global')
  t.deepEqual(hits(/\.send\s*\(/).filter((h) => !/\bbus\.send\(/.test(h)), [],
    'every send goes through the bus')
  // Inherited from the deleted `engine-bus-electron.js` (US-045): a
  // subscription to a protocol channel that bypasses the bus would name
  // the transport, which is what makes the seam substitutable.
  const subs = hits(/\bbus\.on\s*\(|\.on\s*\(\s*['"]wt-/)
  t.ok(subs.length > 5, 'found the engine subscriptions')
  t.deepEqual(subs.filter((h) => !/\bbus\.on\s*\(/.test(h)), [],
    'every subscription goes through the bus')
  t.equal(hits(/createWebSocketBus\s*\(/).length, 1,
    'the bus is constructed in exactly one place')
  t.ok(/wt-uncaught-error/.test(source) && /\bprocess\.on\(/.test(source),
    'uncaught errors are reported from a process handler')
  t.end()
})

test('config paths resolve with no electron module available',
  function (t) {
    // The packaged sidecar runs without `node_modules/electron`, so
    // requiring config must not depend on it resolving. Proved in a
    // child process: patching module resolution in this one would leak
    // into every other test file (they share a process).
    const configPath = path.join(REPO, 'build', 'config.js')
    const probe = [
      'const Module = require("module")',
      'const resolve = Module._resolveFilename',
      'Module._resolveFilename = function (request, ...rest) {',
      '  if (request === "electron" || request === "@electron/remote") {',
      '    const err = new Error("Cannot find module " + request)',
      '    err.code = "MODULE_NOT_FOUND"',
      '    throw err',
      '  }',
      '  return resolve.call(this, request, ...rest)',
      '}',
      'const config = require(' + JSON.stringify(configPath) + ')',
      'console.log(JSON.stringify({',
      '  torrent: config.TORRENT_PATH,',
      '  poster: config.POSTER_PATH',
      '}))'
    ].join('\n')

    const result = spawnSyncNode(probe)
    t.equal(result.status, 0,
      'config loads outside Electron: ' + result.stderr)
    const paths = JSON.parse(result.stdout || '{}')
    t.ok(path.isAbsolute(paths.torrent || ''),
      'TORRENT_PATH is absolute: ' + paths.torrent)
    t.equal(path.basename(paths.torrent || ''), 'Torrents',
      'and still ends in Torrents')
    t.ok(path.isAbsolute(paths.poster || ''),
      'POSTER_PATH is absolute: ' + paths.poster)
    t.equal(path.basename(paths.poster || ''), 'Posters',
      'and still ends in Posters')
    t.end()
  })

function spawnSyncNode (source) {
  const { spawnSync } = require('child_process')
  return spawnSync(process.execPath, ['-e', source], {
    cwd: REPO,
    encoding: 'utf8'
  })
}

// Resolve as soon as `probe` returns something truthy, or reject on
// timeout. Every wait in this file is for a real event from another
// process, so there is no fixed delay anywhere.
function waitFor (probe, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = setInterval(() => {
      let value
      try {
        value = probe()
      } catch (err) {
        clearInterval(poll)
        return reject(err)
      }
      if (value) {
        clearInterval(poll)
        resolve(value)
      } else if (Date.now() - started > timeout) {
        clearInterval(poll)
        reject(new Error('timed out waiting for the engine'))
      }
    }, 20)
  })
}
