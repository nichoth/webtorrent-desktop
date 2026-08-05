const test = require('tape')
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')

// US-072: the cutover. Until this story the repo carried two hosts --
// two shim trees, two renderer builds, an Electron main process and a
// Rust one -- and ADR-014 said that scaffolding comes down as soon as
// the Tauri host is the only one. This file is the check that it did,
// and that it stays down.
//
// It is a source-and-manifest scan rather than a behavioural test on
// purpose: what the story removed has no behaviour left to assert, and
// the failure mode it guards against is a later story quietly
// reintroducing an Electron dependency or a second code path.

const REPO = path.join(__dirname, '..', '..')

const pkg = JSON.parse(
  fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')
)

// Everything the port either deleted outright or replaced with a Rust
// counterpart. Each entry names the story that owns the replacement so
// a failure here reads as "this came back" rather than "this is
// missing".
// `path.join` rather than a literal for the main process's directory:
// the source scan at the bottom of this file rejects a quoted
// `src/main` path anywhere in the repo, and this file is in the repo.
const GONE = [
  ['index.js', 'the Electron entry point; src-tauri/src/main.rs now'],
  [path.join('src', 'main'),
    'the Electron main process, ported through US-053..US-071'],
  ['src/renderer/lib/platform/tauri',
    'the second shim tree; promoted to lib/platform/'],
  ['bin/shim-resolver.js', 'the WT_HOST build flag (ADR-014)'],
  ['bin/build-renderer.js', 'the second renderer build'],
  ['bin/package.js', 'electron-packager; Tauri bundles (US-083/US-084)'],
  ['test/index.js', 'the Spectron suite'],
  ['test/setup.js', 'the Spectron harness'],
  ['test/mocks.js', 'the Spectron dialog mocks'],
  ['spectron-probe.cjs', 'a Spectron smoke probe']
]

test('every dual-host file is gone', function (t) {
  for (const [rel, why] of GONE) {
    t.notOk(fs.existsSync(path.join(REPO, rel)),
      `${rel} is gone -- ${why}`)
  }
  t.end()
})

test('the shim is one tree of real modules', function (t) {
  const shim = path.join(REPO, 'src', 'renderer', 'lib', 'platform')
  const entries = fs.readdirSync(shim, { withFileTypes: true })
  t.ok(entries.length > 5, 'walked the shim')
  for (const entry of entries) {
    t.ok(entry.isFile(), `${entry.name} is a file, not a second tree`)
  }
  t.end()
})

// -- the manifest ----------------------------------------------------

const ELECTRON_PACKAGES = [
  'electron',
  '@electron/remote',
  'electron-packager',
  'electron-winstaller',
  'electron-osx-sign',
  'electron-notarize',
  'electron-installer-debian',
  'electron-installer-redhat',
  'appdmg',
  'spectron'
]

const SECTIONS = [
  'dependencies', 'devDependencies', 'optionalDependencies',
  'peerDependencies'
]

test('no Electron package is still declared', function (t) {
  for (const section of SECTIONS) {
    for (const name of Object.keys(pkg[section] || {})) {
      t.notOk(ELECTRON_PACKAGES.includes(name),
        `${section}.${name} is gone`)
    }
  }
  t.end()
})

test('package.json has no Electron entry point', function (t) {
  t.notOk(pkg.main, 'no "main" field -- Tauri loads static/main.html')
  t.end()
})

test('npm start launches Tauri', function (t) {
  const start = pkg.scripts.start
  t.ok(/tauri/.test(start), `start runs Tauri: ${start}`)
  t.notOk(/electron/.test(start), 'start does not run Electron')
  t.notOk(pkg.scripts['start:tauri'],
    'there is one start script, not one per host')
  t.end()
})

test('no npm script mentions Electron or a host flag', function (t) {
  for (const [name, body] of Object.entries(pkg.scripts)) {
    t.notOk(/electron|spectron|WT_HOST/.test(body),
      `scripts.${name} is host-neutral: ${body}`)
  }
  t.notOk(pkg.scripts['build:renderer:tauri'],
    'there is one renderer build, so it needs no host suffix')
  t.end()
})

test('the renderer build has no host to select', function (t) {
  const config = fs.readFileSync(
    path.join(REPO, 'vite.config.js'), 'utf8'
  )
  t.notOk(/shim-resolver|WT_HOST/.test(config),
    'vite.config.js selects no shim tree')
  t.notOk(/'electron'|'@electron\/remote'/.test(config),
    'nothing is externalized to an Electron runtime')
  t.end()
})

// -- the sources -----------------------------------------------------

