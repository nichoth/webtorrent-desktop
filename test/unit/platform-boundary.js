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
