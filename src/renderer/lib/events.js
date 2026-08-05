/**
 * The renderer's `EventEmitter` implementation.
 *
 * `vite.config.js` aliases both `events` and `node:events` to this
 * file, so it serves every `events` import in the renderer bundle:
 * `lib/state.js`, which is the only first-party one, and the bundled
 * dependencies that inherit from it. That was mostly the casting
 * stack (`castv2-client`, `bonjour`, `multicast-dns`, `xml2js`,
 * `airplay-protocol`, `upnp-device-client`) until US-079 moved
 * casting to the host and deleted all three packages; the
 * first-party caller alone is reason enough for this file.
 *
 * It exists for the reason `lib/path.js` does (ADR-011): the alternative
 * is externalizing the builtin, and after US-072 there is no host
 * `require()` left to answer it -- Vite rewrites an un-aliased builtin
 * to an empty object, so `new EventEmitter()` becomes `new undefined()`
 * and `lib/state.js` takes the whole bundle down at load.
 *
 * The surface is Node's minus the parts nothing here uses: no
 * `captureRejections`, no async-iterator helpers (`events.once`,
 * `events.on`), no `errorMonitor`. What is present behaves as Node
 * documents it, including the details dependencies rely on --
 * `emit('error')` with no listener throws, `once` wrappers are
 * removable by their original function, and a listener list is copied
 * before dispatch so a handler that unsubscribes itself does not
 * perturb the emit in progress.
 *
 * `maxListeners` is accepted and reported but never enforced: Node's
 * limit only ever produces a warning, and a warning nobody can see in
 * a webview is not worth the code.
 */

// Node's default. Reported by `getMaxListeners()` so that a dependency
// reading it back gets a number rather than `undefined`.
const DEFAULT_MAX_LISTENERS = 10

class EventEmitter {
  constructor () {
    // Created lazily by `on`, matching Node: a fresh emitter that is
    // only ever emitted through allocates nothing. Null-prototype so
    // an event literally named `constructor` or `__proto__` is an
    // ordinary key rather than a collision with `Object.prototype`.
    this._events = undefined
    this._maxListeners = undefined
  }

  addListener (type, listener) {
    return prepend(this, type, listener, false)
  }

  on (type, listener) {
    return prepend(this, type, listener, false)
  }

  prependListener (type, listener) {
    return prepend(this, type, listener, true)
  }

  once (type, listener) {
    return prepend(this, type, wrapOnce(this, type, listener), false)
  }

  prependOnceListener (type, listener) {
    return prepend(this, type, wrapOnce(this, type, listener), true)
  }

  removeListener (type, listener) {
    check(listener)
    const list = this._events && this._events[type]
    if (!list) return this

    // Last match wins, as in Node: `removeListener` takes off the most
    // recently added copy of a listener registered more than once.
    // `listener` matches a `once` wrapper through its `listener`
    // property, which is what makes a handler removable by the
    // function the caller actually passed in.
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] === listener || list[i].listener === listener) {
        list.splice(i, 1)
        break
      }
    }
    if (list.length === 0) delete this._events[type]
    return this
  }

  off (type, listener) {
    return this.removeListener(type, listener)
  }

  removeAllListeners (type) {
    if (!this._events) return this
    if (arguments.length === 0) this._events = undefined
    else delete this._events[type]
    return this
  }

  emit (type, ...args) {
    const list = this._events && this._events[type]

    if (!list || list.length === 0) {
      // Node's one piece of behaviour that is not "do nothing": an
      // unhandled `error` event throws, which is how a dependency
      // reports a failure it has no other channel for. Swallowing it
      // would turn a cast or torrent failure into silence.
      if (type === 'error') {
        const err = args[0]
        throw err instanceof Error
          ? err
          : Object.assign(
            new Error(`Unhandled "error" event. (${err})`),
            { context: err }
          )
      }
      return false
    }

    // Copied first: a listener that calls `off()` -- which every
    // `once` wrapper does -- otherwise shortens the array underneath
    // the loop and skips its neighbour.
    for (const listener of list.slice()) listener.apply(this, args)
    return true
  }

  listenerCount (type) {
    const list = this._events && this._events[type]
    return list ? list.length : 0
  }

  listeners (type) {
    const list = this._events && this._events[type]
    // Unwrapped, as Node does: a `once` handler is reported as the
    // function that was registered, not as the internal wrapper.
    return list ? list.map((fn) => fn.listener || fn) : []
  }

  rawListeners (type) {
    const list = this._events && this._events[type]
    return list ? list.slice() : []
  }

  eventNames () {
    return this._events ? Reflect.ownKeys(this._events) : []
  }

  setMaxListeners (n) {
    this._maxListeners = n
    return this
  }

  getMaxListeners () {
    return this._maxListeners === undefined
      ? DEFAULT_MAX_LISTENERS
      : this._maxListeners
  }
}

EventEmitter.defaultMaxListeners = DEFAULT_MAX_LISTENERS

// `require('events').EventEmitter` and `require('events')` are both the
// class in Node, and dependencies use both spellings -- usually as
// `util.inherits(Thing, require('events').EventEmitter)`.
EventEmitter.EventEmitter = EventEmitter

function check (listener) {
  if (typeof listener !== 'function') {
    throw new TypeError(
      `The "listener" argument must be of type function. Received ${typeof listener}`
    )
  }
}

function prepend (emitter, type, listener, first) {
  check(listener)
  if (!emitter._events) emitter._events = Object.create(null)
  const list = emitter._events[type] || (emitter._events[type] = [])
  if (first) list.unshift(listener)
  else list.push(listener)
  return emitter
}

function wrapOnce (emitter, type, listener) {
  check(listener)
  let fired = false
  function onceWrapper (...args) {
    // Removed before the call, not after: a listener that throws must
    // still not run a second time, and one that re-emits the same
    // event synchronously must not recurse.
    if (fired) return
    fired = true
    emitter.removeListener(type, onceWrapper)
    listener.apply(emitter, args)
  }
  // What `removeListener` and `listeners()` match on.
  onceWrapper.listener = listener
  return onceWrapper
}

export { EventEmitter }
export default EventEmitter
