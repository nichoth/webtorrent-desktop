const test = require('tape')
const fs = require('fs')
const path = require('path')

// Static boundary check (FR-8): once a shim module's call sites are
// migrated, nothing outside `src/renderer/lib/platform/` may reach the
// corresponding Electron API directly again. This grew one concern at
// a time as the US-026..US-032 migrations landed.
//
// US-034 added a lint rule (`eslint-boundary.config.js`, driven by
// `test/unit/lint-boundary.js`) but did NOT replace this file. The two
// cover different things and both are needed: the lint rule bans the
// import *specifiers*, which catches a brand new file reaching for a
// host module; this file bans the *concerns* -- `ipcRenderer.` member
// reads, `wt-` channel strings, `new remote.Menu`, `remote.dialog` --
// which no import-level rule can express, plus the `require()`
// spellings that `no-restricted-imports` does not see.
//
// It reads the ESM sources under `src/` rather than the Babel output,
// because the boundary is a property of the source we hand to the
// bundler, and `build/` does not contain `components/` or
// `controllers/` at all.

const SRC = path.join(__dirname, '..', '..', 'src')
const RENDERER = path.join(SRC, 'renderer')
const ENGINE = path.join(SRC, 'engine')
const SHIM = path.join(RENDERER, 'lib', 'platform')

// US-046: `src/renderer/webtorrent.js` used to be exempt from the shim
// under FR-4 -- it was a Node process by design and kept its own
// `require('fs')`. US-045 deleted the file, so nothing under
// `src/renderer/` is exempt from the Node bans any more and the two
// exemption sets below are empty of it.
const EXEMPT = new Set()

// US-079: the last deferred casualty, `lib/cast.js`, is gone --
// casting moved to the host behind `lib/platform/cast.js` (ADR-015) --
// so there is no per-file override left in
// `eslint-boundary.config.js` and no exempt set to keep here.

function rendererSources () {
  const out = []
  ;(function walk (dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (full !== SHIM) walk(full)
      } else if (entry.name.endsWith('.js')) {
        out.push(full)
      }
    }
  })(RENDERER)
  return out
}

// `import { shell, clipboard } from 'electron'` in any spelling, plus
// the namespace form `electron.clipboard` / `electron.shell`.
function offendingLines (source, name) {
  const named = new RegExp(
    'import\\s*\\{[^}]*\\b' + name + '\\b[^}]*\\}\\s*from\\s*[\'"]electron[\'"]'
  )
  const member = new RegExp('\\belectron\\.' + name + '\\b')
  return source.split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => named.test(line) || member.test(line))
    .map(({ line, n }) => n + ': ' + line.trim())
}

for (const name of ['shell', 'clipboard']) {
  test('no renderer code outside the shim uses electron.' + name, function (t) {
    const files = rendererSources()
    t.ok(files.length > 20, 'walked the renderer sources')
    for (const file of files) {
      const rel = path.relative(RENDERER, file)
      const hits = offendingLines(fs.readFileSync(file, 'utf8'), name)
      t.deepEqual(hits, [], rel + ' does not reach for electron.' + name)
    }
    t.end()
  })
}

// US-027 covers two of `@electron/remote`'s concerns: the dialog API and
// the two window-state reads. `remote.Menu` / `remote.MenuItem` in
// `controllers/torrent-list-controller.js` is a third, migrated in
// US-029, so a blanket ban on the `@electron/remote` specifier would be
// dishonest here. These patterns name the concerns instead. The
// namespace forms cover both `remote.x` (`@electron/remote`) and
// `electron.remote.x` (the long-broken Electron 13 spelling that
// `main.js` still used).
const REMOTE_CHECKS = [
  {
    concern: 'the @electron/remote dialog API',
    patterns: [
      /\bremote\.dialog\b/,
      /import\s*\{[^}]*\bdialog\b[^}]*\}\s*from\s*['"]@electron\/remote['"]/
    ]
  },
  {
    concern: 'window-state reads via getCurrentWindow()',
    patterns: [/getCurrentWindow\s*\(\s*\)\s*\.\s*(isVisible|isMaximized)\b/]
  },
  // US-029: the menu concern. `Menu` and `MenuItem` are only ever
  // reached by construction, so the patterns name `new`.
  {
    concern: 'the @electron/remote menu API',
    patterns: [
      /\bnew\s+(electron\.)?remote\.Menu(Item)?\b/,
      /import\s*\{[^}]*\bMenu(Item)?\b[^}]*\}\s*from\s*['"]@electron\/remote['"]/
    ]
  }
]

