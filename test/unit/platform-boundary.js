const test = require('tape')
const fs = require('fs')
const path = require('path')

// Static boundary check (FR-8): once a shim module's call sites are
// migrated, nothing outside `src/renderer/lib/platform/` may reach the
// corresponding Electron API directly again. This grows one concern at
// a time as the US-026..US-032 migrations land; US-034 replaces it with
// a lint rule covering the whole surface.
//
// It reads the ESM sources under `src/` rather than the Babel output,
// because the boundary is a property of the source we hand to the
// bundler, and `build/` does not contain `components/` or
// `controllers/` at all.

const RENDERER = path.join(__dirname, '..', '..', 'src', 'renderer')
const SHIM = path.join(RENDERER, 'lib', 'platform')

// FR-4 exempts the hidden WebTorrent window from the shim: it is a
// Node process by design and keeps its own `require('fs')`.
const EXEMPT = new Set([path.join(RENDERER, 'webtorrent.js')])

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
