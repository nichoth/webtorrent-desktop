// Progress measured in verified bytes, and the stall that falls out of
// it.
//
// The two numbers WebTorrent hands the UI both answer a different
// question than the one the UI is asking:
//
// - `torrent.downloadSpeed` is fed from the raw socket
//   (`lib/peer.js:270`), so it counts handshakes, keepalives, `have`
//   messages and every other byte a peer sends. A peer that never
//   serves a usable block still shows tens of bytes per second.
// - `torrent.downloaded` deliberately includes in-progress piece
//   buffers (`lib/torrent.js:147`), so it climbs as a piece fills and
//   drops back when that piece fails to verify.
//
// Dividing what is missing by the first is how a torrent receiving
// nothing usable reported "12 h 25 min remaining", and watching the
// second is how a torrent whose pieces never verify looks like it is
// making progress. Both are answered by the same substitution: count
// only bytes that passed their SHA-1 check, which is the bitfield.
//
// Everything here is a parameter, including the clock, so the policy
// can be tested without waiting on it.

// How long a torrent may go without verifying a single byte before the
// UI calls it stalled. Long enough that ordinary peer churn -- a seed
// dropping, a slow piece, a tracker interval -- does not flicker the
// label, short enough to be useful.
export const STALL_AFTER_MS = 60000

// The window verified speed is averaged over. Pieces land in lumps,
// often a megabyte at a time and seconds apart, so a one-second sample
// reads as zero through most of a healthy download. Averaging over a
// window turns those lumps back into a rate an ETA can use.
export const SPEED_WINDOW_MS = 30000

/**
 * Create a tracker for one client.
 *
 * @param {object} [options]
 * @param {number} [options.stallAfterMs] silence before "stalled"
 * @param {number} [options.windowMs] averaging window for the speed
 * @returns {{ sample: Function, forget: Function }}
 */
export function createStallTracker (options = {}) {
  const {
    stallAfterMs = STALL_AFTER_MS,
    windowMs = SPEED_WINDOW_MS
  } = options

  // Key -> { samples: [{ at, bytes }], best, lastAdvanceAt }
  const state = new Map()

  /**
   * Record where a torrent has got to, and read back how fast it is
   * really going and whether it has stopped.
   *
   * @param {string} key identifies the torrent
   * @param {number} verifiedBytes bytes that have passed their hash
   * @param {number} now epoch milliseconds
   * @returns {{ verifiedSpeed: number, stalledForMs: number,
   *   stalled: boolean }} speed in bytes per second
   */
  function sample (key, verifiedBytes, now) {
    let entry = state.get(key)
    if (!entry) {
      // The first sample is a baseline, not a measurement. Reporting a
      // stall here would mark every torrent stalled the moment it was
      // added.
      entry = { samples: [], best: verifiedBytes, lastAdvanceAt: now }
      state.set(key, entry)
      entry.samples.push({ at: now, bytes: verifiedBytes })
      return { verifiedSpeed: 0, stalledForMs: 0, stalled: false }
    }

    // Only forward movement counts. A re-verify can move the count
    // down, and that is not progress in any sense the UI cares about.
    if (verifiedBytes > entry.best) {
      entry.best = verifiedBytes
      entry.lastAdvanceAt = now
    }

    entry.samples.push({ at: now, bytes: verifiedBytes })

    // Keep one sample from before the window so the average spans the
    // whole window rather than starting at whatever landed inside it.
    while (entry.samples.length > 2 &&
           entry.samples[1].at <= now - windowMs) {
      entry.samples.shift()
    }

    const oldest = entry.samples[0]
    const elapsed = now - oldest.at
    const gained = verifiedBytes - oldest.bytes
    const verifiedSpeed = (elapsed > 0 && gained > 0)
      ? (gained / elapsed) * 1000
      : 0

    const stalledForMs = now - entry.lastAdvanceAt

    return {
      verifiedSpeed,
      stalledForMs,
      stalled: stalledForMs >= stallAfterMs
    }
  }

  function forget (key) {
    state.delete(key)
  }

  return { sample, forget }
}

/**
 * Bytes of a torrent that have passed their hash check.
 *
 * The bitfield is the only record of what actually verified;
 * `torrent.downloaded` mixes in buffers that may yet fail. Every piece
 * is `pieceLength` except the last.
 *
 * @param {object} torrent a WebTorrent torrent
 * @returns {number} verified bytes, 0 before the metadata arrives
 */
export function verifiedBytes (torrent) {
  const bitfield = torrent && torrent.bitfield
  const pieces = torrent && torrent.pieces
  if (!bitfield || !pieces) return 0

  const last = pieces.length - 1
  let total = 0
  for (let index = 0; index <= last; index++) {
    if (!bitfield.get(index)) continue
    total += index === last ? torrent.lastPieceLength : torrent.pieceLength
  }
  return total
}
