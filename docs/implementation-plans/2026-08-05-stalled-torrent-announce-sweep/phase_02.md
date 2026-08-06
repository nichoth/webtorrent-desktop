# Stalled Torrent Announce Sweep -- Phase 2: The sweep body

**Goal:** Add `runAnnounceSweep`, the function that takes one pass over
the torrent list: find the stalled ones, ask each to re-announce, record
the attempt, and log once if anything happened.

**Architecture:** Still a pure-ish function in `src/engine/announce.js`
-- every dependency is injected rather than imported, including the
clock and the logger. Its one impurity is deliberate: it mutates the
`lastAnnounceAt` map it is handed. That is what makes the cooldown hold
across sweeps, and Phase 3 owns the map's lifecycle.

**Tech Stack:** Node sidecar (`src/engine/`, ESM compiled by Babel to
`build/`), `webtorrent` 1.9.7, `tape` 5.10.2 unit tests in CommonJS
against the Babel output, `standard` style.

**Scope:** Phase 2 of 4, from
`/Users/nick/code/webtorrent-desktop/docs/superpowers/plans/2026-08-05-stalled-torrent-announce-sweep.md`

**Codebase verified:** 2026-08-05

**Depends on:** Phase 1. `selectStalled` and `COOLDOWN_MS` must exist
and be exported before this phase's tests can run.

---

## Acceptance Criteria Coverage

This phase implements and tests:

### stalled-torrent-announce-sweep.AC4: The sweep announces and records

- **stalled-torrent-announce-sweep.AC4.1 Success:** `runAnnounceSweep`
  calls `announceNow` for each selected torrent and for no others.
- **stalled-torrent-announce-sweep.AC4.2 Success:** It writes `now`
  into `lastAnnounceAt` for each selected torrent, so a sweep one
  minute later does not announce the same torrent again, and a sweep
  past the cooldown does.

### stalled-torrent-announce-sweep.AC5: The sweep logs honestly

- **stalled-torrent-announce-sweep.AC5.1 Success:** When the cap holds
  eligible torrents back, exactly one log line is emitted per sweep and
  it carries the deferred count. A cap that drops work silently reads
  as "nothing else needed it".
- **stalled-torrent-announce-sweep.AC5.2 Failure:** When nothing is
  stalled, nothing is announced and nothing at all is logged. A sweep
  that logs when nothing is wrong is a sweep that will be ignored.

### stalled-torrent-announce-sweep.AC6: One wedged torrent cannot end the sweep

- **stalled-torrent-announce-sweep.AC6.1 Failure:** A torrent whose
  tracker client throws does not stop the remaining torrents in the
  same sweep from being announced.
- **stalled-torrent-announce-sweep.AC6.2 Failure:** A failed announce
  is not counted in `announced`, and the failure is logged.
- **stalled-torrent-announce-sweep.AC6.3 Success:** A torrent whose
  announce threw still waits out its full cooldown, because the attempt
  is recorded before it is made.

---

## Interfaces

**Consumes:** `announceNow` (`src/engine/announce.js:30`) and
`selectStalled` (added in Phase 1), both from the same module.

**Produces, from `src/engine/announce.js`:**

`runAnnounceSweep(deps)` where `deps` is:

| Key | Type | Meaning |
| --- | --- | --- |
| `torrents` | `object[]` | The client's torrents. |
| `dht` | `object \| false` | The client-wide DHT. |
| `lastAnnounceAt` | `Map<string, number>` | **Mutated in place.** |
| `now` | `number` | Milliseconds. |
| `log` | `(format, ...args) => void` | `console.log`-shaped. |
| `cooldownMs` | `number?` | Optional override. |
| `max` | `number?` | Optional override. |

Returns `{ announced: string[], deferred: number }`.

Phase 3 is the only caller, from a `setInterval`.

---

## Verified codebase state

Confirmed on branch `stalled-torrent-announce-sweep` on 2026-08-05:

