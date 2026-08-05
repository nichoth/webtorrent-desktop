# Stalled Torrent Announce Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Have the engine notice torrents sitting at zero peers and ask
them to re-announce, so a stalled download recovers in about a minute
instead of waiting out a 30 minute tracker interval.

**Architecture:** The selection rule and the sweep body are pure
functions in `src/engine/announce.js`, taking the torrent list, the DHT,
a last-announced map and a clock as arguments. `src/engine/index.js`
owns only a `setInterval`, the map, and the map's lifecycle. That split
is what makes the guards -- cooldown, cap, eligibility -- testable
without a network or a spawned sidecar.

**Tech Stack:** Node sidecar (`src/engine/`), `webtorrent` 1.9.7,
`tape` unit tests against Babel output under `build/`.

## Prerequisite

**This plan depends on `2026-08-05-force-announce-diagnostic.md` having
been implemented and, more importantly, on its Task 5 having produced
outcome 2: peers rising above zero within 30 seconds of a forced
announce, on most torrents tried.**

If Task 5 produced any other outcome, re-announcing is not the fix and
this plan is the wrong work. Stop and say so.

`announceNow(torrent, dht)` from that plan is reused unchanged here.

## What the guards are for

A sweep that re-announces indiscriminately every minute is worse than
the bug. Trackers publish a `min interval` and rate limit or ban clients
that ignore it, and `bittorrent-tracker` fans every announce out to
every tracker in the list. So:

- **Only torrents that need it.** Zero peers, not done, not paused.
  A torrent with even one peer is making progress through channels the
  sweep cannot improve on.
- **A per-torrent cooldown of 5 minutes.** Comfortably above any
  tracker's `min interval`, and far below the 30 minute natural
  cadence, which is the gap this closes.
- **At most 5 torrents per sweep.** A 40-torrent list must not announce
  40 times in one tick.
- **Oldest first.** A list longer than the cap is served round robin
  rather than the same 5 every minute.
- **The cap is logged when it bites.** A silent truncation reads as
  "nothing else needed it".

## Global Constraints

- Style is `standard` (no semicolons, 2-space indent, space before
  function parens). `npm run lint` must pass.
- Keep lines under 80 columns to match the surrounding code.
- No em dashes in comments or docs. Use `--`. No `->` arrow character;
  use the ASCII `->`.
- `src/engine/index.js` is scanned by
  `test/unit/engine-entry.js:115`. That scan fails on any `window.` /
  `document.` / `navigator.` reference, any `.send(` that is not
  `bus.send(`, and any `.on('wt-` subscription that is not `bus.on(`.
- Unit tests are CommonJS and require the Babel output under `build/`.
  `npm run test-unit` runs `npm run build` first.
- The sweep must never throw out of its interval callback. The engine is
  a long-lived process and one wedged tracker client must not end the
  session or stop the other torrents from being served.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/engine/announce.js` | Gains `selectStalled` (who to announce) and `runAnnounceSweep` (do it, record it, log it). Still knows nothing about the bus or the client. |
| `test/unit/engine-announce.js` | Gains tests for both, with fake torrents and an injected clock. |
| `src/engine/index.js` | The interval, the `lastAnnounceAt` map, and the map's lifecycle. |
| `test/unit/engine-sweep-wiring.js` (new) | Source-level check that the sweep is actually wired in and the map is seeded and cleared. |
| `src/engine/AGENTS.md` | Engine-directory notes. |

---

### Task 1: The selection rule

**Files:**
- Modify: `src/engine/announce.js`
- Test: `test/unit/engine-announce.js`

**Interfaces:**
- Consumes: `announceNow(torrent, dht)`, already in `announce.js`.
- Produces:
  - `SWEEP_INTERVAL_MS`, `COOLDOWN_MS`, `MAX_PER_SWEEP` -- exported
    number constants.
  - `selectStalled(torrents, now, lastAnnounceAt, opts)` returning
    `{ selected: object[], deferred: number }`. `torrents` is an array
    of WebTorrent torrents (only `infoHash`, `numPeers`, `done` and
    `paused` are read); `now` is a millisecond timestamp;
    `lastAnnounceAt` is a `Map` of info hash to timestamp; `opts` may
    carry `cooldownMs` and `max`. Task 2 calls this.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/engine-announce.js`. Add `selectStalled` and the
constants to the existing require at the top of the file:

```js
const {
  announceNow, selectStalled, COOLDOWN_MS, MAX_PER_SWEEP
} = require('../../build/engine/announce')
```

Then append:

```js
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
  const b = stalled('b', { numPeers: 3 })
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build:node && npx tape test/unit/engine-announce.js`
Expected: FAIL, `selectStalled is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/engine/announce.js`:

