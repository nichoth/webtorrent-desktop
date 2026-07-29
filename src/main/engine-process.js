// The host side of the engine sidecar (US-041, ADR-012).
//
// The engine is a plain Node process now, not a hidden window, so
// somebody has to own its lifecycle: spawn it at startup, learn the port
// it bound, forward its output into the app log, restart it when it
// dies, and make sure a quit never leaves it running. That is this
// module, and that is all of it -- no `wt-*` message passes through
// here (ADR-012), so nothing in this file knows the protocol.
//
// The port and the per-launch token are held here, in the main process,
// and handed to the renderer by `ipc-os.getEngineEndpoint()` (US-042).
//
// Phase 4 replaces this file with the Rust equivalent (US-070). It is
// deliberately small for that reason: spawn a child, read one line.

const { spawn } = require('child_process')
const crypto = require('crypto')
const path = require('path')

// The one stdout line the child promises us. Everything else it prints
// is log output. Kept in step with `src/engine/index.js`.
const PORT_LINE_PREFIX = 'WEBTORRENT_ENGINE_PORT='

const LOOPBACK = '127.0.0.1'

// Restart policy. Five attempts at 500ms doubling to 8s spans about 15
// seconds, which is long enough to ride out a transient port or
// filesystem fault and short enough that a broken engine reports itself
// while the user is still looking at the window.
const DEFAULT_MAX_RESTARTS = 5
const DEFAULT_BACKOFF_MS = 500
const DEFAULT_MAX_BACKOFF_MS = 8000

module.exports = { init, kill, getEndpoint, getPid, createEngineProcess }

// The app has exactly one engine, but the supervisor is a factory so
// tests can drive several with their own entry point and timings.
let singleton = null

/**
 * Start supervising the engine sidecar and tie it to the app's
 * lifetime.
 *
 * @param {object} [options] see `createEngineProcess`, plus:
 * @param {object} [options.app] the Electron app, injectable for tests
 * @returns {Promise<{url: string, token: string}>}
 */
function init (options = {}) {
  const { app = require('electron').app, ...rest } = options

  if (singleton) singleton.kill()
  singleton = createEngineProcess(rest)

  // `before-quit` is the criterion, and it fires for a window close, a
  // Cmd-Q and a `app.quit()` alike. The other two are belt and braces
  // for the paths that skip it.
  app.on('before-quit', () => kill())
  app.on('will-quit', () => kill())
  process.once('exit', () => kill())

  return singleton.start()
}

/** Stop the engine and stop supervising it. */
function kill () {
  return singleton ? singleton.kill() : Promise.resolve()
}

/** @returns {{url: string, token: string}|null} */
function getEndpoint () {
  return singleton ? singleton.getEndpoint() : null
}

/** @returns {number|null} */
function getPid () {
  return singleton ? singleton.getPid() : null
}

/**
 * Create a supervisor for one engine sidecar.
 *
 * @param {object} [options]
 * @param {string} [options.entry] the script to run, defaulting to the
 *   built engine entry point next to this file
 * @param {string} [options.execPath] the Node binary. Inside Electron
 *   this is Electron itself run as Node (`ELECTRON_RUN_AS_NODE`), which
 *   is how the packaged app gets a Node runtime without shipping one.
 * @param {object} [options.env] extra environment for the child
 * @param {Function} [options.log] the app log, defaulting to `./log`
 * @param {number} [options.maxRestarts]
 * @param {number} [options.backoffMs] first delay; doubles per attempt
 * @param {number} [options.maxBackoffMs]
 * @returns {{start: Function, kill: Function, getEndpoint: Function,
 *   getPid: Function}}
 */
