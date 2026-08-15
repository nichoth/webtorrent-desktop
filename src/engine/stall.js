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
// making progress.
//
// So the two questions are answered from two different counters, which
// is not the same as answering both from the bitfield:
//
// - **How fast is it going**, for the ETA, is bitfield bytes. An
//   estimate may only be built on data that is certainly kept.
// - **Has it stopped**, for the status line, is the high-water mark of
//   `torrent.downloaded`.
//
// The second used to be the bitfield too, and that was wrong in a way
// that took measuring to see. Pieces verify in lumps: at 8 KB/s with
// megabyte pieces one lands every few minutes, so a torrent that was
// downloading perfectly well went a minute without verifying anything
// and got labelled "Stalled". Measured over four minutes, a torrent
// gaining 2 MB verified something in 13% of ticks and one gaining
// 180 KB in none of them -- both were reported stuck the whole time.
//
// The high-water mark is what makes `downloaded` usable for this
// despite the sawtooth in the header above. A piece that fails takes
// the counter back down and the next attempt climbs the same ground
// again, so the *maximum* only moves when the torrent holds payload it
// has never held before. The corrupt-peer case this module was written
// for still reads as stalled -- the first attempt sets the mark and
// every retry after it is flat -- while a slow download moves the mark
// every 16 KB block and reads as what it is.
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

  // Key -> { samples: [{ at, bytes }], bestPayload, lastAdvanceAt }.
  // `samples` is verified bytes, for the speed; `bestPayload` is the
  // high-water mark of payload bytes, for the stall.
  const state = new Map()

  /**
   * Record where a torrent has got to, and read back how fast it is
   * really going and whether it has stopped.
   *
   * @param {string} key identifies the torrent
   * @param {object} bytes where the torrent has got to
   * @param {number} bytes.verified bytes that have passed their hash,
   *   which the speed is measured in
   * @param {number} bytes.payload bytes held including pieces still in
   *   flight, which the stall is measured in
   * @param {number} now epoch milliseconds
   * @returns {{ verifiedSpeed: number, stalledForMs: number,
   *   stalled: boolean }} speed in bytes per second
   */
  function sample (key, bytes, now) {
    const { verified, payload } = bytes

    let entry = state.get(key)
    if (!entry) {
      // The first sample is a baseline, not a measurement. Reporting a
      // stall here would mark every torrent stalled the moment it was
      // added.
      entry = { samples: [], bestPayload: payload, lastAdvanceAt: now }
      state.set(key, entry)
      entry.samples.push({ at: now, bytes: verified })
      return { verifiedSpeed: 0, stalledForMs: 0, stalled: false }
    }

    // Only forward movement counts, and this is the whole reason the
    // stall can be read off a counter that goes down: a failed piece
    // takes `payload` back and the retry re-covers ground already
    // marked, so the maximum sits still until data the torrent has
    // never held before arrives.
    if (payload > entry.bestPayload) {
      entry.bestPayload = payload
      entry.lastAdvanceAt = now
    }

    entry.samples.push({ at: now, bytes: verified })

    // Keep one sample from before the window so the average spans the
    // whole window rather than starting at whatever landed inside it.
    while (entry.samples.length > 2 &&
           entry.samples[1].at <= now - windowMs) {
      entry.samples.shift()
    }

    const oldest = entry.samples[0]
    const elapsed = now - oldest.at
    const gained = verified - oldest.bytes
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