// These two scans read the AST rather than the text, and they have to.
// A text scan cannot tell a dependency from a description of one, and
// after the cutover this repo is full of descriptions: several modules
// explain in a comment why they no longer need Electron, and
// `test/unit/lint-boundary.js` and `platform-boundary.js` carry
// `import x from 'electron'` and `require('electron')` as the
// synthetic sources they lint and grep for. A regex reports all of
// those, and the only way to make it stop is to loosen it until it
// reports nothing -- which is a green test that checks nothing.
//
// Babel is already a devDependency and already compiles every one of
// these files, so parsing them costs nothing new. `unambiguous` takes
// the CommonJS scripts and the ESM modules through the same call, and
// the `jsx` parser plugin covers the components.
function parse (file, source) {
  return babel.parseSync(source, {
    filename: file,
    configFile: false,
    babelrc: false,
    sourceType: 'unambiguous',
    parserOpts: { plugins: ['jsx'] }
  })
}

// A depth-first walk over plain AST nodes. `@babel/traverse` would do
// this, but it is not a direct dependency and this is a dozen lines.
function nodes (node, out = []) {
  if (!node || typeof node.type !== 'string') return out
  out.push(node)
  for (const key of Object.keys(node)) {
    if (key === 'loc') continue
    const value = node[key]
    if (Array.isArray(value)) for (const child of value) nodes(child, out)
    else if (value && typeof value === 'object') nodes(value, out)
  }
  return out
}

const IMPORTING = new Set([
  'ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'
])

function isRequire (node) {
  return node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' && node.callee.name === 'require' &&
    node.arguments.length > 0 &&
    node.arguments[0].type === 'StringLiteral'
}

// Every module specifier the file actually depends on: the `source` of
// an import or a re-export, and the argument of a `require()` call. A
// specifier that only appears inside another string is not one.
function importsOf (ast) {
  const found = new Set()
  for (const node of nodes(ast.program)) {
    if (IMPORTING.has(node.type) && node.source) found.add(node.source.value)
    else if (isRequire(node)) found.add(node.arguments[0].value)
  }
  return found
}

// Every string the file holds, which is where a path would be. Read
// off the AST for the same reason -- and it is also why the `GONE`
// entry above is a `path.join`: as two strings it says the same thing
// without being one.
function stringsOf (ast) {
  return nodes(ast.program)
    .filter((node) => node.type === 'StringLiteral')
    .map((node) => node.value)
}

function walk (dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

const SOURCES = ['src', 'bin', 'test']
  .flatMap((dir) => walk(path.join(REPO, dir)))
  .concat(path.join(REPO, 'vite.config.js'))
  .concat(path.join(REPO, 'eslint-boundary.config.js'))

// Parsed once: both scans below read the same trees.
const PARSED = SOURCES.map((file) => {
  const source = fs.readFileSync(file, 'utf8')
  return {
    rel: path.relative(REPO, file),
    ast: parse(file, source)
  }
})

const BANNED = [
  'electron', '@electron/remote', 'original-fs', 'spectron',
  'electron-packager', 'electron-winstaller', 'electron-osx-sign',
  'electron-notarize'
]

test('nothing in the repo imports Electron any more', function (t) {
  t.ok(PARSED.length > 40, `walked ${PARSED.length} files`)
  for (const { rel, ast } of PARSED) {
    const imports = importsOf(ast)
    for (const name of BANNED) {
      t.notOk(imports.has(name), `${rel} does not import ${name}`)
    }
  }
  t.end()
})

// The other half: the main process is gone, so no path may still lead
// to it. `src/main/` was the sources, `build/main/` the Babel output
// that `index.js` and the unit suite loaded. Matched at a path
// boundary on both sides, so `src/main.rs` and a `main` that is part
// of a longer word are not it.
const MAIN_PATH = /(?:^|\/)(?:src|build)\/main(?:\/|$)/

test('nothing in the repo names the deleted main process',
  function (t) {
    for (const { rel, ast } of PARSED) {
      const hit = stringsOf(ast).find((value) => MAIN_PATH.test(value))
      t.equal(hit, undefined,
        `${rel} names no src/main or build/main path` +
        (hit === undefined ? '' : ` (${JSON.stringify(hit)})`))
    }
    t.end()
  })

// -- the Babel build -------------------------------------------------

// ADR-003 split the build in two because Electron's main process
// needed CommonJS. That process is gone; what still needs the Babel
// output is the engine sidecar (ADR-012), the config module it shares
// with the renderer, the wire protocol, and the unit suite's CJS copy
// of the renderer's libraries (ADR-010).
test('the Babel build no longer builds a main process', function (t) {
  const build = pkg.scripts['build:node']
  t.ok(build, 'the Babel build is called build:node, not build:main')
  t.notOk(pkg.scripts['build:main'], 'nothing is called build:main')
  t.ok(pkg.scripts.build.includes('build:node'),
    'npm run build runs it')
  t.ok(pkg.scripts['test-unit'].includes('build:node'),
    'the unit suite builds it first')
  t.end()
})

test('the Babel output holds no main process', function (t) {
  const out = path.join(REPO, 'build')
  t.ok(fs.existsSync(out), 'the build directory exists')
  t.notOk(fs.existsSync(path.join(out, 'main')),
    'build/main is gone -- test-unit rebuilt without it')
  t.end()
})