for (const { concern, patterns } of REMOTE_CHECKS) {
  test('no renderer code outside the shim uses ' + concern, function (t) {
    const files = rendererSources()
    t.ok(files.length > 20, 'walked the renderer sources')
    for (const file of files) {
      const rel = path.relative(RENDERER, file)
      const hits = fs.readFileSync(file, 'utf8').split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => patterns.some((re) => re.test(line)))
        .map(({ line, n }) => n + ': ' + line.trim())
      t.deepEqual(hits, [], rel + ' does not use ' + concern)
    }
    t.end()
  })
}

// The window's own rectangle is a host read too, and this one is not
// an Electron API -- it is four DOM properties that only describe the
// OS window when the page is a Chromium browser window. In a webview
// `outerWidth`/`outerHeight` are 0 and `screenX`/`screenY` are the
// content area's origin, one title bar below the window's, so a
// renderer that saves them and asks the host to restore them later
// sends the window to a rectangle no window was ever at. The screen's
// dimensions (`window.screen.width`) are a different question and stay
// where they are: they describe the display, not this window.
test('no renderer code reads the window rectangle from the DOM',
  function (t) {
    const files = rendererSources()
    t.ok(files.length > 20, 'walked the renderer sources')
    const pattern = /\bwindow\.(screenX|screenY|outerWidth|outerHeight)\b/
    for (const file of files) {
      const rel = path.relative(RENDERER, file)
      const hits = fs.readFileSync(file, 'utf8').split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => pattern.test(line))
        .map(({ line, n }) => n + ': ' + line.trim())
      t.deepEqual(hits, [], rel + ' asks the host for the window rectangle')
    }
    t.end()
  })

