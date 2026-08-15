const test = require('tape')
const fs = require('fs')
const path = require('path')

// The dial limit's behaviour lives in `dials.js` and is tested against
// plain objects in `engine-dials.js`. What cannot be reached that way
// is the wiring in `index.js`: driving it for real needs a swarm full
// of addresses that do not answer. So this is a source check, in the
// same shape as `engine-sweep-wiring.js` -- it asserts the parts are
// connected, not that they work.

const ENTRY_SRC = path.join(
  __dirname, '..', '..', 'src', 'engine', 'index.js')

const source = fs.readFileSync(ENTRY_SRC, 'utf8')

// Every assertion below asserts PRESENCE, which means an unstripped
// comment body reads as live code and passes -- so block comments are
// removed whole rather than line by line, for the reason spelled out
// in `engine-sweep-wiring.js`.
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !/^\s*\/\//.test(line))
  .join('\n')

// `client.maxConns` is checked in `Torrent#_drain` against `_numConns`,
// which counts only peers whose socket is already up. A dial waiting on
// its SYN is invisible to it, and every `_addPeer` ends in a `_drain`,
// so peers arriving from the tracker, the DHT and PEX each opened
// another socket with nothing holding the gate.
test('the engine bounds how many connections a torrent opens at once',
  function (t) {
    t.ok(/import \{[^}]*limitPendingDials[^}]*\} from '\.\/dials'/
      .test(code), 'the dial limit comes from dials.js')
    t.ok(/limitPendingDials\(\s*torrent\s*\)/.test(code),
      'and is installed on every torrent')
    t.end()
  })

// Installed with the rest of the per-torrent wiring, so a torrent
// cannot exist unbounded.
test('the limit goes on with the other per-torrent guards',
  function (t) {
    const wiring = /function addTorrentEvents \(torrent\) \{[\s\S]*?\n\}/
      .exec(code)
    t.ok(wiring, 'addTorrentEvents is found')
    t.ok(wiring && /limitPendingDials\(/.test(wiring[0]),
      'the limit is part of it')
    t.end()
  })
