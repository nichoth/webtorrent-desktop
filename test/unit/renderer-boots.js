const test = require('tape')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

// US-072: the renderer bundle has to load in a webview.
//
// Until the cutover the bundle was CommonJS with Node builtins left as
// `require()` calls (ADR-004). That only ever resolved because the
// Electron window ran with `nodeIntegration: true`, and US-070 and
// US-071 both recorded the consequence: in the real Tauri webview the
// bundle died on its first statement with `ReferenceError: Can't find
// variable: require`, so nothing rendered. This file is the check that
// it loads, and that it keeps loading.
//
// It is a real evaluation rather than a scan of the text because the
// failure it guards against is not lexical. A bundle can contain no
// `require` at all and still die at load, which is exactly what
// happened here: Vite rewrites an un-externalized Node builtin to an
// empty object, so `os.platform()` became `undefined()` inside
// `application-config` and threw one frame later. Only running it
// catches that.

const REPO = path.join(__dirname, '..', '..')
const BUNDLE = path.join(REPO, 'build-vite', 'renderer', 'main.js')

// `npm run test-unit` runs `npm run build` first, which builds this.
// That is why it runs the full build and not just `build:node`: this
// file is the only test that asserts on the Vite output, and against a
// stale `build-vite/` it reports on whatever the last build happened
// to leave there -- which passed for two commits while the bundle in
// the tree did not load at all.
//
// Said out loud because the alternative failure -- every assertion
// below skipped -- reads as a pass.
test('the renderer bundle was built', function (t) {
  t.ok(fs.existsSync(BUNDLE),
    `${path.relative(REPO, BUNDLE)} exists -- run 'npm run build'`)
  t.end()
})

const source = fs.existsSync(BUNDLE) ? fs.readFileSync(BUNDLE, 'utf8') : ''

// -- the shape of the output ----------------------------------------

// `static/main.html` loads the bundle with a classic `<script src>`,
// so top-level `import`/`export` would be a syntax error in the
// webview. Checked on the emitted text because the output format is a
// build setting a later story could change without meaning to.
test('the bundle is loadable by a classic script tag', function (t) {
  t.ok(source.length > 0, 'read the bundle')
  t.doesNotThrow(
    () => new vm.Script(source, { filename: 'main.js' }),
    'parses as a classic script -- no top-level import/export'
  )
  t.end()
})

