const test = require('tape')
const fs = require('fs')
const path = require('path')

// The sweep's behaviour lives in `announce.js` and is tested against
// fakes in `engine-announce.js`. What cannot be reached that way is the
// wiring in `index.js`: an interval that fires once a minute is too
// slow to drive from a spawned sidecar, and a test-only override of the
// interval would be production code that exists for a test. So this is
// a source check, in the same shape as the scan in `engine-entry.js` --
// it asserts the parts are connected, not that they work.

const ENTRY_SRC = path.join(
  __dirname, '..', '..', 'src', 'engine', 'index.js')

const source = fs.readFileSync(ENTRY_SRC, 'utf8')

// Comments discuss the sweep at length, so they are not scanned.
const code = source.split('\n')
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n')

test('the engine imports the sweep', function (t) {
  t.ok(/import \{[^}]*runAnnounceSweep[^}]*\} from '\.\/announce'/
    .test(code), 'runAnnounceSweep is imported from announce.js')
  // Checking the identifier merely appears would be subsumed by the
  // setInterval assertion below. It has to come from `announce.js`: a
  // local copy in this file would keep the engine sweeping every 60
  // seconds no matter what the constant says, silently decoupling the
  // two, and nothing else in the suite pins the interval's value.
  t.ok(/import \{[^}]*SWEEP_INTERVAL_MS[^}]*\} from '\.\/announce'/
    .test(code), 'and so is the interval constant')
  t.end()
})

test('the sweep runs on its own interval', function (t) {
  t.ok(/setInterval\(\s*runSweep\s*,\s*SWEEP_INTERVAL_MS\s*\)/.test(code),
    'setInterval drives runSweep at SWEEP_INTERVAL_MS')
  t.ok(/runAnnounceSweep\(\{/.test(code),
    'and runSweep calls into announce.js')
  t.end()
})

test('the last-announced map is seeded and cleared', function (t) {
  t.ok(/const lastAnnounceAt = new Map\(\)/.test(code),
    'the map exists')
  // The key and the value are both pinned. Seeding under `torrent.key`
  // -- the identifier the adjacent `bus.send` uses, so a plausible
  // slip -- or seeding a 0 would leave every new torrent eligible on
  // the first sweep, which is the waste AC7.2 exists to prevent, and a
  // bare `.set(` check would not notice either.
  t.ok(/lastAnnounceAt\.set\(torrent\.infoHash, Date\.now\(\)\)/
    .test(code),
  'a new torrent seeds it, so it is not announced the moment it ' +
  'starts')
  t.ok(/lastAnnounceAt\.delete\(/.test(code),
    'and a stopped torrent is removed, so the map cannot grow ' +
    'without bound')
  t.end()
})
