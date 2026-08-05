/**
 * The `wt-*` wire codec (US-038, ADR-012).
 *
 * The engine and the UI used to be two Electron renderers, so every
 * `wt-*` message travelled through structured clone and nobody had to
 * think about serialization. Under the sidecar they are two processes
 * joined by a localhost WebSocket, which carries text. This module is
 * the only place that knows how a `wt-*` message becomes bytes.
 *
 * The envelope is `{ channel, args }` as JSON. `args` is the argument
 * list exactly as documented in the command and event tables of
 * `docs/platform-shim.md` -- same order, same arity.
 *
 * JSON alone is not enough for two of the shapes on that wire, so the
 * codec tags what JSON would lose:
 *
 * - `Uint8Array` and `Buffer`, which JSON turns into `{"0":1,...}`.
 *   `wt-progress` carries `torrent.bitfield`, whose backing store is a
 *   byte array, and `pages/player-page.js:943` reads it back through
 *   `BitField.prototype.get.call(...)`.
 * - `undefined` and non-finite numbers, both of which JSON silently
 *   converts to `null` inside an array. `wt-warning` and `wt-error`
 *   send a real `null` for `torrentKey`, so `null` and `undefined`
 *   must stay distinguishable.
 *
 * Anything else JSON cannot carry -- a function, a symbol, a bigint, a
 * raw `ArrayBuffer`, a non-byte typed array -- is a bug in the caller
 * and throws rather than crossing the wire as `null` or `{}`.
 *
 * `decode` throws on malformed input. It never returns a partial
 * envelope: a frame is either the whole message or an error.
 */

// Marker key for a tagged value. A plain object that happens to own
// this key is escaped on the way out and unescaped on the way back, so
// no payload shape is unrepresentable.
const TAG = '__wtWire'

const TAG_UNDEFINED = 'undefined'
const TAG_NUMBER = 'number'
const TAG_ESCAPE = 'escape'
const TAG_UINT8 = 'Uint8Array'
const TAG_BUFFER = 'Buffer'

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

const NON_FINITE = new Map([
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity]
])

/**
 * Serialize one message into a wire frame.
 *
 * @param {string} channel a `wt-*` channel name
 * @param {Array} [args] the argument list, defaulting to empty
 * @returns {string} the JSON frame
 */
export function encode (channel, args = []) {
  if (typeof channel !== 'string' || channel === '') {
    throw new TypeError('wire.encode: channel must be a non-empty string')
  }
  if (!Array.isArray(args)) {
    throw new TypeError('wire.encode: args must be an array')
  }
  return JSON.stringify({ channel, args: args.map(pack) })
}

/**
 * Parse one wire frame. Throws on anything malformed.
 *
 * @param {string|Uint8Array} message the frame, as text or as the
 *   Buffer a WebSocket `message` event hands to Node
 * @returns {{ channel: string, args: Array }}
 */
export function decode (message) {
  const text = frameToText(message)

  let envelope
  try {
    envelope = JSON.parse(text)
  } catch (err) {
    throw new TypeError(`wire.decode: not JSON: ${err.message}`)
  }

  if (envelope === null || typeof envelope !== 'object' ||
      Array.isArray(envelope)) {
    throw new TypeError('wire.decode: frame is not an envelope object')
  }
  if (typeof envelope.channel !== 'string' || envelope.channel === '') {
    throw new TypeError('wire.decode: channel must be a non-empty string')
  }
  if (!Array.isArray(envelope.args)) {
    throw new TypeError('wire.decode: args must be an array')
  }

  return {
    channel: envelope.channel,
    args: envelope.args.map(unpack)
  }
}

function frameToText (message) {
  if (typeof message === 'string') return message
  if (message instanceof Uint8Array) return utf8ToString(message)
  throw new TypeError('wire.decode: frame must be a string or a byte array')
}

function pack (value) {
  if (value === undefined) return { [TAG]: TAG_UNDEFINED }
  if (value === null) return null

  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') {
    if (Number.isFinite(value)) return value
    return { [TAG]: TAG_NUMBER, value: String(value) }
  }
  if (type !== 'object') {
    throw new TypeError(`wire.encode: cannot carry a ${type}`)
  }

  if (Array.isArray(value)) return value.map(pack)

  if (value instanceof Uint8Array) {
    return {
      [TAG]: isBuffer(value) ? TAG_BUFFER : TAG_UINT8,
      data: toBase64(value)
    }
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw new TypeError(
      'wire.encode: only Uint8Array and Buffer binary values are carried'
    )
  }

  // A `bitfield` instance, a `TorrentInfo`, a `Progress`: walk the own
  // enumerable properties, which is what structured clone effectively
  // delivered as well -- the prototype was always stripped.
  if (Object.prototype.hasOwnProperty.call(value, TAG)) {
    return { [TAG]: TAG_ESCAPE, value: packObject(value) }
  }
  return packObject(value)
}

function packObject (value) {
  const out = {}
  for (const key of Object.keys(value)) {
    out[key] = pack(value[key])
  }
  return out
}

function unpack (value) {
  if (value === null) return null

  const type = typeof value
  if (type === 'string' || type === 'boolean' || type === 'number') {
    return value
  }
  if (type !== 'object') {
    throw new TypeError(`wire.decode: unexpected ${type} in args`)
  }

  if (Array.isArray(value)) return value.map(unpack)
  if (!Object.prototype.hasOwnProperty.call(value, TAG)) {
    return unpackObject(value)
  }

  const tag = value[TAG]
  if (typeof tag !== 'string') {
    throw new TypeError('wire.decode: tag must be a string')
  }
  switch (tag) {
    case TAG_UNDEFINED:
      return undefined
    case TAG_NUMBER:
      return unpackNumber(value.value)
    case TAG_ESCAPE:
      if (value.value === null || typeof value.value !== 'object' ||
          Array.isArray(value.value)) {
        throw new TypeError('wire.decode: escaped value is not an object')
      }
      return unpackObject(value.value)
    case TAG_UINT8:
      return fromBase64(value.data)
    case TAG_BUFFER:
      return toBuffer(fromBase64(value.data))
    default:
      throw new TypeError(`wire.decode: unknown tag ${JSON.stringify(tag)}`)
  }
}

function unpackObject (value) {
  const out = {}
  for (const key of Object.keys(value)) {
    out[key] = unpack(value[key])
  }
  return out
}

function unpackNumber (value) {
  if (typeof value !== 'string' || !NON_FINITE.has(value)) {
    throw new TypeError('wire.decode: not a non-finite number')
  }
  return NON_FINITE.get(value)
}

function isBuffer (value) {
  return typeof Buffer !== 'undefined' && Buffer.isBuffer(value)
}

function toBuffer (bytes) {
  if (typeof Buffer === 'undefined') return bytes
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

// A view can sit anywhere in a larger backing store, so always narrow
// to the view's own bytes before encoding.
function ownBytes (view) {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function toBase64 (view) {
  const bytes = ownBytes(view)
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64')
  }
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return globalThis.btoa(binary)
}

function fromBase64 (data) {
  // `Buffer.from(x, 'base64')` and `atob` both tolerate junk, so the
  // shape is checked here rather than trusted to the decoder.
  if (typeof data !== 'string' || data.length % 4 !== 0 ||
      !BASE64.test(data)) {
    throw new TypeError('wire.decode: binary value is not base64')
  }
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(data, 'base64')
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  }
  const binary = globalThis.atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function utf8ToString (bytes) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(ownBytes(bytes)).toString('utf8')
  }
  return new globalThis.TextDecoder().decode(bytes)
}
