const test = require('tape')
const fs = require('fs')
const path = require('path')
const { isBuiltin } = require('module')

const {
  resolveClosure, packageDir
} = require('../../bin/sidecar-closure')

const REPO = path.join(__dirname, '..', '..')

// The Babel output the sidecar actually loads. `build/config.js`
// because the entry point imports it for APP_VERSION, `build/shared`
// for the wire envelope -- the same three the staging script copies.
const STAGED_SOURCES = [
  path.join(REPO, 'build', 'config.js'),
  path.join(REPO, 'build', 'engine'),
  path.join(REPO, 'build', 'shared')
]

function jsFilesIn (target) {
  if (fs.statSync(target).isFile()) return [target]
  return fs.readdirSync(target)
    .filter(name => name.endsWith('.js'))
    .map(name => path.join(target, name))
}

/**
 * The package names the staged sources require, as Node would resolve
 * them: no relative paths, no builtins, and a subpath or a scope
 * reduced to the package it belongs to.
 */
function bareSpecifiers () {
  const names = new Set()

  for (const target of STAGED_SOURCES) {
    for (const file of jsFilesIn(target)) {
      // A `require` inside a comment is not a dependency, and the
      // header comments in `src/engine/` name modules in prose.
      const source = fs.readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')

      const calls = source.matchAll(
        /require\(\s*['"]([^'"]+)['"]\s*\)/g
      )
      for (const [, specifier] of calls) {
        if (specifier.startsWith('.') || specifier.startsWith('/')) {
          continue
        }
        const parts = specifier.split('/')
        const name = specifier.startsWith('@')
          ? parts.slice(0, 2).join('/')
          : parts[0]
        if (isBuiltin(name)) continue
        names.add(name)
      }
    }
  }

  return names
}

// `ROOTS` in `bin/sidecar-closure.js` is a hand-written list, and the
// closure is only ever as complete as its seed. One bare import added
// to `src/engine/` drops a package -- and everything reachable only
// through it -- out of the bundle, with no build error and no test
// failure: the app opens and cannot torrent. So re-derive the seed
// from the built files rather than trusting the list.
test('the closure seeds on every package the sidecar requires',
  function (t) {
    const names = new Set(resolveClosure().map(entry => entry.name))
    const required = bareSpecifiers()

    t.ok(required.size > 0, `the scan found imports: ${[...required]}`)
    for (const name of required) {
      t.ok(names.has(name), `${name} is in the closure`)
    }
    t.end()
  })

test('the closure reaches the engine\'s own dependencies',
  function (t) {
    const names = new Set(resolveClosure().map(entry => entry.name))
    for (const name of [
      'webtorrent', 'ws', 'music-metadata', 'bittorrent-dht'
    ]) {
      t.ok(names.has(name), `${name} is staged`)
    }
    t.end()
  })

test('the ws performance addons are left out', function (t) {
  const names = new Set(resolveClosure().map(entry => entry.name))

  // Both only accelerate frame masking and UTF-8 validation, ws falls
  // back to JS without them, and each is a nested Mach-O that US-083
  // would have to sign.
  t.notOk(names.has('bufferutil'), 'bufferutil is not staged')
  t.notOk(names.has('utf-8-validate'), 'utf-8-validate is not staged')
  t.end()
})

test('utp-native ships exactly one prebuild', function (t) {
  const utp = resolveClosure().filter(e => e.name === 'utp-native')
  t.equal(utp.length, 1, 'utp-native is staged once')

  const platforms = utp[0].files
    .filter(file => file.startsWith(`prebuilds${path.sep}`))
    .map(file => file.split(path.sep)[1])

  t.deepEqual(
    [...new Set(platforms)], ['darwin-arm64'],
    'only the arm64 prebuild is staged'
  )
  t.end()
})

test('every copy of a duplicated package is kept', function (t) {
  // `debug` resolves to a dozen directories at differing versions.
  // Flattening by name would pick one for every consumer, and the
  // failure would only show up at runtime in a bundle.
  const debugs = resolveClosure().filter(e => e.name === 'debug')
  t.ok(debugs.length > 1, 'more than one debug is staged')

  const paths = new Set(debugs.map(entry => entry.relative))
  t.equal(paths.size, debugs.length, 'each is at its own path')
  t.end()
})

test('resolution walks up the way Node does', function (t) {
  const nested = packageDir(
    'debug', path.join(REPO, 'node_modules', 'music-metadata')
  )
  t.equal(
    nested,
    path.join(
      REPO, 'node_modules', 'music-metadata', 'node_modules', 'debug'
    ),
    'a nested copy wins over the hoisted one'
  )

  t.equal(
    packageDir('no-such-package-anywhere', REPO), null,
    'an unresolvable name answers null rather than throwing'
  )
  t.end()
})
