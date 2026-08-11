// Peers that serve corrupt piece data, and what to do about them.
//
// WebTorrent 1.9.7 answers a failed SHA-1 check by rebuilding the piece
// and asking again -- `lib/torrent.js` emits `Piece N failed
// verification` and nothing else. There is no strike count and no
// runtime ban, so a peer that serves garbage for a piece is re-asked
// for that same piece forever. A torrent whose last few pieces are only
// available from such a peer sits one piece short of done, burning
// bandwidth at full speed, with `torrent.downloaded` sawtoothing up to
// the piece boundary and back as each attempt is discarded. The UI
// reads that as "downloading, seconds remaining", indefinitely.
//
// This module is the strike count. It answers one question -- which
// peers should be cut off -- from two facts the engine feeds it: who
// sent blocks for a piece, and which pieces failed to verify. It holds
// no wires and no sockets, so it can be tested without either.
//
// Attribution comes from the block sender rather than from
// `piece.sources`, which would be the natural place to look. `flush()`
// nulls `sources` before the SHA-1 callback runs and the failure path
// then replaces the whole `Piece`, so by the time the warning is
// emitted the contributor list is gone. `wire.on('piece')` in
// `bittorrent-protocol` carries the same information and is a public
// event.

// Failures a peer is allowed before it is cut off. Not 1: a block can
// be corrupted in transit by something other than malice, and a single
// bad piece from an otherwise good peer is not worth losing the peer
// over. Not 10: at roughly three seconds per attempt, a high threshold
// is a lot of wasted bandwidth on a torrent whose only remaining source
// is the bad peer.
export const MAX_STRIKES = 3

// How many pieces may have a live contributor set. A piece that
// verifies has no event to clear its set on, so without a bound the map
// would keep one entry per piece the torrent ever completed. Only
// pieces in flight can still fail, and there are never more of those
// than a client has outstanding requests, so evicting the oldest costs
// nothing real. Well above `MAX_QUEUED_PER_PEER` times any sane peer
// count.
export const MAX_TRACKED_PIECES = 256

/**
 * Create a tracker for one client.
 *
 * @param {object} [options]
 * @param {number} [options.maxStrikes] failures before a peer is banned
 * @param {number} [options.maxTrackedPieces] live contributor sets
 * @returns {{
 *   recordContribution: Function, recordFailure: Function,
 *   isBanned: Function, strikesFor: Function, bannedPeers: Function,
 *   trackedPieceCount: Function
 * }}
 */
export function createHashFailTracker (options = {}) {
  const {
    maxStrikes = MAX_STRIKES,
    maxTrackedPieces = MAX_TRACKED_PIECES
  } = options

  // Piece index -> Set of peer key. A `Map` because insertion order is
  // what makes the eviction below "oldest first".
  const contributors = new Map()

  // Peer key -> failures charged so far. A banned peer is removed, so
  // this only ever holds peers still under suspicion.
  const strikes = new Map()

  const banned = new Set()

  /**
   * Note that a peer sent block data for a piece. Called once per
   * block, so it stays cheap: two lookups and a set insert.
   *
   * @param {number} pieceIndex
   * @param {string} peerKey the peer's address
   */
  function recordContribution (pieceIndex, peerKey) {
    // A wire has no `remoteAddress` until the connection is up. Blocks
    // cannot arrive before then, but an unidentifiable peer is one we
    // could not ban anyway, so it is dropped rather than tracked.
    if (!peerKey) return

    let peers = contributors.get(pieceIndex)
    if (!peers) {
      peers = new Set()
      contributors.set(pieceIndex, peers)
      evictOldestPieces()
    }
    peers.add(peerKey)
  }

  /**
   * Charge a failed verification to whoever fed the piece.
   *
   * The contributor set is consumed, not kept. WebTorrent discards the
   * buffer and re-requests every block, so the next failure of the same
   * piece is a fresh round of contributions -- carrying the old set
   * forward would charge one bad transfer several times over and ban a
   * peer for a single mistake.
   *
   * @param {number} pieceIndex the piece that failed to verify
   * @returns {{ suspects: string[], banned: string[] }} everyone
   *   charged, and the subset banned by this failure. Each ban is
   *   reported once, on the failure that causes it.
   */
  function recordFailure (pieceIndex) {
    const peers = contributors.get(pieceIndex)
    contributors.delete(pieceIndex)
    if (!peers || peers.size === 0) return { suspects: [], banned: [] }

    const suspects = []
    const newlyBanned = []

    peers.forEach((peerKey) => {
      suspects.push(peerKey)
      if (banned.has(peerKey)) return

      const count = (strikes.get(peerKey) || 0) + 1
      if (count < maxStrikes) {
        strikes.set(peerKey, count)
        return
      }

      strikes.delete(peerKey)
      banned.add(peerKey)
      newlyBanned.push(peerKey)
    })

    return { suspects, banned: newlyBanned }
  }

  function evictOldestPieces () {
    while (contributors.size > maxTrackedPieces) {
      const oldest = contributors.keys().next()
      if (oldest.done) return
      contributors.delete(oldest.value)
    }
  }

  return {
    recordContribution,
    recordFailure,
    isBanned: (peerKey) => banned.has(peerKey),
    strikesFor: (peerKey) => strikes.get(peerKey) || 0,
    bannedPeers: () => Array.from(banned),
    trackedPieceCount: () => contributors.size
  }
}

