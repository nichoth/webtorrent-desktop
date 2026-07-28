const test = require('tape')
const fsp = require('fs/promises')

// `fs/promises` is a builtin, so `require.cache` seeding (the route
// `electron` is stubbed by) does not apply: Node never consults the
// cache for builtins. Its exports are plain writable properties on a
// single shared object, and Babel compiles the module's named imports
// to per-call-site `_promises.readFile` property reads, so swapping
// the properties around each test stubs it just as effectively.
const STUBBED = ['readFile', 'writeFile', 'copyFile', 'mkdir', 'rename',
  'unlink', 'readdir', 'stat']

const real = {}
for (const name of STUBBED) real[name] = fsp[name]

let calls = []

function stub (results) {
  calls = []
  for (const name of STUBBED) {
    fsp[name] = async function (...args) {
      calls.push({ method: name, args })
      const result = results[name]
      if (typeof result === 'function') return result(...args)
      return result
    }
  }
}

function restore () {
  for (const name of STUBBED) fsp[name] = real[name]
}

const fs = require('../../build/renderer/lib/platform/fs')

test('fs.readFile resolves to the file contents', async function (t) {
  stub({ readFile: Buffer.from([1, 2, 3]) })
  const data = await fs.readFile('/tmp/a.torrent')
  t.deepEqual(calls, [{ method: 'readFile', args: ['/tmp/a.torrent'] }],
    'read the path it was given')
  t.deepEqual(Array.from(data), [1, 2, 3], 'resolved with the bytes')
  restore()
  t.end()
})

test('fs.readFile resolves to a plain Uint8Array, not a Buffer',
  async function (t) {
    stub({ readFile: Buffer.from('hello') })
    const data = await fs.readFile('/tmp/a.txt')
    t.ok(data instanceof Uint8Array, 'is a Uint8Array')
    t.notOk(Buffer.isBuffer(data), 'is not a Node Buffer')
    t.equal(new TextDecoder().decode(data), 'hello', 'decodes back')
    restore()
    t.end()
  })

test('fs.readFile rejects when the read fails', async function (t) {
  stub({
    readFile () { throw new Error('ENOENT') }
  })
  try {
    await fs.readFile('/nope')
    t.fail('should have rejected')
  } catch (err) {
    t.equal(err.message, 'ENOENT', 'surfaced the underlying error')
  }
  restore()
  t.end()
})

test('fs.writeFile forwards path and data', async function (t) {
  stub({})
  const data = new Uint8Array([4, 5])
  const result = await fs.writeFile('/tmp/b.torrent', data)
  t.equal(calls.length, 1, 'one call')
  t.equal(calls[0].method, 'writeFile', 'wrote')
  t.equal(calls[0].args[0], '/tmp/b.torrent', 'to the given path')
  t.equal(calls[0].args[1], data, 'with the given data')
  t.equal(result, undefined, 'resolves with nothing')
  restore()
  t.end()
})

test('fs.writeFile accepts a string', async function (t) {
  stub({})
  await fs.writeFile('/tmp/b.json', '{}')
  t.equal(calls[0].args[1], '{}', 'passed the string through')
  restore()
  t.end()
})

test('fs.copyFile forwards both paths', async function (t) {
  stub({})
  await fs.copyFile('/tmp/a', '/tmp/b')
  t.deepEqual(calls, [{ method: 'copyFile', args: ['/tmp/a', '/tmp/b'] }],
    'copied src to dest')
  restore()
  t.end()
})

test('fs.mkdir is always recursive', async function (t) {
  stub({})
  await fs.mkdir('/tmp/deep/dir')
  t.equal(calls[0].method, 'mkdir', 'made the directory')
  t.equal(calls[0].args[0], '/tmp/deep/dir', 'at the given path')
  t.deepEqual(calls[0].args[1], { recursive: true }, 'recursively')
  restore()
  t.end()
})

test('fs.rename forwards both paths', async function (t) {
  stub({})
  await fs.rename('/tmp/a', '/tmp/b')
  t.deepEqual(calls, [{ method: 'rename', args: ['/tmp/a', '/tmp/b'] }],
    'renamed')
  restore()
  t.end()
})

test('fs.unlink forwards the path', async function (t) {
  stub({})
  await fs.unlink('/tmp/a')
  t.deepEqual(calls, [{ method: 'unlink', args: ['/tmp/a'] }], 'unlinked')
  restore()
  t.end()
})

test('fs.readdir resolves to names only', async function (t) {
  stub({ readdir: ['a.mkv', 'b.mkv'] })
  const names = await fs.readdir('/tmp/folder')
  t.deepEqual(calls, [{ method: 'readdir', args: ['/tmp/folder'] }],
    'listed the folder')
  t.deepEqual(names, ['a.mkv', 'b.mkv'], 'resolved with the names')
  restore()
  t.end()
})

test('fs.stat resolves to a plain object, not a Stats instance',
  async function (t) {
    stub({
      stat: {
        size: 42,
        mode: 0o100644,
        isDirectory () { return false },
        isFile () { return true }
      }
    })
    const stats = await fs.stat('/tmp/a.mkv')
    t.deepEqual(stats, { size: 42, isDirectory: false, isFile: true },
      'flattened to size and two booleans')
    t.equal(typeof stats.isDirectory, 'boolean',
      'isDirectory is a value, not a method')
    restore()
    t.end()
  })

test('fs.stat rejects when the path is missing', async function (t) {
  stub({
    stat () { throw new Error('ENOENT') }
  })
  try {
    await fs.stat('/nope')
    t.fail('should have rejected')
  } catch (err) {
    t.equal(err.message, 'ENOENT', 'surfaced the underlying error')
  }
  restore()
  t.end()
})

test('fs.exists is true for a path that stats', async function (t) {
  stub({
    stat: { size: 0, isDirectory () { return true }, isFile () { return false } }
  })
  t.equal(await fs.exists('/tmp'), true, 'exists')
  restore()
  t.end()
})

test('fs.exists is false when stat throws', async function (t) {
  stub({
    stat () { throw new Error('ENOENT') }
  })
  t.equal(await fs.exists('/nope'), false, 'does not exist')
  restore()
  t.end()
})

test('every fs export is async', function (t) {
  stub({
    readFile: Buffer.alloc(0),
    readdir: [],
    stat: {
      size: 0,
      isDirectory () { return false },
      isFile () { return true }
    }
  })
  const names = ['readFile', 'writeFile', 'copyFile', 'mkdir', 'rename',
    'unlink', 'readdir', 'stat', 'exists']
  for (const name of names) {
    const returned = fs[name]('/tmp/a', '/tmp/b')
    t.ok(returned instanceof Promise, `${name} returns a promise`)
  }
  restore()
  t.end()
})