test('the bundle asks for no Node module at load', function (t) {
  // The `require("x")` spelling a bundler emits for an external, which
  // is the one that needs a host to answer it. Two near-misses are
  // deliberately not matched. A first-party require is rewritten to
  // the bundle's own registry (`require_debounce()`), so it has no
  // string argument. And a *member* require -- lodash's
  // `module.require("util")` feature probe, guarded by a `typeof` and
  // wrapped in a `try` -- is a property access on an object the
  // webview does not have, not a global call, so the leading
  // character must not be a dot.
  const calls = source.match(/(^|[^.\w$])require\(\s*["'`]/g) || []
  t.equal(calls.length, 0,
    `no bare require() calls (found ${calls.length})`)
  t.end()
})

// -- the load itself -------------------------------------------------

// A webview-shaped global object: enough DOM for React and material-ui
// to initialize, and deliberately **no** `require`, `process`,
// `module`, `exports` or `global`. Anything the bundle needs from Node
// is therefore a failure here rather than a blank window nobody sees
// until a human launches the app.
function webviewSandbox (invoked = [], answer = null) {
  const listeners = () => ({
    addEventListener () {}, removeEventListener () {}, dispatchEvent () {}
  })

  function element () {
    return Object.assign(listeners(), {
      style: {},
      classList: { add () {}, remove () {}, contains: () => false },
      dataset: {},
      childNodes: [],
      children: [],
      firstChild: null,
      parentNode: null,
      appendChild (child) { return child },
      insertBefore (child) { return child },
      removeChild (child) { return child },
      setAttribute () {},
      getAttribute: () => null,
      removeAttribute () {},
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementsByTagName: () => [],
      contains: () => false,
      focus () {},
      blur () {}
    })
  }

  const document = Object.assign(listeners(), {
    nodeType: 9,
    createElement: element,
    createElementNS: element,
    createTextNode: element,
    createComment: element,
    createDocumentFragment: element,
    getElementById: () => element(),
    querySelector: () => element(),
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
    head: element(),
    body: element(),
    documentElement: element(),
    activeElement: null,
    readyState: 'complete',
    cookie: ''
  })

  const sandbox = Object.assign(listeners(), {
    console,
    document,
    navigator: {
      userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15',
      platform: 'MacIntel',
      language: 'en-US',
      languages: ['en-US'],
      onLine: true
    },
    location: {
      href: 'tauri://localhost/static/main.html',
      protocol: 'tauri:',
      hostname: 'localhost',
      search: ''
    },
    localStorage: {
      getItem: () => null, setItem () {}, removeItem () {}, clear () {}
    },
    screen: { width: 1440, height: 900 },
    innerWidth: 500,
    innerHeight: 638,
    devicePixelRatio: 2,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    matchMedia: () => Object.assign(listeners(), {
      matches: false, addListener () {}, removeListener () {}
    }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    Event: function Event () {},
    CustomEvent: function CustomEvent () {},
    fetch: () => Promise.reject(new Error('offline in this test')),
    WebSocket: function WebSocket () {},

    // What Tauri injects into the real webview, and what the platform
    // shim reaches `invoke` through. Present because a real webview
    // has it -- leaving it out would make this sandbox *less* faithful
    // rather than stricter.
    //
    // `invoke` never settles, on purpose. Only the synchronous
    // module-initialization phase is under test here; the host is a
    // separate process and answering for it would mean stubbing the
    // whole command surface. A promise that stays pending stops the
    // bundle's startup chain at the first host call and leaves nothing
    // scheduled -- whereas rejecting would run `main.js`'s `onError`
    // before `onState` has assigned `state`, and that throw lands on a
    // later tick, outside any `try` this file can write, where it
    // takes the whole `tape` process down with it.
    __TAURI_INTERNALS__: {
      invoke: (command, args) => {
        invoked.push({ command, args })
        return answer ? answer(command) : new Promise(() => {})
      },
      transformCallback: (fn) => fn,
      convertFileSrc: (src) => src
    }
  })

  sandbox.window = sandbox
  sandbox.self = sandbox
  sandbox.globalThis = sandbox
  return sandbox
}

test('the renderer bundle loads in a webview', function (t) {
  const sandbox = webviewSandbox()
  let thrown = null
  try {
    // The bundle kicks off `State.load()` and a `setTimeout`; only the
    // synchronous module-initialization phase is under test here, so a
    // timeout bounds it rather than expressing an expectation.
    vm.runInNewContext(source, sandbox, {
      filename: 'main.js',
      timeout: 30000
    })
  } catch (err) {
    thrown = err
  }

  t.equal(thrown, null, thrown === null
    ? 'the bundle initialized with no Node runtime'
    : `threw ${thrown.name}: ${thrown.message}`)
  t.end()
})

// The two failures the cutover actually hit, named individually so a
// regression says which one came back rather than just "it threw".
test('neither Node-environment failure is reachable', function (t) {
  const sandbox = webviewSandbox()
  let message = ''
  try {
    vm.runInNewContext(source, sandbox, {
      filename: 'main.js',
      timeout: 30000
    })
  } catch (err) {
    message = `${err.name}: ${err.message}`
  }

  t.notOk(/\brequire\b.*(is not defined|find variable)/.test(message),
    'no `require is not defined` -- ADR-004 externals are gone')
  t.notOk(/\bprocess\b.*(is not defined|find variable)/.test(message),
    'no `process is not defined` -- config.js reads no Node globals')
  t.end()
})

// -- the first thing it asks the host --------------------------------

// The startup ordering the cutover depends on. `src/config.js` cannot
// resolve `CONFIG_PATH` in a webview -- it has no `$HOME` and no
// platform convention -- so every path it exports is the empty string
// until the host's `app_paths` answer lands in `config.useHostPaths`.
// A `State.load()` that runs before that reads and writes
// `./config.json`, relative to whatever the webview considers its
// working directory, and the user's profile is silently not the one on
// disk.
//
// Asserted on the emitted bundle rather than on `main.js` because the
// ordering is a runtime fact, not a lexical one: an `await` in the
// wrong place reorders it while the source still reads correctly.
// `invoke` never settles here, so the startup chain stops at its first
// host call -- which means the recorded commands are exactly what the
// bundle asks for before it has any answer at all.
test('the bundle asks the host for its paths before reading state',
  function (t) {
    const invoked = []
    const sandbox = webviewSandbox(invoked)
    try {
      vm.runInNewContext(source, sandbox, {
        filename: 'main.js',
        timeout: 30000
      })
    } catch (err) {
      t.fail(`threw ${err.name}: ${err.message}`)
    }

    const commands = invoked.map((call) => call.command)
    t.ok(commands.includes('app_paths'),
      `app_paths was invoked (saw: ${commands.join(', ') || 'nothing'})`)
    t.deepEqual(commands.filter((name) => name.startsWith('fs_')), [],
      'and no filesystem command ran while the paths were unknown')
    t.end()
  })

// The other half, and the half a pending `invoke` cannot show: what
// the bundle does with the answer. This one lets `app_paths` resolve
// and leaves every other command pending, so startup advances exactly
// one step -- into `State.load`, whose first act is to read the config
// file. The path it reads is the assertion: it has to be the one the
// host just supplied, which is true only if the answer reached *both*
// surfaces of `src/config.js` (the named exports and the default one).
//
// A launch caught this where the ordering test above could not: the
// bootstrap called `config.useHostPaths` through the default export,
// which carries the path values and not the function that moves them,
// so it threw `undefined is not a function` on a promise nobody was
// awaiting. Nothing rendered and nothing said why.
test('and it uses the answer, on both config surfaces', async (t) => {
  const HOST = {
    configPath: '/host/Profile',
    torrentPath: '/host/Profile/Torrents',
    posterPath: '/host/Profile/Posters',
    tempPath: '/host/Temp',
    defaultDownloadPath: '/host/Downloads',
    isPortable: false
  }

  // The bootstrap deliberately has no `catch` -- there is no UI to
  // report into that early -- so a failure arrives as an unhandled
  // rejection on a later tick, where no `try` here could see it. It
  // would otherwise take the whole `tape` process down.
  const rejections = []
  const onRejection = (err) => rejections.push(err)
  process.on('unhandledRejection', onRejection)

  const invoked = []
  const sandbox = webviewSandbox(invoked, (command) => (
    command === 'app_paths'
      ? Promise.resolve(HOST)
      : new Promise(() => {})
  ))

  try {
    vm.runInNewContext(source, sandbox, {
      filename: 'main.js',
      timeout: 30000
    })

    // Two turns of the loop: one for the `app_paths` answer, one for
    // the read `State.load` starts on the back of it.
    await new Promise((resolve) => setTimeout(resolve, 50))

    t.deepEqual(rejections.map(String), [],
      'the bootstrap ran to completion')

    const read = invoked.find((call) => call.command === 'fs_read_file')
    t.ok(read, 'State.load ran once the host had answered')
    t.equal(read && read.args.path, '/host/Profile/config.json',
      'and read the config file out of the host\'s profile directory')
  } finally {
    process.removeListener('unhandledRejection', onRejection)
  }
  t.end()
})
