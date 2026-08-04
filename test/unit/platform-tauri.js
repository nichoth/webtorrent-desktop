const test = require('tape')
const fs = require('fs')
const path = require('path')

const {
  ELECTRON, TAURI, host, redirect, shimDir
} = require('../../bin/shim-resolver')

// US-052: the second shim tree, and the build flag that selects it.
//
// ADR-014 keeps both hosts buildable for the whole of Phase 4, with
// exactly one shim tree in a given bundle. Two things have to hold for
// that to be worth anything. The trees must not drift -- a Tauri
// module that quietly loses an export is a runtime `undefined is not a
// function` in a build nobody runs by default -- and the selection has
// to be all-or-nothing, because a bundle with half of each tree in it
// builds cleanly and fails at the first call.
//
// The parity checks below are the first. The resolver checks are the
// second: `bin/shim-resolver.js` is a plain module precisely so the
// decision can be tested without running a build.

const REPO = path.join(__dirname, '..', '..')
const SRC_SHIM = shimDir(REPO)
const SRC_TAURI = path.join(SRC_SHIM, TAURI)

// Unit tests require the Babel output, not the ESM sources.
const BUILT_SHIM = path.join(
  REPO, 'build', 'renderer', 'lib', 'platform'
)

// Not a shim module: the shared failure helper the stubs call.
const HELPERS = ['not-implemented.js']

// The one module in the Tauri tree that is a real implementation
// rather than a stub -- it re-exports the sibling, which has been
// host-free since US-044. Its exports are therefore not called below.
const REEXPORTED = 'ipc-engine'

// The exports a Phase 4 story has already implemented, module by
// module. They are the ones that must NOT throw, so they are skipped
// by the not-implemented sweep below and checked for the opposite
// instead. Each has its own test file; this list is the register that
// keeps the sweep honest as the tree fills in.
const IMPLEMENTED = {
  // US-056: the window restore loop's renderer half.
  // US-057: the window controls, and the fullscreen event.
  // US-061: the application menu's renderer half -- the calls that
  // enable and disable items, and the event a click arrives on.
  // US-063: the dock badge and the Downloads stack.
  'ipc-os.js': [
    'onWindowBoundsChanged',
    'setTitle',
    'setProgress',
    'setBadge',
    'notifyDownloadFinished',
    'setBounds',
    'setAspectRatio',
    'toggleFullScreen',
    'show',
    'onFullscreenChanged',
    'setAllowNav',
    'notifyPlayerOpen',
    'notifyPlayerUpdate',
    'notifyPlayerClose',
    'onDispatch'
  ],
  // US-057: the two current-window reads.
  'window.js': ['isVisible', 'isMaximized'],
  // US-058: the file dialogs.
  'dialog.js': ['showOpenDialog', 'showSaveDialog'],
  // US-059: handing paths and URLs to the OS, and the clipboard.
  'shell.js': ['openExternal', 'showItemInFolder', 'openPath',
    'moveItemToTrash'],
  'clipboard.js': ['readText', 'writeText'],
  // US-060: file access, against the host's directory allowlist.
  'fs.js': ['readFile', 'writeFile', 'copyFile', 'mkdir', 'rename',
    'unlink', 'readdir', 'stat', 'exists'],
  // US-061: the context menu, built by the host from descriptors.
  'menu.js': ['showContextMenu']
}

function implemented (name) {
  return IMPLEMENTED[name] || []
}

function modules (dir) {
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.js') && !HELPERS.includes(name))
    .sort()
}

function load (tree, name) {
  return require(path.join(BUILT_SHIM, tree, name))
}

const electronModules = modules(SRC_SHIM)

