const test = require('tape')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const WebSocket = require('ws')

// US-041: the host side of the sidecar. `src/main/engine-process.js`
// spawns `build/engine/index.js`, parses its one port line, forwards its
// output to the app log, restarts it with capped backoff when it dies,
// and leaves no orphan behind. Every assertion here drives the real
// child process -- the supervisor's whole job is process lifecycle, and
// a fake `child_process` would assert the mock instead.

const engineProcess = require('../../build/main/engine-process')

const REPO = path.join(__dirname, '..', '..')

// Keep the spawned engines off the real profile directory.
const CHILD_ENV = { NODE_ENV: 'test' }

function makeLog () {
  const lines = []
  const errors = []
  const log = (...args) => lines.push(args.join(' '))
  log.error = (...args) => errors.push(args.join(' '))
  log.lines = lines
  log.errors = errors
  log.all = () => lines.concat(errors).join('\n')
  return log
}

// The path to the real Electron binary, read the way the npm helper
// reads it. `require('electron')` would give the same string, but other
// unit files seed `require.cache` for `electron` with a stub and one
// tape process is shared, so requiring it here is not reliable.
function electronBinary () {
  const dir = path.dirname(require.resolve('electron/package.json'))
  const rel = fs.readFileSync(path.join(dir, 'path.txt'), 'utf8').trim()
  return path.join(dir, 'dist', rel)
}

function isAlive (pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return false
  }
}

async function waitFor (fn, timeout = 20000) {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - start > timeout) {
      throw new Error('timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function connect (url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.on('open', () => resolve(socket))
    socket.on('error', (err) => reject(err))
  })
}

// A throwaway sidecar stand-in, for the failure paths the real engine
// will not perform on demand.
async function writeScript (body) {
  const dir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'wt-engine-process-')
  )
  const file = path.join(dir, 'fake-engine.js')
  await fs.promises.writeFile(file, body)
  return file
}

test('the supervisor spawns the sidecar and reports its endpoint',
  async function (t) {
    const log = makeLog()
    const engine = engineProcess.createEngineProcess({
      log,
      env: CHILD_ENV,
      backoffMs: 50
    })

    t.equal(engine.getEndpoint(), null, 'no endpoint before start')

    let socket = null
    try {
      const endpoint = await engine.start()

      t.ok(/^ws:\/\/127\.0\.0\.1:\d+$/.test(endpoint.url),
        'endpoint url is a loopback WebSocket url (' + endpoint.url + ')')
      t.ok(/^[0-9a-f]{32,}$/.test(endpoint.token),
        'endpoint carries a random hex token')
      t.deepEqual(engine.getEndpoint(), endpoint,
        'getEndpoint() hands back the same endpoint, held in this process')
      t.ok(isAlive(engine.getPid()), 'the child is running')

      // The token is the child's, not just the supervisor's bookkeeping.
      socket = await connect(endpoint.url + '/?token=' + endpoint.token)
      t.ok(socket, 'a client presenting the token connects')

      let refused = null
      try {
        await connect(endpoint.url + '/?token=wrong')
      } catch (err) {
        refused = err
      }
      t.ok(refused, 'a client with the wrong token is refused')

      // Acceptance criterion: child stdout reaches the app log. The
      // engine prints `init: <time>` right after its port line.
      await waitFor(() => log.lines.some((line) => line.includes('init:')))
      t.ok(log.lines.some((line) => line.includes('init:')),
        'sidecar stdout is written to the app log')
      t.equal(log.errors.length, 0,
        'a healthy start logs no error: ' + log.errors.join('\n'))
    } finally {
      if (socket) socket.close()
      const pid = engine.getPid()
      await engine.kill()
      t.notOk(isAlive(pid), 'kill() leaves no orphan')
      t.equal(engine.getEndpoint(), null, 'the endpoint is dropped on kill')
    }
  })

test('the sidecar runs under the Electron binary in Node mode',
  async function (t) {
    // This is the configuration the app actually uses: inside Electron
    // `process.execPath` is the Electron binary, and the supervisor asks
    // it to behave as Node (`ELECTRON_RUN_AS_NODE`) rather than shipping
    // a second runtime.
    const log = makeLog()
    const binary = electronBinary()
    // A wrong path here would look like a sidecar that cannot start,
    // which is the failure this test is meant to detect.
    t.ok(fs.existsSync(binary), 'the Electron binary is where we think')

    const engine = engineProcess.createEngineProcess({
      log,
      execPath: binary,
      // Deliberately NOT `NODE_ENV=test`: that makes config portable,
      // which skips the `app.getPath('downloads')` branch -- the one
      // that decides whether config can load at all under Node mode.
      // The engine only reads those paths at startup; it writes nothing
      // under them until it is sent a command.
      env: { NODE_ENV: 'development' },
      backoffMs: 50
    })

    try {
      const endpoint = await engine.start()
      t.ok(/^ws:\/\/127\.0\.0\.1:\d+$/.test(endpoint.url),
        'the endpoint is reported: ' + endpoint.url)
      t.equal(log.errors.length, 0,
        'nothing is logged as an error: ' + log.errors.join('\n'))
    } finally {
      const pid = engine.getPid()
      await engine.kill()
      t.notOk(isAlive(pid), 'no orphan after the Electron-as-Node test')
    }
  })

