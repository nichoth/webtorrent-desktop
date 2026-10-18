const test = require('tape')
const http = require('http')
const path = require('path')

// US-043 / ADR-013: poster generation runs in the UI renderer, not in
// the engine. `lib/torrent-poster.js` now
//
//  - picks the poster source from `torrentSummary.files` (the file list
//    the UI already holds from `wt-metadata`),
//  - reads the bytes over the engine's streaming HTTP server with
//    `fetch`, not `file.getBuffer()`,
//  - captures a video frame through `lib/video-frame.js` (a detached
//    `<video>` plus a canvas), not `capture-frame`,
//  - and writes the file itself through `platform/fs`, with the same
//    `infoHash + extension` name the engine used.
//
// The DOM half lives in `lib/video-frame.js` precisely so this file can
// stub it: `require.cache` stubs of built modules are the codebase's
// standard seam (test/AGENTS.md).

const ROOT = path.join(__dirname, '..', '..')
const BUILT = path.join(ROOT, 'build', 'renderer')
const LIB = path.join(BUILT, 'lib')

// -- stubs ------------------------------------------------------------

// Every stub is a stable object reading from `record`, because Babel
// binds each imported module object once, at first require.
let record = null

const engineStub = {
  __esModule: true,
  async startServer (infoHash) {
    record.engine.push(['startServer', infoHash])
  },
  async stopServer (infoHash) {
    record.engine.push(['stopServer', infoHash])
  },
  async onServerRunningFor (infoHash, listener, options) {
    record.engine.push(['onServerRunningFor', infoHash, options])
    record.serverListeners.push({ infoHash, listener })
    if (record.serverURL != null && !record.silent.includes(infoHash)) {
      setTimeout(() => listener({ localURL: record.serverURL }), 0)
    }
    return () => record.unsubscribed.push(infoHash)
  }
}

const fsStub = {
  __esModule: true,
  async mkdir (dir) {
    record.fs.push(['mkdir', dir])
  },
  async writeFile (file, data) {
    record.fs.push(['writeFile', file, data])
  }
}

const videoFrameStub = {
  __esModule: true,
  async captureVideoFrame (url) {
    record.captured.push(url)
    if (record.captureFails) throw new Error('decode failed')
    return record.frameBytes
  }
}

function reset () {
  record = {
    engine: [],
    serverListeners: [],
    unsubscribed: [],
    fs: [],
    captured: [],
    captureFails: false,
    frameBytes: new Uint8Array([1, 2, 3]),
    serverURL: null,
    // Info hashes whose server never answers.
    silent: []
  }
}

reset()

const undo = []

function stub (modulePath, exports) {
  const id = require.resolve(modulePath)
  const previous = require.cache[id]
  require.cache[id] = { id, filename: id, loaded: true, exports }
  undo.push(() => {
    if (previous) require.cache[id] = previous
    else delete require.cache[id]
  })
}

// The real config would do, but earlier files in the glob stub
// `build/config` for their own purposes, so pin it here instead of
// inheriting whatever is in `require.cache`.
const POSTER_PATH = path.join(require('os').tmpdir(), 'wt-poster-test')

stub(path.join(ROOT, 'build', 'config'), {
  __esModule: true,
  default: { POSTER_PATH }
})
stub(path.join(LIB, 'platform', 'ipc-engine'), engineStub)
stub(path.join(LIB, 'platform', 'fs'), fsStub)
stub(path.join(LIB, 'video-frame'), videoFrameStub)

// `engine-ipc-call-sites.js` loads earlier in the glob and requires the
// real module through `torrent-controller.js`, so a cached instance
// bound to the real `video-frame` is already there. Drop it, load our
// own against the stubs, and drop that too so nothing after this file
// inherits it.
const POSTER_ID = require.resolve(path.join(LIB, 'torrent-poster'))
const cachedPoster = require.cache[POSTER_ID]
delete require.cache[POSTER_ID]

const poster = require(POSTER_ID)

// `tape test/unit/*.js` is one process: a stub left behind is a stub
// the next file inherits. Babel has already bound the module objects.
for (const fn of undo.reverse()) fn()
if (cachedPoster) require.cache[POSTER_ID] = cachedPoster
else delete require.cache[POSTER_ID]

const torrentPoster = poster.default
const { choosePosterSource, generateTorrentPoster } = poster

// -- fixtures ---------------------------------------------------------

const INFO_HASH = 'd2474e86c95b19b8bcfdb92bc12c9d44667cfa36'

const file = (name, length) => ({ name, length, path: '/dl/' + name })

