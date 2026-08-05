/**
 * Platform shim.
 *
 * Casting to Chromecast, DLNA and AirPlay receivers (US-075).
 *
 * ADR-015 moves all three protocols into the Rust host: the webview
 * has no `require`, no Node module registry and no `http`, which is
 * what kept `src/renderer/lib/cast.js` outside the shim until now.
 * This module is the surface that work lands behind. It is the whole
 * of it -- discovery, the three event streams, and the session
 * commands -- so US-076 (Chromecast), US-077 (DLNA) and US-078
 * (AirPlay) each fill in a host implementation without the renderer
 * changing again.
 *
 * The host holds a single session, because the UI already forbids two
 * ("Never cast to two devices at the same time", `cast.js:toggleMenu`),
 * which is why nothing below names a device except `connect`.
 *
 * What answers today is a stub: `src-tauri/src/cast.rs` reports no
 * devices and every session command fails with a clear
 * not-implemented message. `player-page.js`'s existing rule -- no
 * devices and not casting means no button -- hides the UI for a
 * protocol that has not landed, so an empty list is a complete
 * answer rather than a broken one.
 *
 * `docs/platform-shim.md` is the contract each export is written
 * against. US-079 deleted `src/renderer/lib/cast.js` and the three
 * npm packages under it, so this is the only route to a receiver:
 * `controllers/cast-controller.js` owns the session and
 * `controllers/playback-controller.js` sends the five commands that
 * only forward a value, with `lib/cast-mirror.js` folding the host's
 * device list back into the shape `player-page.js` reads.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, once } from '@tauri-apps/api/event'

/**
 * Register a listener on a host event, hiding both the Tauri event
 * envelope and the unsubscribe bookkeeping from the caller. The same
 * helper `ipc-os.js` uses, kept private to each module.
 *
 * @param {string} event
 * @param {(payload: any) => void} listener
 * @param {{ once?: boolean }} [options]
 * @returns {Promise<() => void>}
 */
function subscribe (event, listener, options) {
  const register = options && options.once ? once : listen
  return register(event, (received) => listener(received.payload))
}

/**
 * An optional value, as a Tauri command reads it.
 *
 * `undefined` is dropped by JSON serialisation, and a dropped key is
 * not the same thing as a value the caller left out on purpose -- a
 * torrent with no subtitle track selected has to say so.
 *
 * @param {any} value
 * @returns {any}
 */
function optional (value) {
  return value === undefined ? null : value
}

/**
 * Start looking for receivers on the local network.
 *
 * Discovery runs on the host for as long as it is on, and every
 * change to the list arrives on `onDevices`. A protocol whose
 * implementation has not landed contributes nothing and raises
 * nothing.
 *
 * @returns {Promise<void>}
 */
export async function startDiscovery () {
  return invoke('cast_start_discovery')
}

/**
 * Stop looking for receivers.
 *
 * @returns {Promise<void>}
 */
export async function stopDiscovery () {
  return invoke('cast_stop_discovery')
}

/**
 * The receivers found so far.
 *
 * Each is `{ id, protocol, name, capabilities }`, where `protocol` is
 * one of `chromecast`, `dlna` or `airplay` -- the strings
 * `player-page.js` already reads -- and `capabilities` is the subset
 * of `play`, `pause`, `seek`, `volume` and `rate` the device answers.
 * That array is what lets `playback-controller.js` keep
 * `Cast.setRate()`'s synchronous boolean.
 *
 * Always an array: the button rule in `player-page.js` counts it, and
 * a host with no protocols implemented yet answers an empty list.
 *
 * @returns {Promise<object[]>}
 */
export async function getDevices () {
  const devices = await invoke('cast_get_devices')
  return devices == null ? [] : devices
}

/**
 * The device list changed.
 *
 * The whole list arrives on every change, so a receiver that goes
 * away can finally disappear -- the bug `lib/cast.js` documents and
 * does not fix.
 *
 * @param {(devices: object[]) => void} listener
 * @param {{ once?: boolean }} [options]
 * @returns {Promise<() => void>}
 */
export async function onDevices (listener, options) {
  return subscribe('castDevices', listener, options)
}

/**
 * The connected device's playback state changed.
 *
 * This replaces the one-second `setInterval` in `lib/cast.js`: the
 * host polls the device and pushes the result, so a poll that hangs
 * cannot stall the UI thread. The payload is the same shape
 * [`getStatus`] resolves to.
 *
 * @param {(status: object) => void} listener
 * @param {{ once?: boolean }} [options]
 * @returns {Promise<() => void>}
 */
export async function onStatus (listener, options) {
  return subscribe('castStatus', listener, options)
}

/**
 * Casting failed.
 *
 * Discovery finding nothing and discovery *failing* look identical in
 * a device list, and only one of them should raise anything; this is
 * the other one. The payload is a message for `state.errors`.
 *
 * @param {(message: string) => void} listener
 * @param {{ once?: boolean }} [options]
 * @returns {Promise<() => void>}
 */
export async function onError (listener, options) {
  return subscribe('castError', listener, options)
}

/**
 * Start casting to a device.
 *
 * The media description is plain data (ADR-007): the media URL is the
 * engine's own `networkURL`, and subtitles cross as cue text rather
 * than as a URL because the host serves them itself -- the renderer
 * no longer runs an HTTP server.
 *
 * @param {string} deviceId an `id` from [`getDevices`]
 * @param {object} media `{ url, title, contentType, subtitlesVtt,
 *   startTime }`; the last two are optional and cross as `null` when
 *   the caller omits them.
 * @returns {Promise<void>}
 */
export async function connect (deviceId, media) {
  return invoke('cast_connect', {
    deviceId,
    media: {
      url: media.url,
      title: media.title,
      contentType: media.contentType,
      subtitlesVtt: optional(media.subtitlesVtt),
      startTime: optional(media.startTime)
    }
  })
}

/**
 * Resume the connected device.
 *
 * @returns {Promise<void>}
 */
export async function play () {
  return invoke('cast_play')
}

/**
 * Pause the connected device.
 *
 * @returns {Promise<void>}
 */
export async function pause () {
  return invoke('cast_pause')
}

/**
 * Stop casting and drop the session.
 *
 * @returns {Promise<void>}
 */
export async function stop () {
  return invoke('cast_stop')
}

/**
 * Seek the connected device.
 *
 * @param {number} seconds absolute position, as `lib/cast.js` uses it
 * @returns {Promise<void>}
 */
export async function seek (seconds) {
  return invoke('cast_seek', { seconds })
}

/**
 * Set the connected device's volume, 0..1.
 *
 * @param {number} volume
 * @returns {Promise<void>}
 */
export async function setVolume (volume) {
  return invoke('cast_set_volume', { volume })
}

/**
 * Set the connected device's playback rate.
 *
 * Whether a device can do this at all is its `capabilities`, so a
 * caller that needs the answer synchronously reads that rather than
 * waiting on this promise.
 *
 * @param {number} rate a multiplier, 1 being normal speed
 * @returns {Promise<void>}
 */
export async function setRate (rate) {
  return invoke('cast_set_rate', { rate })
}

/**
 * The connected device's playback state right now.
 *
 * `{ deviceId, isPaused, currentTime, volume, ended }` -- the fields
 * `lib/cast.js` folds into `state.playing` on every poll.
 *
 * @returns {Promise<object>}
 */
export async function getStatus () {
  return invoke('cast_get_status')
}
