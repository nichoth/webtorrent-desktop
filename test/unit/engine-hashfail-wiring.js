const test = require('tape')
const fs = require('fs')
const path = require('path')

// The banning policy lives in `hashfail.js` and is tested against plain
// values in `engine-hashfail.js`. What cannot be reached that way is the
// wiring in `index.js`: driving it for real needs a peer willing to
// serve corrupt data. So this is a source check, in the same shape as
// `engine-sweep-wiring.js` -- it asserts the parts are connected, not
// that they work.

const ENTRY_SRC = path.join(
  __dirname, '..', '..', 'src', 'engine', 'index.js')

const source = fs.readFileSync(ENTRY_SRC, 'utf8')

// Comments discuss all of this at length, so they are stripped first.
// Every assertion below asserts PRESENCE, which means an unstripped
// comment body reads as live code and passes -- so block comments are
// removed whole rather than line by line, for the reason spelled out in
// `engine-sweep-wiring.js`.
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !/^\s*\/\//.test(line))
  .join('\n')

test('the engine imports the hash-fail tracker', function (t) {
  t.ok(/import \{[^}]*createHashFailTracker[^}]*\} from '\.\/hashfail'/
    .test(code), 'createHashFailTracker comes from hashfail.js')
  // A local copy of the regex here would keep matching after a
  // WebTorrent upgrade reworded the message, so the parser has to be
  // the one the tests pin.
  t.ok(/import \{[^}]*parseFailedPiece[^}]*\} from '\.\/hashfail'/
    .test(code), 'and so does the warning parser')
  t.ok(/createHashFailTracker\(/.test(code), 'and the tracker is built')
  t.end()
})

test('block senders are recorded', function (t) {
  t.ok(/torrent\.on\('wire'/.test(code),
    'the engine subscribes to new wires')
  t.ok(/wire\.on\('piece'/.test(code),
    "and to each wire's piece event, which names the sender")
  t.ok(/recordContribution\(\s*index\s*,\s*wire\.remoteAddress\s*\)/
    .test(code), 'attributing the block to that peer')
  t.end()
})

test('a failed piece is charged to its contributors', function (t) {
  t.ok(/parseFailedPiece\(/.test(code),
    'verification failures are picked out of the warning channel')
  t.ok(/recordFailure\(\s*pieceIndex\s*\)/.test(code),
    'and charged to whoever fed that piece')
  t.end()
})

// Three parts, and the ban leaks without all three: `client.blocked`
// stops a banned peer being re-added through discovery, destroying its
// wires ends the connection it is already on, and the guard on the
// `wire` event catches everything else.
test('a banned peer is refused and disconnected', function (t) {
  t.ok(/client\.blocked = \{[^}]*isBanned\(host\)/.test(code),
    'client.blocked is a live view of the ban set')
  t.ok(/wire\.destroy\(\)/.test(code),
    'and live wires to banned peers are destroyed')
  t.end()
})

// The regression this exists for, measured rather than reasoned about:
// with the two checks above and no guard on the `wire` event, a
// localhost seeder serving one corrupt piece was banned and then
// straight back on the wire, and the leecher logged 123,173 failed
// verifications in 30 seconds -- against 3 with the guard in place.
//
// `client.blocked` is consulted by the public `addPeer` only.
// WebTorrent's own backoff reconnect in `conn.on('close')` calls the
// private `_addPeer`, and `_addIncomingPeer` takes incoming
// connections; neither looks at the blocklist. `Torrent#_onWire` is
// the one funnel all of them pass through.
test('a banned peer cannot get a wire by any other route', function (t) {
  const handler = /torrent\.on\('wire',[\s\S]*?\n {2}\}\)/.exec(code)
  t.ok(handler, 'the wire handler is found')

  const body = handler ? handler[0] : ''
  t.ok(/isBanned\(wire\.remoteAddress\)/.test(body),
    'the handler checks the ban before anything else')
  const guard = /isBanned\(wire\.remoteAddress\)\) return wire\.destroy\(\)/
  t.ok(guard.test(body),
    'and drops the wire instead of listening to it')

  // Order matters: recording blocks from a peer already banned would
  // let it keep earning strikes it can no longer be punished for, and
  // means the wire was live long enough to send them.
  const banAt = body.search(/isBanned\(wire\.remoteAddress\)/)
  const pieceAt = body.search(/wire\.on\('piece'/)
  t.ok(banAt >= 0 && pieceAt >= 0 && banAt < pieceAt,
    'the ban check comes before the piece subscription')
  t.end()
})

// The residue of the guard above. It stops the banned peer's data but
// not its reconnect: `wire.destroy()` closes the connection, WebTorrent
// re-adds the peer from `conn.on('close')` through the private
// `_addPeer`, and `Peer#onHandshake` has already reset `retries` to 0
// by the time our guard runs -- so the backoff never exhausts. The peer
// came back every second forever, paying for a handshake and a full
// bitfield each time, which is the download speed a stalled torrent was
// showing next to "corrupt peer blocked". `_addPeer` is the one funnel
// both the public `addPeer` and the reconnect pass through.
test('a banned peer cannot be re-added by the backoff reconnect',
  function (t) {
    t.ok(/import \{[^}]*guardPeerAdds[^}]*\} from '\.\/hashfail'/
      .test(code), 'the peer-add guard comes from hashfail.js')
    t.ok(/guardPeerAdds\(\s*torrent\s*,\s*hashFails\.isBanned\s*\)/
      .test(code), 'and is installed on every torrent')

    // Installed with the rest of the per-torrent wiring, so a torrent
    // cannot exist unguarded.
    const wiring = /function addTorrentEvents \(torrent\) \{[\s\S]*?\n\}/
      .exec(code)
    t.ok(wiring, 'addTorrentEvents is found')
    t.ok(wiring && /guardPeerAdds\(/.test(wiring[0]),
      'and the guard goes on with the event handlers')
    t.end()
  })

// The direction neither of the guards above covers. `_addPeer` is only
// reached by peers we add; a peer that dials us arrives through
// `conn-pool.js:_onConnection` and is handed straight to
// `_addIncomingPeer`, which consults no blocklist. The `wire` guard
// still cuts the connection, but `_registerPeer` has by then attached
// the `download`/`upload` listeners feeding `torrent.downloadSpeed`, so
// the banned peer's handshake was counted against the torrent -- and it
// could dial again immediately, for as long as it liked.
test('a banned peer cannot get in by dialling us', function (t) {
  t.ok(/import \{[^}]*guardIncomingPeers[^}]*\} from '\.\/hashfail'/
    .test(code), 'the incoming guard comes from hashfail.js')
  t.ok(/guardIncomingPeers\(\s*torrent\s*,\s*hashFails\.isBanned\s*\)/
    .test(code), 'and is installed on every torrent')

  const wiring = /function addTorrentEvents \(torrent\) \{[\s\S]*?\n\}/
    .exec(code)
  t.ok(wiring && /guardIncomingPeers\(/.test(wiring[0]),
    'alongside the outbound guard, so neither direction is left open')
  t.end()
})

