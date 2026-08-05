/**
 * The device mirror: the renderer's view of what the host knows about
 * cast receivers.
 *
 * This is what is left of `src/renderer/lib/cast.js` after US-079.
 * That module drove three protocols through three npm packages and
 * ran an HTTP server in the renderer; ADR-015 moved all of it to the
 * Rust host behind `lib/platform/cast.js`, and what does not move is
 * the *shape* the UI reads. `player-page.js` decides whether to show
 * each cast button from `state.devices[protocol].getDevices().length`
 * and ticks the connected one with `player.device === device`, so the
 * host's flat device list is folded back into that shape here rather
 * than the UI learning a new one.
 *
 * Everything in this file is a plain function over plain data
 * (ADR-007). Nothing here talks to the host -- `controllers/
 * cast-controller.js` owns the shim calls and the state writes -- so
 * the folds are testable without a receiver on the network, which is
 * the point: the protocols themselves are host code that only a real
 * device exercises.
 */

import config from '../../config'

/**
 * The protocols the UI knows about, in the order `player-page.js`
 * renders their buttons.
 */
export const PROTOCOLS = ['chromecast', 'airplay', 'dlna']

/**
 * How subtitle tracks are stored in `state.playing.subtitles`: a
 * `data:` URL rather than the cue text. `subtitles-controller.js`
 * builds it.
 */
const VTT_DATA_URL = 'data:text/vtt;base64,'

/**
 * Rebuild `state.devices[protocol]` from the whole device list the
 * host pushed.
 *
 * The host sends the entire list on every change -- which is how a
 * receiver that goes away can finally disappear, the bug `cast.js`
 * documented and did not fix -- so this rebuilds rather than appends.
 * The one thing that has to survive a rebuild is which device is
 * connected, and it is carried across *by id* and re-read from the new
 * list, because `player-page.js` compares it by identity against the
 * entries `getDevices()` hands back.
 *
 * @param {object[]} devices `{ id, protocol, name, capabilities }`
 * @param {object} previous the current `state.devices`
 * @returns {object} one player per protocol, `{ device, getDevices }`
 */
export function mirrorDevices (devices, previous) {
  const mirror = {}
  for (const protocol of PROTOCOLS) {
    const found = (devices || []).filter((d) => d.protocol === protocol)
    const was = previous && previous[protocol]
    const connectedId = was && was.device ? was.device.id : null
    mirror[protocol] = {
      device: found.find((d) => d.id === connectedId) || null,
      getDevices: () => found
    }
  }
  return mirror
}

/**
 * The player for a location, or for wherever playback is right now.
 *
 * `null` while playing locally and, deliberately, while still
 * connecting: `location` is `chromecast-pending` until the host
 * confirms the session, and nothing should be sent to a device that
 * has not accepted one.
 *
 * @param {object} state
 * @param {string} [location] a protocol name; omit for the connected one
 * @returns {object|null}
 */
export function castPlayer (state, location) {
  const protocol = location ||
    (PROTOCOLS.includes(state.playing.location) ? state.playing.location : null)
  if (!protocol) return null
  return state.devices[protocol] || null
}

/**
 * Whether the connected device can be asked to change playback rate.
 *
 * `playback-controller.js` needs this answer synchronously -- it is
 * what `Cast.setRate()`'s boolean return has always meant -- so it
 * comes off the mirrored device's `capabilities` rather than off a
 * promise the caller has nowhere to await.
 *
 * @param {object} state
 * @returns {boolean}
 */
export function canSetRate (state) {
  const player = castPlayer(state)
  const device = player && player.device
  return !!(device && (device.capabilities || []).includes('rate'))
}

/**
 * Fold a status the host pushed into `state.playing`.
 *
 * The same fields `cast.js` wrote from its one-second poll, except
 * that the poll now runs on the host. A field the device did not
 * report is left alone rather than zeroed: an absent position must not
 * send the scrubber back to the start.
 *
 * @param {object} playing `state.playing`
 * @param {object} status `{ isPaused, currentTime, volume }`
 */
export function applyStatus (playing, status) {
  if (!status) return
  if (typeof status.isPaused === 'boolean') playing.isPaused = status.isPaused
  if (Number.isFinite(status.currentTime)) {
    playing.currentTime = status.currentTime
  }
  if (Number.isFinite(status.volume)) playing.volume = status.volume
}

/**
 * The selected subtitle track as cue text, or `undefined` when none is
 * selected.
 *
 * `cast.js` served this over an HTTP server it ran in the renderer and
 * handed Chromecast the URL. The host serves it now (ADR-015), so what
 * crosses the boundary is the text itself.
 *
 * @param {object} subtitles `state.playing.subtitles`
 * @returns {string|undefined}
 */
export function subtitlesVtt (subtitles) {
  const track = subtitles && subtitles.tracks[subtitles.selectedIndex]
  if (!track) return undefined
  return Buffer.from(track.buffer.slice(VTT_DATA_URL.length), 'base64')
    .toString('utf8')
}

/**
 * What the host is asked to play, for `cast.connect()`.
 *
 * `startTime` applies to all three protocols. `cast.js` only asked
 * DLNA to resume, and only past ten seconds; the host takes one
 * `startTime`, so the ten-second rule moves here rather than
 * disappearing -- resuming a file the user has barely started is
 * worse than starting it over.
 *
 * @param {object} state
 * @returns {object} `{ url, title, contentType, subtitlesVtt, startTime }`
 */
export function mediaFor (state) {
  const torrent = state.saved.torrents
    .find((x) => x.infoHash === state.playing.infoHash)
  const currentTime = state.playing.currentTime
  return {
    url: state.server.networkURL + '/' + state.playing.fileIndex,
    title: torrent ? config.APP_NAME + ' - ' + torrent.name : config.APP_NAME,
    contentType: 'video/mp4',
    subtitlesVtt: subtitlesVtt(state.playing.subtitles),
    startTime: currentTime > 10 ? currentTime : 0
  }
}
