/**
 * The renderer's `util` implementation -- the inheritance helpers, and
 * nothing else.
 *
 * Same reason as `lib/path.js` (ADR-011), `lib/events.js` and
 * `lib/stream.js`: after US-072 no host `require()` answers a Node
 * builtin, and Vite rewrites an un-aliased one to an **empty object**
 * rather than to an error, so the failure surfaces one frame later as
 * `undefined is not a function`. `util` is the fourth builtin where
 * that happens during module initialization rather than in dead code:
 *
 *     var inherits = require('util').inherits
 *     inherits(DestroyableTransform, Transform)   // through2.js
 *
 * `through2` is reached from a static import --
 * `controllers/subtitles-controller.js` imports `srt-to-vtt` -- so
 * `undefined()` there is a blank window, not a dormant bug.
 *
 * **Only `inherits` and `inspect` are implemented.** That is not an
 * oversight, it is the measured surface: everything else the bundle
 * asks `util` for is *read* at load and *called* only from the casting
 * stack (`lib/cast.js`), which cannot work in a webview regardless --
 * the sockets under it are empty objects too. It is exempt from the
 * shim under ADR-008 and is being rewritten host-side in US-076
 * through US-079. Reading an absent key yields `undefined` exactly as
 * it did before this file existed, so nothing that worked stops
 * working; what changes is that the one live caller now works.
 *
 * Adding to this file is therefore a deliberate act: it means a real
 * caller was found. Say which one in the comment, the way these two
 * do.
 */

/**
 * Node's `util.inherits`, in its current form -- `setPrototypeOf` on
 * an existing prototype object, not the older
 * `ctor.prototype = Object.create(...)` replacement.
 *
 * The difference is load-bearing here. `lib/stream.js` is written with
 * `class`, and a class's `prototype` is non-writable, so the old
 * assignment throws `TypeError: Cannot assign to read only property`
 * on any of our aliased base classes. `setPrototypeOf` mutates rather
 * than replaces and works on both shapes, which is why Node moved.
 *
 * `super_` is what `readable-stream` and friends call up through.
 */
export function inherits (ctor, superCtor) {
  if (ctor === undefined || ctor === null) {
    throw new TypeError('The "ctor" argument must be of type function')
  }
  if (superCtor === undefined || superCtor === null) {
    throw new TypeError('The "superCtor" argument must be of type function')
  }
  if (superCtor.prototype === undefined) {
    throw new TypeError('The "superCtor.prototype" property must be of ' +
      'type object')
  }

  Object.defineProperty(ctor, 'super_', {
    value: superCtor,
    writable: true,
    configurable: true
  })
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype)
}

/**
 * A debug-print stand-in. `bencode`'s encoder calls it behind an
 * `if (debug)` that is off, and `debug` itself calls it on the format
 * path; neither needs Node's inspector, and shipping one would mean
 * several hundred lines of formatting for output no user sees. Kept
 * total rather than faithful: it must never throw, because every
 * caller is already inside someone else's logging path.
 */
export function inspect (value) {
  try {
    if (typeof value === 'string') return value
    return JSON.stringify(value) ?? String(value)
  } catch (err) {
    // Cyclic, or a BigInt. Neither is worth a second attempt.
    return String(value)
  }
}

export default { inherits, inspect }
