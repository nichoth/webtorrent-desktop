const test = require('tape')

// US-038: the `wt-*` wire codec (ADR-012). The engine leaves the
// renderer in Phase 3, so the structured clone that used to carry
// these payloads between two Electron windows becomes an explicit
// serialization boundary. Every channel in the command and event
// tables of `docs/platform-shim.md` is round-tripped here, so a
// payload shape the codec cannot carry fails in this file rather
// than in the app.
const wire = require('../../build/shared/wire')

const BitFieldModule = require('bitfield')
const BitField = BitFieldModule.default || BitFieldModule

const INFO_HASH = '6a9759bffd5c0af65319979fb7832189f4f3c35d'

const TORRENT_INFO = {
  infoHash: INFO_HASH,
  magnetURI: `magnet:?xt=urn:btih:${INFO_HASH}`,
  name: 'Some Torrent',
  path: '/home/user/Downloads',
  files: [
    { name: 'video.mp4', length: 1234567, path: 'Some Torrent/video.mp4' },
    { name: 'readme.txt', length: 42, path: 'Some Torrent/readme.txt' }
  ],
  bytesReceived: 1234
}

const SERVER_INFO = {
  torrentKey: 3,
  localURL: 'http://localhost:52301',
  networkURL: 'http://192.168.1.20:52301',
  networkAddress: '192.168.1.20'
}

function sampleBitField () {
  const field = new BitField(16)
  field.set(0, true)
  field.set(5, true)
  field.set(15, true)
  return field
}

// What the UI actually receives: the prototype was already stripped by
// structured clone, so `Progress.bitfield` arrives as a plain object
// carrying the backing buffer (`docs/platform-shim.md`, payload
// shapes). The instance case has its own test below.
const WIRE_BITFIELD = Object.assign({}, sampleBitField())

const PROGRESS = {
  progress: 0.42,
  hasActiveTorrents: true,
  torrents: [{
    torrentKey: 3,
    ready: true,
    progress: 0.42,
    downloaded: 1234,
    downloadSpeed: 5678,
    uploadSpeed: 90,
    numPeers: 7,
    length: 1234567,
    bitfield: WIRE_BITFIELD,
    files: [
      { startPiece: 0, endPiece: 9, numPieces: 10, numPiecesPresent: 4 }
    ]
  }]
}

// One sample payload per channel. The keys are exactly the channels in
// the two tables plus the two dynamic families; `args` mirrors the
// documented argument list, in order.
const SAMPLES = [
  // Commands: UI -> engine
  ['wt-set-global-trackers', [['udp://tracker.example:80']]],
  ['wt-start-torrenting', [
    3, `magnet:?xt=urn:btih:${INFO_HASH}`, '/home/user/Downloads',
    { 'Some Torrent/video.mp4': 1699999999000 }, [true, false]
  ]],
  ['wt-stop-torrenting', [INFO_HASH]],
  ['wt-create-torrent', [4, {
    name: 'New Torrent',
    path: '/home/user/Videos',
    files: [{ path: '/home/user/Videos/clip.mp4' }],
    announce: ['udp://tracker.example:80'],
    comment: 'made by a test',
    private: true
  }]],
  ['wt-save-torrent-file', [3]],
  ['wt-get-audio-metadata', [INFO_HASH, 2]],
  ['wt-start-server', [INFO_HASH]],
  ['wt-stop-server', [INFO_HASH]],
  ['wt-select-files', [INFO_HASH, [true, false, true]]],

  // Events: engine -> UI
  ['wt-parsed', [3, INFO_HASH, `magnet:?xt=urn:btih:${INFO_HASH}`]],
  ['wt-metadata', [3, TORRENT_INFO]],
  ['wt-ready', [3, TORRENT_INFO]],
  ['wt-done', [3, TORRENT_INFO]],
  ['wt-warning', [null, 'a client-level warning']],
  ['wt-error', [null, 'a client-level error']],
  ['wt-progress', [PROGRESS]],
  ['wt-file-modtimes', [3, { 'Some Torrent/video.mp4': 1699999999000 }]],
  ['wt-file-saved', [3, 'Some Torrent.torrent']],
  ['wt-audio-metadata', [INFO_HASH, 2, {
    common: { title: 'A Song', artist: 'Someone', track: { no: 2, of: 9 } },
    format: { container: 'MPEG', duration: 210.5, lossless: false }
  }]],
  ['wt-server-running', [SERVER_INFO]],

  // Dynamic channel families
  [`wt-ready-${INFO_HASH}`, [3, TORRENT_INFO]],
  [`wt-server-${INFO_HASH}`, [SERVER_INFO]]
]

function roundTrip (channel, args) {
  return wire.decode(wire.encode(channel, args))
}

test('wire: exports encode and decode', (t) => {
  t.equal(typeof wire.encode, 'function', 'encode is a function')
  t.equal(typeof wire.decode, 'function', 'decode is a function')
  t.end()
})