```js
// How often the engine looks for stalled torrents. Short, because the
// check itself is a filter over an in-memory array; the cooldown below
// is what keeps the announces themselves rare.
export const SWEEP_INTERVAL_MS = 60 * 1000

// The floor between two forced announces of the same torrent.
// Comfortably above any tracker's `min interval`, and far below the 30
// minute natural cadence this exists to close.
export const COOLDOWN_MS = 5 * 60 * 1000

// A 40-torrent list must not announce 40 times in one tick. Anything
// over the cap waits for the next sweep, oldest first.
export const MAX_PER_SWEEP = 5

function lastOf (lastAnnounceAt, infoHash) {
  const last = lastAnnounceAt.get(infoHash)
  return last == null ? 0 : last
}

/**
 * Which torrents should be asked to re-announce right now.
 *
 * A torrent qualifies when it has no peers at all, is not finished and
 * is not paused. One peer is enough to disqualify it: the sweep exists
 * for torrents that have nobody to talk to, and a torrent that is
 * talking to somebody is making progress the sweep cannot improve on.
 *
 * @param {object[]} torrents The client's torrents.
 * @param {number} now Milliseconds, injected so this stays testable.
 * @param {Map<string, number>} lastAnnounceAt Info hash -> when the
 *   sweep last asked. A missing entry means never.
 * @param {object} [opts]
 * @param {number} [opts.cooldownMs]
 * @param {number} [opts.max]
 * @returns {{ selected: object[], deferred: number }} `deferred` is how
 *   many eligible torrents the cap held back, for logging.
 */
export function selectStalled (torrents, now, lastAnnounceAt, opts = {}) {
  const cooldownMs =
    opts.cooldownMs == null ? COOLDOWN_MS : opts.cooldownMs
  const max = opts.max == null ? MAX_PER_SWEEP : opts.max

  const eligible = torrents.filter((torrent) =>
    torrent &&
    torrent.infoHash &&
    torrent.numPeers === 0 &&
    !torrent.done &&
    !torrent.paused &&
    now - lastOf(lastAnnounceAt, torrent.infoHash) >= cooldownMs)

  // Least recently announced first, so a list longer than the cap is
  // served round robin instead of the same head every sweep. A torrent
  // never announced sorts to the front.
  eligible.sort((a, b) =>
    lastOf(lastAnnounceAt, a.infoHash) - lastOf(lastAnnounceAt, b.infoHash))

  return {
    selected: eligible.slice(0, max),
    deferred: Math.max(0, eligible.length - max)
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build:node && npx tape test/unit/engine-announce.js`
Expected: PASS, including the five `announceNow` tests from the
previous plan.

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/engine/announce.js test/unit/engine-announce.js
git commit -m "feat(engine): add selectStalled, the announce sweep's guards"
```

---

### Task 2: The sweep body

**Files:**
- Modify: `src/engine/announce.js`
- Test: `test/unit/engine-announce.js`

**Interfaces:**
- Consumes: `announceNow` and `selectStalled` from `announce.js`.
- Produces: `runAnnounceSweep(deps)` where `deps` is
  `{ torrents, dht, lastAnnounceAt, now, log, cooldownMs?, max? }` and
  `log` is a `console.log`-shaped `(format, ...args) => void`. Returns
  `{ announced: string[], deferred: number }`. It mutates
  `lastAnnounceAt`. Task 3 calls this from an interval.

- [ ] **Step 1: Write the failing tests**

Add `runAnnounceSweep` to the require at the top of
`test/unit/engine-announce.js`, then append:

```js
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
  const bad = sweepable('bad', calls, {
    discovery: {
      tracker: {
        update () { throw new Error('tracker is wedged') }
      }
    }
  })

  const result = runAnnounceSweep(sweepDeps(
    [bad, sweepable('good', calls)],
    { log: (...args) => logged.push(args) }))

  t.deepEqual(calls, ['good'], 'the rest of the sweep still ran')
  t.deepEqual(result.announced, ['good'], 'and the failure is not counted')
  t.ok(logged.length >= 1, 'the failure was logged')
  t.end()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build:node && npx tape test/unit/engine-announce.js`
Expected: FAIL, `runAnnounceSweep is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/engine/announce.js`:

```js
/**
 * One pass: find the stalled torrents, ask each to re-announce, record
 * the attempt, and log once if anything happened.
 *
 * Every dependency is injected rather than imported, which is what
 * keeps the guards testable without a client or a network.
 *
 * @param {object} deps
 * @param {object[]} deps.torrents The client's torrents.
 * @param {object|false} deps.dht The client-wide DHT.
 * @param {Map<string, number>} deps.lastAnnounceAt Mutated in place.
 * @param {number} deps.now Milliseconds.
 * @param {(format: string, ...args: any[]) => void} deps.log
 * @param {number} [deps.cooldownMs]
 * @param {number} [deps.max]
 * @returns {{ announced: string[], deferred: number }}
 */
