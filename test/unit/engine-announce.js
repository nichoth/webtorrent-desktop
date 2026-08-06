const test = require('tape')

// The discovery half of "destroy and re-add", on its own. Fakes stand
// in for the torrent and the DHT: what is under test is which calls go
// out and how missing pieces are tolerated, not the network.
const {
  announceNow, selectStalled, COOLDOWN_MS, MAX_PER_SWEEP
} = require('../../build/engine/announce')

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

// -- selectStalled ---------------------------------------------------

// A torrent as the sweep sees it. Only four properties are read.
function stalled (infoHash, overrides = {}) {
  return Object.assign({
    infoHash, numPeers: 0, done: false, paused: false
  }, overrides)
}

const NOW = 1000000

test('selectStalled picks torrents with no peers', function (t) {
  const a = stalled('a')
  const b = stalled('b', { numPeers: 1 })
  const c = stalled('c')

  const { selected, deferred } =
    selectStalled([a, b, c], NOW, new Map())

  t.deepEqual(selected.map((x) => x.infoHash), ['a', 'c'],
    'the one with peers is left alone')
  t.equal(deferred, 0)
  t.end()
})

test('selectStalled skips finished and paused torrents',
  function (t) {
    const torrents = [
      stalled('done', { done: true }),
      stalled('paused', { paused: true }),
      stalled('live')
    ]

    const { selected } = selectStalled(torrents, NOW, new Map())

    t.deepEqual(selected.map((x) => x.infoHash), ['live'])
    t.end()
  })

test('selectStalled skips a torrent inside its cooldown', function (t) {
  const last = new Map([
    ['recent', NOW - 60 * 1000],
    ['old', NOW - COOLDOWN_MS - 1]
  ])

  const { selected } = selectStalled(
    [stalled('recent'), stalled('old')], NOW, last)

  t.deepEqual(selected.map((x) => x.infoHash), ['old'],
    'only the one past its cooldown')
  t.end()
})

test('selectStalled treats an unseen torrent as eligible',
  function (t) {
    const { selected } = selectStalled(
      [stalled('unseen')], NOW, new Map())

    t.deepEqual(selected.map((x) => x.infoHash), ['unseen'])
    t.end()
  })

test('selectStalled caps a sweep and reports what it deferred',
  function (t) {
    const torrents = []
    for (let i = 0; i < MAX_PER_SWEEP + 3; i++) {
      torrents.push(stalled('t' + i))
    }

    const { selected, deferred } =
      selectStalled(torrents, NOW, new Map())

    t.deepEqual(selected.map((x) => x.infoHash),
      ['t0', 't1', 't2', 't3', 't4'],
      'ties keep list order, so the cap serves the head first')
    t.equal(deferred, 3, 'and the remainder is counted, not dropped')
    t.end()
  })

test('selectStalled serves the least recently announced first',
  function (t) {
    const last = new Map([
      ['newest', NOW - COOLDOWN_MS - 1],
      ['oldest', NOW - COOLDOWN_MS - 5000],
      ['middle', NOW - COOLDOWN_MS - 3000]
    ])
    const torrents = [
      stalled('newest'), stalled('oldest'), stalled('middle')
    ]

    const { selected } =
      selectStalled(torrents, NOW, last, { max: 2 })

    t.deepEqual(selected.map((x) => x.infoHash), ['oldest', 'middle'],
      'a list longer than the cap is served round robin')
    t.end()
  })

test('selectStalled ignores a torrent with no info hash yet',
  function (t) {
    const { selected } = selectStalled(
      [stalled(undefined), stalled('ok')], NOW, new Map())

    t.deepEqual(selected.map((x) => x.infoHash), ['ok'])
    t.end()
  })
