const test = require('tape')
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const parseTorrent = require('parse-torrent')
const WebSocket = require('ws')

// `wt-force-announce` is a diagnostic command: it asks one torrent to
// re-announce and prints peer counts around the call. What is asserted
// here is the wiring -- that the command reaches the engine, that an
// unknown info hash is survivable, and that a known one produces the
// readout the operator reads. The announce itself is unit tested in
// engine-announce.js against fakes.

const { decode, encode } = require('../../build/shared/wire')

const REPO = path.join(__dirname, '..', '..')
const ENTRY = path.join(REPO, 'build', 'engine', 'index.js')
const FIXTURE = path.join(REPO, 'static', 'sintel.torrent')
const TOKEN = 'test-token-announce'
const UNKNOWN = 'b'.repeat(40)

test('the engine answers wt-force-announce', async function (t) {
  const expected = parseTorrent(await fs.promises.readFile(FIXTURE))
  const downloadPath = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'wt-announce-test-')
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
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => stdout.push(chunk))
  child.stderr.on('data', (chunk) => stdout.push(chunk))
  const out = () => stdout.join('')

  let client = null
  try {
    const port = await waitFor(() => {
      const line = out().split('\n')
        .find((l) => l.startsWith('WEBTORRENT_ENGINE_PORT='))
      return line ? Number(line.slice('WEBTORRENT_ENGINE_PORT='.length)) : null
    }, 'the engine printed its port')

    // The token goes on the query string: that is where
    // `bus-websocket.js` reads it in `verifyClient`.
    client = new WebSocket('ws://127.0.0.1:' + port + '/?token=' + TOKEN)
    const frames = []
    client.on('message', (data) => frames.push(decode(data)))
    await new Promise((resolve, reject) => {
      client.once('open', resolve)
      client.once('error', reject)
    })

    // An info hash the engine has never seen must not take it down.
    client.send(encode('wt-force-announce', [UNKNOWN]))
    await waitFor(
      () => out().includes('DIAG announce: no torrent ' + UNKNOWN) || null,
      'the engine reported the missing torrent'
    )

    // Now a torrent it does hold. Every file is deselected, so nothing
    // downloads; the fixture only has to exist for `client.get` to
    // find it.
    client.send(encode('wt-start-torrenting', [
      1, FIXTURE, downloadPath, null,
      new Array(expected.files.length).fill(false)
    ]))
    await waitFor(
      () => frames.find((f) => f.channel === 'wt-ready') || null,
      'the fixture torrent is ready'
    )

    client.send(encode('wt-force-announce', [expected.infoHash]))
    await waitFor(
      () => out().includes('DIAG announce ' + expected.infoHash +
        ': before peers=') || null,
      'the engine printed the before readout'
    )
    await waitFor(
      () => out().includes('DIAG announce ' + expected.infoHash +
        ': sent tracker=') || null,
      'and reported which halves fired'
    )

    t.pass('wt-force-announce is wired end to end')
  } finally {
    if (client) client.close()
    child.kill()
    await new Promise((resolve) => child.once('exit', resolve))
    await fs.promises.rm(downloadPath, { recursive: true, force: true })
  }

  t.end()
})

// Wait on a condition, never on a delay (test/AGENTS.md). `check`
// returns a truthy value to stop, or null to keep waiting.
async function waitFor (check, what, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > deadline) throw new Error('timed out waiting: ' + what)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
