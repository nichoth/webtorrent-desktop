const test = require('tape')

// Attribution and banning for peers that serve corrupt piece data.
// Everything here runs against plain values -- a piece index and a peer
// address -- because that is all the tracker knows. The wires it learns
// them from are `index.js`'s problem, and the wiring is checked
// separately in `engine-hashfail-wiring.js`.
const {
  createHashFailTracker, parseFailedPiece, peerHost, guardPeerAdds,
  guardIncomingPeers, bannedSinceProgress, MAX_STRIKES,
  MAX_TRACKED_PIECES
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

// The ban set is keyed by host, and the addresses WebTorrent hands
// `_addPeer` are "ip:port". Getting this wrong in either direction is
// silent: a host that never matches bans nobody, and a match on the
// whole "ip:port" would ban a peer only until it picked a new port.
test('peerHost reads the host out of an address', function (t) {
  t.equal(peerHost('176.190.134.108:6881'), '176.190.134.108',
    'IPv4 loses its port')
  t.equal(peerHost('[2001:db8::1]:6881'), '2001:db8::1',
    'and IPv6 loses its brackets as well, which is the form ' +
    'wire.remoteAddress takes')
  t.end()
})

test('peerHost reads a connection object too', function (t) {
  // The WebRTC path hands `_addPeer` a simple-peer connection rather
  // than a string, the same way `Torrent#addPeer` finds its host.
  t.equal(peerHost({ remoteAddress: '10.0.0.7' }), '10.0.0.7',
    'the address a live connection reports')
  t.end()
})

test('peerHost yields null for anything it cannot read', function (t) {
  const unreadable = ['', 'not-an-address', null, undefined, 42, {}]
  unreadable.forEach((value) => {
    t.equal(peerHost(value), null,
      `unreadable: ${JSON.stringify(value)}`)
  })
  t.end()
})

// A torrent, cut down to the one method the guard wraps.
function fakeTorrent () {
  const added = []
  return {
    added,
    _addPeer (peer, type) {
      added.push({ peer, type })
      return { peer, type }
    }
  }
}

// The bug this exists for. Destroying a banned peer's wire is not the
// end of it: WebTorrent's backoff reconnect in `conn.on('close')` calls
// the private `_addPeer`, which never looks at `client.blocked`, and
// `Peer#onHandshake` resets `retries` to 0 before the wire event fires.
// So the backoff never exhausts and the banned peer comes back every
// second forever, paying for a handshake and a full bitfield each time
// -- which the UI shows as download speed on a stalled torrent.
test('a banned peer is never re-added', function (t) {
  const torrent = fakeTorrent()
  guardPeerAdds(torrent, (host) => host === A)

  t.equal(torrent._addPeer(`${A}:6881`, 'tcp'), null,
    'the reconnect gets nothing back, so it schedules no retry')
  t.deepEqual(torrent.added, [],
    'and the real _addPeer is never reached')
  t.end()
})

test('an unbanned peer is added exactly as before', function (t) {
  const torrent = fakeTorrent()
  guardPeerAdds(torrent, (host) => host === A)

  const result = torrent._addPeer(`${B}:6881`, 'utp')
  t.deepEqual(result, { peer: `${B}:6881`, type: 'utp' },
    'the return value is the real one, which the caller uses')
  t.deepEqual(torrent.added, [{ peer: `${B}:6881`, type: 'utp' }],
    'and the arguments arrive unchanged')
  t.end()
})

// The guard is installed once per torrent, but a peer is banned much
// later. Capturing the ban set at install time would guard against an
// empty one for the life of the torrent.
test('the guard reads the ban set at call time', function (t) {
  const torrent = fakeTorrent()
  const banned = new Set()
  guardPeerAdds(torrent, (host) => banned.has(host))

  t.ok(torrent._addPeer(`${A}:6881`, 'tcp'), 'allowed before the ban')
  banned.add(A)
  t.equal(torrent._addPeer(`${A}:6881`, 'tcp'), null,
    'and refused after it')
  t.end()
})

// `_addPeer` destroys a connection it declines rather than leaking the
// socket, on every one of its own refusal paths. The guard is another
// one and owes the same.
test('a refused connection object is destroyed', function (t) {
  const torrent = fakeTorrent()
  guardPeerAdds(torrent, () => true)

  let destroyed = false
  const conn = { remoteAddress: A, destroy: () => { destroyed = true } }

  t.equal(torrent._addPeer(conn, 'webrtc'), null, 'refused')
  t.equal(destroyed, true, 'and the socket is not left open')
  t.end()
})

// An address the guard cannot parse is one it cannot match against the
// ban set either. Refusing it would drop peers over a format the guard
// simply does not recognise; passing it through is what happened
// before the guard existed.
test('an unreadable address is passed through', function (t) {
  const torrent = fakeTorrent()
  guardPeerAdds(torrent, () => true)

  t.ok(torrent._addPeer('web-seed-id', 'webSeed'),
    'no host to check means no grounds to refuse')
  t.end()
})

// An incoming peer is neither of the two shapes `_addPeer` takes. It is
// a `Peer`, built by `lib/peer.js:_createIncomingPeer` from a socket
// that is already connected, so its host is on the connection rather
// than on the peer itself.
test('peerHost reads an incoming peer', function (t) {
  t.equal(peerHost({ conn: { remoteAddress: A }, addr: `${A}:6881` }), A,
    'the address the accepted socket reports')
  t.equal(peerHost({ addr: `${B}:51413` }), B,
    'and its addr serves when the socket has already gone')
  t.end()
})

// A torrent, cut down to the one method the incoming guard wraps.
function fakeIncomingTorrent () {
  const added = []
  return {
    added,
    _addIncomingPeer (peer) {
      added.push(peer)
      return peer
    }
  }
}

// An incoming `Peer` as `conn-pool.js` hands it over: connected,
// handshake already exchanged, wire built but not yet in `torrent.wires`.
function fakeIncomingPeer (host) {
  const peer = {
    addr: `${host}:51413`,
    conn: { remoteAddress: host },
    destroyed: false,
    destroy () { peer.destroyed = true }
  }
  return peer
}

// The hole `guardPeerAdds` cannot reach. `client.blocked` is consulted
// by the public `addPeer` only, and the guard on `_addPeer` covers
// every outbound route -- but an incoming connection arrives through
// `conn-pool.js:_onConnection`, which routes it straight to
// `_addIncomingPeer` with no ban check anywhere on the path. The guard
// on the `wire` event still cuts it, but only after a full TCP connect
// and BitTorrent handshake, and `_registerPeer` has by then attached
// the `download`/`upload` listeners that feed `torrent.downloadSpeed`.
// So a banned peer could dial us forever, and its bytes were counted.
test('a banned peer cannot get in through an incoming connection',
  function (t) {
    const torrent = fakeIncomingTorrent()
    guardIncomingPeers(torrent, (host) => host === A)
    const peer = fakeIncomingPeer(A)

    torrent._addIncomingPeer(peer)
    t.deepEqual(torrent.added, [],
      'the real _addIncomingPeer is never reached, so the peer is ' +
      'never registered and none of its bytes are counted')
    t.equal(peer.destroyed, true,
      'and the accepted socket is closed rather than left open')
    t.end()
  })

test('an unbanned incoming peer is registered exactly as before',
  function (t) {
    const torrent = fakeIncomingTorrent()
    guardIncomingPeers(torrent, (host) => host === A)
    const peer = fakeIncomingPeer(B)

    t.equal(torrent._addIncomingPeer(peer), peer,
      'the return value is the real one')
    t.deepEqual(torrent.added, [peer], 'and the peer arrives unchanged')
    t.equal(peer.destroyed, false, 'with its connection intact')
    t.end()
  })

// Same reason as the outbound guard: it is installed once per torrent
// and the ban happens much later.
test('the incoming guard reads the ban set at call time', function (t) {
  const torrent = fakeIncomingTorrent()
  const banned = new Set()
  guardIncomingPeers(torrent, (host) => banned.has(host))

  t.ok(torrent._addIncomingPeer(fakeIncomingPeer(A)), 'allowed before')
  banned.add(A)
  const after = fakeIncomingPeer(A)
  torrent._addIncomingPeer(after)
  t.equal(after.destroyed, true, 'and refused after the ban')
  t.equal(torrent.added.length, 1, 'only the first one got through')
  t.end()
})

test('an incoming peer with no readable host is passed through',
  function (t) {
    const torrent = fakeIncomingTorrent()
    guardIncomingPeers(torrent, () => true)
    const peer = { destroyed: false, destroy () { this.destroyed = true } }

    t.ok(torrent._addIncomingPeer(peer),
      'no host to check means no grounds to refuse')
    t.end()
  })

// Once a peer is banned the count never goes down, so "has this torrent
// ever banned anyone" stays true for the life of the torrent. Answering
// "is this stall the ban's doing" with it labelled every later stall --
// including the ordinary one where no peer has the last few pieces --
// as a corrupt peer being blocked.
test('a ban explains a stall only if it happened during the stall',
  function (t) {
    const now = 100000
    // Stalled for a minute, so the torrent last verified at 40000.
    const stalledForMs = 60000

    t.equal(bannedSinceProgress(50000, stalledForMs, now), true,
      'a ban after the last verified byte is a live explanation')
    t.equal(bannedSinceProgress(30000, stalledForMs, now), false,
      'and one from before it is history, not the cause')
    t.equal(bannedSinceProgress(40000, stalledForMs, now), true,
      'a ban at the moment progress stopped counts')
    t.end()
  })

test('a torrent that never banned anyone has no ban to blame',
  function (t) {
    t.equal(bannedSinceProgress(0, 60000, 100000), false, 'never banned')
    t.equal(bannedSinceProgress(undefined, 60000, 100000), false,
      'and neither has one with no tally at all')
    t.end()
  })

test('a torrent that is still moving has nothing to explain',
  function (t) {
    // stalledForMs 0 means it verified something this very tick.
    t.equal(bannedSinceProgress(99999, 0, 100000), false,
      'progress since the ban clears it')
    t.end()
  })
