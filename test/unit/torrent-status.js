const test = require('tape')

const {
  stallReason, etaSpeed, displayDownloadSpeed
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
    bannedSinceProgress: false,
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
  t.equal(stallReason(prog({ stalled: true, bannedSinceProgress: true })),
    'corrupt-peers', 'the more specific explanation wins')
  t.end()
})

// `bannedPeers` counts every ban this torrent ever made and never goes
// down, so reading it here labelled every later stall "corrupt peer
// blocked" -- including the ordinary one where the swarm simply has no
// seeder for the last few pieces, long after the bad peer was gone.
test('a ban the torrent has since recovered from is not the reason',
  function (t) {
    t.equal(
      stallReason(prog({
        stalled: true, bannedPeers: 4, bannedSinceProgress: false
      })),
      'no-progress',
      'the torrent verified data after the ban, so the ban is history')
    t.end()
  })

// The engine owns the clock, so it is the one that can compare the ban
// to the stall. A payload without the answer degrades to the vaguer
// message rather than to a confident wrong one.
test('a payload that does not answer the question blames nobody',
  function (t) {
    t.equal(stallReason({ stalled: true, progress: 0.99, bannedPeers: 2 }),
      'no-progress', 'no answer is not a yes')
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

// The report this exists for: "Stalled -- corrupt peer blocked" on one
// line and a download speed on the next, which reads as the app still
// pulling from the peer it just said it had blocked. Measured over two
// minutes, that torrent reported 189 B/s and gained zero bytes -- the
// figure was handshakes and keepalives from two peers with nothing to
// offer.
test('a stalled torrent shows no download speed', function (t) {
  t.equal(displayDownloadSpeed(prog({
    stalled: true, bannedSinceProgress: true, downloadSpeed: 189
  })), 0, 'socket chatter does not contradict the stall label')
  t.equal(displayDownloadSpeed(prog({
    stalled: true, downloadSpeed: 63
  })), 0, 'and the same holds when no ban explains the stall')
  t.end()
})

// The regression the obvious fix would have caused. `verifiedSpeed` is
// the honest rate but reads zero through most of a slow download, so
// using it here would blank the speed on torrents that are fine. Only
// the stall suppresses the figure; nothing else does.
test('a moving torrent still shows its download speed', function (t) {
  t.equal(displayDownloadSpeed(prog({ downloadSpeed: 5529 })), 5529,
    'a torrent that is not stalled reports as it always did')
  const lumpy = prog({ downloadSpeed: 60, verifiedSpeed: 0 })
  t.equal(displayDownloadSpeed(lumpy), 60,
    'including one whose pieces verify in lumps too far apart for ' +
    'the verified-speed window to register')
  t.end()
})

// Seeding is not stalling, and a paused or empty payload has no figure
// to show rather than a wrong one.
test('completeness and missing payloads are handled', function (t) {
  t.equal(displayDownloadSpeed(prog({
    stalled: true, progress: 1, downloadSpeed: 400
  })), 400, 'a complete torrent is never stalled, so it is unaffected')
  t.equal(displayDownloadSpeed(null), 0, 'no payload, no speed')
  t.equal(displayDownloadSpeed({}), 0, 'and neither has an empty one')
  t.end()
})
