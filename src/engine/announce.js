// Peer discovery for a torrent the client already holds.
//
// `torrent.destroy()` followed by `client.add()` revives a stalled
// torrent, but it does four things at once: fresh tracker announce,
// fresh DHT lookup, reset peer bookkeeping, and a re-verify of every
// piece already on disk. This module is the first two on their own --
// no re-hash, no dropped peer connections, safe to call on a healthy
// torrent.
//
// It exists because the natural cadence is slow. `torrent-discovery`
// asks for a 15 minute interval and then calls `tracker.start()`,
// which resets each tracker to its own DEFAULT_ANNOUNCE_INTERVAL: 30
// minutes for HTTP and UDP. The DHT re-announces every 15 minutes plus
// jitter. A torrent whose last peer drops can therefore sit at zero
// peers for half an hour before it next asks anyone for peers.

/**
 * Force one round of peer discovery for a torrent.
 *
 * Every argument is optional in practice: `discovery` does not exist
 * until the torrent has been parsed, `discovery.tracker` is null when
 * trackers are disabled, and `dht` is false when the client has no
 * DHT. None of those is an error, so each half reports whether it ran
 * rather than throwing.
 *
 * @param {object} torrent A WebTorrent torrent, or null.
 * @param {object|false} dht The client-wide DHT, or a falsy value.
 * @returns {{ tracker: boolean, dht: boolean }} What actually fired.
 */
export function announceNow (torrent, dht) {
  const result = { tracker: false, dht: false }
  if (!torrent) return result

  const tracker = torrent.discovery && torrent.discovery.tracker
  if (tracker) {
    // A no-event announce to every tracker in the list.
    tracker.update()
    result.tracker = true
  }

  if (torrent.infoHash && dht && typeof dht.lookup === 'function') {
    // `torrent-discovery` is already subscribed to the DHT's `peer`
    // event for this info hash, so a plain lookup feeds peers back
    // through the path the torrent already uses.
    dht.lookup(torrent.infoHash)
    result.dht = true
  }

  return result
}