test('killing the sidecar by hand produces a logged restart',
  async function (t) {
    const log = makeLog()
    const engine = engineProcess.createEngineProcess({
      log,
      env: CHILD_ENV,
      backoffMs: 50
    })

    try {
      const first = await engine.start()
      const firstPid = engine.getPid()

      process.kill(firstPid, 'SIGKILL')

      const second = await waitFor(() => {
        const endpoint = engine.getEndpoint()
        if (!endpoint || endpoint.url === first.url) return null
        return endpoint
      })

      t.notEqual(second.url, first.url,
        'the restarted sidecar reports a new endpoint (' + second.url + ')')
      t.notEqual(engine.getPid(), firstPid, 'a new child is running')
      t.ok(isAlive(engine.getPid()), 'the restarted child is running')
      t.ok(log.errors.some((line) => /restart/i.test(line)),
        'the crash and restart are logged: ' + log.all())

      const socket = await connect(second.url + '/?token=' + second.token)
      t.ok(socket, 'the restarted sidecar answers on the same token')
      socket.close()
    } finally {
      const pid = engine.getPid()
      await engine.kill()
      t.notOk(isAlive(pid), 'no orphan after the restart test')
    }
  })

test('restarts are capped, and giving up is logged', async function (t) {
  const entry = await writeScript(
    'console.log("fake engine booting")\nprocess.exit(7)\n'
  )
  const log = makeLog()
  const engine = engineProcess.createEngineProcess({
    log,
    entry,
    env: CHILD_ENV,
    backoffMs: 10,
    maxRestarts: 2
  })

  let failure = null
  try {
    await engine.start()
  } catch (err) {
    failure = err
  }

  t.ok(failure, 'start() rejects once the supervisor gives up')
  t.equal(engine.getEndpoint(), null, 'no endpoint is reported')

  const boots = log.lines.filter((line) => line.includes('fake engine booting'))
  t.equal(boots.length, 3,
    'the child is spawned once plus maxRestarts times, and no more')
  t.ok(log.errors.some((line) => /giving up/i.test(line)),
    'giving up is logged: ' + log.all())

  // Nothing may be scheduled after the cap.
  await new Promise((resolve) => setTimeout(resolve, 200))
  t.equal(
    log.lines.filter((line) => line.includes('fake engine booting')).length,
    3,
    'no further restart is attempted after the cap'
  )

  await engine.kill()
})

test('the sidecar stderr is written to the app log', async function (t) {
  const entry = await writeScript(
    'console.error("fake engine complaining")\n' +
    'setInterval(() => {}, 1000)\n'
  )
  const log = makeLog()
  const engine = engineProcess.createEngineProcess({
    log,
    entry,
    env: CHILD_ENV,
    backoffMs: 10
  })

  // This stand-in never prints a port line, so `start()` never settles;
  // the assertion is about the output, not about readiness.
  engine.start().catch(() => {})

  try {
    await waitFor(
      () => log.errors.some((line) => line.includes('fake engine complaining')),
      5000
    )
    t.ok(log.errors.some((line) => line.includes('fake engine complaining')),
      'sidecar stderr reaches log.error')
  } finally {
    const pid = engine.getPid()
    await engine.kill()
    t.notOk(isAlive(pid), 'no orphan after the stderr test')
  }
})

test('kill() stops supervision -- no restart, no orphan', async function (t) {
  const log = makeLog()
  const engine = engineProcess.createEngineProcess({
    log,
    env: CHILD_ENV,
    backoffMs: 10
  })

  await engine.start()
  const pid = engine.getPid()
  await engine.kill()

  t.notOk(isAlive(pid), 'the child is gone')
  await new Promise((resolve) => setTimeout(resolve, 300))
  t.equal(engine.getEndpoint(), null, 'no endpoint reappears')
  t.equal(engine.getPid(), null, 'no replacement child is spawned')
})

test('init() supervises the sidecar and kills it on before-quit',
  async function (t) {
    const listeners = new Map()
    const app = {
      on: (name, fn) => {
        if (!listeners.has(name)) listeners.set(name, [])
        listeners.get(name).push(fn)
      },
      once: (name, fn) => app.on(name, fn)
    }
    const log = makeLog()

    const endpoint = await engineProcess.init({
      app,
      log,
      env: CHILD_ENV,
      backoffMs: 50
    })
    const pid = engineProcess.getPid()

    try {
      t.ok(/^ws:\/\/127\.0\.0\.1:\d+$/.test(endpoint.url),
        'init() resolves the endpoint')
      t.deepEqual(engineProcess.getEndpoint(), endpoint,
        'the module-level getEndpoint() answers for the singleton')
      t.ok(listeners.has('before-quit'),
        'a before-quit listener is registered on the app')

      for (const fn of listeners.get('before-quit')) fn()
      await waitFor(() => !isAlive(pid), 5000)
      t.notOk(isAlive(pid), 'before-quit kills the sidecar')
      t.equal(engineProcess.getEndpoint(), null,
        'the endpoint is dropped once the sidecar is killed')
    } finally {
      await engineProcess.kill()
      t.notOk(isAlive(pid), 'no orphan after the init test')
    }
  })