test('wire: every documented channel round-trips', (t) => {
  t.equal(SAMPLES.length, 22, '22 channels covered')
  for (const [channel, args] of SAMPLES) {
    const decoded = roundTrip(channel, args)
    t.equal(decoded.channel, channel, `${channel}: channel preserved`)
    t.equal(decoded.args.length, args.length, `${channel}: arity preserved`)
    t.deepEqual(decoded.args, args, `${channel}: args preserved`)
  }
  t.end()
})

test('wire: encode produces a { channel, args } JSON envelope', (t) => {
  const envelope = JSON.parse(wire.encode('wt-stop-torrenting', [INFO_HASH]))
  t.deepEqual(Object.keys(envelope).sort(), ['args', 'channel'],
    'envelope has exactly channel and args')
  t.equal(envelope.channel, 'wt-stop-torrenting', 'channel is the channel')
  t.deepEqual(envelope.args, [INFO_HASH], 'args is the argument list')
  t.end()
})

test('wire: nested Uint8Array survives a round trip', (t) => {
  const bytes = new Uint8Array([0, 1, 127, 128, 254, 255])
  const { args } = roundTrip('wt-progress', [{ nested: { deep: [bytes] } }])
  const out = args[0].nested.deep[0]
  t.ok(out instanceof Uint8Array, 'decodes to a Uint8Array')
  t.notOk(Buffer.isBuffer(out), 'not widened to a Buffer')
  t.deepEqual(Array.from(out), Array.from(bytes), 'bytes match')
  t.end()
})

test('wire: nested Buffer survives a round trip', (t) => {
  const buf = Buffer.from([0, 1, 127, 128, 254, 255])
  const { args } = roundTrip('wt-progress', [{ nested: { deep: [buf] } }])
  const out = args[0].nested.deep[0]
  t.ok(Buffer.isBuffer(out), 'decodes back to a Buffer')
  t.deepEqual(Array.from(out), Array.from(buf), 'bytes match')
  t.end()
})

test('wire: an empty binary value survives a round trip', (t) => {
  const { args } = roundTrip('wt-progress', [new Uint8Array(0)])
  t.ok(args[0] instanceof Uint8Array, 'decodes to a Uint8Array')
  t.equal(args[0].length, 0, 'still empty')
  t.end()
})

test('wire: a byte-offset view carries only its own bytes', (t) => {
  const backing = new Uint8Array([1, 2, 3, 4, 5, 6])
  const view = backing.subarray(2, 5)
  const { args } = roundTrip('wt-progress', [view])
  t.deepEqual(Array.from(args[0]), [3, 4, 5], 'the view, not the backing store')
  t.end()
})

// `pages/player-page.js:943` reads the bitfield back with
// `BitField.prototype.get.call(prog.bitfield, i)`, so the borrowed
// method has to keep working on what comes off the wire.
test('wire: wt-progress bitfield stays readable through BitField', (t) => {
  const expected = sampleBitField()

  // The engine puts a real instance on the wire...
  const sent = roundTrip('wt-progress', [{
    ...PROGRESS,
    torrents: [{ ...PROGRESS.torrents[0], bitfield: sampleBitField() }]
  }])
  // ...and the UI reads back whatever arrives with a borrowed method.
  const received = roundTrip('wt-progress', [PROGRESS])

  for (const [label, decoded] of [['instance', sent], ['plain', received]]) {
    const bitfield = decoded.args[0].torrents[0].bitfield
    t.ok(bitfield.buffer instanceof Uint8Array,
      `${label}: backing buffer is still a byte array`)
    for (let i = 0; i < 16; i++) {
      t.equal(
        BitField.prototype.get.call(bitfield, i),
        BitField.prototype.get.call(expected, i),
        `${label}: bit ${i} matches`
      )
    }
  }
  t.end()
})

test('wire: null argument positions are preserved', (t) => {
  for (const channel of ['wt-warning', 'wt-error']) {
    const { args } = roundTrip(channel, [null, 'client-level fault'])
    t.equal(args.length, 2, `${channel}: two arguments`)
    t.equal(args[0], null, `${channel}: torrentKey is still null`)
    t.notEqual(args[0], undefined, `${channel}: null did not become undefined`)
  }
  const { args } = roundTrip('wt-progress', [{ a: null, b: [null, 1, null] }])
  t.equal(args[0].a, null, 'a null property stays null')
  t.deepEqual(args[0].b, [null, 1, null], 'nulls inside an array stay put')
  t.end()
})

test('wire: omitted optional arguments keep their positions', (t) => {
  const { args } = roundTrip('wt-start-torrenting',
    [3, 'magnet:?xt=urn:btih:x', undefined, undefined, undefined])
  t.equal(args.length, 5, 'arity preserved')
  t.equal(args[2], undefined, 'undefined stays undefined, not null')
  t.notEqual(args[2], null, 'undefined did not become null')
  t.end()
})

test('wire: encode accepts a missing argument list', (t) => {
  const { channel, args } = wire.decode(wire.encode('wt-stop-server'))
  t.equal(channel, 'wt-stop-server', 'channel preserved')
  t.deepEqual(args, [], 'args defaults to empty')
  t.end()
})

