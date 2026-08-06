# Stalled Torrent Announce Sweep -- Phase 1: The selection rule

**Goal:** Add `selectStalled`, the pure function that decides which
torrents are asked to re-announce, plus the three constants that bound
the sweep.

**Architecture:** Everything in this phase is a pure function in
`src/engine/announce.js`. It takes the torrent list, a clock, and a
last-announced map as arguments and returns a plain object. No network,
no client, no bus. That is what makes the guards -- cooldown, cap,
eligibility -- testable at all.

**Tech Stack:** Node sidecar (`src/engine/`, ESM compiled by Babel to
`build/`), `webtorrent` 1.9.7, `tape` 5.10.2 unit tests in CommonJS
against the Babel output, `standard` style.

**Scope:** Phase 1 of 4, from
`/Users/nick/code/webtorrent-desktop/docs/superpowers/plans/2026-08-05-stalled-torrent-announce-sweep.md`

**Codebase verified:** 2026-08-05

---

## Prerequisite -- read before writing any code

**This whole plan is conditional, and the condition is not something
the code can tell you.**

It depends on `docs/superpowers/plans/2026-08-05-force-announce-diagnostic.md`
having been implemented, and -- far more importantly -- on that plan's
Task 5 having produced **outcome 2**: peers rising above zero within
about 30 seconds of a forced announce, on most torrents tried.

That diagnostic is what established that re-announcing revives a
stalled torrent at all. Everything in Phases 1-4 is machinery for doing
automatically what Task 5 did by hand. If forcing an announce did not
bring peers back, then automating it will not either, and this plan is
building a scheduler for an action that does not work.

**If Task 5 produced any other outcome: stop, and say so.** Do not
start Task 1. Do not adjust the interval or the cooldown to compensate.
Report that the premise failed and hand the question back.

**Status at planning time (2026-08-05): outcome 2 was confirmed by the
user.** The gate is satisfied and Phase 1 may proceed. It is written
down anyway, because a phase file executed on its own months from now
carries no memory of that conversation, and a conditional plan that has
lost its condition looks exactly like an unconditional one.

`announceNow(torrent, dht)` from the diagnostic plan is reused unchanged
throughout. Note that Phase 4 retires the rest of that diagnostic, but
only after Phase 4 Task 1 confirms the sweep has taken over its job.

---

## Note on test code in this plan

The house rule is that implementation plans describe tests rather than
carrying test code, because signatures and project conventions are
normally unknown at planning time. Neither applies here: the signatures
are fixed by this phase's Interfaces section below, and the conventions
were verified directly against
`/Users/nick/code/webtorrent-desktop/test/unit/engine-announce.js` and
`/Users/nick/code/webtorrent-desktop/test/AGENTS.md`. The test code
below is given in full because it is known to match both. Treat the
assertion messages as part of the deliverable -- they are the record of
why each guard exists.

---

## Acceptance Criteria Coverage

This phase implements and tests:

### stalled-torrent-announce-sweep.AC1: Only torrents that need it are selected

- **stalled-torrent-announce-sweep.AC1.1 Success:** A torrent with
  `numPeers === 0`, not done and not paused is selected.
- **stalled-torrent-announce-sweep.AC1.2 Failure:** A torrent with one
  or more peers is not selected. One peer is enough to disqualify it:
  the sweep exists for torrents that have nobody to talk to.
- **stalled-torrent-announce-sweep.AC1.3 Failure:** A finished torrent
  (`done === true`) is not selected.
- **stalled-torrent-announce-sweep.AC1.4 Failure:** A paused torrent
  (`paused === true`) is not selected.
- **stalled-torrent-announce-sweep.AC1.5 Failure:** A torrent that has
  no info hash yet is not selected.

### stalled-torrent-announce-sweep.AC2: The per-torrent cooldown holds

- **stalled-torrent-announce-sweep.AC2.1 Failure:** A torrent whose
  last announce was less than `COOLDOWN_MS` ago is not selected.
- **stalled-torrent-announce-sweep.AC2.2 Success:** A torrent whose
  last announce was more than `COOLDOWN_MS` ago is selected.
- **stalled-torrent-announce-sweep.AC2.3 Success:** A torrent with no
  entry in the map at all is treated as eligible.

### stalled-torrent-announce-sweep.AC3: The cap bounds a sweep without hiding work

- **stalled-torrent-announce-sweep.AC3.1 Success:** At most
  `MAX_PER_SWEEP` torrents are selected.
