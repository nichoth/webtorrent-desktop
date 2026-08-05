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
function webviewSandbox () {
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
      invoke: () => new Promise(() => {}),
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
