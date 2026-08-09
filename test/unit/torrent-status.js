const test = require('tape')

const {
  stallReason, etaSpeed
} = require('../../build/renderer/lib/torrent-status')

// One torrent's entry in a progress payload, cut down to the fields
// these two read.
function prog (overrides = {}) {
  return Object.assign({
    progress: 0.998,
    numPeers: 1,
    downloadSpeed: 63,
    verifiedSpeed: 0,
    stalled: false,
    bannedPeers: 0,
    hashFails: 0
  }, overrides)
}

test('a moving torrent has no stall reason', function (t) {
  t.equal(stallReason(prog({ verifiedSpeed: 500000 })), null,
    'data is landing')
  t.end()
})

test('a stalled torrent with no bans ran out of sources', function (t) {
  t.equal(stallReason(prog({ stalled: true })), 'no-progress',
    'nothing is arriving and nobody was caught cheating')
  t.end()
})

test('a stalled torrent with bans names the corrupt peers', function (t) {
  t.equal(stallReason(prog({ stalled: true, bannedPeers: 1 })),
    'corrupt-peers', 'the more specific explanation wins')
  t.end()
})

// Seeding is not stalling. A complete torrent verifies nothing further
// by definition, so the engine's silence timer would otherwise mark
// every finished download as stuck.
test('a complete torrent is never stalled', function (t) {
  t.equal(stallReason(prog({ stalled: true, progress: 1 })), null,
    'it has everything it came for')
  t.equal(stallReason(prog({ stalled: true, progress: 1, bannedPeers: 2 })),
    null, 'even if it banned peers on the way')
  t.end()
})

test('a missing payload has no stall reason', function (t) {
  t.equal(stallReason(null), null, 'nothing to report')
  t.equal(stallReason(undefined), null, 'still nothing')
  t.equal(stallReason({}), null, 'and an empty one is not a stall')
  t.end()
})

// The bug in one assertion: 63 B/s of keepalives and `have` messages
// against 3 MB missing is the "12 h 25 min remaining" the UI showed
// while receiving nothing usable.
test('the ETA ignores socket chatter and uses verified speed',
  function (t) {
    t.equal(etaSpeed(prog({ downloadSpeed: 63, verifiedSpeed: 0 })), 0,
      'chatter is not grounds for an estimate')
    t.equal(etaSpeed(prog({ downloadSpeed: 900, verifiedSpeed: 500 })), 500,
      'and the estimate follows what actually verified')
    t.end()
  })

// The renderer is older or newer than the engine during an upgrade, and
// another implementation of the protocol may not report this at all.
// Hiding every ETA in that case would be a worse regression than the
// bug being fixed.
test('the ETA falls back when verified speed is not reported',
  function (t) {
    t.equal(etaSpeed({ downloadSpeed: 4096 }), 4096,
      'an engine that does not send it keeps the old behaviour')
    t.equal(etaSpeed({}), 0, 'and a payload with neither yields nothing')
    t.equal(etaSpeed(null), 0, 'as does no payload at all')
    t.end()
  })