test('wire: a payload key colliding with the tag survives', (t) => {
  const payload = { __wtWire: 'Buffer', data: 'not really' }
  const { args } = roundTrip('wt-progress', [payload])
  t.deepEqual(args[0], payload, 'the object comes back as itself')
  t.end()
})

test('wire: non-finite numbers survive a round trip', (t) => {
  const { args } = roundTrip('wt-progress', [{
    nan: NaN, inf: Infinity, ninf: -Infinity
  }])
  t.ok(Number.isNaN(args[0].nan), 'NaN stays NaN, not null')
  t.equal(args[0].inf, Infinity, 'Infinity stays Infinity')
  t.equal(args[0].ninf, -Infinity, '-Infinity stays -Infinity')
  t.end()
})

test('wire: encode rejects a bad channel', (t) => {
  t.throws(() => wire.encode(), /channel/, 'no channel')
  t.throws(() => wire.encode(''), /channel/, 'empty channel')
  t.throws(() => wire.encode(null), /channel/, 'null channel')
  t.throws(() => wire.encode(7), /channel/, 'numeric channel')
  t.end()
})

test('wire: encode rejects a non-array argument list', (t) => {
  t.throws(() => wire.encode('wt-stop-server', 'nope'), /args/, 'a string')
  t.throws(() => wire.encode('wt-stop-server', { 0: 'a' }), /args/, 'an object')
  t.throws(() => wire.encode('wt-stop-server', null), /args/, 'null')
  t.end()
})

test('wire: encode rejects values it cannot carry', (t) => {
  t.throws(() => wire.encode('wt-progress', [() => {}]), TypeError,
    'a function')
  t.throws(() => wire.encode('wt-progress', [Symbol('x')]), TypeError,
    'a symbol')
  t.throws(() => wire.encode('wt-progress', [1n]), TypeError, 'a bigint')
  t.throws(() => wire.encode('wt-progress', [new ArrayBuffer(4)]), TypeError,
    'a raw ArrayBuffer')
  t.throws(() => wire.encode('wt-progress', [new Uint16Array(2)]), TypeError,
    'a typed array that is not byte-sized')
  t.end()
})

test('wire: decode throws on malformed input', (t) => {
  const bad = [
    ['not JSON at all', 'garbage'],
    ['', 'the empty string'],
    ['null', 'JSON null'],
    ['7', 'a JSON number'],
    ['"wt-progress"', 'a JSON string'],
    ['[]', 'a JSON array'],
    ['{}', 'an empty envelope'],
    ['{"args":[]}', 'no channel'],
    ['{"channel":"","args":[]}', 'an empty channel'],
    ['{"channel":7,"args":[]}', 'a numeric channel'],
    ['{"channel":"wt-progress"}', 'no args'],
    ['{"channel":"wt-progress","args":null}', 'null args'],
    ['{"channel":"wt-progress","args":{}}', 'args as an object'],
    ['{"channel":"wt-progress","args":"x"}', 'args as a string'],
    ['{"channel":"wt-progress","args":[{"__wtWire":"nope"}]}',
      'an unknown tag'],
    ['{"channel":"wt-progress","args":[{"__wtWire":7}]}',
      'a non-string tag'],
    ['{"channel":"wt-progress","args":[{"__wtWire":"Buffer"}]}',
      'a binary tag with no data'],
    ['{"channel":"wt-progress","args":[{"__wtWire":"Buffer","data":"!!"}]}',
      'a binary tag with non-base64 data'],
    ['{"channel":"wt-progress","args":[{"__wtWire":"Buffer","data":7}]}',
      'a binary tag with numeric data'],
    ['{"channel":"wt-progress","args":[{"__wtWire":"number","value":"x"}]}',
      'a number tag that is not a number']
  ]
  for (const [message, why] of bad) {
    t.throws(() => wire.decode(message), Error, `rejects ${why}`)
  }
  t.end()
})

test('wire: decode throws on a non-string frame', (t) => {
  t.throws(() => wire.decode(), Error, 'undefined')
  t.throws(() => wire.decode(null), Error, 'null')
  t.throws(() => wire.decode(7), Error, 'a number')
  t.throws(() => wire.decode({ channel: 'wt-progress', args: [] }), Error,
    'an already-parsed envelope')
  t.end()
})

// A WebSocket `message` event hands Node a Buffer, not a string.
test('wire: decode accepts a binary frame', (t) => {
  const frame = Buffer.from(wire.encode('wt-stop-torrenting', [INFO_HASH]))
  const decoded = wire.decode(frame)
  t.equal(decoded.channel, 'wt-stop-torrenting', 'channel preserved')
  t.deepEqual(decoded.args, [INFO_HASH], 'args preserved')
  t.throws(() => wire.decode(Buffer.from('garbage')), Error,
    'a malformed binary frame still throws')
  t.end()
})

test('wire: decode does not return a partial object on failure', (t) => {
  let result = 'untouched'
  try {
    result = wire.decode('{"channel":"wt-progress","args":[{"__wtWire":"?"}]}')
  } catch (err) {
    t.ok(err instanceof Error, 'threw an Error')
  }
  t.equal(result, 'untouched', 'nothing was returned')
  t.end()
})
