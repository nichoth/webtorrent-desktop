const test = require('tape')

// Progress measured in verified bytes, the stall measured in payload
// bytes, and the reasons they are not the same counter. The clock is a
// parameter, like the sweep's in `announce.js`, so none of this waits
// on real time.
const {
  createStallTracker, verifiedBytes, STALL_AFTER_MS, SPEED_WINDOW_MS
} = require('../../build/engine/stall')

const KEY = 'ccf09fcb'
const MB = 1024 * 1024

// Both counters at the same figure, for the cases where the distinction
// between them is not what is under test.
const both = (bytes) => ({ verified: bytes, payload: bytes })

test('the first sample has nothing to compare against', function (t) {
  const tracker = createStallTracker()
  const first = tracker.sample(KEY, both(100 * MB), 1000)

  t.equal(first.verifiedSpeed, 0, 'no speed can be derived from one point')
  t.equal(first.stalledForMs, 0, 'and nothing has stalled yet')
  t.equal(first.stalled, false, 'so it is not reported as stalled')
  t.end()
})

test('speed is verified bytes over elapsed time', function (t) {
  const tracker = createStallTracker()
  tracker.sample(KEY, both(0), 0)
  const result = tracker.sample(KEY, both(10 * MB), 10000)

  t.equal(result.verifiedSpeed, MB, '10 MB verified over 10s is 1 MB/s')
  t.equal(result.stalled, false, 'and it is plainly moving')
  t.end()
})

// The bug this whole module exists for. A peer that sends handshakes,
// keepalives and `have` messages but never a usable block keeps
// `torrent.downloadSpeed` off zero, because that counts every byte off
// the socket. Dividing what is missing by that speed is what produced
// "12 h 25 min remaining" on a torrent receiving nothing. Neither
// counter here moves, because neither counts a byte that is not payload.
test('chatter from a peer that sends no blocks is not progress',
  function (t) {
    const tracker = createStallTracker()
    let now = 0
    let result
    tracker.sample(KEY, both(1553 * MB), now)

    // Ten minutes of a connected, talkative, useless peer.
    for (let i = 0; i < 600; i++) {
      now += 1000
      result = tracker.sample(KEY, both(1553 * MB), now)
    }

    t.equal(result.verifiedSpeed, 0, 'no verified bytes means no speed')
    t.equal(result.stalled, true, 'and the torrent is reported stalled')
    t.ok(result.stalledForMs >= 600000, 'for as long as it has been')
    t.end()
  })

test('a torrent is not called stalled before the threshold', function (t) {
  const tracker = createStallTracker({ stallAfterMs: 60000 })
  tracker.sample(KEY, both(100 * MB), 0)

  const early = tracker.sample(KEY, both(100 * MB), 59000)
  t.equal(early.stalled, false, 'a quiet minute is ordinary peer churn')

  const late = tracker.sample(KEY, both(100 * MB), 60000)
  t.equal(late.stalled, true, 'past the threshold it is a stall')
  t.end()
})

test('one verified piece clears the stall', function (t) {
  const tracker = createStallTracker({ stallAfterMs: 60000 })
  tracker.sample(KEY, both(100 * MB), 0)
  t.equal(tracker.sample(KEY, both(100 * MB), 90000).stalled, true,
    'stalled')

  const moved = tracker.sample(KEY, both(101 * MB), 91000)
  t.equal(moved.stalled, false, 'a verified piece is real progress')
  t.equal(moved.stalledForMs, 0, 'and the stall clock restarts')
  t.end()
})

// Measured, not reasoned about. Pieces verify in lumps: at these rates
// one lands every few minutes, so reading the stall off the bitfield
// labelled a perfectly healthy download "Stalled" for minutes at a
// time. Over four minutes a torrent gaining 2 MB verified something in
// 13% of ticks and one gaining 180 KB in none of them -- both were
// reported stuck throughout. Payload moves every 16 KB block, so it
// sees what the bitfield is too coarse to.
test('a slow download between pieces is not a stall', function (t) {
  const tracker = createStallTracker({ stallAfterMs: 60000 })
  let now = 0
  let result
  let payload = 300 * MB
  const verified = 280 * MB

  tracker.sample(KEY, { verified, payload }, now)

  // Four minutes of blocks arriving steadily, no piece completing.
  for (let i = 0; i < 240; i++) {
    now += 1000
    payload += 8 * 1024
    result = tracker.sample(KEY, { verified, payload }, now)
  }

  t.equal(result.stalled, false,
    'a torrent gaining two megabytes is not stuck')
  t.equal(result.verifiedSpeed, 0,
    'while the ETA still refuses to estimate from data that has ' +
    'not passed its hash')
  t.end()
})