test('warnings that are not verification failures still reach the bus',
  function (t) {
    // The handler grew a side effect; the passthrough it wrapped has to
    // survive it, or every tracker warning stops reaching the UI.
    t.ok(/bus\.send\('wt-warning', torrent\.key, err\.message\)/.test(code),
      'the torrent warning passthrough is intact')
    t.ok(/bus\.send\('wt-warning', null, err\.message\)/.test(code),
      'and so is the client-level one')
    t.end()
  })

test('the UI is told about corrupt peers', function (t) {
  t.ok(/hashFails: corrupt/.test(code),
    'wt-progress carries the failure count')
  t.ok(/bannedPeers: corrupt/.test(code),
    'and the running ban tally')
  t.ok(/corruptPeerStats\.delete\(infoHash\)/.test(code),
    'and the tally is dropped with the torrent')
  t.end()
})

// The tally above only ever goes up, so "this torrent has banned
// someone" stays true forever and cannot answer "is that why it is
// stuck now". The status line needs the second question, so the engine
// -- which owns the clock -- answers it.
test('the UI is told whether a ban explains the current stall',
  function (t) {
    t.ok(/import \{[^}]*bannedSinceProgress[^}]*\} from '\.\/hashfail'/
      .test(code), 'the comparison comes from hashfail.js')
    t.ok(/lastBanAt/.test(code), 'the engine records when it last banned')
    t.ok(/bannedSinceProgress: /.test(code),
      'and wt-progress carries the answer the status line reads')
    t.end()
  })

// The ETA and the stall label are only as honest as what they are fed,
// and they are not fed the same thing. The speed an estimate is built
// on has to be verified bytes: `torrent.downloaded` includes piece
// buffers that have not passed their hash, and dividing by that is the
// original bug in full. The stall cannot use verified bytes, because
// pieces land minutes apart on a slow torrent and it reported healthy
// downloads as stuck. `stall.js` takes both and says which is which.
test('progress is sampled in verified bytes and payload bytes',
  function (t) {
    t.ok(/import \{[^}]*createStallTracker[^}]*\} from '\.\/stall'/
      .test(code), 'the stall tracker comes from stall.js')
    t.ok(/import \{[^}]*verifiedBytes[^}]*\} from '\.\/stall'/.test(code),
      'and so does the verified-byte count')

    const call = /stalls\.sample\([\s\S]*?\}, now\)/.exec(code)
    t.ok(call, 'the tracker is sampled')
    const body = call ? call[0] : ''
    t.ok(/torrent\.infoHash/.test(body), 'per torrent')
    t.ok(/verified:\s*verifiedBytes\(torrent\)/.test(body),
      'the speed is measured in bytes that passed their hash')
    t.ok(/payload:\s*downloaded/.test(body),
      'and the stall in bytes held, which moves per block')

    t.ok(/stalls\.forget\(infoHash\)/.test(code),
      'and the history is dropped with the torrent')
    t.end()
  })

test('the UI is told the verified speed and the stall', function (t) {
  t.ok(/verifiedSpeed: Math\.round\(motion\.verifiedSpeed\)/.test(code),
    'wt-progress carries the speed the ETA is derived from')
  t.ok(/stalled: motion\.stalled/.test(code),
    'and whether the torrent has stopped verifying')
  // Sending the raw millisecond counter would change the payload on
  // every tick, defeating the diff above it and putting the whole
  // object on the bus once a second for every idle torrent.
  t.ok(!/stalledForMs:/.test(code),
    'but not the counter that changes every tick')
  t.end()
})