- **stalled-torrent-announce-sweep.AC3.2 Success:** The number of
  eligible torrents held back is returned as `deferred`, not dropped.
- **stalled-torrent-announce-sweep.AC3.3 Success:** Selection is
  least-recently-announced first, so a list longer than the cap is
  served round robin rather than the same head every sweep.

---

## Interfaces

**Consumes:** nothing new. `announceNow(torrent, dht)` already exists at
`/Users/nick/code/webtorrent-desktop/src/engine/announce.js:30` and is
untouched by this phase.

**Produces, all from `src/engine/announce.js`:**

- `SWEEP_INTERVAL_MS`, `COOLDOWN_MS`, `MAX_PER_SWEEP` -- exported number
  constants.
- `selectStalled(torrents, now, lastAnnounceAt, opts)` returning
  `{ selected: object[], deferred: number }`.
  - `torrents` -- array of WebTorrent torrents. Only `infoHash`,
    `numPeers`, `done` and `paused` are read.
  - `now` -- millisecond timestamp, injected so this stays testable.
  - `lastAnnounceAt` -- `Map` of info hash to timestamp. Read only in
    this phase; Phase 2 writes it.
  - `opts` -- may carry `cooldownMs` and `max`.

Phase 2 is the only caller.

---

## Verified codebase state

Confirmed on branch `stalled-torrent-announce-sweep` on 2026-08-05:

- `src/engine/announce.js` exists, 50 lines, ESM `export` syntax. It
  exports exactly one thing, `announceNow` at line 30. None of
  `selectStalled`, `runAnnounceSweep`, `SWEEP_INTERVAL_MS`,
  `COOLDOWN_MS` or `MAX_PER_SWEEP` exists yet.
- `test/unit/engine-announce.js` exists, 82 lines, CommonJS. Its require
  line is `const { announceNow } = require('../../build/engine/announce')`
  at line 6. It has five `announceNow` tests and helpers `fakeTorrent`
  and `fakeDht` plus an `INFO_HASH` constant. The new helpers `stalled`
  and the `NOW` constant added below do not collide with any of these.
- `webtorrent` is 1.9.7 in both `package.json` and `node_modules`.
- On that version, every property the filter reads is defined:
  `node_modules/webtorrent/lib/torrent.js:103` sets
  `this.paused = opts.paused || false`, line 104 sets `this.done`, line
  181 defines `get numPeers () { return this.wires.length }`.

### The `paused` guard is currently inert, and that is fine

Be precise about what was checked, because the obvious reading is
wrong. `paused` is a real property and `torrent.pause()` at
`node_modules/webtorrent/lib/torrent.js:1812` really does set it. But
**nothing in this repository ever calls `torrent.pause()`.** The
renderer's idea of pausing is `stopTorrenting`, which goes to
`torrent.destroy()` (`src/renderer/controllers/torrent-list-controller.js:155-156`);
every `.pause()` in `src/` belongs to media playback -- a video tag, a
stream, a cast session -- and never to a torrent.

So in this application `torrent.paused` is always `false`, and the
`!torrent.paused` filter never excludes anything today.

Keep it anyway. It costs one property read, it is correct the moment
pause is ever wired to the torrent rather than to destroy, and
AC1.4 pins the behaviour so a future change gets it for free. What it
must not do is masquerade as protection that is currently doing work:
an inert guard described as an active one is how the next person comes
to trust a filter that has never once fired.

---

## Constraints for this phase

- Style is `standard`. `npm run lint` runs `standard` then
  `npm run lint:boundary`. Both must pass.
- Keep lines under 80 columns to match the surrounding code.
- No em dashes in comments. Use `--`. No arrow character; use `->`.
- `test/unit/platform-boundary.js:401-427` scans **every** `.js` file in
  `src/engine/`, `announce.js` included, for Electron imports and DOM
  globals. Nothing in this phase goes near either, but do not introduce
  one.
- Unit tests are CommonJS and require the Babel output under `build/`.
  A build must happen before tests run. See
  `/Users/nick/code/webtorrent-desktop/test/AGENTS.md` lines 43-62.

---

<!-- START_SUBCOMPONENT_A (tasks 1-2) -->

<!-- START_TASK_1 -->
### Task 1: The constants and `selectStalled`