// An "ip:port" address, with the host captured. IPv6 arrives bracketed
// -- `[2001:db8::1]:6881` -- because a bare one is all colons and there
// would be no telling the port from the address. `wire.remoteAddress`,
// which is what the ban set is keyed by, holds the unbracketed host, so
// that is what comes back.
const ADDRESS = /^(?:\[([0-9a-fA-F:.]+)\]|([^[\]:]+)):(\d+)$/

/**
 * The host a peer would connect from, however the peer is expressed.
 *
 * `_addPeer` takes either an "ip:port" string or a live connection, the
 * same two shapes `Torrent#addPeer` handles.
 *
 * @param {string|object} peer an address, or a connection object
 * @returns {string|null} the host, or null if there is none to read
 */
export function peerHost (peer) {
  if (peer && typeof peer.remoteAddress === 'string') {
    return peer.remoteAddress || null
  }
  if (typeof peer !== 'string') return null
  const match = ADDRESS.exec(peer)
  if (!match) return null
  return match[1] || match[2]
}

/**
 * Refuse banned peers at the one place every peer is added.
 *
 * Destroying a banned peer's wire stops its data and nothing else.
 * WebTorrent answers the closed connection by re-adding the peer from
 * `conn.on('close')` (`lib/torrent.js`), and it does so through the
 * private `_addPeer`, which -- unlike the public `addPeer` -- never
 * consults `client.blocked`. The backoff that should give up after
 * three attempts never gets there either: `Peer#onHandshake` resets
 * `retries` to 0, and the handshake completes before the `wire` event
 * the ban is enforced on. So the peer returned every second forever,
 * paying for a TCP connect, a handshake and a full bitfield each time.
 * On a torrent that was otherwise stalled, that churn was the whole of
 * its reported download speed.
 *
 * Returning null is what ends it: the reconnect only carries on `if
 * (newPeer)`, so a refusal is the end of that chain rather than the
 * start of the next one.
 *
 * Incoming connections do not come through here -- `_addIncomingPeer`
 * registers them directly -- but they have no reconnect loop either,
 * and the guard on the `wire` event still catches them.
 *
 * @param {object} torrent a WebTorrent torrent
 * @param {function} isBanned called with a host, at add time
 */
export function guardPeerAdds (torrent, isBanned) {
  const addPeer = torrent._addPeer.bind(torrent)

  torrent._addPeer = (peer, type) => {
    const host = peerHost(peer)
    if (host && isBanned(host)) {
      // Every refusal path in `_addPeer` closes a connection it
      // declines rather than leaking the socket. This is one of them.
      if (typeof peer !== 'string') peer.destroy()
      return null
    }
    return addPeer(peer, type)
  }
}

/**
 * Whether a ban is a live explanation for a torrent's silence.
 *
 * The ban tally only ever goes up, so "has this torrent banned anyone"
 * stays true for as long as the torrent exists and cannot answer "is
 * that why it is stuck". This can: a ban that happened after the last
 * byte verified is part of the current silence, and one from before it
 * is history the torrent has already recovered from.
 *
 * @param {number} lastBanAt epoch ms of the most recent ban, 0 for none
 * @param {number} stalledForMs how long since the torrent last verified
 * @param {number} now epoch milliseconds
 * @returns {boolean}
 */
export function bannedSinceProgress (lastBanAt, stalledForMs, now) {
  if (!lastBanAt) return false
  return lastBanAt >= now - stalledForMs
}

// The message WebTorrent emits as a `warning` when a piece fails its
// SHA-1 check, in `lib/torrent.js`. Matching on it is what turns that
// warning into a piece index. The engine subscribes to `warning`
// already, and every other warning on that channel is passed through
// untouched.
const FAILED_VERIFICATION = /^Piece (\d+) failed verification$/

/**
 * Read a piece index out of a WebTorrent warning message.
 *
 * @param {string} message the `warning` event's `err.message`
 * @returns {number|null} the piece index, or null for any other warning
 */
export function parseFailedPiece (message) {
  if (typeof message !== 'string') return null
  const match = FAILED_VERIFICATION.exec(message)
  return match ? Number(match[1]) : null
}