- **`announceNow` does not catch tracker failures.**
  `src/engine/announce.js:34-39` reads:

  ```js
  const tracker = torrent.discovery && torrent.discovery.tracker
  if (tracker) {
    // A no-event announce to every tracker in the list.
    tracker.update()
    result.tracker = true
  }
  ```

  There is no `try` anywhere in the function. It guards against
  *missing* pieces -- no torrent, no discovery, no tracker, no DHT --
  and returns `{ tracker: false, dht: false }` for those. But a
  `tracker.update()` that **throws** propagates straight out.

  This is the single fact this phase's error handling rests on. The
  `try/catch` added below is not defensive decoration; it is the only
  thing standing between a wedged tracker client and a sweep that stops
  half way through. Verify it is still true before writing the code --
  if a future edit adds a `try` inside `announceNow`, the
  `runAnnounceSweep survives one torrent throwing` test below becomes a
  test of nothing.

- `announceNow` returns `{ tracker: boolean, dht: boolean }`, not void.
  See the note on counting below.

- `test/unit/engine-announce.js` after Phase 1 has the `stalled()`
  helper and the `NOW` constant this phase builds on. There is no
  existing `sweepable` or `sweepDeps` to collide with.

---

## A known imprecision, recorded rather than hidden

`runAnnounceSweep` counts a torrent as `announced` when `announceNow`
returns without throwing -- **not** when it actually sent something.
`announceNow` returns `{ tracker: false, dht: false }` for a torrent
that has an info hash but no `discovery` yet, and this sweep would
still count that torrent and name it in the log line.

In practice a torrent with an info hash almost always has discovery, so
the log stays accurate. It is written down here because the design's
whole argument for the log line is that silent inaccuracy is worse than
noise, and it would be inconsistent to leave this unstated.

**Do not "fix" this as a drive-by during implementation.** Using
`announceNow`'s return value to decide the count is a real improvement
and the existing tests would still pass, but it is a design change and
belongs in its own change with its own test. Implement the behaviour as
specified below.

---

## Constraints for this phase

- Style is `standard`; `npm run lint` must pass.
- Keep lines under 80 columns.
- No em dashes in comments. Use `--`. No arrow character; use `->`.
- One wedged tracker client must not end the session or stop the other
  torrents from being served. See the next section for exactly how far
  that holds and where it stops.
- Unit tests are CommonJS against `build/`. See
  `/Users/nick/code/webtorrent-desktop/test/AGENTS.md` lines 43-62.

---

## How far the "never throws" guarantee actually reaches

The design states a global constraint: "The sweep must never throw out
of its interval callback." The implementation below does **not** fully
establish that, and it is better to say so than to let the sentence
stand as if it had been proved.

What is guarded: the `announceNow` call, per torrent, inside the loop.
That is the part that touches a tracker client and therefore the part
that realistically throws. AC6.1 tests it.

What is not guarded: `selectStalled(...)`, the `lastAnnounceAt.set(...)`
call, and the summary `log(...)` all sit outside any `try`. A throw
from one of those escapes `runAnnounceSweep`, escapes `runSweep`, and
lands in the `setInterval` callback with nothing to catch it.

The consequence is bounded but real. `src/engine/index.js:117`
registers `process.on('uncaughtException', onUncaughtError)`, so the
engine reports the error and survives rather than dying -- but that
sweep is lost, and the failure surfaces as a generic uncaught error
rather than as anything that names the sweep.

**Do not add a blanket `try` around the whole function to close this.**
It would swallow programmer errors in `selectStalled` -- a typo'd
property, a bad comparator -- and turn them into a sweep that silently
does nothing every minute forever, which is far harder to notice than
an uncaught exception. The current shape fails loudly for bugs and
quietly for wedged trackers, which is the right way round.

This is recorded as a known limitation, not a task. The design has the
identical gap; this plan is faithful to it and simply declines to claim
more than it delivers.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: `runAnnounceSweep`

**Verifies:** stalled-torrent-announce-sweep.AC4.1,
stalled-torrent-announce-sweep.AC4.2,
stalled-torrent-announce-sweep.AC5.1,
stalled-torrent-announce-sweep.AC5.2,
stalled-torrent-announce-sweep.AC6.1,
stalled-torrent-announce-sweep.AC6.2,
stalled-torrent-announce-sweep.AC6.3

