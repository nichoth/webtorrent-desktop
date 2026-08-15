// Reading a torrent's progress payload for states the status line has
// to distinguish. `pages/torrent-list-page.js` is JSX around a React
// component and will not load in a unit test, so the decisions it makes
// live here where they can be checked against plain objects.
//
// These return reasons rather than sentences. The wording belongs with
// the markup; what is worth pinning in a test is which case was
// recognised.

/**
 * Why a downloading torrent is not moving, if it is not.
 *
 * The engine decides *that* a torrent has stalled -- it owns the clock
 * and the threshold. This decides how to explain it, which is the one
 * thing the engine cannot know from bytes alone: a torrent that stopped
 * because its peers were caught serving corrupt data is a different
 * story from one that simply ran out of seeders, even though both look
 * like silence.
 *
 * Not `bannedPeers`, which counts every ban this torrent ever made and
 * never comes back down: once a single bad peer had been cut off, every
 * later stall was reported as a corrupt peer being blocked, including
 * the ordinary one where the swarm has no seeder for the last few
 * pieces. `bannedSinceProgress` is the engine's answer to the narrower
 * question, and its absence means no answer -- which leaves the vaguer
 * message rather than a confident wrong one.
 *
 * @param {object} prog one torrent's entry in a progress payload
 * @returns {string|null} 'corrupt-peers', 'no-progress', or null when
 *   the torrent is moving or complete
 */
export function stallReason (prog) {
  if (!prog || !prog.stalled) return null
  if (prog.progress >= 1) return null
  return prog.bannedSinceProgress ? 'corrupt-peers' : 'no-progress'
}

/**
 * The speed an ETA may be derived from, in bytes per second.
 *
 * Not `downloadSpeed`, which is every byte off the socket: handshakes,
 * keepalives and `have` messages from a peer serving nothing usable
 * kept it in the tens of bytes per second, and dividing the missing
 * megabytes by that produced a confident "12 h 25 min remaining" on a
 * torrent that was receiving no usable data at all. Zero means no
 * honest estimate is available, and the caller should show none.
 *
 * @param {object} prog one torrent's entry in a progress payload
 * @returns {number} bytes per second of verified data
 */
export function etaSpeed (prog) {
  if (!prog) return 0
  // An older engine, or another implementation of the protocol, may not
  // report verified speed. Falling back to the raw socket speed keeps
  // the old behaviour rather than silently hiding every ETA.
  if (typeof prog.verifiedSpeed !== 'number') return prog.downloadSpeed || 0
  return prog.verifiedSpeed
}

/**
 * The download speed worth putting on screen, in bytes per second.
 *
 * `downloadSpeed` is every byte off the socket, so a torrent gaining
 * nothing still reads tens of bytes per second. Beside the word
 * "Stalled" that is not just noise, it is a contradiction: it says the
 * app is still pulling from the peer it has just told you it blocked.
 * Measured on a stalled torrent over two minutes -- 189 B/s reported,
 * zero bytes gained.
 *
 * A stalled torrent therefore shows no download figure at all. The
 * label already explains the silence, and a number next to it can only
 * argue with the label.
 *
 * `verifiedSpeed` is deliberately not used in its place. It is the
 * honest rate, but it is averaged over a 30-second window and pieces
 * verify in lumps minutes apart at low speeds: measured across four
 * minutes, a torrent gaining 2 MB reported a non-zero verified speed in
 * 13% of ticks and one gaining 180 KB in none of them. Showing it would
 * make a healthy slow download flicker between a speed and nothing,
 * which trades this bug for a worse one. Suppressing the figure only
 * where it contradicts the label costs nothing anywhere else.
 *
 * @param {object} prog one torrent's entry in a progress payload
 * @returns {number} bytes per second, or 0 to show nothing
 */
export function displayDownloadSpeed (prog) {
  if (!prog) return 0
  if (stallReason(prog)) return 0
  return prog.downloadSpeed || 0
}
