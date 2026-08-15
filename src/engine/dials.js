// How many connections a torrent may be opening at once.
//
// WebTorrent 1.9.7 has a connection cap, `client.maxConns`, and
// `Torrent#_drain` is the one place that respects it:
//
//     if (... || this._numConns >= this.client.maxConns) return
//
// but `_numConns` counts only peers that are already up:
//
//     get _numConns () {
//       let numConns = 0
//       for (const id in this._peers) {
//         if (this._peers[id].connected) numConns += 1
//       }
//       return numConns
//     }
//
// `connected` is set in `Peer#onConnect`, which runs on the socket's
// `connect` event. A dial still waiting on the SYN counts as zero, so
// the cap does not see it. Every `_addPeer` ends in a `_drain`, so as
// the tracker, the DHT and PEX feed addresses in, each one starts
// another connection and none of them holds the gate: the only limit
// on how many sockets a torrent has half-open is how fast peers are
// discovered.
//
// Observed on four torrents: 53 simultaneous SYN_SENT sockets to a
// single host -- one address, 53 ports -- 41 to another, and over 150
// half-open sockets across the client, against a nominal cap of 55 per
// torrent. Each one is a `Peer`, a `Wire` and its streams, built and
// torn down five seconds later on `CONNECT_TIMEOUT_TCP`.
//
// This is the half-open connection limit every other BitTorrent client
// has and this one is missing. It bounds the dials in flight; it does
// not drop anyone. `_drain` is called again whenever a peer is removed
// -- which is what a failed dial does on its way out -- so the queue
// keeps draining at the rate connections actually resolve.

// Dials a torrent may have in flight. Low enough to bound the socket
// churn and the objects that go with it; high enough that discovery is
// not the bottleneck, since a dial that is going to succeed resolves in
// well under the five seconds a dead one takes to time out. In the same
// range as the half-open limits other clients settle on.
export const MAX_PENDING_DIALS = 10

/**
 * How many outgoing connections a torrent is waiting on.
 *
 * A peer gets its `conn` in `_drain`, at the moment the socket is
 * opened, and `connected` when that socket comes up -- so the pair
 * picks out exactly the outgoing dials in flight. Peers still queued
 * have no `conn` yet. Incoming and web-seed peers are built with a
 * socket that is already open and are marked connected before anyone
 * can ask, so neither is counted here.
 *
 * @param {object} torrent a WebTorrent torrent
 * @returns {number}
 */
export function pendingDials (torrent) {
  const peers = torrent._peers
  if (!peers) return 0

  let pending = 0
  for (const id in peers) {
    const peer = peers[id]
    if (peer && peer.conn && !peer.connected) pending += 1
  }
  return pending
}

/**
 * Hold `_drain` at a fixed number of dials in flight.
 *
 * Returning without draining is not a refusal: the peer stays on
 * `torrent._queue` in the order it arrived, and the next `_drain` --
 * from the next peer added, or from `removePeer` as a dial resolves or
 * times out -- takes it. Nothing else has to run for the queue to move.
 *
 * @param {object} torrent a WebTorrent torrent
 * @param {number} [maxPending] dials allowed in flight
 */
export function limitPendingDials (torrent, maxPending = MAX_PENDING_DIALS) {
  const drain = torrent._drain.bind(torrent)

  torrent._drain = () => {
    if (pendingDials(torrent) >= maxPending) return
    return drain()
  }
}
