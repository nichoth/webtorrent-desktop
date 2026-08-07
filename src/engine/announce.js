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
//
// The rest of the module is the sweep that closes that window without
// anyone clicking anything: `selectStalled` decides who qualifies and
// `runAnnounceSweep` takes one pass, calling `announceNow` for each.
// The guards live here rather than in `index.js` so they can be tested
// without a client or a network -- every dependency, including the
// clock and the logger, is a parameter. `index.js` owns only the
// timer and the last-announced map.

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

// How often the engine looks for stalled torrents. Short, because the
// check itself is a filter over an in-memory array; the cooldown below
// is what keeps the announces themselves rare.
export const SWEEP_INTERVAL_MS = 60 * 1000

// The floor between two forced announces of the same torrent.
// Comfortably above any tracker's `min interval`, and far below the 30
// minute natural cadence this exists to close.
export const COOLDOWN_MS = 5 * 60 * 1000

// A 40-torrent list must not announce 40 times in one tick. Anything
// over the cap waits for the next sweep, oldest first.
export const MAX_PER_SWEEP = 5

function lastOf (lastAnnounceAt, infoHash) {
  const last = lastAnnounceAt.get(infoHash)
  return last == null ? 0 : last
}

/**
 * Which torrents should be asked to re-announce right now.
 *
 * A torrent qualifies when it has no peers at all, is not finished and
 * is not paused. One peer is enough to disqualify it: the sweep exists
 * for torrents that have nobody to talk to, and a torrent that is
 * talking to somebody is making progress the sweep cannot improve on.
 *
 * @param {object[]} torrents The client's torrents.
 * @param {number} now Milliseconds, injected so this stays testable.
 * @param {Map<string, number>} lastAnnounceAt Info hash -> when the
 *   sweep last asked. A missing entry means never.
 * @param {object} [opts]
 * @param {number} [opts.cooldownMs]
 * @param {number} [opts.max]
 * @returns {{ selected: object[], deferred: number }} `deferred` is how
 *   many eligible torrents the cap held back, for logging.
 */
export function selectStalled (torrents, now, lastAnnounceAt, opts = {}) {
  const cooldownMs =
    opts.cooldownMs == null ? COOLDOWN_MS : opts.cooldownMs
  const max = opts.max == null ? MAX_PER_SWEEP : opts.max

  const eligible = torrents.filter((torrent) =>
    // Caller supplies a well-formed array; filter elements may be null.
    torrent &&
    torrent.infoHash &&
    torrent.numPeers === 0 &&
    !torrent.done &&
    !torrent.paused &&
    now - lastOf(lastAnnounceAt, torrent.infoHash) >= cooldownMs)

  // Least recently announced first, so a list longer than the cap is
  // served round robin instead of the same head every sweep. A torrent
  // never announced sorts to the front.
  eligible.sort((a, b) =>
    lastOf(lastAnnounceAt, a.infoHash) - lastOf(lastAnnounceAt, b.infoHash))

  return {
    selected: eligible.slice(0, max),
    deferred: Math.max(0, eligible.length - max)
  }
}

/**
 * One pass: find the stalled torrents, ask each to re-announce, record
 * the attempt, and log once if anything happened.
 *
 * Every dependency is injected rather than imported, which is what
 * keeps the guards testable without a client or a network.
 *
 * @param {object} deps
 * @param {object[]} deps.torrents The client's torrents.
 * @param {object|false} deps.dht The client-wide DHT.
 * @param {Map<string, number>} deps.lastAnnounceAt Mutated in place.
 * @param {number} deps.now Milliseconds.
 * @param {(format: string, ...args: any[]) => void} deps.log
 * @param {number} [deps.cooldownMs]
 * @param {number} [deps.max]
 * @returns {{ announced: string[], deferred: number }}
 */
export function runAnnounceSweep (deps) {
  const { torrents, dht, lastAnnounceAt, now, log } = deps
  const { selected, deferred } = selectStalled(
    torrents, now, lastAnnounceAt,
    { cooldownMs: deps.cooldownMs, max: deps.max })

  if (selected.length === 0 && deferred === 0) {
    return { announced: [], deferred: 0 }
  }

  const announced = []
  for (const torrent of selected) {
    // Record the attempt before making it, so a torrent whose tracker
    // client throws every time still waits out its cooldown rather
    // than being retried every sweep.
    lastAnnounceAt.set(torrent.infoHash, now)
    try {
      announceNow(torrent, dht)
      announced.push(torrent.infoHash)
    } catch (err) {
      // The engine is long lived and one wedged tracker client must
      // not cost the other torrents their sweep.
      log('announce sweep: %s failed: %o', torrent.infoHash, err)
    }
  }

  // A cap that drops work silently reads as "nothing else needed it".
  log('announce sweep: re-announced %d stalled torrent(s), ' +
    '%d deferred: %s',
  announced.length, deferred, announced.join(' '))

  return { announced, deferred }
}