test('the sidecar exits when the parent pipe closes', async function (t) {
  // Belt and braces for the orphan criterion: a main process that dies
  // without running `before-quit` still takes the child with it,
  // because the child watches the stdin pipe it was given.
  const child = spawn(
    process.execPath,
    [path.join(REPO, 'build', 'engine', 'index.js')],
    {
      cwd: REPO,
      env: {
        ...process.env,
        ...CHILD_ENV,
        WEBTORRENT_ENGINE_PARENT_PIPE: '1'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )

  const out = []
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => out.push(chunk))

  const exited = new Promise((resolve) => child.on('exit', resolve))

  try {
    await waitFor(
      () => out.join('').includes('WEBTORRENT_ENGINE_PORT='),
      20000
    )
    t.ok(out.join('').includes('WEBTORRENT_ENGINE_PORT='),
      'the child came up')

    child.stdin.end()
    await Promise.race([
      exited,
      new Promise((resolve, reject) =>
        setTimeout(() => reject(new Error('child outlived its parent pipe')),
          10000))
    ])
    t.pass('closing the parent pipe shuts the sidecar down')
  } finally {
    if (isAlive(child.pid)) child.kill('SIGKILL')
  }
})

// US-042: the host answers `getEngineEndpoint` from here, and the
// renderer may ask before the child has bound its port, or during the
// gap while a restart is in flight. `waitForEndpoint()` is that wait --
// it always resolves with the *current* endpoint, never a stale one.
test('waitForEndpoint() resolves with the endpoint once the port is bound',
  async function (t) {
    const log = makeLog()
    const engine = engineProcess.createEngineProcess({
      log,
      env: CHILD_ENV,
      backoffMs: 50
    })

    try {
      // Asked before `start()` has settled: the caller waits rather
      // than getting null.
      const started = engine.start()
      const waited = engine.waitForEndpoint()
      const endpoint = await started
      t.deepEqual(await waited, endpoint,
        'a pending wait resolves with the endpoint start() reported')

      t.deepEqual(await engine.waitForEndpoint(), endpoint,
        'and a later call resolves immediately with the same endpoint')
    } finally {
      await engine.kill()
    }
  })

test('waitForEndpoint() waits across a restart and reports the new port',
  async function (t) {
    const log = makeLog()
    const engine = engineProcess.createEngineProcess({
      log,
      env: CHILD_ENV,
      backoffMs: 50
    })

    try {
      const first = await engine.start()
      const pid = engine.getPid()

      process.kill(pid, 'SIGKILL')
      // The endpoint is dropped the moment the child exits, so this
      // wait is the restart gap the renderer would hit.
      await waitFor(() => engine.getEndpoint() === null)
      const second = await engine.waitForEndpoint()

      t.ok(/^ws:\/\/127\.0\.0\.1:\d+$/.test(second.url),
        'resolves with a loopback url after the restart (' + second.url + ')')
      t.notEqual(second.url, first.url,
        'and it is the new port, not the dead one')
      t.equal(second.token, first.token,
        'the token is per launch, so it survives the restart')
    } finally {
      const pid = engine.getPid()
      await engine.kill()
      t.notOk(isAlive(pid), 'no orphan after the restart wait test')
    }
  })

test('waitForEndpoint() rejects once the supervisor gives up',
  async function (t) {
    const entry = await writeScript('process.exit(7)\n')
    const log = makeLog()
    const engine = engineProcess.createEngineProcess({
      log,
      entry,
      env: CHILD_ENV,
      backoffMs: 10,
      maxRestarts: 1
    })

    const waited = engine.waitForEndpoint()
    let startFailure = null
    try {
      await engine.start()
    } catch (err) {
      startFailure = err
    }
    t.ok(startFailure, 'start() rejected')

    let failure = null
    try {
      await waited
    } catch (err) {
      failure = err
    }
    t.ok(failure, 'a pending wait rejects rather than hanging forever')

    let later = null
    try {
      await engine.waitForEndpoint()
    } catch (err) {
      later = err
    }
    t.ok(later, 'and so does a call made after the cap')

    await engine.kill()
  })

test('the module-level waitForEndpoint() answers before init()',
  async function (t) {
    // Nothing is supervised in this process, so the host has nothing to
    // hand the renderer. Null, not a hang: `src/main/ipc.js` replies
    // with whatever this resolves to.
    t.equal(await engineProcess.waitForEndpoint(), null,
      'resolves with null when there is no engine')
    t.end()
  })
