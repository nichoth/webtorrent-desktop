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

// -- the same contract, against the Tauri tree (US-060) --------------
//
// Nine host commands rather than the `fs` plugin's JS API, for the
// reason every other Phase 4 module is a command: an app command needs
// no capability, so `capabilities/default.json` stays at
// `core:default` and the webview never carries raw file access of its
// own. The directory allowlist that goes with that lives in
// `src-tauri/src/fs.rs` and is asserted there.
//
// So what is asserted here is the command name, the argument object
// that reaches the host, and the two shapes that have to survive the
// crossing: bytes out of `readFile` and bytes into `writeFile`.
// The stub is seeded at `@tauri-apps/api/core`, which several files in
// this directory do; it is held in a local rather than reached for
// through `require.cache`, which by the time the tests run belongs to
// whichever file loaded last (test/AGENTS.md).

const corePath = require.resolve('@tauri-apps/api/core')

let invocations = []
let handler = async () => null

require.cache[corePath] = {
  id: corePath,
  filename: corePath,
  loaded: true,
  exports: {
    __esModule: true,
    async invoke (command, args) {
      invocations.push({ command, args })
      return handler(command, args)
    }
  }
}

const tauriFs = require('../../build/renderer/lib/platform/tauri/fs')

function resetTauri (next) {
  invocations = []
  handler = next || (async () => null)
}

// The command name each export sends, the arguments it forwards, and
// what the host answers with. A Rust parameter is camelCased on the JS
// side, so a mistyped key is a silently ignored argument rather than
// an error -- which is why the argument object is asserted rather than
// just the command name.
const COMMANDS = [
  ['copyFile', 'fs_copy_file', ['/tmp/a', '/tmp/b'],
    { src: '/tmp/a', dest: '/tmp/b' }],
  ['mkdir', 'fs_mkdir', ['/tmp/deep/dir'], { path: '/tmp/deep/dir' }],
  ['rename', 'fs_rename', ['/tmp/a', '/tmp/b'],
    { oldPath: '/tmp/a', newPath: '/tmp/b' }],
  ['unlink', 'fs_unlink', ['/tmp/a'], { path: '/tmp/a' }],
  ['readdir', 'fs_readdir', ['/tmp/folder'], { path: '/tmp/folder' }],
  ['stat', 'fs_stat', ['/tmp/a.mkv'], { path: '/tmp/a.mkv' }],
  ['exists', 'fs_exists', ['/tmp/a.mkv'], { path: '/tmp/a.mkv' }],
  ['readFile', 'fs_read_file', ['/tmp/a.torrent'],
    { path: '/tmp/a.torrent' }]
]

for (const [name, command, args, expected] of COMMANDS) {
  test(`tauri fs.${name} asks the host`, async function (t) {
    resetTauri(async () => answerFor(command))
    await tauriFs[name](...args)

    t.equal(invocations.length, 1, 'one command')
    t.equal(invocations[0].command, command, 'named the command')
    t.deepEqual(invocations[0].args, expected,
      'forwarded the arguments under the keys the host names them')
    t.end()
  })
}

// Three commands answer with something the shim has to shape; the
// rest resolve with nothing.
function answerFor (command) {
  if (command === 'fs_read_file') return new Uint8Array([1, 2, 3]).buffer
  if (command === 'fs_readdir') return ['a.mkv']
  if (command === 'fs_stat') {
    return { size: 0, isDirectory: false, isFile: true }
  }
  if (command === 'fs_exists') return false
  return null
}

test('tauri fs.readFile resolves to a plain Uint8Array',
  async function (t) {
    resetTauri(async () => new Uint8Array([1, 2, 3]).buffer)
    const data = await tauriFs.readFile('/tmp/a.torrent')

    t.ok(data instanceof Uint8Array, 'is a Uint8Array')
    t.deepEqual(Array.from(data), [1, 2, 3], 'the bytes the host read')
    t.end()
  })