const VIDEO_TORRENT = {
  infoHash: INFO_HASH,
  files: [
    file('readme.txt', 100),
    file('small.mp4', 1000),
    file('big.mkv', 900000000)
  ]
}

const AUDIO_TORRENT = {
  infoHash: INFO_HASH,
  files: [
    file('01 - track.mp3', 8000000),
    file('spectrogram.png', 900000),
    file('back.jpg', 400000),
    file('cover.jpg', 300000)
  ]
}

const IMAGE_TORRENT = {
  infoHash: INFO_HASH,
  files: [
    file('notes.txt', 10),
    file('small.png', 500),
    file('scan.jpeg', 50000)
  ]
}

// -- selection --------------------------------------------------------

test('poster: a poster.jpg in the torrent wins outright', (t) => {
  const source = choosePosterSource([
    file('big.mkv', 900000000),
    file('poster.jpg', 40000)
  ])
  t.deepEqual(source, { kind: 'file', index: 1, extension: '.jpg' })
  t.end()
})

test('poster: the fast path accepts only jpg, png and gif', (t) => {
  t.equal(choosePosterSource([file('poster.bmp', 10)]), null,
    'poster.bmp is not a poster')
  t.deepEqual(choosePosterSource([file('poster.gif', 10)]).extension, '.gif')
  t.end()
})

test('poster: a video torrent picks the largest video file', (t) => {
  const source = choosePosterSource(VIDEO_TORRENT.files)
  t.equal(source.kind, 'video', 'the video branch was chosen')
  t.equal(source.index, 2, 'and the largest video file')
  t.end()
})

test('poster: an audio torrent picks the best cover art', (t) => {
  const source = choosePosterSource(AUDIO_TORRENT.files)
  t.equal(source.kind, 'file', 'cover art is read as a file')
  t.equal(source.index, 3, 'cover.jpg beats back.jpg and the spectrogram')
  t.equal(source.extension, '.jpg')
  t.end()
})

test('poster: an image torrent picks the largest image', (t) => {
  const source = choosePosterSource(IMAGE_TORRENT.files)
  t.deepEqual(source, { kind: 'file', index: 2, extension: '.jpeg' })
  t.end()
})

test('poster: a torrent with no media has no poster', (t) => {
  t.equal(choosePosterSource([file('notes.txt', 10)]), null)
  t.equal(choosePosterSource([]), null, 'nor does an empty torrent')
  t.end()
})

test('poster: an audio torrent with no images has no poster', (t) => {
  t.equal(choosePosterSource([file('01 - track.mp3', 8000000)]), null)
  t.end()
})

// -- reading bytes over the streaming server --------------------------

// A stand-in for the engine's `torrent.createServer()`, which serves
// each file of the torrent at `/${index}`.
function serveBytes (bytes) {
  const requested = []
  const server = http.createServer((req, res) => {
    requested.push(req.url)
    res.end(Buffer.from(bytes))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: 'http://127.0.0.1:' + server.address().port,
        requested,
        close: () => new Promise((resolve) => server.close(resolve))
      })
    })
  })
}

test('poster: file bytes come from the server, by index',
  async function (t) {
    reset()
    const served = await serveBytes([7, 8, 9])
    const { bytes, extension } = await torrentPoster(AUDIO_TORRENT, served.url)
    t.deepEqual(served.requested, ['/3'], 'fetched the cover art by index')
    t.ok(bytes instanceof Uint8Array, 'bytes, not a Buffer')
    t.ok(!Buffer.isBuffer(bytes), 'no host object crossed the boundary')
    t.deepEqual([...bytes], [7, 8, 9], 'the served bytes came back')
    t.equal(extension, '.jpg', 'with the source file extension')
    await served.close()
    t.end()
  })

test('poster: an empty response is not a poster', async function (t) {
  reset()
  const served = await serveBytes([])
  try {
    await torrentPoster(IMAGE_TORRENT, served.url)
    t.fail('should have rejected')
  } catch (err) {
    t.ok(/poster/i.test(err.message), 'rejected: ' + err.message)
  }
  await served.close()
  t.end()
})

test('poster: a video torrent captures a frame as jpeg',
  async function (t) {
    reset()
    const { bytes, extension } = await torrentPoster(
      VIDEO_TORRENT, 'http://127.0.0.1:9999'
    )
    t.deepEqual(record.captured, ['http://127.0.0.1:9999/2'],
      'the largest video file was decoded, by index')
    t.deepEqual([...bytes], [1, 2, 3], 'the frame bytes came back')
    t.equal(extension, '.jpg', 'named .jpg, and now actually a jpeg')
    t.end()
  })

