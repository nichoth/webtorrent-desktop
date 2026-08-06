const test = require('tape')

// The discovery half of "destroy and re-add", on its own. Fakes stand
// in for the torrent and the DHT: what is under test is which calls go
// out and how missing pieces are tolerated, not the network.
const {
  announceNow, selectStalled, runAnnounceSweep, COOLDOWN_MS,
  MAX_PER_SWEEP
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

    t.equal(selected.length, MAX_PER_SWEEP, 'the cap holds')
    t.deepEqual(selected.map((x) => x.infoHash),
      torrents.slice(0, MAX_PER_SWEEP).map((x) => x.infoHash),
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

// -- runAnnounceSweep ------------------------------------------------

// A stalled torrent whose tracker records the call, so the sweep's
// effect is observable without a network.
function sweepable (infoHash, calls, overrides = {}) {
  return Object.assign(stalled(infoHash), {
    discovery: {
      tracker: { update () { calls.push(infoHash) } }
    }
  }, overrides)
}

function sweepDeps (torrents, overrides = {}) {
  return Object.assign({
    torrents,
    dht: false,
    lastAnnounceAt: new Map(),
    now: NOW,
    log: () => {}
  }, overrides)
}

test('runAnnounceSweep announces only the stalled torrents',
  function (t) {
    const calls = []
    const deps = sweepDeps([
      sweepable('a', calls),
      sweepable('b', calls, { numPeers: 2 }),
      sweepable('c', calls)
    ])

    const result = runAnnounceSweep(deps)

    t.deepEqual(calls, ['a', 'c'], 'the healthy one was left alone')
    t.deepEqual(result.announced, ['a', 'c'])
    t.end()
  })

test('runAnnounceSweep records the attempt so the cooldown holds',
  function (t) {
    const calls = []
    const lastAnnounceAt = new Map()
    const torrents = [sweepable('a', calls)]

    runAnnounceSweep(sweepDeps(torrents, { lastAnnounceAt }))
    t.equal(lastAnnounceAt.get('a'), NOW, 'the attempt was recorded')

    // A sweep one minute later must not announce it again.
    runAnnounceSweep(
      sweepDeps(torrents, { lastAnnounceAt, now: NOW + 60 * 1000 }))
    t.deepEqual(calls, ['a'], 'still one announce')

    // Past the cooldown it is eligible again.
    runAnnounceSweep(sweepDeps(torrents, {
      lastAnnounceAt, now: NOW + COOLDOWN_MS + 1
    }))
    t.deepEqual(calls, ['a', 'a'], 'and now it announces again')
    t.end()
  })

test('runAnnounceSweep is silent when nothing is stalled',
  function (t) {
    const calls = []
    const logged = []
    const deps = sweepDeps([sweepable('a', calls, { numPeers: 1 })],
      { log: (...args) => logged.push(args) })

    const result = runAnnounceSweep(deps)

    t.deepEqual(calls, [], 'nothing announced')
    t.deepEqual(logged, [], 'and nothing logged')
    t.deepEqual(result, { announced: [], deferred: 0 })
    t.end()
  })

test('runAnnounceSweep says so when the cap holds work back',
  function (t) {
    const calls = []
    const logged = []
    const torrents = []
    for (let i = 0; i < MAX_PER_SWEEP + 2; i++) {
      torrents.push(sweepable('t' + i, calls))
    }

    const result = runAnnounceSweep(
      sweepDeps(torrents, { log: (...args) => logged.push(args) }))

    t.equal(result.announced.length, MAX_PER_SWEEP)
    t.equal(result.deferred, 2)
    t.equal(logged.length, 1, 'one line per sweep')
    t.ok(logged[0].includes(2),
      'and the deferred count is in it, not silently dropped')
    t.end()
  })

test('runAnnounceSweep survives one torrent throwing', function (t) {
  const calls = []
  const logged = []
  const lastAnnounceAt = new Map()
  const bad = sweepable('bad', calls, {
    discovery: {
      tracker: {
        update () { throw new Error('tracker is wedged') }
      }
    }
  })

  const result = runAnnounceSweep(sweepDeps(
    [bad, sweepable('good', calls)],
    { lastAnnounceAt, log: (...args) => logged.push(args) }))

  t.deepEqual(calls, ['good'], 'the rest of the sweep still ran')
  t.deepEqual(result.announced, ['good'], 'and the failure is not counted')
  t.ok(logged.some((args) => args.includes('bad')),
    'the failure names the torrent')
  t.equal(lastAnnounceAt.get('bad'), NOW,
    'and the wedged one still waits out its cooldown, rather than ' +
    'being retried every sweep')
  t.end()
})

test('runAnnounceSweep calls DHT lookup for each announced torrent',
  function (t) {
    const trackerCalls = []
    const dhtCalls = []
    const deps = sweepDeps([
      sweepable('a', trackerCalls),
      sweepable('b', trackerCalls)
    ], { dht: fakeDht(dhtCalls) })

    runAnnounceSweep(deps)

    t.deepEqual(dhtCalls, [
      ['dht.lookup', 'a'],
      ['dht.lookup', 'b']
    ], 'DHT lookup was called for each stalled torrent')
    t.end()
  })

test('runAnnounceSweep respects the max override',
  function (t) {
    const calls = []
    const torrents = []
    for (let i = 0; i < 3; i++) {
      torrents.push(sweepable('t' + i, calls))
    }

    const result = runAnnounceSweep(
      sweepDeps(torrents, { max: 1 }))

    t.equal(result.announced.length, 1, 'max: 1 caps the sweep')
    t.equal(result.deferred, 2,
      'deferred count reflects torrents held back by cap')
    t.end()
  })
