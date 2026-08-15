const test = require('tape')

// The half-open connection limit WebTorrent 1.9.7 does not have.
// Everything here runs against plain objects shaped like the parts of a
// torrent the limiter reads -- `_peers` and `_drain` -- because that is
// all it touches. The wiring into `index.js` is checked separately in
// `engine-dials-wiring.js`.
const {
  pendingDials, limitPendingDials, MAX_PENDING_DIALS
} = require('../../build/engine/dials')

// A peer in each of the states the limiter has to tell apart. `conn` is
// assigned in `_drain` when the socket is opened and `connected` in
// `Peer#onConnect` when it comes up, so only the pair means "dialling".
const queued = () => ({ conn: null, connected: false })
const dialling = () => ({ conn: {}, connected: false })
const up = () => ({ conn: {}, connected: true })

function fakeTorrent (peers = {}, onDrain = () => {}) {
  return {
    _peers: peers,
    drains: 0,
    _drain () {
      this.drains += 1
      onDrain(this)
    }
  }
}

test('only dials in flight are counted', function (t) {
  const torrent = fakeTorrent({
    a: dialling(),
    b: dialling(),
    c: up(),
    d: queued()
  })

  t.equal(pendingDials(torrent), 2,
    'a peer that is up is not pending, and one not yet dialled has ' +
    'no socket to be pending on')
  t.end()
})

// Incoming and web-seed peers are built around a socket that is already
// open and are marked connected before `_addIncomingPeer` is even
// called, so they must not eat into the dial budget.
test('an established peer never counts as a dial', function (t) {
  const torrent = fakeTorrent({ a: up(), b: up(), c: up() })
  t.equal(pendingDials(torrent), 0, 'nothing is in flight')
  t.end()
})

test('a torrent with no peers yet is not pending on anything',
  function (t) {
    t.equal(pendingDials(fakeTorrent()), 0, 'an empty peer set')
    t.equal(pendingDials({}), 0, 'and one that does not exist')
    t.end()
  })

// The bug: `_drain` gates on `_numConns`, which counts `connected`
// peers only, so a socket waiting on its SYN is invisible to the cap.
// Every `_addPeer` ends in a `_drain`, so peers arriving from the
// tracker, the DHT and PEX each started another connection with nothing
// holding the gate -- 53 simultaneous half-open sockets to one host,
// against a nominal cap of 55 for the whole torrent.
test('a torrent at the dial limit opens no more connections',
  function (t) {
    const peers = {}
    for (let i = 0; i < 3; i++) peers['d' + i] = dialling()
    const torrent = fakeTorrent(peers)

    limitPendingDials(torrent, 3)
    torrent._drain()

    t.equal(torrent.drains, 0, 'the real _drain is not reached')
    t.end()
  })

test('a torrent below the limit dials as it always did', function (t) {
  const torrent = fakeTorrent({ a: dialling(), b: up() })

  limitPendingDials(torrent, 3)
  torrent._drain()
  torrent._drain()

  t.equal(torrent.drains, 2, 'both passed through')
  t.end()
})

// Holding `_drain` is not refusing the peer: it stays on the queue, and
// the next `_drain` takes it. A dial that fails or times out destroys
// its peer, and `removePeer` calls `_drain` on the way out -- so the
// queue keeps moving at the rate connections resolve, with nothing else
// having to run.
test('the queue moves again as dials resolve', function (t) {
  const peers = { a: dialling(), b: dialling() }
  const torrent = fakeTorrent(peers)
  limitPendingDials(torrent, 2)

  torrent._drain()
  t.equal(torrent.drains, 0, 'held while both dials are in flight')

  // One comes up, one times out and is removed.
  peers.a.connected = true
  delete peers.b

  torrent._drain()
  t.equal(torrent.drains, 1,
    'and dials again once a slot frees, without being reset')
  t.end()
})

// The limit is read on every call, not captured when it is installed:
// the peer set it counts is the live one.
test('the limit follows the torrent as its peers change', function (t) {
  const peers = {}
  const torrent = fakeTorrent(peers)
  limitPendingDials(torrent, 1)

  torrent._drain()
  t.equal(torrent.drains, 1, 'nothing in flight, so it drains')

  peers.a = dialling()
  torrent._drain()
  t.equal(torrent.drains, 1, 'and holds once a dial is out')
  t.end()
})

test('the default limit is the shipped policy', function (t) {
  t.equal(MAX_PENDING_DIALS, 10, 'ten dials in flight per torrent')

  const peers = {}
  for (let i = 0; i < MAX_PENDING_DIALS; i++) peers['d' + i] = dialling()
  const torrent = fakeTorrent(peers)
  limitPendingDials(torrent)
  torrent._drain()

  t.equal(torrent.drains, 0, 'and it is what an uncustomised call uses')
  t.end()
})

// `_drain` returns nothing, but wrapping a method must not change what
// callers see either way.
test('the real return value is passed through', function (t) {
  const torrent = {
    _peers: {},
    _drain: () => 'drained'
  }
  limitPendingDials(torrent, 1)
  t.equal(torrent._drain(), 'drained', 'the caller gets the real answer')
  t.end()
})
