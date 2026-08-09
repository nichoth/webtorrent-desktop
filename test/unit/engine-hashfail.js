const test = require('tape')

// Attribution and banning for peers that serve corrupt piece data.
// Everything here runs against plain values -- a piece index and a peer
// address -- because that is all the tracker knows. The wires it learns
// them from are `index.js`'s problem, and the wiring is checked
// separately in `engine-hashfail-wiring.js`.
const {
  createHashFailTracker, parseFailedPiece, MAX_STRIKES, MAX_TRACKED_PIECES
} = require('../../build/engine/hashfail')

const A = '176.190.134.108'
const B = '10.0.0.7'

// One full round of "this peer sent every block of this piece, and the
// piece did not verify".
function failOnce (tracker, pieceIndex, ...peers) {
  peers.forEach((peer) => tracker.recordContribution(pieceIndex, peer))
  return tracker.recordFailure(pieceIndex)
}

test('a sole contributor is named as the suspect', function (t) {
  const tracker = createHashFailTracker()
  const result = failOnce(tracker, 1066, A)

  t.deepEqual(result.suspects, [A], 'the one peer that sent blocks')
  t.deepEqual(result.banned, [], 'one strike is not enough to ban')
  t.equal(tracker.isBanned(A), false, 'and it is still allowed')
  t.end()
})

test('a peer is banned on its MAX_STRIKES-th failure', function (t) {
  const tracker = createHashFailTracker()

  for (let i = 1; i < MAX_STRIKES; i++) {
    const result = failOnce(tracker, 1066, A)
    t.deepEqual(result.banned, [], `still unbanned after strike ${i}`)
    t.equal(tracker.isBanned(A), false, 'and still allowed')
  }

  const last = failOnce(tracker, 1066, A)
  t.deepEqual(last.banned, [A], 'the final strike reports the ban')
  t.equal(tracker.isBanned(A), true, 'and the peer is banned')
  t.end()
})

test('the ban is reported once, not on every later failure',
  function (t) {
    const tracker = createHashFailTracker({ maxStrikes: 1 })

    t.deepEqual(failOnce(tracker, 1066, A).banned, [A], 'banned here')
    t.deepEqual(failOnce(tracker, 1066, A).banned, [],
      'and not announced a second time')
    t.equal(tracker.isBanned(A), true, 'though it stays banned')
    t.end()
  })

test('strikes accumulate across different pieces', function (t) {
  const tracker = createHashFailTracker({ maxStrikes: 3 })

  failOnce(tracker, 1066, A)
  failOnce(tracker, 1385, A)
  const result = failOnce(tracker, 1386, A)

  t.deepEqual(result.banned, [A],
    'three bad pieces from one peer is three strikes')
  t.end()
})

// The honest limit of block-level attribution: when several peers fed
// one piece, any of them could have sent the bad block. Striking all of
// them is what makes the threshold matter -- an innocent peer has to be
// present at MAX_STRIKES separate failures before it is banned, which a
// peer that is not deliberately poisoning will not be.
test('every contributor to a bad piece takes a strike', function (t) {
  const tracker = createHashFailTracker({ maxStrikes: 2 })

  const first = failOnce(tracker, 1066, A, B)
  t.deepEqual(first.suspects.slice().sort(), [B, A].sort(),
    'both peers are suspects')
  t.deepEqual(first.banned, [], 'neither is banned yet')

  const second = failOnce(tracker, 1066, A, B)
  t.deepEqual(second.banned.slice().sort(), [B, A].sort(),
    'and both cross the threshold together')
  t.end()
})

test('a peer that only ever fed good pieces keeps a clean sheet',
  function (t) {
    const tracker = createHashFailTracker({ maxStrikes: 2 })

    // B contributes to a piece that never fails.
    tracker.recordContribution(2, B)
    // A fails its own piece twice over.
    failOnce(tracker, 1066, A)
    failOnce(tracker, 1066, A)

    t.equal(tracker.isBanned(A), true, 'the bad peer is banned')
    t.equal(tracker.isBanned(B), false, 'the bystander is not')
    t.equal(tracker.strikesFor(B), 0, 'and has no strikes at all')
    t.end()
  })

