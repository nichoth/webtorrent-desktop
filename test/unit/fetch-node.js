const test = require('tape')
const crypto = require('crypto')

const {
  MANIFEST, tarballName, tarballUrl, verifyTarball
} = require('../../bin/fetch-node')

const PLATFORM = 'darwin-arm64'

function manifestFor (bytes) {
  return {
    version: '24.19.0',
    platforms: {
      [PLATFORM]: {
        sha256: crypto.createHash('sha256').update(bytes).digest('hex')
      }
    }
  }
}

test('the tarball name and URL follow the pinned version',
  function (t) {
    const manifest = { version: '24.19.0', platforms: {} }

    t.equal(
      tarballName(manifest, PLATFORM),
      'node-v24.19.0-darwin-arm64.tar.gz'
    )
    t.equal(
      tarballUrl(manifest, PLATFORM),
      'https://nodejs.org/dist/v24.19.0/' +
      'node-v24.19.0-darwin-arm64.tar.gz'
    )
    t.end()
  })

test('a tarball matching the pin verifies', function (t) {
  const bytes = Buffer.from('pretend this is a tarball')
  t.doesNotThrow(
    () => verifyTarball(manifestFor(bytes), PLATFORM, bytes)
  )
  t.end()
})

test('a tarball not matching the pin throws', function (t) {
  const bytes = Buffer.from('pretend this is a tarball')
  t.throws(
    () => verifyTarball(
      manifestFor(bytes), PLATFORM, Buffer.from('something else')
    ),
    /checksum mismatch/,
    'the mismatch is named rather than swallowed'
  )
  t.end()
})

test('an unpinned platform throws', function (t) {
  const manifest = { version: '24.19.0', platforms: {} }
  t.throws(
    () => verifyTarball(manifest, 'linux-x64', Buffer.from('x')),
    /pins no linux-x64/
  )
  t.end()
})

test('the committed manifest pins an exact build', function (t) {
  // A range or a missing digest would make the "pin" decorative: the
  // point is that changing the shipped runtime is a reviewable diff.
  t.match(
    MANIFEST.version, /^\d+\.\d+\.\d+$/,
    'the version is exact rather than a range'
  )
  t.match(
    MANIFEST.platforms[PLATFORM].sha256, /^[0-9a-f]{64}$/,
    'the arm64 build is pinned by sha256'
  )
  t.end()
})
