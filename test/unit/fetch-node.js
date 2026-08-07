const test = require('tape')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  CACHE_PATH, MANIFEST, fetchNode, tarballName, tarballUrl,
  verifyTarball
} = require('../../bin/fetch-node')

const PLATFORM = 'darwin-arm64'

function tempCache () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-node-'))
}

/** Stands in for the network for the length of one call. */
async function withFetch (impl, body) {
  const real = globalThis.fetch
  globalThis.fetch = impl
  try {
    return await body()
  } finally {
    globalThis.fetch = real
  }
}

function respondWith (bytes) {
  return async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes
  })
}

/** tape has no `rejects`, and `throws` does not await. */
async function rejects (t, promise, pattern, message) {
  try {
    await promise
    t.fail(`${message} -- it resolved instead`)
  } catch (err) {
    t.match(err.message, pattern, message)
  }
}

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

// The cache is what makes the pin worth having. A tarball that is
// verified on the way in but trusted forever after is a pin that a
// single bad write disables permanently, and a bad download left on
// disk is one that every later build picks up and believes.

test('a cached tarball matching the pin is used without a download',
  async function (t) {
    const cachePath = tempCache()
    const bytes = Buffer.from('pretend this is a tarball')
    const manifest = manifestFor(bytes)
    const cached = path.join(cachePath, tarballName(manifest, PLATFORM))

    try {
      fs.writeFileSync(cached, bytes)
      const result = await withFetch(
        () => t.fail('the network was reached for a warm cache'),
        () => fetchNode(PLATFORM, manifest, cachePath)
      )
      t.equal(result, cached, 'the cached path is returned')
    } finally {
      fs.rmSync(cachePath, { recursive: true, force: true })
    }
  })

test('a cached tarball that no longer matches is deleted',
  async function (t) {
    const cachePath = tempCache()
    const manifest = manifestFor(Buffer.from('the pinned bytes'))
    const cached = path.join(cachePath, tarballName(manifest, PLATFORM))

    try {
      // Either a corrupted download or a bumped pin. Leaving it would
      // fail the same way on every future run with no way out but
      // knowing where the cache lives.
      fs.writeFileSync(cached, Buffer.from('something else entirely'))

      await rejects(
        t,
        fetchNode(PLATFORM, manifest, cachePath),
        /checksum mismatch/,
        'the mismatch is reported rather than trusted'
      )
      t.notOk(fs.existsSync(cached), 'and the bad copy is gone')
    } finally {
      fs.rmSync(cachePath, { recursive: true, force: true })
    }
  })

test('a download that does not match the pin is never written',
  async function (t) {
    const cachePath = tempCache()
    const manifest = manifestFor(Buffer.from('the pinned bytes'))
    const cached = path.join(cachePath, tarballName(manifest, PLATFORM))

    try {
      await rejects(
        t,
        withFetch(
          respondWith(Buffer.from('a substituted tarball')),
          () => fetchNode(PLATFORM, manifest, cachePath)
        ),
        /checksum mismatch/,
        'the substituted bytes are rejected'
      )
      t.notOk(
        fs.existsSync(cached),
        'and never reach the cache for a later run to trust'
      )
    } finally {
      fs.rmSync(cachePath, { recursive: true, force: true })
    }
  })

test('a verified download is cached for the next build',
  async function (t) {
    const cachePath = tempCache()
    const bytes = Buffer.from('pretend this is a tarball')
    const manifest = manifestFor(bytes)
    const cached = path.join(cachePath, tarballName(manifest, PLATFORM))

    try {
      const result = await withFetch(
        respondWith(bytes),
        () => fetchNode(PLATFORM, manifest, cachePath)
      )
      t.equal(result, cached, 'the download is returned from the cache')
      t.deepEqual(
        fs.readFileSync(cached), bytes, 'byte for byte'
      )
    } finally {
      fs.rmSync(cachePath, { recursive: true, force: true })
    }
  })

test('the cache sits outside the repository', function (t) {
  // `bin/clean.js` deletes generated directories under the repo root.
  // A cache inside one would turn every `npm run clean` into another
  // 50MB download.
  const repo = path.join(__dirname, '..', '..')
  t.ok(
    path.relative(repo, CACHE_PATH).startsWith('..'),
    `${CACHE_PATH} is outside ${repo}`
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
