const test = require('tape')
const path = require('path')

const {
  resolveClosure, packageDir
} = require('../../bin/sidecar-closure')

const REPO = path.join(__dirname, '..', '..')

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
