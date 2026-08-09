const test = require('tape')

// Progress measured in verified bytes, and the stall that falls out of
// it. The clock is a parameter, like the sweep's in `announce.js`, so
// none of this waits on real time.
const {
  createStallTracker, verifiedBytes, STALL_AFTER_MS, SPEED_WINDOW_MS
} = require('../../build/engine/stall')

const KEY = 'ccf09fcb'
const MB = 1024 * 1024

test('the first sample has nothing to compare against', function (t) {
  const tracker = createStallTracker()
  const first = tracker.sample(KEY, 100 * MB, 1000)

  t.equal(first.verifiedSpeed, 0, 'no speed can be derived from one point')
  t.equal(first.stalledForMs, 0, 'and nothing has stalled yet')
  t.equal(first.stalled, false, 'so it is not reported as stalled')
  t.end()
})

test('speed is verified bytes over elapsed time', function (t) {
  const tracker = createStallTracker()
  tracker.sample(KEY, 0, 0)
  const result = tracker.sample(KEY, 10 * MB, 10000)

  t.equal(result.verifiedSpeed, MB, '10 MB verified over 10s is 1 MB/s')
  t.equal(result.stalled, false, 'and it is plainly moving')
  t.end()
})

// The bug this whole module exists for. A peer that sends handshakes,
// keepalives and `have` messages but never a usable block keeps
// `torrent.downloadSpeed` off zero, because that counts every byte off
// the socket. Dividing what is missing by that speed is what produced
// "12 h 25 min remaining" on a torrent receiving nothing.
test('chatter from a peer that sends no blocks is not progress',
  function (t) {
    const tracker = createStallTracker()
    let now = 0
    tracker.sample(KEY, 1553 * MB, now)

    // Ten minutes of a connected, talkative, useless peer.
    for (let i = 0; i < 600; i++) {
      now += 1000
      var result = tracker.sample(KEY, 1553 * MB, now)
    }

    t.equal(result.verifiedSpeed, 0, 'no verified bytes means no speed')
    t.equal(result.stalled, true, 'and the torrent is reported stalled')
    t.ok(result.stalledForMs >= 600000, 'for as long as it has been')
    t.end()
  })

test('a torrent is not called stalled before the threshold', function (t) {
  const tracker = createStallTracker({ stallAfterMs: 60000 })
  tracker.sample(KEY, 100 * MB, 0)

  const early = tracker.sample(KEY, 100 * MB, 59000)
  t.equal(early.stalled, false, 'a quiet minute is ordinary peer churn')

  const late = tracker.sample(KEY, 100 * MB, 60000)
  t.equal(late.stalled, true, 'past the threshold it is a stall')
  t.end()
})

test('one verified piece clears the stall', function (t) {
  const tracker = createStallTracker({ stallAfterMs: 60000 })
  tracker.sample(KEY, 100 * MB, 0)
  t.equal(tracker.sample(KEY, 100 * MB, 90000).stalled, true, 'stalled')

  const moved = tracker.sample(KEY, 101 * MB, 91000)
  t.equal(moved.stalled, false, 'a verified piece is real progress')
  t.equal(moved.stalledForMs, 0, 'and the stall clock restarts')
  t.end()
})

// `torrent.downloaded` counts in-progress piece buffers, so it climbs
// as a piece fills and drops back when the piece fails to verify. Fed
// that number, a stall tracker would see constant motion and never
// report the very case it exists for. It is fed the bitfield instead,
// but a re-verify can still move the count down, and that is not
// progress either.
test('a count going backwards is not progress', function (t) {
  const tracker = createStallTracker({ stallAfterMs: 60000 })
  tracker.sample(KEY, 100 * MB, 0)

  const dropped = tracker.sample(KEY, 99 * MB, 30000)
  t.equal(dropped.verifiedSpeed, 0, 'speed is never negative')

  const stillStalled = tracker.sample(KEY, 99 * MB, 61000)
  t.equal(stillStalled.stalled, true,
    'and losing ground does not reset the stall clock')
  t.end()
})

test('speed is measured over a bounded window', function (t) {
  const tracker = createStallTracker({ windowMs: 10000 })
  // A burst, then nothing for well past the window.
  tracker.sample(KEY, 0, 0)
  tracker.sample(KEY, 100 * MB, 1000)
  const after = tracker.sample(KEY, 100 * MB, 60000)

  t.equal(after.verifiedSpeed, 0,
    'an old burst does not prop up the current speed')
  t.end()
})

test('torrents are tracked independently', function (t) {
  const tracker = createStallTracker({ stallAfterMs: 60000 })
  tracker.sample('a', 0, 0)
  tracker.sample('b', 0, 0)
  tracker.sample('a', 10 * MB, 61000)
  const b = tracker.sample('b', 0, 61000)

  t.equal(b.stalled, true, 'b stalled on its own account')
  t.ok(tracker.sample('a', 20 * MB, 62000).verifiedSpeed > 0,
    'and a is unaffected')
  t.end()
})

test('a forgotten torrent starts over', function (t) {
  const tracker = createStallTracker({ stallAfterMs: 60000 })
  tracker.sample(KEY, 0, 0)
  t.equal(tracker.sample(KEY, 0, 61000).stalled, true, 'stalled')

  tracker.forget(KEY)
  const fresh = tracker.sample(KEY, 0, 62000)
  t.equal(fresh.stalled, false, 'the history went with it')
  t.equal(fresh.stalledForMs, 0, 'and so did the stall clock')
  t.end()
})

// A stand-in for the parts of a torrent `verifiedBytes` reads. `have`
// lists the piece indexes whose hash checked out.
function fakeTorrent (numPieces, have, pieceLength, lastPieceLength) {
  const set = new Set(have)
  return {
    pieceLength,
    lastPieceLength,
    pieces: new Array(numPieces).fill(null),
    bitfield: { get: (i) => set.has(i) }
  }
}

test('verifiedBytes counts only pieces that passed their hash',
  function (t) {
    const torrent = fakeTorrent(4, [0, 2], 1000, 300)
    t.equal(verifiedBytes(torrent), 2000, 'two whole pieces')
    t.end()
  })

// The last piece is short, and counting it as a full one would report
// more bytes than the torrent contains -- enough, on a torrent missing
// only its tail, to look like progress that never happened.
test('verifiedBytes uses the short length for the last piece',
  function (t) {
    const torrent = fakeTorrent(4, [0, 3], 1000, 300)
    t.equal(verifiedBytes(torrent), 1300, 'one whole piece and the tail')
    t.end()
  })

test('verifiedBytes is zero for an empty and a bare torrent',
  function (t) {
    t.equal(verifiedBytes(fakeTorrent(4, [], 1000, 300)), 0,
      'nothing verified yet')
    t.equal(verifiedBytes({}), 0, 'no metadata yet')
    t.equal(verifiedBytes(null), 0, 'no torrent at all')
    t.end()
  })

test('verifiedBytes counts a fully downloaded torrent exactly',
  function (t) {
    const torrent = fakeTorrent(3, [0, 1, 2], 1000, 250)
    t.equal(verifiedBytes(torrent), 2250, 'two full pieces plus the tail')
    t.end()
  })

test('the defaults are the shipped policy', function (t) {
  t.ok(STALL_AFTER_MS >= 30000,
    'long enough that ordinary peer churn does not trip it')
  t.ok(SPEED_WINDOW_MS > 0, 'and the speed window is a real bound')
  t.end()
})