function createEngineProcess (options = {}) {
  const {
    entry = path.join(__dirname, '..', 'engine', 'index.js'),
    execPath = process.execPath,
    env = {},
    log = require('./log'),
    maxRestarts = DEFAULT_MAX_RESTARTS,
    backoffMs = DEFAULT_BACKOFF_MS,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS
  } = options

  // One token per launch, not per spawn: it is the app's credential for
  // this engine, and the renderer holds a copy. The port changes across
  // a restart, so the renderer re-reads the endpoint either way.
  const token = crypto.randomBytes(24).toString('hex')

  let child = null
  let endpoint = null
  let restarts = 0
  let stopped = false
  let restartTimer = null

  // `start()` resolves with the first endpoint and rejects if the
  // supervisor gives up before ever getting one.
  let resolveStarted = null
  let rejectStarted = null
  let started = null
  let settled = false

  function start () {
    if (!started) {
      started = new Promise((resolve, reject) => {
        resolveStarted = resolve
        rejectStarted = reject
      })
      spawnChild()
    }
    return started
  }

  function spawnChild () {
    stopped = false
    restartTimer = null

    child = spawn(execPath, [entry], {
      cwd: path.join(__dirname, '..', '..'),
      env: {
        ...process.env,
        // Electron acts as a plain Node runtime with this set, so the
        // sidecar gets Node without a second binary in the bundle.
        ELECTRON_RUN_AS_NODE: '1',
        WEBTORRENT_ENGINE_TOKEN: token,
        // Tells the child to shut down when this pipe closes, which is
        // what stops an orphan when the host dies without quitting.
        WEBTORRENT_ENGINE_PARENT_PIPE: '1',
        ...env
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const current = child

    readLines(child.stdout, (line) => {
      if (current !== child) return
      if (line.startsWith(PORT_LINE_PREFIX)) {
        onPort(Number(line.slice(PORT_LINE_PREFIX.length)))
      }
      log('Engine:', line)
    })

    readLines(child.stderr, (line) => log.error('Engine:', line))

    child.on('error', (err) => {
      if (current !== child) return
      log.error('Engine: failed to spawn:', err.message)
    })

    child.on('exit', (code, signal) => {
      if (current !== child) return
      child = null
      endpoint = null
      if (stopped) return
      log.error('Engine: exited with code ' + code + ', signal ' + signal)
      scheduleRestart()
    })
  }

  function onPort (port) {
    if (!Number.isInteger(port) || port <= 0) {
      log.error('Engine: unparseable port line, ignoring')
      return
    }
    // A start that got as far as a bound port counts as healthy, so a
    // crash days later gets the full restart allowance again.
    restarts = 0
    endpoint = { url: 'ws://' + LOOPBACK + ':' + port, token }
    if (!settled) {
      settled = true
      resolveStarted(endpoint)
    }
  }

  function scheduleRestart () {
    if (restarts >= maxRestarts) {
      log.error('Engine: giving up after ' + restarts + ' restarts. ' +
        'Torrenting is unavailable until the app is restarted.')
      if (!settled) {
        settled = true
        rejectStarted(new Error(
          'engine sidecar failed to start after ' + restarts + ' restarts'
        ))
      }
      return
    }

    const delay = Math.min(backoffMs * Math.pow(2, restarts), maxBackoffMs)
    restarts++
    log.error('Engine: restarting in ' + delay + 'ms ' +
      '(attempt ' + restarts + ' of ' + maxRestarts + ')')
    // Not `unref`ed: a pending restart is the only thing keeping the
    // engine alive at that moment, and an unref'd timer lets a bare
    // Node process (a test, or the sidecar driven by hand) exit during
    // the backoff instead of restarting.
    restartTimer = setTimeout(() => {
      if (stopped) return
      spawnChild()
    }, delay)
  }

  function kill () {
    stopped = true
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    endpoint = null

    const dying = child
    child = null
    if (!dying) return Promise.resolve()

    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(force)
        resolve()
      }
      // SIGTERM lets the engine destroy its client and release the
      // download directory; SIGKILL is the backstop if it hangs.
      const force = setTimeout(() => {
        if (dying.exitCode === null && dying.signalCode === null) {
          dying.kill('SIGKILL')
        }
      }, 4000)
      if (force.unref) force.unref()

      if (dying.exitCode !== null || dying.signalCode !== null) return done()
      dying.once('exit', done)
      dying.kill('SIGTERM')
    })
  }

  return {
    start,
    kill,
    getEndpoint: () => endpoint,
    getPid: () => (child ? child.pid : null)
  }
}

// Split a child stream into lines. The port line is only parseable if
// the chunk boundaries are ignored, and the log reads better per line
// than per chunk.
function readLines (stream, onLine) {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) {
      if (line.length > 0) onLine(line)
    }
  })
  stream.on('end', () => {
    if (buffer.length > 0) onLine(buffer)
    buffer = ''
  })
}
