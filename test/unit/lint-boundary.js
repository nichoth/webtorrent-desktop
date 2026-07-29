const test = require('tape')
const path = require('path')
const { ESLint } = require('eslint')

// US-034 (FR-11): the shim boundary is enforced by a real lint rule,
// not only by the source-scanning assertions in
// `test/unit/platform-boundary.js`. The two are complementary:
//
//   - `eslint-boundary.config.js` bans the *import specifiers*
//     (`electron`, `@electron/remote`, `fs`, `os`, `crypto`, `http`)
//     anywhere under `src/renderer/`, so a brand new file cannot
//     reintroduce a host dependency the shim has not seen.
//   - `platform-boundary.js` bans the *concerns* -- `ipcRenderer.`
//     member reads, `wt-` channel strings, `new remote.Menu` -- which
//     no import-level rule can express.
//
// This file drives the config through ESLint's Node API rather than
// shelling out to `npm run lint:boundary`, so it can lint synthetic
// text at a chosen path and prove the exemptions actually exempt.

const ROOT = path.join(__dirname, '..', '..')
const CONFIG = path.join(ROOT, 'eslint-boundary.config.js')

// Every specifier the rule must reject, in the spellings a renderer
// file could plausibly use.
const BANNED = [
  'electron',
  '@electron/remote',
  'fs',
  'fs/promises',
  'node:fs',
  'original-fs',
  'os',
  'node:os',
  'crypto',
  'node:crypto',
  'http',
  'node:http'
]

// Paths whose banned imports are legitimate. `lib/platform/` is the
// shim itself; the other two are the deferred casualties named in
// FR-4 and in the US-013 notes.
const EXEMPT = [
  'src/renderer/lib/platform/ipc-os.js',
  'src/renderer/lib/platform/a-new-shim-module.js',
  'src/renderer/webtorrent.js',
  'src/renderer/lib/cast.js'
]

// A file outside the renderer must not be touched by this config at
// all -- it exists to police `src/renderer/`, not the main process.
const OUTSIDE = [
  'src/main/index.js',
  'bin/package.js'
]

function boundaryEslint () {
  return new ESLint({
    cwd: ROOT,
    useEslintrc: false,
    overrideConfigFile: CONFIG
  })
}

async function lintAs (source, relPath) {
  const results = await boundaryEslint()
    .lintText(source, { filePath: path.join(ROOT, relPath) })
  return results[0].messages
}

test('the boundary config rejects every banned specifier under ' +
  'src/renderer/', async function (t) {
  for (const specifier of BANNED) {
    const messages = await lintAs(
      "import x from '" + specifier + "'\nexport default x\n",
      'src/renderer/probe.js'
    )
    const restricted = messages
      .filter((m) => m.ruleId === 'no-restricted-imports')
    t.equal(restricted.length, 1, specifier + ' is rejected')
    t.ok(/platform/.test(restricted[0].message || ''),
      specifier + ' is pointed at the shim')
  }
  t.end()
})

test('the boundary config rejects a banned side-effect and re-export ' +
  'too', async function (t) {
  const forms = [
    "import 'fs'\n",
    "export { readFileSync } from 'fs'\n"
  ]
  for (const source of forms) {
    const messages = await lintAs(source, 'src/renderer/probe.js')
    t.equal(
      messages.filter((m) => m.ruleId === 'no-restricted-imports').length,
      1,
      JSON.stringify(source.trim()) + ' is rejected'
    )
  }
  t.end()
})

test('the boundary config allows the imports the renderer still needs',
  async function (t) {
    const allowed = ['path', '../lib/platform/index.js', 'react']
    for (const specifier of allowed) {
      const messages = await lintAs(
        "import x from '" + specifier + "'\nexport default x\n",
        'src/renderer/probe.js'
      )
      t.deepEqual(
        messages.filter((m) => m.ruleId === 'no-restricted-imports'), [],
        specifier + ' is allowed')
    }
    t.end()
  })

test('the shim and the two deferred casualties are exempt',
  async function (t) {
    for (const relPath of EXEMPT) {
      for (const specifier of ['electron', '@electron/remote', 'fs']) {
        const messages = await lintAs(
          "import x from '" + specifier + "'\nexport default x\n",
          relPath
        )
        t.deepEqual(
          messages.filter((m) => m.ruleId === 'no-restricted-imports'), [],
          relPath + ' may import ' + specifier)
      }
    }
    t.end()
  })

test('the boundary config leaves code outside src/renderer/ alone',
  async function (t) {
    for (const relPath of OUTSIDE) {
      const messages = await lintAs(
        "import x from 'fs'\nexport default x\n", relPath)
      t.deepEqual(
        messages.filter((m) => m.ruleId === 'no-restricted-imports'), [],
        relPath + ' is not policed by the renderer boundary rule')
    }
    t.end()
  })

// Exactly two per-file overrides, one per deferred casualty (AC-3).
// The shim exemption is a directory glob, not a per-file override, so
// it is excluded from the count.
test('the config declares exactly two deferred-casualty overrides',
  function (t) {
    const config = require(CONFIG)
    const perFile = config.overrides
      .filter((o) => o.files.every((f) => !f.includes('*')))
      .flatMap((o) => o.files)
      .sort()
    t.deepEqual(perFile, [
      'src/renderer/lib/cast.js',
      'src/renderer/webtorrent.js'
    ], 'webtorrent.js and cast.js are the only per-file exemptions')
    t.end()
  })

// The real tree has to be clean, or the rule is decorative.
test('every real renderer source passes the boundary rule',
  async function (t) {
    const results = await boundaryEslint().lintFiles(['src/renderer'])
    t.ok(results.length > 20, 'linted the renderer tree')
    const offenders = results
      .filter((r) => r.messages.length > 0)
      .map((r) => path.relative(ROOT, r.filePath) + ': ' +
        r.messages.map((m) => m.line + ' ' + m.message).join('; '))
    t.deepEqual(offenders, [], 'src/renderer/ is clean')
    t.end()
  })