**Verifies:** stalled-torrent-announce-sweep.AC1.1,
stalled-torrent-announce-sweep.AC1.2,
stalled-torrent-announce-sweep.AC1.3,
stalled-torrent-announce-sweep.AC1.4,
stalled-torrent-announce-sweep.AC1.5,
stalled-torrent-announce-sweep.AC2.1,
stalled-torrent-announce-sweep.AC2.2,
stalled-torrent-announce-sweep.AC2.3,
stalled-torrent-announce-sweep.AC3.1,
stalled-torrent-announce-sweep.AC3.2,
stalled-torrent-announce-sweep.AC3.3

**Files:**
- Modify: `/Users/nick/code/webtorrent-desktop/src/engine/announce.js`
  (append after line 50)
- Test: `/Users/nick/code/webtorrent-desktop/test/unit/engine-announce.js`
  (modify line 6, then append) -- unit

**Step 1: Widen the require at the top of the test file**

Replace line 6 of `test/unit/engine-announce.js`:

```js
const { announceNow } = require('../../build/engine/announce')
```

with:

```js
const {
  announceNow, selectStalled, COOLDOWN_MS, MAX_PER_SWEEP
} = require('../../build/engine/announce')
```

**Step 2: Write the failing tests**

Append to `test/unit/engine-announce.js`. Each test names the AC it
covers in its assertion message where that reads naturally; do not
renumber or reword the existing five `announceNow` tests.

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

**Step 3: Run the tests to verify they fail**

Run:

```bash
npm run build:node && npx tape test/unit/engine-announce.js
```

Expected: FAIL. The seven new tests error with
`selectStalled is not a function`. The five existing `announceNow`
tests still pass.

If instead you see a Babel or module error, the build did not run --
tests read `build/engine/announce.js`, never `src/`.

**Step 4: Write the implementation**

Append to `src/engine/announce.js`, after the closing brace of
`announceNow` at line 50:

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

Two things about this implementation that are load-bearing and easy to
break on a later edit:

1. **The sort must be stable and it is.** `Array.prototype.sort` is
   stable in Node, so torrents that share a timestamp -- including the
   very common case of several never-announced torrents, which all read
   as `0` -- keep their list order. Two tests depend on that:
   `selectStalled picks torrents with no peers` expects `['a', 'c']`
   and the cap test expects `t0..t4`.
2. **`lastOf` returns `0`, not `-Infinity`, for a missing entry.** That
   makes a never-seen torrent sort to the front and pass the cooldown
   check in one rule, without a special case.

**Step 5: Run the tests to verify they pass**

Run:

```bash
npm run build:node && npx tape test/unit/engine-announce.js
```

Expected: PASS. `tape` prints **`# tests 20`** -- note that its "tests"
line counts *assertions*, not `test()` blocks. There are 12 blocks: the
five existing `announceNow` ones carrying 10 assertions, plus the seven
added here carrying 10. Looking for "12" in the output will not find it.

**Step 6: Lint**

Run:

```bash
npm run lint
```

Expected: no output, exit 0. This runs `standard` and then the
boundary config over `src/renderer` and `src/engine`.

**Commit:**

```bash
git add src/engine/announce.js test/unit/engine-announce.js
git commit -m "feat(engine): add selectStalled, the announce sweep's guards"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Confirm the phase leaves the suite green

**Verifies:** None. This is a regression gate, not new behaviour.

**Files:** none.

**Step 1: Run the whole suite**

Run:

```bash
npm test
```

Expected: PASS. This runs `standard`, the boundary lint, `depcheck`, a
full `build`, and every file in `test/unit/`.

`depcheck` is in the path and this phase adds no dependency, so it has
nothing to say. If it complains, something unrelated to this phase is
wrong -- do not add an ignore entry to quiet it.

**Step 2: Confirm no new export leaked into the engine scan**

Run:

```bash
npx tape test/unit/platform-boundary.js
```

Expected: PASS, including `announce.js imports no Electron module` and
`announce.js uses no DOM global`. Phase 1 adds code to a file that scan
walks, so this is worth seeing green once explicitly rather than
inferring it from `npm test`.

**Commit:** none. Nothing changed; this task is a gate.
<!-- END_TASK_2 -->

<!-- END_SUBCOMPONENT_A -->

---

## Done when

- `selectStalled` and the three constants are exported from
  `src/engine/announce.js`.
- `test/unit/engine-announce.js` passes: 12 `test()` blocks, 20
  assertions.
- `npm test` passes.
- Nothing in `src/engine/index.js` has changed. Wiring is Phase 3.
