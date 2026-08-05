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

// Paths whose banned imports are legitimate: `lib/platform/`, the
// shim itself, and nothing else. Both deferred casualties are spent --
// US-045 deleted `src/renderer/webtorrent.js` and US-079 deleted
// `src/renderer/lib/cast.js` -- so the exemption is a directory glob
// with no per-file override beside it (ADR-008).
const EXEMPT = [
  'src/renderer/lib/platform/ipc-os.js',
  'src/renderer/lib/platform/a-new-shim-module.js'
]

// A file outside the renderer must not be touched by this config at
// all -- it exists to police `src/renderer/` and `src/engine/`, and
// nothing else. Until US-072 the example was the Electron main
// process; the build scripts and the config module the renderer shares
// with the sidecar make the same point and are still here.
const OUTSIDE = [
  'bin/build-tauri.js',
  'src/config.js'
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

// US-052 banned `lib/platform/tauri/` here: it was one of two trees
// behind the barrel, selected by `WT_HOST`, and naming it directly
// pinned a caller to one host. US-072 promoted that tree to
// `lib/platform/` and deleted the flag, so there is nothing left to
// ban -- and the rule that replaces it is the one below: a module
// inside the shim is reachable, because there is only one of it.
test('a shim module is importable by its own name now',
  async function (t) {
    const specifiers = [
      '../lib/platform',
      '../lib/platform/window',
      './platform/fs.js',
      'src/renderer/lib/platform/clipboard'
    ]
    for (const specifier of specifiers) {
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

// US-056: the Tauri API package is the second host's `electron`, and
// it is reached by subpath, so every subpath has to be caught.
test('the boundary config rejects a direct Tauri API import',
  async function (t) {
    const specifiers = [
      '@tauri-apps/api',
      '@tauri-apps/api/event',
      '@tauri-apps/api/core',
      '@tauri-apps/api/window'
    ]
    for (const specifier of specifiers) {
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

    // ...and the shim is where it is allowed, except in the one file
    // that is meant to need no host at all.
    const inShim = await lintAs(
      "import { listen } from '@tauri-apps/api/event'\nexport { listen }\n",
      'src/renderer/lib/platform/ipc-os.js'
    )
    t.deepEqual(
      inShim.filter((m) => m.ruleId === 'no-restricted-imports'), [],
      'the shim may import it')

    const inEngine = await lintAs(
      "import { listen } from '@tauri-apps/api/event'\nexport { listen }\n",
      'src/renderer/lib/platform/ipc-engine.js'
    )
    t.equal(
      inEngine.filter((m) => m.ruleId === 'no-restricted-imports').length, 1,
      'the engine shim stays host-free')
    t.end()
  })

// The shim's barrel imports its siblings relatively. That was true
// with two trees and is true with one; what changed is that there is
// no second tree for the exemption to have to reach.
test('the shim may reach its own siblings', async function (t) {
  const inside = [
    'src/renderer/lib/platform/index.js',
    'src/renderer/lib/platform/window.js'
  ]
  for (const relPath of inside) {
    const messages = await lintAs(
      "import * as x from './ipc-engine'\nexport { x }\n", relPath)
    t.deepEqual(
      messages.filter((m) => m.ruleId === 'no-restricted-imports'), [],
      relPath + ' may import its sibling')
  }
  t.end()
})

test('the shim and the deferred casualty are exempt',
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

// US-079: no deferred casualty is left. `webtorrent.js` went at
// US-045 and `lib/cast.js` at US-079, which closes ADR-008 -- every
// renderer file is behind the shim, so nothing may switch the rule
// off. `ipc-engine.js` is a per-file override too, but it re-enables
// the rule rather than switching it off, so it is not an exemption and
// is asserted separately below. The shim exemption is a directory
// glob, not a per-file override, so it is excluded from the count
// either way.
test('the config declares no deferred-casualty exemption',
  function (t) {
    const config = require(CONFIG)
    const exemptions = config.overrides
      .filter((o) => o.files.every((f) => !f.includes('*')))
      .filter((o) => o.rules['no-restricted-imports'] === 'off')
      .flatMap((o) => o.files)
      .sort()
    t.deepEqual(exemptions, [], 'no file is exempt from the import ban')
    t.end()
  })

// US-046 AC-2: `ipc-engine.js` used to need `electron` -- it spoke the
// `wt-*` protocol over `ipcRenderer`. US-044 made it a WebSocket
// client, so the blanket shim exemption is now more than it needs and
// the Electron ban goes back on for that one file.
test('ipc-engine.js is no longer exempt from the Electron ban',
  async function (t) {
    const IPC_ENGINE = 'src/renderer/lib/platform/ipc-engine.js'
    for (const specifier of ['electron', '@electron/remote', 'original-fs']) {
      const messages = await lintAs(
        "import x from '" + specifier + "'\nexport default x\n", IPC_ENGINE)
      t.equal(
        messages.filter((m) => m.ruleId === 'no-restricted-imports').length,
        1, IPC_ENGINE + ' may not import ' + specifier)
    }
    // The rest of the shim is unaffected: `ipc-os.js` owns the one
    // `electron` import the UI still has.
    const messages = await lintAs(
      "import x from 'electron'\nexport default x\n",
      'src/renderer/lib/platform/ipc-os.js')
    t.deepEqual(
      messages.filter((m) => m.ruleId === 'no-restricted-imports'), [],
      'ipc-os.js is still exempt')
    t.end()
  })

// US-046 AC-3/AC-4: the sidecar is a Node process, so the renderer's
// Node bans must not apply to it -- but the opposite mistake has to be
// caught. It has no Electron module available (it runs under
// ELECTRON_RUN_AS_NODE) and no DOM at all.
const ENGINE = 'src/engine/probe.js'

test('the engine may use Node builtins freely', async function (t) {
  for (const specifier of ['fs', 'fs/promises', 'os', 'crypto', 'http',
    'node:fs', 'path']) {
    const messages = await lintAs(
      "import x from '" + specifier + "'\nexport default x\n", ENGINE)
    t.deepEqual(
      messages.filter((m) => m.ruleId === 'no-restricted-imports'), [],
      ENGINE + ' may import ' + specifier)
  }
  t.end()
})

test('the engine may not import Electron', async function (t) {
  for (const specifier of ['electron', '@electron/remote', 'original-fs']) {
    const messages = await lintAs(
      "import x from '" + specifier + "'\nexport default x\n", ENGINE)
    const restricted = messages
      .filter((m) => m.ruleId === 'no-restricted-imports')
    t.equal(restricted.length, 1, ENGINE + ' may not import ' + specifier)
    // The renderer's message points at the shim, which would be
    // nonsense advice here: the sidecar has no shim and no Electron.
    t.notOk(/platform/.test(restricted[0].message || ''),
      specifier + ' is not pointed at the renderer shim')
    t.ok(/sidecar/.test(restricted[0].message || ''),
      specifier + ' is explained as a sidecar constraint')
  }
  t.end()
})

test('the engine may not touch a DOM global', async function (t) {
  for (const global of ['window', 'document', 'navigator', 'localStorage']) {
    const messages = await lintAs(
      'export default ' + global + '.x\n', ENGINE)
    const restricted = messages
      .filter((m) => m.ruleId === 'no-restricted-globals')
    t.equal(restricted.length, 1, global + ' is rejected in the engine')
  }
  // A Node global of the same shape must still be fine.
  const messages = await lintAs('export default process.pid\n', ENGINE)
  t.deepEqual(
    messages.filter((m) => m.ruleId === 'no-restricted-globals'), [],
    'process is not a DOM global')
  t.end()
})

test('the renderer is not policed by the engine rules', async function (t) {
  const messages = await lintAs(
    'export default window.location.href\n', 'src/renderer/probe.js')
  t.deepEqual(
    messages.filter((m) => m.ruleId === 'no-restricted-globals'), [],
    'the renderer is a DOM and may say window')
  t.end()
})

// US-072: the mirror image of the engine's DOM ban. The renderer runs
// in a webview now, and a webview has no Node globals -- so the ban
// runs in both directions and each tree is policed for the other's
// surface.
test('the renderer may not touch a Node global', async function (t) {
  for (const name of ['process', 'global', '__dirname', '__filename']) {
    const messages = await lintAs(
      'export default ' + name + '.x\n', 'src/renderer/probe.js')
    const restricted = messages
      .filter((m) => m.ruleId === 'no-restricted-globals')
    t.equal(restricted.length, 1, name + ' is rejected in the renderer')
  }
  t.end()
})

test('the engine is not policed by the renderer rules', async function (t) {
  // The sidecar is a plain Node process (ADR-012) and these are its
  // native surface. Asserted because the two `no-restricted-globals`
  // lists live in one file and the wrong `files` glob would swap them
  // without either tree noticing.
  const messages = await lintAs(
    'export default process.pid + __dirname\n', ENGINE)
  t.deepEqual(
    messages.filter((m) => m.ruleId === 'no-restricted-globals'), [],
    'the engine is Node and may say process')
  t.end()
})

test('lib/path.js keeps its guarded process read', async function (t) {
  // The one exemption. It is a file-scoped override rather than a
  // blanket one, so the check is that the *neighbouring* file does not
  // inherit it -- an override with a sloppy glob is indistinguishable
  // from no rule at all.
  const source = "export default typeof process !== 'undefined' ? 1 : 2\n"
  const exempt = await lintAs(source, 'src/renderer/lib/path.js')
  t.deepEqual(
    exempt.filter((m) => m.ruleId === 'no-restricted-globals'), [],
    'lib/path.js may read process behind its guard')

  const neighbour = await lintAs(source, 'src/renderer/lib/os.js')
  t.equal(
    neighbour.filter((m) => m.ruleId === 'no-restricted-globals').length, 1,
    'the exemption does not leak to the rest of lib/')
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

// A rule the lint script never runs over is decorative, and the
// engine override is easy to add to the config and forget in the
// script.
test('npm run lint:boundary covers both trees', function (t) {
  const { scripts } = require(path.join(ROOT, 'package.json'))
  const script = scripts['lint:boundary']
  t.ok(/\bsrc\/renderer\b/.test(script), 'the renderer is linted')
  t.ok(/\bsrc\/engine\b/.test(script), 'the engine is linted')
  t.ok(/eslint-boundary\.config\.js/.test(script), 'with this config')
  t.end()
})

test('every real engine source passes the boundary rule',
  async function (t) {
    const results = await boundaryEslint().lintFiles(['src/engine'])
    t.ok(results.length > 1, 'linted the engine tree')
    const offenders = results
      .filter((r) => r.messages.length > 0)
      .map((r) => path.relative(ROOT, r.filePath) + ': ' +
        r.messages.map((m) => m.line + ' ' + m.message).join('; '))
    t.deepEqual(offenders, [], 'src/engine/ is clean')
    t.end()
  })