test('contributors are forgotten once the failure is attributed',
  function (t) {
    const tracker = createHashFailTracker({ maxStrikes: 3 })

    failOnce(tracker, 1066, A)
    // WebTorrent throws the buffer away and re-requests, so the next
    // failure must be earned by a fresh round of blocks. Without this,
    // one contribution would be charged for every retry.
    const second = tracker.recordFailure(1066)

    t.deepEqual(second.suspects, [],
      'the stale contributor is not blamed twice')
    t.equal(tracker.strikesFor(A), 1, 'so the peer still has one strike')
    t.end()
  })

test('a failure for a piece nobody contributed to is harmless',
  function (t) {
    const tracker = createHashFailTracker()
    const result = tracker.recordFailure(999)

    t.deepEqual(result, { suspects: [], banned: [] }, 'nothing to report')
    t.end()
  })

test('a wire with no address yet is ignored', function (t) {
  const tracker = createHashFailTracker({ maxStrikes: 1 })
  tracker.recordContribution(1066, undefined)
  tracker.recordContribution(1066, null)
  tracker.recordContribution(1066, '')

  t.deepEqual(tracker.recordFailure(1066), { suspects: [], banned: [] },
    'an unidentifiable peer cannot be blamed')
  t.end()
})

test('unknown peers are not banned', function (t) {
  const tracker = createHashFailTracker()
  t.equal(tracker.isBanned('8.8.8.8'), false, 'never seen, never banned')
  t.equal(tracker.strikesFor('8.8.8.8'), 0, 'and has no strikes')
  t.end()
})

// A piece that verifies leaves its contributor set behind -- there is no
// per-piece success event to clear it on. The cap is what keeps that
// from growing with the torrent: only pieces in flight matter, and there
// are far fewer of those than MAX_TRACKED_PIECES.
test('tracked pieces are capped, evicting the oldest first',
  function (t) {
    const tracker = createHashFailTracker({ maxTrackedPieces: 3 })

    tracker.recordContribution(1, A)
    tracker.recordContribution(2, A)
    tracker.recordContribution(3, A)
    tracker.recordContribution(4, A)

    t.equal(tracker.trackedPieceCount(), 3, 'the cap holds')
    t.deepEqual(tracker.recordFailure(1).suspects, [],
      'the oldest piece was evicted')
    t.deepEqual(tracker.recordFailure(4).suspects, [A],
      'the newest is still tracked')
    t.end()
  })

test('the defaults are the shipped policy', function (t) {
  t.equal(typeof MAX_STRIKES, 'number', 'MAX_STRIKES is exported')
  t.ok(MAX_STRIKES >= 2,
    'more than one failure is needed, so a corrupt transfer is not a ban')
  t.ok(MAX_TRACKED_PIECES > 0, 'MAX_TRACKED_PIECES is a real bound')

  const tracker = createHashFailTracker()
  for (let i = 1; i < MAX_STRIKES; i++) failOnce(tracker, 1066, A)
  t.equal(tracker.isBanned(A), false, 'the default takes MAX_STRIKES')
  failOnce(tracker, 1066, A)
  t.equal(tracker.isBanned(A), true, 'and bans on the last one')
  t.end()
})

// The warning channel carries every torrent warning there is, so the
// engine has to be able to tell a verification failure from the rest.
// The message text is WebTorrent's, quoted verbatim from
// `lib/torrent.js`, and a version bump that reworded it would fail here
// rather than silently stop banning anyone.
test('parseFailedPiece reads the index out of the warning', function (t) {
  t.equal(parseFailedPiece('Piece 1066 failed verification'), 1066,
    'the exact message WebTorrent emits')
  t.equal(parseFailedPiece('Piece 0 failed verification'), 0,
    'piece zero is an index, not a falsy miss')
  t.end()
})

test('parseFailedPiece ignores every other warning', function (t) {
  const others = [
    'Piece 1066 failed verification!',
    'piece 1066 failed verification',
    'Piece one failed verification',
    'Piece 1066 failed',
    'tracker: connection timed out',
    '',
    undefined,
    null,
    12
  ]
  others.forEach((message) => {
    t.equal(parseFailedPiece(message), null,
      `passed through: ${JSON.stringify(message)}`)
  })
  t.end()
})

test('banned peers are listed for the caller to disconnect', function (t) {
  const tracker = createHashFailTracker({ maxStrikes: 1 })
  failOnce(tracker, 1066, A)
  failOnce(tracker, 1385, B)

  t.deepEqual(tracker.bannedPeers().slice().sort(), [B, A].sort(),
    'both bans are readable after the fact')
  t.end()
})