// Export names are read out of the ESM sources rather than by
// requiring the built modules. Half the Electron tree pulls in
// `electron` and `@electron/remote` on require, which only work inside
// a real Electron process -- and the sibling test files that do stub
// them share one `require.cache` with this one, so requiring a module
// here would hand them this file's stub instead of their own (see
// test/AGENTS.md). A parser sidesteps both. It understands exactly the
// four export forms this directory uses.
function exportsOf (file) {
  const source = fs.readFileSync(file, 'utf8')
  const found = new Map()

  // `export * from '../ipc-engine'` -- the Tauri engine shim.
  const star = source.match(/export \* from '([^']+)'/)
  if (star) {
    const target = path.resolve(path.dirname(file), star[1]) + '.js'
    return exportsOf(target)
  }

  const fn = /export (?:async )?function (\w+)\s*\(([\s\S]*?)\)\s*\{/g
  let m
  while ((m = fn.exec(source))) {
    const args = m[2].replace(/\s+/g, ' ').trim()
    found.set(m[1], 'function/' + (args ? args.split(',').length : 0))
  }

  const constant = /export const (\w+)\s*=/g
  while ((m = constant.exec(source))) found.set(m[1], 'const')

  // The barrel: `export {\n  clipboard,\n  ...\n}`.
  const list = source.match(/export \{([^}]+)\}\s*$/m)
  if (list) {
    for (const name of list[1].split(',')) {
      const trimmed = name.trim()
      if (trimmed) found.set(trimmed, 'namespace')
    }
  }

  return found
}

// -- the two trees stay in step --------------------------------------

test('the Tauri tree has one module per Electron shim module',
  function (t) {
    t.ok(electronModules.length > 5, 'walked the shim')
    t.deepEqual(modules(SRC_TAURI), electronModules,
      'same module list, so neither tree can grow a module alone')
    t.end()
  })

test('the Tauri tree holds no undeclared extra file', function (t) {
  const extra = fs.readdirSync(SRC_TAURI)
    .filter((name) => !electronModules.includes(name))
    .sort()
  t.deepEqual(extra, HELPERS.slice().sort(),
    'the only non-module file is the shared helper')
  t.end()
})

for (const name of electronModules) {
  test(`tauri/${name} exports the same names as ${name}`, function (t) {
    const electron = exportsOf(path.join(SRC_SHIM, name))
    const tauri = exportsOf(path.join(SRC_TAURI, name))

    t.ok(electron.size > 0, `${name} exports something`)
    t.deepEqual([...tauri.keys()].sort(), [...electron.keys()].sort(),
      'same export names')

    for (const [key, shape] of electron) {
      t.equal(tauri.get(key), shape,
        `${key} has the same shape and arity`)
    }
    t.end()
  })
}

// -- the stubs fail loudly rather than returning undefined ------------

const { NOT_IMPLEMENTED } = require(
  path.join(BUILT_SHIM, TAURI, 'not-implemented')
)

for (const name of electronModules) {
  const stem = name.replace(/\.js$/, '')
  if (stem === REEXPORTED || stem === 'index') continue

  test(`every unported tauri/${name} export rejects as not implemented`,
    async function (t) {
      const tauri = load(TAURI, name)
      for (const key of Object.keys(tauri)) {
        if (implemented(name).includes(key)) continue
        const result = tauri[key]()
        t.ok(result instanceof Promise, `${key}() returns a promise`)
        try {
          await result
          t.fail(`${key}() resolved instead of throwing`)
        } catch (err) {
          t.equal(err.code, NOT_IMPLEMENTED, `${key}() is not implemented`)
          t.ok(err.message.includes(key), `${key}() names itself`)
        }
      }
    })
}

test('the implemented exports are implemented, not still stubs',
  function (t) {
    for (const [name, names] of Object.entries(IMPLEMENTED)) {
      const source = fs.readFileSync(path.join(SRC_TAURI, name), 'utf8')
      for (const key of names) {
        const body = source.split(`export async function ${key} `)[1]
        t.ok(body, `tauri/${name} still exports ${key}`)
        // The sweep above skips these, so a story that regressed one
        // back to a stub would otherwise go unnoticed.
        t.notOk(
          /^[\s\S]*?\n}/.exec(body)[0].includes('notImplemented('),
          `${key} calls the host rather than failing`
        )
      }
    }
    t.end()
  })

test('the Tauri engine shim is the Electron one, not a fork',
  function (t) {
    const source = fs.readFileSync(
      path.join(SRC_TAURI, REEXPORTED + '.js'), 'utf8'
    )
    t.ok(/export \* from '\.\.\/ipc-engine'/.test(source),
      'tauri/ipc-engine.js re-exports the sibling')
    t.notOk(/notImplemented/.test(source),
      'the engine protocol is not stubbed out under Tauri')
    t.end()
  })

// -- the build flag --------------------------------------------------

