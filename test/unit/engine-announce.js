const test = require('tape')

// The discovery half of "destroy and re-add", on its own. Fakes stand
// in for the torrent and the DHT: what is under test is which calls go
// out and how missing pieces are tolerated, not the network.
const { announceNow } = require('../../build/engine/announce')

const INFO_HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function fakeTorrent (calls, overrides = {}) {
  return Object.assign({
    infoHash: INFO_HASH,
    discovery: {
      tracker: {
        update () { calls.push(['tracker.update']) }
      }
    }
  }, overrides)
}

function fakeDht (calls) {
  return {
    lookup (hash) { calls.push(['dht.lookup', hash]) }
  }
}

test('announceNow updates the trackers and looks up the DHT',
  function (t) {
    const calls = []
    const result = announceNow(fakeTorrent(calls), fakeDht(calls))

    t.deepEqual(calls, [
      ['tracker.update'],
      ['dht.lookup', INFO_HASH]
    ], 'both halves fired, and the lookup names this torrent')
    t.deepEqual(result, { tracker: true, dht: true },
      'and the result says so')
    t.end()
  })

test('announceNow tolerates a torrent with no discovery yet',
  function (t) {
    const calls = []
    const torrent = fakeTorrent(calls, { discovery: null })
    const result = announceNow(torrent, fakeDht(calls))

    t.deepEqual(calls, [['dht.lookup', INFO_HASH]],
      'the DHT half still fires')
    t.deepEqual(result, { tracker: false, dht: true })
    t.end()
  })

test('announceNow tolerates discovery with trackers disabled',
  function (t) {
    const calls = []
    const torrent = fakeTorrent(calls, { discovery: { tracker: null } })
    const result = announceNow(torrent, fakeDht(calls))

    t.deepEqual(calls, [['dht.lookup', INFO_HASH]])
    t.deepEqual(result, { tracker: false, dht: true })
    t.end()
  })

test('announceNow tolerates a client with no DHT', function (t) {
  const calls = []
  const result = announceNow(fakeTorrent(calls), false)

  t.deepEqual(calls, [['tracker.update']], 'the tracker half still fires')
  t.deepEqual(result, { tracker: true, dht: false },
    'the tracker half ran and the DHT half did not')
  t.end()
})

test('announceNow does nothing at all for a missing torrent',
  function (t) {
    const calls = []
    const result = announceNow(null, fakeDht(calls))

    t.deepEqual(calls, [], 'no call went out')
    t.deepEqual(result, { tracker: false, dht: false })
    t.end()
  })
