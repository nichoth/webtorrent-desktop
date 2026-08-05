/**
 * Installs `Buffer` as a global for the renderer bundle.
 *
 * `Buffer` is a Node global, and under Electron's
 * `nodeIntegration: true` the renderer simply had it. A webview does
 * not, and the renderer cannot do without one: torrent metadata is
 * bytes, so `parse-torrent`, `create-torrent`, `bitfield` and
 * `simple-concat` all take and return `Buffer`s, and six first-party
 * modules do too -- `lib/state.js`, `lib/torrent-poster.js`,
 * `lib/video-frame.js`, `lib/migrations.js`, `lib/platform/fs.js` and
 * `controllers/subtitles-controller.js`.
 *
 * The implementation is the `buffer` package: feross's, the one
 * browserify has used for a decade, and already in this tree as a
 * transitive dependency of the torrent stack. This is the exception to
 * the rule `lib/path.js` and `lib/events.js` set -- those are
 * first-party because they are a few hundred lines of string and array
 * handling that the app should own. `Buffer` is a typed-array subclass
 * with base64, hex and UTF-16 codecs and a decade of encoding
 * edge-cases, and a hand-rolled one would be a liability, not an
 * asset. It is now a declared dependency rather than an accidental
 * one; see ADR-011 for the general rule.
 *
 * **Import this before anything else.** `src/renderer/main.js` lists
 * it first for that reason: ES modules initialize in import order, so
 * anything above it would run without a `Buffer` and the failure would
 * be a blank window. It is a side-effecting import with no exports, so
 * there is nothing else to keep the ordering honest.
 *
 * Assigned only when absent, so a host that provides its own -- or a
 * test that has already installed one -- is left alone.
 */

import { Buffer } from 'buffer'

if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = Buffer
}