test('poster: a torrent with no usable file rejects', async function (t) {
  reset()
  try {
    await torrentPoster({ infoHash: INFO_HASH, files: [file('a.txt', 1)] }, 'http://x')
    t.fail('should have rejected')
  } catch (err) {
    t.ok(/poster/i.test(err.message), 'rejected: ' + err.message)
  }
  t.end()
})

// -- the whole job ----------------------------------------------------

test('poster: the job starts a server, writes the file, releases it',
  async function (t) {
    reset()
    record.serverURL = 'http://127.0.0.1:4321'
    const name = await generateTorrentPoster(VIDEO_TORRENT)

    t.equal(name, INFO_HASH + '.jpg',
      'the name is infoHash + extension, as the engine wrote it')
    t.deepEqual(record.engine.map((c) => c[0]),
      ['onServerRunningFor', 'startServer', 'stopServer'],
      'subscribed before asking, and released afterwards')
    t.equal(record.engine[0][1], INFO_HASH, 'addressed by info hash')
    t.deepEqual(record.engine[0][2], { once: true }, 'one-shot')
    t.equal(record.engine[2][1], INFO_HASH,
      'wt-stop-server names the torrent to release')

    t.deepEqual(record.fs, [
      ['mkdir', POSTER_PATH],
      [
        'writeFile',
        path.join(POSTER_PATH, INFO_HASH + '.jpg'),
        record.frameBytes
      ]
    ], 'the poster landed in POSTER_PATH through the fs shim')
    t.end()
  })

test('poster: a failed capture is quiet, and still releases the server',
  async function (t) {
    reset()
    record.serverURL = 'http://127.0.0.1:4321'
    record.captureFails = true
    const name = await generateTorrentPoster(VIDEO_TORRENT)
    t.equal(name, null, 'no poster, no throw -- the placeholder stays')
    t.deepEqual(record.fs, [], 'nothing was written')
    t.deepEqual(record.engine.filter((c) => c[0] === 'stopServer'),
      [['stopServer', INFO_HASH]], 'the server was still released')
    t.end()
  })

test('poster: a torrent with no poster never asks for a server',
  async function (t) {
    reset()
    record.serverURL = 'http://127.0.0.1:4321'
    const name = await generateTorrentPoster({
      infoHash: INFO_HASH, files: [file('notes.txt', 10)]
    })
    t.equal(name, null, 'no poster')
    t.deepEqual(record.engine, [], 'and the engine was left alone')
    t.end()
  })

test('poster: jobs run one at a time', async function (t) {
  reset()
  record.serverURL = 'http://127.0.0.1:4321'

  // Two jobs, started together. The second must not touch the DOM
  // until the first has released its server (ADR-013's mitigation for
  // decoding in the window the user is looking at).
  const order = []
  const captureVideoFrame = videoFrameStub.captureVideoFrame
  videoFrameStub.captureVideoFrame = async (url) => {
    order.push('capture ' + url)
    await new Promise((resolve) => setTimeout(resolve, 20))
    return captureVideoFrame(url)
  }

  const names = await Promise.all([
    generateTorrentPoster(VIDEO_TORRENT),
    generateTorrentPoster({ ...VIDEO_TORRENT, infoHash: 'b'.repeat(40) })
  ])

  videoFrameStub.captureVideoFrame = captureVideoFrame

  t.deepEqual(names, [INFO_HASH + '.jpg', 'b'.repeat(40) + '.jpg'],
    'both jobs produced a poster')
  t.equal(order.length, 2, 'both decoded')
  t.equal(record.fs.filter((c) => c[0] === 'writeFile').length, 2,
    'and both wrote a poster')

  // Serialization: the first job's stopServer precedes the second
  // job's startServer.
  const calls = record.engine.map((c) => c[0])
  t.ok(calls.indexOf('stopServer') < calls.lastIndexOf('startServer'),
    'the second job started only after the first released')
  t.end()
})

// -- a job that times out ---------------------------------------------

// A server that never answers wedges nothing: the job gives up after
// its timeout. Injected short here, never a real 60 seconds.
const SHORT = { timeout: 30 }

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('poster: a timed-out job leaves no server-running subscription',
  async function (t) {
    reset()
    const name = await generateTorrentPoster(VIDEO_TORRENT, SHORT)
    t.equal(name, null, 'no poster')
    t.equal(record.serverListeners.length, 1, 'it did subscribe')
    t.deepEqual(record.unsubscribed, [INFO_HASH],
      'and the subscription was removed when it gave up')
    t.end()
  })