**Files:**
- Modify: `/Users/nick/code/webtorrent-desktop/src/engine/announce.js`
  (append)
- Test: `/Users/nick/code/webtorrent-desktop/test/unit/engine-announce.js`
  (modify the require, then append) -- unit

**Step 1: Widen the require**

Add `runAnnounceSweep` to the destructured require that Phase 1 left at
the top of `test/unit/engine-announce.js`:

```js
const {
  announceNow, selectStalled, runAnnounceSweep, COOLDOWN_MS,
  MAX_PER_SWEEP
} = require('../../build/engine/announce')
```

**Step 2: Write the failing tests**

Append to `test/unit/engine-announce.js`. These reuse the `stalled()`
helper and the `NOW` constant from Phase 1.

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
  t.ok(logged.length >= 1, 'the failure was logged')
  t.equal(lastAnnounceAt.get('bad'), NOW,
    'and the wedged one still waits out its cooldown, rather than ' +
    'being retried every sweep')
  t.end()
})
```

Two details in these tests that look incidental and are not:

- `sweepable` passes `overrides` to `Object.assign` **last**, so
  `{ numPeers: 2 }` and the throwing `discovery` both win over the
  defaults. Keep that argument order.
- `logged[0]` is the raw argument array, so `.includes(2)` finds the
  deferred count as an array element. It does not search the format
  string. If the log call's argument order changes, this assertion
  changes with it.

**Step 3: Run the tests to verify they fail**

Run:

```bash
npm run build:node && npx tape test/unit/engine-announce.js
```

Expected: FAIL with `runAnnounceSweep is not a function` on the five
new tests. The 12 tests from Phase 1 still pass.

**Step 4: Write the implementation**

Append to `src/engine/announce.js`, after `selectStalled`:

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

Three things here are load-bearing:

1. **The early return is what makes the quiet case quiet.** Without it
   the summary line would fire every minute forever, which is the
   failure mode AC5.2 exists to prevent.
2. **`lastAnnounceAt.set` comes before the `try`, not inside it.** A
   torrent whose tracker throws on every call would otherwise be
   retried every single sweep, which is exactly the tracker-hammering
   the cooldown exists to prevent. The comment says so; keep it.
3. **The `catch` is per torrent, inside the loop.** Wrapping the whole
   loop instead would let one bad torrent cost every torrent after it
   its sweep, failing AC6.1.

**Step 5: Run the tests to verify they pass**

Run:

```bash
npm run build:node && npx tape test/unit/engine-announce.js
```

Expected: PASS. `tape` prints **`# tests 36`** -- its "tests" line
counts *assertions*, not `test()` blocks. There are 17 blocks: five
`announceNow`, seven `selectStalled`, five `runAnnounceSweep`. The five
added here carry 16 assertions on top of Phase 1's 20.

**Step 6: Lint**

Run:

```bash
npm run lint
```

Expected: no output, exit 0.

**Commit:**

```bash
git add src/engine/announce.js test/unit/engine-announce.js
git commit -m "feat(engine): add runAnnounceSweep with cooldown and cap"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Confirm the phase leaves the suite green

**Verifies:** None. Regression gate.

**Files:** none.

**Step 1: Run the whole suite**

Run:

```bash
npm test
```

Expected: PASS.

**Step 2: Confirm `index.js` is still untouched**

Run:

```bash
git diff --name-only HEAD~2
```

Expected: exactly `src/engine/announce.js` and
`test/unit/engine-announce.js` across Phase 1 and Phase 2. If
`src/engine/index.js` appears, wiring leaked in early -- that is
Phase 3's job and doing it here means Phase 3's failing-test step
cannot fail for the right reason.

**Commit:** none. This task is a gate.
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

---

## Done when

- `runAnnounceSweep` is exported from `src/engine/announce.js`.
- `test/unit/engine-announce.js` passes: 17 `test()` blocks, 36
  assertions.
- `npm test` passes.
- `src/engine/index.js` is still unchanged.