test('tauri fs.readFile also copes with a host that sends an array',
  async function (t) {
    // The host sends raw bytes, which arrive as an ArrayBuffer. A
    // plain JSON array is what a serialized `Vec<u8>` would be, and
    // the shim should not care which it got.
    resetTauri(async () => [4, 5, 6])
    const data = await tauriFs.readFile('/tmp/a.torrent')

    t.ok(data instanceof Uint8Array, 'is still a Uint8Array')
    t.deepEqual(Array.from(data), [4, 5, 6], 'same bytes')
    t.end()
  })

test('tauri fs.writeFile sends bytes the host can deserialize',
  async function (t) {
    resetTauri()
    await tauriFs.writeFile('/tmp/b.torrent', new Uint8Array([4, 5]))

    t.equal(invocations[0].command, 'fs_write_file', 'named the command')
    t.deepEqual(invocations[0].args, {
      path: '/tmp/b.torrent',
      data: [4, 5]
    }, 'a plain array -- a Uint8Array JSONifies to a keyed object')
    t.end()
  })

test('tauri fs.writeFile encodes a string as UTF-8 bytes',
  async function (t) {
    resetTauri()
    await tauriFs.writeFile('/tmp/b.json', '{"é":1}')

    t.deepEqual(invocations[0].args.data,
      Array.from(new TextEncoder().encode('{"é":1}')),
      'the host writes bytes, so the shim does the encoding')
    t.end()
  })

test('tauri fs.stat resolves to the flattened object', async function (t) {
  resetTauri(async () => ({ size: 42, isDirectory: false, isFile: true }))
  const stats = await tauriFs.stat('/tmp/a.mkv')

  t.deepEqual(stats, { size: 42, isDirectory: false, isFile: true },
    'size and two booleans, as the Electron tree resolves')
  t.end()
})

test('tauri fs.readdir resolves to names only', async function (t) {
  resetTauri(async () => ['a.mkv', 'b.mkv'])
  t.deepEqual(await tauriFs.readdir('/tmp/folder'), ['a.mkv', 'b.mkv'],
    'the names the host listed')
  t.end()
})

test('tauri fs.exists answers the host', async function (t) {
  resetTauri(async () => true)
  t.equal(await tauriFs.exists('/tmp'), true, 'exists')

  resetTauri(async () => false)
  t.equal(await tauriFs.exists('/nope'), false, 'does not exist')
  t.end()
})

test('tauri fs.exists reads any host failure as "not there"',
  async function (t) {
    // The contract `../fs.js` documents: it covers the
    // `try { statSync() } catch {}` probes in `lib/migrations.js`, so
    // every failure -- including a path the host refuses -- is false
    // rather than a rejection. It is the one export that does not
    // surface the refusal, because it has no channel for one.
    resetTauri(async () => { throw new Error('outside the allowlist') })
    t.equal(await tauriFs.exists('/etc/passwd'), false,
      'a refused path does not exist as far as the caller is concerned')
    t.end()
  })

test('the two fs trees answer the same questions', function (t) {
  const electron = Object.keys(fs).filter(k => k !== '__esModule')
  const tauri = Object.keys(tauriFs).filter(k => k !== '__esModule')

  t.deepEqual(tauri.sort(), electron.sort(), 'the same nine operations')
  t.end()
})

test('every tauri fs export is async and rejects on host failure',
  async function (t) {
    // A path outside the allowlist is one way the host says no, and
    // it has to reach the caller rather than resolving to a plausible
    // value -- which is the whole point of the allowlist.
    const refusal = '/etc/passwd is outside the directories WebTorrent ' +
      'Desktop may use'

    for (const [name] of COMMANDS) {
      resetTauri(async (command) => answerFor(command))
      t.ok(tauriFs[name]('/tmp/a', '/tmp/b') instanceof Promise,
        `${name} is async`)
    }

    // `exists` is the one export that swallows a failure; it has its
    // own test above.
    const rejecting = COMMANDS
      .map(([name]) => name)
      .filter((name) => name !== 'exists')
      .concat(['writeFile'])

    for (const name of rejecting) {
      resetTauri(async () => { throw new Error(refusal) })
      try {
        await tauriFs[name]('/etc/passwd', '/etc/shadow')
        t.fail(`${name} resolved over a host refusal`)
      } catch (err) {
        t.equal(err.message, refusal, `${name} surfaced the refusal`)
      }
    }
    t.end()
  })