test('the default host is Electron', function (t) {
  t.equal(host({}), ELECTRON, 'an unset WT_HOST means Electron')
  t.equal(host({ WT_HOST: '' }), ELECTRON, 'an empty WT_HOST means Electron')
  t.equal(host({ WT_HOST: ELECTRON }), ELECTRON, 'electron is electron')
  t.equal(host({ WT_HOST: TAURI }), TAURI, 'tauri is tauri')
  t.throws(() => host({ WT_HOST: 'gtk' }), /not a host/,
    'an unknown host is an error, not a silent fallback')
  t.end()
})

test('the Electron build redirects nothing', function (t) {
  for (const name of electronModules) {
    t.equal(
      redirect({
        root: REPO,
        id: path.join(SRC_SHIM, name),
        importer: path.join(REPO, 'src', 'renderer', 'main.js'),
        host: ELECTRON
      }),
      null,
      `${name} resolves to the Electron tree by default`
    )
  }
  t.end()
})

test('the Tauri build redirects every shim module', function (t) {
  for (const name of electronModules) {
    t.equal(
      redirect({
        root: REPO,
        id: path.join(SRC_SHIM, name),
        importer: path.join(REPO, 'src', 'renderer', 'main.js'),
        host: TAURI
      }),
      path.join(SRC_TAURI, name),
      `${name} resolves to the Tauri tree`
    )
  }
  t.end()
})

test('the redirect survives a Vite query suffix', function (t) {
  t.equal(
    redirect({
      root: REPO,
      id: path.join(SRC_SHIM, 'window.js') + '?v=abc123',
      importer: path.join(REPO, 'src', 'renderer', 'main.js'),
      host: TAURI
    }),
    path.join(SRC_TAURI, 'window.js'),
    'an id with a query still lands in the Tauri tree'
  )
  t.end()
})

test('the redirect cannot recurse', function (t) {
  // The barrel's `./clipboard` and the engine shim's `../ipc-engine`
  // are both imports made from inside the Tauri tree. Redirecting
  // either would send the file back to itself.
  t.equal(
    redirect({
      root: REPO,
      id: path.join(SRC_TAURI, 'clipboard.js'),
      importer: path.join(SRC_TAURI, 'index.js'),
      host: TAURI
    }),
    null,
    'a module already in the Tauri tree is left alone'
  )
  t.equal(
    redirect({
      root: REPO,
      id: path.join(SRC_SHIM, 'ipc-engine.js'),
      importer: path.join(SRC_TAURI, 'ipc-engine.js'),
      host: TAURI
    }),
    null,
    'the engine shim reaches its sibling rather than itself'
  )
  t.end()
})

test('the redirect leaves everything outside the shim alone',
  function (t) {
    const outside = [
      path.join(REPO, 'src', 'renderer', 'lib', 'state.js'),
      path.join(REPO, 'src', 'renderer', 'lib', 'cast.js'),
      path.join(REPO, 'src', 'main', 'index.js'),
      path.join(REPO, 'node_modules', 'react', 'index.js'),
      // A nested directory under the shim is not a sibling module.
      path.join(SRC_SHIM, 'nested', 'thing.js'),
      // Non-JS assets keep resolving where they resolved.
      path.join(SRC_SHIM, 'window.css')
    ]
    for (const id of outside) {
      t.equal(
        redirect({ root: REPO, id, host: TAURI }),
        null,
        path.relative(REPO, id) + ' is not a shim module'
      )
    }
    t.end()
  })

// -- the flag is actually wired into the build -----------------------

test('the renderer build selects the tree through the resolver',
  function (t) {
    const config = fs.readFileSync(
      path.join(REPO, 'vite.config.js'), 'utf8'
    )
    t.ok(/shim-resolver/.test(config),
      'vite.config.js uses bin/shim-resolver.js')

    const pkg = JSON.parse(
      fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')
    )
    t.equal(pkg.scripts['build:renderer'], 'vite build',
      'the default renderer build is unchanged')
    t.ok(pkg.scripts['build:renderer:tauri'],
      'there is a renderer build for the Tauri host')
    t.ok(pkg.scripts['build:tauri'].includes('build:renderer:tauri'),
      'build:tauri builds the renderer against the Tauri tree')
    t.ok(pkg.scripts.start.includes('npm run build'),
      'npm start still builds the Electron default')
    t.end()
  })