export function runAnnounceSweep (deps) {
  const { torrents, dht, lastAnnounceAt, now, log } = deps
  const { selected, deferred } = selectStalled(
    torrents, now, lastAnnounceAt,
    { cooldownMs: deps.cooldownMs, max: deps.max })

  if (selected.length === 0) return { announced: [], deferred: 0 }

  const announced = []
  for (const torrent of selected) {
    // Record the attempt before making it, so a torrent whose tracker
    // client throws every time still waits out its cooldown rather
    // than being retried every sweep.
    lastAnnounceAt.set(torrent.infoHash, now)
    try {
      announceNow(torrent, dht)
      announced.push(torrent.infoHash)
    } catch (err) {
      // The engine is long lived and one wedged tracker client must
      // not cost the other torrents their sweep.
      log('announce sweep: %s failed: %o', torrent.infoHash, err)
    }
  }

  // A cap that drops work silently reads as "nothing else needed it".
  log('announce sweep: re-announced %d stalled torrent(s), %d deferred: %s',
    announced.length, deferred, announced.join(' '))

  return { announced, deferred }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build:node && npx tape test/unit/engine-announce.js`
Expected: PASS.

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/engine/announce.js test/unit/engine-announce.js
git commit -m "feat(engine): add runAnnounceSweep with cooldown and cap"
```

---

### Task 3: Wire the sweep into the engine

**Files:**
- Modify: `src/engine/index.js`
- Modify: `src/engine/AGENTS.md`
- Test: `test/unit/engine-sweep-wiring.js` (create)

**Interfaces:**
- Consumes: `runAnnounceSweep` and `SWEEP_INTERVAL_MS` from
  `announce.js`.
- Produces: no new export and no new channel. The sweep is engine
  behaviour the UI never asks for.

The behaviour is covered by Task 1 and Task 2 against fakes. What is
left is wiring, and a sweep that fires once a minute is too slow to
drive from a spawned-sidecar test without adding a test-only override to
production code. So this task's test is a source-level check, in the
same shape as the scan at `test/unit/engine-entry.js:115` and
`test/unit/platform-boundary.js`. It asserts the parts are connected,
not that they work.

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine-sweep-wiring.js`:

```js
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
  t.ok(/SWEEP_INTERVAL_MS/.test(code),
    'and so is the interval constant')
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
  t.ok(/lastAnnounceAt\.set\(/.test(code),
    'a new torrent seeds it, so it is not announced the moment it ' +
    'starts')
  t.ok(/lastAnnounceAt\.delete\(/.test(code),
    'and a stopped torrent is removed, so the map cannot grow ' +
    'without bound')
  t.end()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tape test/unit/engine-sweep-wiring.js`
Expected: FAIL on every assertion.

- [ ] **Step 3: Import the sweep**

In `src/engine/index.js`, change the existing announce import to:

```js
import { announceNow, runAnnounceSweep, SWEEP_INTERVAL_MS } from './announce'
```

- [ ] **Step 4: Add the map**

In `src/engine/index.js`, below the `servers` Map declaration:

```js
// Info hash -> when the sweep last asked this torrent to announce. A
// torrent that has never been asked is eligible immediately, so a new
// torrent is seeded here when its info hash arrives: `client.add()`
// has just sent a `start` announce of its own and a second one a
// minute later would be pure waste.
const lastAnnounceAt = new Map()
```

- [ ] **Step 5: Seed the map when a torrent arrives**

In `addTorrentEvents`, the `infoHash` handler is currently a one-line
arrow. Turn it into a block:

```js
  torrent.on('infoHash', () => {
    // `client.add()` announces `started` as it goes, so the sweep's
    // clock for this torrent starts here rather than at zero.
    lastAnnounceAt.set(torrent.infoHash, Date.now())
    bus.send('wt-parsed', torrent.key, torrent.infoHash, torrent.magnetURI)
  })
```

- [ ] **Step 6: Clear the map when a torrent stops**

In `stopTorrenting`:

```js
function stopTorrenting (infoHash) {
  console.log('--- STOP TORRENTING: ', infoHash)
  lastAnnounceAt.delete(infoHash)
  const torrent = client.get(infoHash)
  if (torrent) torrent.destroy()
}
```

- [ ] **Step 7: Add the sweep itself**

In `src/engine/index.js`, add below `forceAnnounce`:

```js
// Ask any torrent sitting at zero peers to re-announce. Without this a
// torrent whose last peer drops waits out the tracker's own interval,
// which `bittorrent-tracker` defaults to 30 minutes for HTTP and UDP,
// or the DHT's 15 minutes plus jitter. The guards -- who qualifies, a
// five minute per-torrent cooldown, a cap per sweep -- are in
// `announce.js`, along with their tests.
function runSweep () {
  runAnnounceSweep({
    torrents: client.torrents,
    dht: client.dht,
    lastAnnounceAt,
    now: Date.now(),
    log: (...args) => console.log(...args)
  })
}
```

And in `init()`, beside the existing progress interval:

```js
  setInterval(updateTorrentProgress, 1000)
  setInterval(runSweep, SWEEP_INTERVAL_MS)
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npm run build:node && npx tape test/unit/engine-sweep-wiring.js`
Expected: PASS.

- [ ] **Step 9: Verify the engine source scan still passes**

Step 5 edited a `bus.send` call site, which the scan at
`test/unit/engine-entry.js:115` checks.

Run: `npx tape test/unit/engine-entry.js`
Expected: PASS, including "every send goes through the bus".

- [ ] **Step 10: Document it**

In `src/engine/AGENTS.md`, extend the `announce.js` section added by
the diagnostic plan:

```markdown
The sweep is the automatic form. Once a minute `index.js` calls
`runAnnounceSweep`, which re-announces every torrent that has zero
peers, is not finished and is not paused. Three guards keep it from
being worse than the bug it fixes, and they are the reason the logic
lives here rather than inline in `index.js`, where it could not be
tested: a five minute per-torrent cooldown, comfortably above any
tracker's `min interval`; a cap of five torrents per sweep, served
least-recently-announced first so a long list goes round robin; and a
log line whenever the cap holds work back, because a silent truncation
reads as "nothing else needed it".

`index.js` owns only the interval and the `lastAnnounceAt` map. The map
is seeded when a torrent's info hash arrives -- `client.add()` has just
announced `started` and a second announce a minute later would be waste
-- and cleared in `stopTorrenting`, so it cannot outgrow the torrent
list.
```

- [ ] **Step 11: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add src/engine/index.js src/engine/AGENTS.md \
  test/unit/engine-sweep-wiring.js
git commit -m "feat(engine): re-announce torrents that stall at zero peers"
```

---

### Task 4: Verify against the real app

**Files:** none. This task produces a written result.

- [ ] **Step 1: Start the app with a visible terminal**

Run: `npm start`

Engine stdout is relayed with an `Engine:` prefix.

- [ ] **Step 2: Confirm the sweep is quiet when nothing is stalled**

With every torrent showing a peer count, watch for five minutes. There
should be **no** `announce sweep:` lines at all. A sweep that logs when
nothing is wrong is a sweep that will be ignored.

- [ ] **Step 3: Confirm it fires when something stalls**

Wait for a torrent to drop to zero peers. Within about a minute:

```
Engine: announce sweep: re-announced 1 stalled torrent(s), 0 deferred: <hash>
```

Note the time, and whether the torrent picks up peers within the next
30 seconds.

- [ ] **Step 4: Confirm the cooldown holds**

If the torrent stays at zero peers, the same info hash must **not**
appear again for five minutes. A sweep line every minute for the same
torrent means the map is not being written and is a bug in Task 2's
wiring, not in the guards.

- [ ] **Step 5: Confirm a restart does not stampede**

Quit and restart the app with several torrents in the list. No
`announce sweep:` line should appear in the first minute: every torrent
was seeded into the map as it started.

- [ ] **Step 6: Confirm the original symptom is gone**

Use the app normally for a session. The thing to watch for is the
original report: downloads stopping and staying stopped until a play
click revives them. Note whether it recurs, and if it does, whether the
sweep logged anything for the affected torrents.

If the sweep is firing and peers still do not come back, the stall is
not a discovery problem after all. Say so rather than tuning the
interval down -- a shorter interval against an unresponsive tracker
just gets the client rate limited.

- [ ] **Step 7: Remove the diagnostic**

Once the sweep is confirmed working, the manual instrument from
`2026-08-05-force-announce-diagnostic.md` has served its purpose. Its
removal is a separate change, and should delete all of: the
`wt-force-announce` handler, `forceAnnounce` and
`ANNOUNCE_DIAG_DELAYS_MS` in `src/engine/index.js`; the `forceAnnounce`
export in `ipc-engine.js`; the controller method and the menu item; the
protocol table rows and the paragraph below them in
`docs/platform-shim.md`; and `test/unit/engine-force-announce.js`.

`announceNow` in `src/engine/announce.js` **stays** -- the sweep is its
caller now.