// US-028: the filesystem concern. Unlike the Electron checks above the
// offending API is a Node builtin, so the pattern names the module
// specifier -- there is only one way to reach `fs` and no second
// concern sharing it. `src/renderer/webtorrent.js` is exempt by FR-4,
// and `lib/platform/` is already skipped by the walk.
test('no renderer code outside the shim imports fs', function (t) {
  const files = rendererSources().filter((f) => !EXEMPT.has(f))
  t.ok(files.length > 20, 'walked the renderer sources')
  const patterns = [
    /from\s*['"](fs|fs\/promises|original-fs)['"]/,
    /require\s*\(\s*['"](fs|fs\/promises|original-fs)['"]\s*\)/
  ]
  for (const file of files) {
    const rel = path.relative(RENDERER, file)
    const hits = fs.readFileSync(file, 'utf8').split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => patterns.some((re) => re.test(line)))
      .map(({ line, n }) => n + ': ' + line.trim())
    t.deepEqual(hits, [], rel + ' does not import fs directly')
  }
  t.end()
})

// US-030/US-031 covered the OS-facing IPC concern (`ipc-os.js`) and
// US-032 the engine protocol (`ipc-engine.js`). Between them the two
// shims own every renderer <-> main channel (FR-9), so there is no
// longer a channel prefix to carve out: nothing outside
// `lib/platform/` may name a channel at all.
//
// `webtorrent.js` was the last exemption here, as the counterparty of
// the `wt-*` protocol. US-039 put a bus between the engine and the
// transport (`src/engine/bus-electron.js`, outside this walk), so the
// exemption is gone and this check now covers the whole renderer with
// no carve-out. It still names `wt-` channels, so it stays exempt from
// the channel-string check below.
test('no renderer file outside the shim touches ipcRenderer',
  function (t) {
    const files = rendererSources()
    t.ok(files.length > 20, 'walked the renderer sources')
    for (const file of files) {
      const rel = path.relative(RENDERER, file)
      const hits = fs.readFileSync(file, 'utf8').split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => /\bipcRenderer\s*\./.test(line))
        .map(({ line, n }) => n + ': ' + line.trim())
      t.deepEqual(hits, [], rel + ' routes every channel through a shim')
    }
    t.end()
  })

// The dynamic channel families are the one place a caller could route
// through the shim and still know the protocol: building
// `'wt-ready-' + infoHash` and handing it over defeats the point. The
// shim takes the info hash instead (`onTorrentReadyFor`), so no
// `wt-`-prefixed string literal belongs outside it.
test('no renderer file outside the shim builds a wt-* channel string',
  function (t) {
    const files = rendererSources().filter((f) => !EXEMPT.has(f))
    for (const file of files) {
      const rel = path.relative(RENDERER, file)
      const hits = fs.readFileSync(file, 'utf8').split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => /['"`]wt-/.test(line))
        .map(({ line, n }) => n + ': ' + line.trim())
      t.deepEqual(hits, [], rel + ' names no wt-* channel')
    }
    t.end()
  })

// US-034: `no-restricted-imports` only sees `import` declarations, so
// the lint rule cannot stop a renderer file from reaching a host
// module through a call-scoped `require()` -- which is exactly the
// escape hatch `lib/cast.js` used for the casting libraries, and the
// only deferral mechanism that works in this renderer at all. US-079
// deleted that file and with it the last `require()` in the renderer;
// this covers the same specifier list for the `require()` spelling.
test('no renderer file outside the shim requires a banned host module',
  function (t) {
    const files = rendererSources()
    t.ok(files.length > 20, 'walked the renderer sources')
    const banned = [
      'electron', '@electron/remote',
      'fs', 'fs/promises', 'original-fs',
      'os', 'crypto', 'http'
    ]
    const pattern = new RegExp(
      'require\\s*\\(\\s*[\'"](node:)?(' +
      banned.map((s) => s.replace('/', '\\/')).join('|') +
      ')[\'"]\\s*\\)'
    )
    for (const file of files) {
      const rel = path.relative(RENDERER, file)
      const hits = fs.readFileSync(file, 'utf8').split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => pattern.test(line))
        .map(({ line, n }) => n + ': ' + line.trim())
      t.deepEqual(hits, [], rel + ' requires no host module directly')
    }
    t.end()
  })

// US-052: the shim has two implementations (ADR-014), and which one a
// build talks to is decided by `WT_HOST` at resolve time, not by any
// import. A UI file naming `lib/platform/tauri/` would pin itself to
// one host and quietly survive a bundle built for the other. The lint
// rule bans the specifier; this covers the `require()` spelling it
// cannot see, and both directions of slash.
test('no renderer file outside the shim names the Tauri tree',
  function (t) {
    const files = rendererSources()
    t.ok(files.length > 20, 'walked the renderer sources')
    const pattern = /platform[\\/]tauri/
    for (const file of files) {
      const rel = path.relative(RENDERER, file)
      const hits = fs.readFileSync(file, 'utf8').split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => pattern.test(line))
        .map(({ line, n }) => n + ': ' + line.trim())
      t.deepEqual(hits, [], rel + ' lets the build pick the shim tree')
    }
    t.end()
  })

