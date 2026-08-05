/**
 * The renderer's legacy `Stream` base class.
 *
 * `vite.config.js` aliases `stream` and `node:stream` to this file, for
 * the reason `lib/path.js` (ADR-011) and `lib/events.js` exist: after
 * US-072 there is no host `require()` left to answer a Node builtin,
 * and Vite rewrites an un-aliased one to an **empty object** rather
 * than to an error. `stream` is the third builtin where that empty
 * object is not merely dead weight but a load-time crash, and it was
 * the last one standing:
 *
 *     util.inherits(Readable, Stream)   // Object.create(undefined)
 *
 * That line is in `through2`'s bundled `readable-stream@1.x`, it runs
 * in the module body, and `through2` is reached from a static import
 * -- `controllers/subtitles-controller.js` imports `srt-to-vtt`. So
 * the whole bundle died on it with `TypeError: Object prototype may
 * only be an Object or null: undefined`, which is a blank window.
 *
 * **This file is CommonJS, and that is load-bearing.** Its two
 * siblings are ESM, so a `require('path')` in a bundled dependency
 * gets a module *namespace* object -- which is fine there, because
 * every consumer only reads a property off it (`path.join`,
 * `events.EventEmitter`), and both files export their whole surface by
 * name for exactly that reason. `stream` is the first alias where the
 * module object has to *be* the constructor:
 *
 *     Stream.call(this)                 // _stream_readable.js:131
 *     util.inherits(Readable, Stream)   // reads Stream.prototype
 *
 * A namespace object has neither `.call` nor `.prototype`, and no
 * export list can give it them. `module.exports = Stream` is the only
 * shape that answers those two call sites, and it is also exactly
 * Node's own: the constructor, with the rest hung off it.
 *
 * **This is the legacy base class and nothing else.** It is Node's
 * `Stream` -- an `EventEmitter` with a `pipe()` method -- which is
 * exactly what the bundle asks of the builtin and no more:
 *
 * - `through2`'s `readable-stream` brings its own `Readable`,
 *   `Writable`, `Duplex` and `Transform` implementations. It imports
 *   `stream` solely to inherit from it, so subtitle conversion works
 *   on top of this with nothing further.
 * - `stream-buffers` and `sax` named `stream.Readable` and
 *   `stream.Stream`. Both were in the casting stack (`airplayer` via
 *   `bplist-creator`, and `chromecasts`/`dlnacasts` via `xml2js` and
 *   `elementtree`), and US-079 removed all three packages with
 *   `lib/cast.js` -- so as of that story nothing in the tree reads
 *   the subclasses below at all. They are kept because they are the
 *   shape `require('stream')` has in Node, and because an absent one
 *   is `undefined` at the reader rather than an error here; do not
 *   read their presence as evidence of a live caller.
 *
 * A full `Readable`/`Writable` implementation would be several hundred
 * lines of backpressure and state machine for no live caller, so
 * `Readable` and `Writable` below are the legacy base under another
 * name: enough to be a valid prototype for `util.inherits`, and
 * honest about being nothing more. If a first-party module ever needs
 * real streams in the renderer, that is a dependency decision to
 * record, not a gap to fill in silently here.
 */

// Named, not default: `./events` is ESM, so this reads the same key
// under Rolldown's interop and under Babel's.
const { EventEmitter } = require('./events')

class Stream extends EventEmitter {
  /**
   * Node's legacy `Stream.prototype.pipe`, which is the whole of the
   * base class's behaviour: forward `data` to `dest.write`, honour
   * backpressure through `pause`/`resume`, and end the destination
   * when the source does.
   *
   * Kept faithful because the things that inherit from it are old
   * enough to rely on it. `readable-stream` overrides `pipe` outright,
   * so this is not on the subtitle path.
   */
  pipe (dest, options) {
    const source = this

    function onData (chunk) {
      if (dest.writable && dest.write(chunk) === false && source.pause) {
        source.pause()
      }
    }

    function onDrain () {
      if (source.readable && source.resume) source.resume()
    }

    source.on('data', onData)
    dest.on('drain', onDrain)

    // `process.stdout` and `process.stderr` are the cases Node exempts
    // from the automatic end; neither exists in a webview, so the only
    // condition left is the caller's own opt-out.
    const shouldEnd = !options || options.end !== false

    let ended = false
    function onEnd () {
      if (ended) return
      ended = true
      dest.end()
    }

    function onClose () {
      if (ended) return
      ended = true
      if (typeof dest.destroy === 'function') dest.destroy()
    }

    if (shouldEnd) {
      source.on('end', onEnd)
      source.on('close', onClose)
    }

    // An `error` with no listener throws (see `lib/events.js`), and an
    // unhandled throw out of a stream teardown is not recoverable from
    // the UI. Node installs this same guard for the same reason.
    function onError (err) {
      cleanup()
      if (source.listenerCount('error') === 0) throw err
    }

    source.on('error', onError)
    dest.on('error', onError)

    function cleanup () {
      source.removeListener('data', onData)
      dest.removeListener('drain', onDrain)
      source.removeListener('end', onEnd)
      source.removeListener('close', onClose)
      source.removeListener('error', onError)
      dest.removeListener('error', onError)
      source.removeListener('end', cleanup)
      source.removeListener('close', cleanup)
      dest.removeListener('close', cleanup)
    }

    source.on('end', cleanup)
    source.on('close', cleanup)
    dest.on('close', cleanup)

    dest.emit('pipe', source)

    // Node returns the destination so pipes chain.
    return dest
  }
}

// Named so a stack trace says which one it was rather than reporting
// `Stream` five times. No dependency in the tree reads them since
// US-079 -- see the note at the top of this file.
class Readable extends Stream {}
class Writable extends Stream {}
class Duplex extends Stream {}
class Transform extends Duplex {}
class PassThrough extends Transform {}

// `require('stream')` returns the constructor with the rest hung off
// it, and `require('stream').Stream` has to be the same function.
Stream.Stream = Stream
Stream.Readable = Readable
Stream.Writable = Writable
Stream.Duplex = Duplex
Stream.Transform = Transform
Stream.PassThrough = PassThrough

module.exports = Stream
