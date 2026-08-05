const test = require('tape')
const fs = require('fs')
const path = require('path')

// US-072: `process.platform` was readable from the renderer only
// because the Electron window ran with `nodeIntegration: true`. A
// webview has no `process`, so the four call sites that read it went
// from working to `ReferenceError: process is not defined` -- and one
// of them (`pages/app.js`) ran at module scope, which made it a blank
// window rather than a broken feature.
//
// `lib/os.js` answers the same question from the DOM. It is not part
// of the platform shim on purpose: the shim is the host boundary and
// every export of it is `async`, whereas this is a synchronous read of
// `navigator` and the call sites -- a `className`, a menu label, a
// font stack -- cannot await anything.

const { platform, isDarwin, isWindows, isLinux } = require(
  '../../build/renderer/lib/os'
)

const RENDERER = path.join(__dirname, '..', '..', 'src', 'renderer')

// The user agents the three supported webviews report: WKWebView on
// macOS, WebView2 on Windows, WebKitGTK on Linux. Taken from the real
// runtimes rather than invented, because the whole file is a bet on
// their contents.
const AGENTS = {
  darwin: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/' +
    '605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  win32: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, ' +
    'like Gecko) Version/17.0 Safari/605.1.15'
}

function withAgent (userAgent, fn) {
  const had = Object.prototype.hasOwnProperty.call(global, 'navigator')
  const previous = global.navigator
  Object.defineProperty(global, 'navigator', {
    value: { userAgent },
    configurable: true,
    writable: true
  })
  try {
    return fn()
  } finally {
    if (had) {
      Object.defineProperty(global, 'navigator', {
        value: previous,
        configurable: true,
        writable: true
      })
    } else {
      delete global.navigator
    }
  }
}

test('platform() reports Node spellings, not browser ones', function (t) {
  // `win32` rather than `windows`, and `darwin` rather than `macos`,
  // because the call sites compare against what `process.platform`
  // used to return and `static/main.css` styles `.app.is-win32`.
  t.equal(withAgent(AGENTS.darwin, platform), 'darwin')
  t.equal(withAgent(AGENTS.win32, platform), 'win32')
  t.equal(withAgent(AGENTS.linux, platform), 'linux')
  t.end()
})

test('a macOS user agent is not mistaken for Linux', function (t) {
  // Both are WebKit and both say `like Gecko`; only the platform token
  // in the parentheses separates them. Ordering the checks wrongly is
  // the plausible bug, so it gets its own assertion.
  t.ok(withAgent(AGENTS.darwin, isDarwin), 'macOS is darwin')
  t.notOk(withAgent(AGENTS.darwin, isLinux), 'macOS is not linux')
  t.notOk(withAgent(AGENTS.linux, isDarwin), 'linux is not darwin')
  t.ok(withAgent(AGENTS.linux, isLinux), 'linux is linux')
  t.end()
})

test('the predicates agree with platform()', function (t) {
  for (const [name, agent] of Object.entries(AGENTS)) {
    withAgent(agent, function () {
      t.equal(isDarwin(), name === 'darwin', `isDarwin on ${name}`)
      t.equal(isWindows(), name === 'win32', `isWindows on ${name}`)
      t.equal(isLinux(), name === 'linux', `isLinux on ${name}`)
    })
  }
  t.end()
})

test('an unrecognized user agent falls back to linux', function (t) {
  // Something has to be returned: `'is-' + platform()` becomes a CSS
  // class and `undefined` there is a silent styling failure. Linux is
  // the least-decorated of the three -- macOS adds a traffic-light
  // inset and Windows a title bar -- so guessing it is the guess that
  // degrades most gracefully.
  t.equal(withAgent('Mozilla/5.0 (Something New)', platform), 'linux')
  t.end()
})

test('no navigator at all is survivable', function (t) {
  // The module is loaded by the unit suite under plain Node, and by
  // `bin/` scripts indirectly. Throwing at load would take a test run
  // down for a reason unrelated to the test.
  const previous = global.navigator
  delete global.navigator
  try {
    t.doesNotThrow(() => platform(), 'no throw with no navigator')
  } finally {
    if (previous !== undefined) {
      Object.defineProperty(global, 'navigator', {
        value: previous,
        configurable: true,
        writable: true
      })
    }
  }
  t.end()
})

// -- and that the call sites actually moved -------------------------

// The point of the module is that nothing in the renderer reads the
// Node global any more. `eslint-boundary.config.js` bans it as an
// identifier; this is the companion check on the source text, for the
// same reason `platform-boundary.js` exists alongside that config --
// a scan catches spellings a rule about identifiers does not, such as
// `globalThis.process` or a string built at runtime.
function rendererSources () {
  const out = []
  ;(function walk (dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js')) out.push(full)
    }
  })(RENDERER)
  return out
}

// One file reads it on purpose. `lib/path.js` is Node's `path`
// algorithms, and `resolve()` resolves a relative segment against the
// working directory; it takes the real one where there is a `process`
// (the unit suite runs this module under plain Node) and falls back to
// `/` where there is not. That read is behind a `typeof` guard, which
// is the same shape `src/config.js` uses for the same reason, and is
// the only spelling that is safe in a webview.
const GUARDED = new Set([path.join('lib', 'path.js')])

test('the guarded reader really is guarded', function (t) {
  // An exemption that stops matching what it exempts is how this kind
  // of list quietly stops meaning anything.
  for (const relative of GUARDED) {
    const source = fs.readFileSync(path.join(RENDERER, relative), 'utf8')
    t.ok(/typeof\s+process\s*!==\s*'undefined'/.test(source),
      `${relative} still guards its read with typeof`)
  }
  t.end()
})

test('no renderer source reads the process global', function (t) {
  const offenders = []
  for (const file of rendererSources()) {
    const relative = path.relative(RENDERER, file)
    if (GUARDED.has(relative)) continue

    const source = fs.readFileSync(file, 'utf8')
    // Skip prose. The doc comments in `lib/os.js` and `lib/util.js`
    // both name `process.platform` to explain why they exist.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    if (/(^|[^.\w$])process\s*\./.test(code)) offenders.push(relative)
  }
  t.deepEqual(offenders, [],
    'the webview has no `process` -- use lib/os.js or the shim')
  t.end()
})