// US-032 AC-4: with both IPC concerns migrated, the only renderer
// modules left importing Electron were the shim itself (skipped by the
// walk) and the hidden WebTorrent window (FR-4). AC-4 also exempts
// `lib/cast.js`, but it reached Chromecast through `chromecasts` /
// `airplay-js`, not Electron, so the assertion below was exact rather
// than allowing it -- and US-079 deleted the file anyway.
//
// Since US-039 the list is empty: the engine's `electron` import moved
// into `src/engine/bus-electron.js`, which is not under this walk.
test('nothing outside the shim imports electron',
  function (t) {
    const patterns = [
      /from\s*['"](electron|@electron\/remote)['"]/,
      /require\s*\(\s*['"](electron|@electron\/remote)['"]\s*\)/
    ]
    const importers = rendererSources()
      .filter((file) => patterns.some((re) =>
        re.test(fs.readFileSync(file, 'utf8'))))
      .map((file) => path.relative(RENDERER, file).split(path.sep).join('/'))
      .sort()
    t.deepEqual(importers, [],
      'no renderer module outside the shim imports electron')
    t.end()
  })

// US-056: the same rule for the second host. `@tauri-apps/api` is
// Tauri's `electron` -- a package the shim may hold and nothing above
// it may, in either spelling and at any subpath. Without this a UI
// file could reach the Tauri host directly and the bundle would build
// for one host only, which is exactly what ADR-014 keeps out.
test('nothing outside the shim imports the Tauri API',
  function (t) {
    const patterns = [
      /from\s*['"]@tauri-apps\/api(\/[\w-]+)*['"]/,
      /require\s*\(\s*['"]@tauri-apps\/api(\/[\w-]+)*['"]\s*\)/
    ]
    const importers = rendererSources()
      .filter((file) => patterns.some((re) =>
        re.test(fs.readFileSync(file, 'utf8'))))
      .map((file) => path.relative(RENDERER, file).split(path.sep).join('/'))
      .sort()
    t.deepEqual(importers, [],
      'no renderer module outside the shim imports Tauri')
    t.end()
  })

// US-042 AC-4: the sidecar endpoint reaches the renderer over the shim
// and nowhere else. The two tempting shortcuts are the environment the
// host happened to spawn the window with and a global the host poked
// onto `window`, and both would survive every check above -- neither
// touches an Electron API. This walk therefore includes
// `lib/platform/` itself, because the shim is exactly the file that
// would be tempted.
test('no renderer file reads the engine endpoint from env or a global',
  function (t) {
    const patterns = [
      /process\s*\.\s*env\s*\.\s*WEBTORRENT_ENGINE\w*/,
      /WEBTORRENT_ENGINE_(TOKEN|PORT)/,
      /\b(window|globalThis|global)\s*\.\s*\w*[eE]ngine(Endpoint|Url|Port|Token)\b/
    ]
    const files = rendererSources().concat(
      fs.readdirSync(SHIM)
        .filter((name) => name.endsWith('.js'))
        .map((name) => path.join(SHIM, name))
    )
    t.ok(files.length > 20, 'walked the renderer sources and the shim')
    for (const file of files) {
      const rel = path.relative(RENDERER, file)
      const hits = fs.readFileSync(file, 'utf8').split('\n')
        // A comment explaining what the renderer must not do would
        // otherwise fail this check (see test/AGENTS.md).
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => patterns.some((re) => re.test(line)))
        .map(({ line, n }) => n + ': ' + line.trim())
      t.deepEqual(hits, [], rel + ' does not read the endpoint directly')
    }
    t.end()
  })

// -- US-046: the sidecar side of the boundary -------------------------

function engineSources () {
  return fs.readdirSync(ENGINE)
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(ENGINE, name))
}

// Comment lines are dropped before every match below: these files
// explain at length what they must not do, and a scan cannot tell code
// from prose (see test/AGENTS.md).
function codeLines (file) {
  return fs.readFileSync(file, 'utf8').split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line))
}

function hitsIn (file, patterns) {
  return codeLines(file)
    .filter(({ line }) => patterns.some((re) => re.test(line)))
    .map(({ line, n }) => n + ': ' + line.trim())
}

// AC-2: `ipc-engine.js` spoke the `wt-*` protocol over `ipcRenderer`
// until US-044 made it a WebSocket client. It is inside the shim, so
// every check above skips it; this one names it. The `require()`
// spelling is here because `no-restricted-imports` cannot see it.
test('the engine shim reaches no Electron API', function (t) {
  const file = path.join(SHIM, 'ipc-engine.js')
  const patterns = [
    /from\s*['"](electron|@electron\/remote|original-fs)['"]/,
    /require\s*\(\s*['"](electron|@electron\/remote|original-fs)['"]\s*\)/,
    /\bipcRenderer\s*\./
  ]
  t.deepEqual(hitsIn(file, patterns), [],
    'ipc-engine.js talks to the sidecar, not to Electron')
  t.end()
})

// AC-4: the opposite mistake. The sidecar runs under
// ELECTRON_RUN_AS_NODE, where `require('electron')` yields no `app`,
// and a packaged sidecar has no `node_modules/electron` to resolve at
// all -- so an Electron import there fails at load rather than
// degrading. It has no DOM either.
test('no engine source imports Electron', function (t) {
  const files = engineSources()
  t.ok(files.length > 1, 'walked the engine sources')
  const patterns = [
    /from\s*['"](electron|@electron\/remote|original-fs)['"]/,
    /require\s*\(\s*['"](electron|@electron\/remote|original-fs)['"]\s*\)/
  ]
  for (const file of files) {
    t.deepEqual(hitsIn(file, patterns), [],
      path.basename(file) + ' imports no Electron module')
  }
  t.end()
})

test('no engine source touches a DOM global', function (t) {
  const files = engineSources()
  t.ok(files.length > 1, 'walked the engine sources')
  const patterns = [
    /\b(window|document|navigator|localStorage|sessionStorage)\s*\./,
    /\bnew\s+(Image|Audio|XMLHttpRequest)\b/
  ]
  for (const file of files) {
    t.deepEqual(hitsIn(file, patterns), [],
      path.basename(file) + ' uses no DOM global')
  }
  t.end()
})

// The engine is exempt from the renderer's Node bans, and the walk
// above must not quietly grow into policing them. Asserting the
// sidecar does use a Node builtin keeps that explicit.
test('the engine uses Node builtins freely', function (t) {
  const source = fs.readFileSync(path.join(ENGINE, 'index.js'), 'utf8')
  t.ok(/from\s*['"]fs['"]/.test(source),
    'src/engine/index.js imports fs directly, as a Node process may')
  t.end()
})

// US-079: the three casting packages went to the host with the code
// that loaded them (ADR-015), and they are gone from `package.json`.
// `depcheck` catches an unused dependency; this catches the opposite
// mistake -- a renderer file naming one that is no longer installed --
// which would otherwise surface as a bundler resolution failure in
// whatever story reintroduced it.
test('no renderer file names a casting package', function (t) {
  const files = rendererSources()
  t.ok(files.length > 20, 'walked the renderer sources')
  const packages = ['chromecasts', 'dlnacasts', 'airplayer']
  const patterns = packages.map((name) => new RegExp(
    '(from|require\\s*\\()\\s*[\'"]' + name + '[\'"]'))
  for (const file of files) {
    t.deepEqual(hitsIn(file, patterns), [],
      path.relative(RENDERER, file) + ' drives no cast device itself')
  }
  t.end()
})

// The counterpart: casting is behind the shim like everything else,
// so `lib/cast.js` must not come back under any name.
test('the renderer has no cast module outside the shim', function (t) {
  t.equal(fs.existsSync(path.join(RENDERER, 'lib', 'cast.js')), false,
    'src/renderer/lib/cast.js is gone')
  t.equal(fs.existsSync(path.join(SHIM, 'cast.js')), true,
    'and lib/platform/cast.js is where casting lives')
  t.end()
})
