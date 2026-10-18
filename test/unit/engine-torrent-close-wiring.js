const test = require('tape')
const fs = require('fs')
const path = require('path')

// The engine keeps per-torrent diagnostic state -- announce times,
// corrupt-peer tallies, stall samples -- keyed by info hash. A torrent
// can close without `wt-stop-torrenting` (a fatal error, say), and
// state left behind under its info hash greets the torrent when the
// user resumes it: the stall clock is still running from the old
// session, so it reports as stalled on its first progress update.
//
// That outcome is pinned against plain values by "a forgotten torrent
// starts over" in `engine-stall.js`. What this checks is the wiring:
// the forgetting hangs off the torrent's own `close`, which WebTorrent
// emits from `destroy()` whatever the reason, so no close path can skip
// it. Driving a real stall from a spawned sidecar would take a minute
// per case, so this is a source scan in the shape of
// `engine-sweep-wiring.js`.

const ENTRY_SRC = path.join(
  __dirname, '..', '..', 'src', 'engine', 'index.js')

const source = fs.readFileSync(ENTRY_SRC, 'utf8')

// Every assertion below asserts PRESENCE, so comments are stripped
// whole first, for the reason spelled out in `engine-sweep-wiring.js`.
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !/^\s*\/\//.test(line))
  .join('\n')

const wiring = /function addTorrentEvents \(torrent\) \{[\s\S]*?\n\}/
  .exec(code)
const events = wiring ? wiring[0] : ''

test('a closing torrent is handled where its events are wired',
  function (t) {
    t.ok(wiring, 'addTorrentEvents is found')
    t.ok(/torrent\.once?\('close',\s*torrentClose\)/.test(events),
      'the torrent\'s own close event has a handler')
    t.equal((code.match(/\.once?\('close',\s*torrentClose\)/g) || [])
      .length, 1, 'and there is exactly one, so cleanup has one home')
    t.end()
  })

test('the close handler forgets every kind of per-torrent state',
  function (t) {
    const handler = /function torrentClose \(\) \{[\s\S]*?\n {2}\}/
      .exec(events)
    t.ok(handler, 'torrentClose is found inside addTorrentEvents')
    const body = handler ? handler[0] : ''

    t.ok(/const infoHash = torrent\.infoHash/.test(body),
      'it reads the closing torrent\'s own info hash')
    t.ok(/lastAnnounceAt\.delete\(infoHash\)/.test(body),
      'the announce time is forgotten')
    t.ok(/corruptPeerStats\.delete\(infoHash\)/.test(body),
      'the corrupt-peer tally is forgotten')
    t.ok(/stalls\.forget\(infoHash\)/.test(body),
      'and the stall samples are forgotten, so a resumed torrent ' +
      'starts with a clean stall clock')

    // WebTorrent destroys a duplicate add after giving it the live
    // torrent's info hash, and removes a closing torrent from the
    // client before emitting `close`. So a torrent still found under
    // the hash at close time is someone else's, and its state stays.
    const guardAt = body.search(/if \(client\.get\(infoHash\)\) return/)
    const forgetAt = body.search(/lastAnnounceAt\.delete/)
    t.ok(guardAt >= 0 && guardAt < forgetAt,
      'a duplicate closing does not wipe the live torrent\'s state')
    t.end()
  })

test('stop-torrenting relies on the close handler', function (t) {
  const stop = /function stopTorrenting \(infoHash\) \{[\s\S]*?\n\}/
    .exec(code)
  t.ok(stop, 'stopTorrenting is found')
  const body = stop ? stop[0] : ''
  t.ok(/torrent\.destroy\(\)/.test(body),
    'it destroys the torrent, which emits close')
  t.notOk(/lastAnnounceAt\.delete|corruptPeerStats\.delete|stalls\.forget/
    .test(body), 'and does not keep a second copy of the cleanup')
  t.end()
})

// A torrent can close holding a streaming server nobody released --
// stop-torrenting is not required to follow stop-server, and a fatal
// error follows nothing. If the entry outlived the torrent, a resumed
// torrent under the same info hash would be handed the old entry's URL,
// whose port is closed. `engine-entry.js` proves the outcome on the
// real sidecar for stop-torrenting; this pins that the forgetting hangs
// off `close`, so the fatal-error path is covered too.
test('the close handler forgets the torrent\'s server entry',
  function (t) {
    const handler = /function torrentClose \(\) \{[\s\S]*?\n {2}\}/
      .exec(events)
    const body = handler ? handler[0] : ''
    const forgetAt = body.search(/forgetServer\(infoHash\)/)
    t.ok(forgetAt >= 0, 'torrentClose forgets the server entry')
    const guardAt = body.search(/if \(client\.get\(infoHash\)\) return/)
    t.ok(guardAt >= 0 && guardAt < forgetAt,
      'after the duplicate guard, so a duplicate add closing leaves ' +
      'the live torrent\'s server alone')

    const forget = /function forgetServer \(infoHash\) \{[\s\S]*?\n\}/
      .exec(code)
    t.ok(forget, 'forgetServer is found')
    const forgetBody = forget ? forget[0] : ''
    t.ok(/servers\.delete\(infoHash\)/.test(forgetBody),
      'forgetting deletes the entry')
    t.ok(/destroyServer\(/.test(forgetBody),
      'and destroys its server, if it has one')
    t.end()
  })