// The counter the stall is read off goes down, which is why it is read
// as a high-water mark. WebTorrent discards a piece that fails its hash
// and re-requests every block, so `downloaded` climbs to the piece
// boundary and falls back, over and over, on the exact torrent this
// module was written for. Re-covering ground already marked is not
// progress, and the maximum is what says so.
test('a piece that keeps failing is not progress', function (t) {
  const tracker = createStallTracker({ stallAfterMs: 60000 })
  const verified = 1553 * MB
  const base = 1553 * MB
  let now = 0
  let result

  tracker.sample(KEY, { verified, payload: base }, now)

  // Six rounds of a piece filling and being thrown away.
  for (let round = 0; round < 6; round++) {
    for (let i = 1; i <= 30; i++) {
      now += 1000
      result = tracker.sample(
        KEY, { verified, payload: base + i * 64 * 1024 }, now)
    }
    now += 1000
    result = tracker.sample(KEY, { verified, payload: base }, now)
  }

  t.equal(result.stalled, true,
    'the sawtooth is the stall, not an escape from it')
  t.ok(result.stalledForMs >= 60000,
    'and the clock has run since the first attempt covered that ground')
  t.end()
})

// The first attempt at a piece does mark new ground, so it moves the
// high-water mark once. Only the retries after it are flat.
test('ground covered for the first time is progress', function (t) {
  const tracker = createStallTracker({ stallAfterMs: 60000 })
  const verified = 100 * MB
  tracker.sample(KEY, { verified, payload: 100 * MB }, 0)

  const filling = tracker.sample(KEY, { verified, payload: 101 * MB }, 30000)
  t.equal(filling.stalled, false, 'blocks the torrent has never held')
  t.equal(filling.stalledForMs, 0, 'restart the stall clock')

  const discarded = tracker.sample(KEY, { verified, payload: 100 * MB }, 40000)
  t.equal(discarded.stalled, false, 'the drop itself proves nothing yet')

  // The clock last moved at 30000, when that megabyte was new, so the
  // stall is due at 90000 however many times the same ground is
  // re-covered in between.
  const refilled = tracker.sample(KEY, { verified, payload: 101 * MB }, 91000)
  t.equal(refilled.stalled, true,
    'but re-covering it does not restart the clock, so the stall ' +
    'lands on schedule')
  t.end()
})

test('a verified count going backwards is not negative speed',
  function (t) {
    const tracker = createStallTracker({ stallAfterMs: 60000 })
    tracker.sample(KEY, both(100 * MB), 0)

    const dropped = tracker.sample(KEY, both(99 * MB), 30000)
    t.equal(dropped.verifiedSpeed, 0, 'speed is never negative')

    const stillStalled = tracker.sample(KEY, both(99 * MB), 61000)
    t.equal(stillStalled.stalled, true,
      'and losing ground does not reset the stall clock')
    t.end()
  })

test('speed is measured over a bounded window', function (t) {
  const tracker = createStallTracker({ windowMs: 10000 })
  // A burst, then nothing for well past the window.
  tracker.sample(KEY, both(0), 0)
  tracker.sample(KEY, both(100 * MB), 1000)
  const after = tracker.sample(KEY, both(100 * MB), 60000)

  t.equal(after.verifiedSpeed, 0,
    'an old burst does not prop up the current speed')
  t.end()
})

test('torrents are tracked independently', function (t) {
  const tracker = createStallTracker({ stallAfterMs: 60000 })
  tracker.sample('a', both(0), 0)
  tracker.sample('b', both(0), 0)
  tracker.sample('a', both(10 * MB), 61000)
  const b = tracker.sample('b', both(0), 61000)

  t.equal(b.stalled, true, 'b stalled on its own account')
  t.ok(tracker.sample('a', both(20 * MB), 62000).verifiedSpeed > 0,
    'and a is unaffected')
  t.end()
})

test('a forgotten torrent starts over', function (t) {
  const tracker = createStallTracker({ stallAfterMs: 60000 })
  tracker.sample(KEY, both(0), 0)
  t.equal(tracker.sample(KEY, both(0), 61000).stalled, true, 'stalled')

  tracker.forget(KEY)
  const fresh = tracker.sample(KEY, both(0), 62000)
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
