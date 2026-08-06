# Test Requirements -- Stalled Torrent Announce Sweep

Maps every acceptance criterion to either an automated test or a
documented human verification. No criterion is unaccounted for.

**Slug:** `stalled-torrent-announce-sweep`
**Generated:** 2026-08-05, after plan validation
**Source design:**
`/Users/nick/code/webtorrent-desktop/docs/superpowers/plans/2026-08-05-stalled-torrent-announce-sweep.md`

## A note on where these criteria came from

The design document has no formal Acceptance Criteria section. The
criteria below were derived during planning from its `Expected:`
assertions, its "What the guards are for" section, and its manual
verification steps, then scoped with the plan slug. They are a
reconstruction, not a copy, which is worth knowing if the design is
ever revised: it will not renumber to match.

## Test vocabulary

`tape` prints `# tests N`, where N counts **assertions**, not `test()`
blocks. Every count below is assertions unless it says otherwise.

---

## Automated coverage

### Phase 1 -- `test/unit/engine-announce.js` (unit)

| AC | Verified by | Asserts |
| --- | --- | --- |
| AC1.1 | `selectStalled picks torrents with no peers` | a zero-peer, unfinished, unpaused torrent is selected |
| AC1.2 | `selectStalled picks torrents with no peers` | the torrent with `numPeers: 3` is absent from the result |
| AC1.3 | `selectStalled skips finished and paused torrents` | `done: true` is absent |
| AC1.4 | `selectStalled skips finished and paused torrents` | `paused: true` is absent |
| AC1.5 | `selectStalled ignores a torrent with no info hash yet` | `infoHash: undefined` is absent |
| AC2.1 | `selectStalled skips a torrent inside its cooldown` | a torrent announced 60s ago is absent |
| AC2.2 | `selectStalled skips a torrent inside its cooldown` | a torrent announced `COOLDOWN_MS + 1` ago is present |
| AC2.3 | `selectStalled treats an unseen torrent as eligible` | a torrent with no map entry is present |
| AC3.1 | `selectStalled caps a sweep and reports what it deferred` | `selected.length === MAX_PER_SWEEP` |
| AC3.2 | `selectStalled caps a sweep and reports what it deferred` | `deferred === 3` for `MAX_PER_SWEEP + 3` inputs |
| AC3.3 | `selectStalled serves the least recently announced first` | order is `['oldest', 'middle']` under `{ max: 2 }` |

### Phase 2 -- `test/unit/engine-announce.js` (unit)

| AC | Verified by | Asserts |
| --- | --- | --- |
| AC4.1 | `runAnnounceSweep announces only the stalled torrents` | `tracker.update()` fired for `a` and `c`, never `b` |
| AC4.2 | `runAnnounceSweep records the attempt so the cooldown holds` | `NOW` written to the map; no second announce at `+60s`; a third at `+COOLDOWN_MS+1` |
| AC5.1 | `runAnnounceSweep says so when the cap holds work back` | exactly one log line, carrying the deferred count `2` |
| AC5.1 | `runAnnounceSweep with max: 0 reports deferred work` | `announced: []`, `deferred: 2`, one log line carrying `2` |
| AC5.2 | `runAnnounceSweep is silent when nothing is stalled` | zero announces, zero log lines, `{ announced: [], deferred: 0 }` |
| AC6.1 | `runAnnounceSweep survives one torrent throwing` | `good` still announced after `bad` threw |
| AC6.2 | `runAnnounceSweep survives one torrent throwing` | `announced` is `['good']`; the failure was logged |
| AC6.3 | `runAnnounceSweep survives one torrent throwing` | `lastAnnounceAt.get('bad') === NOW` -- the wedged torrent still waits out its cooldown |
| Interface | `runAnnounceSweep respects the cooldownMs override` | torrent not announced within default cooldown; announced again with `cooldownMs: 0` |

> **AC6.3 was a coverage gap found while writing this document, and it
> is now closed.** The plan originally listed AC6.3 but no assertion
> checked it: the throwing test verified that the sweep continued and
> that the failure was not counted, but never that the failed torrent's
> timestamp had been recorded. That timestamp is the entire reason
> `lastAnnounceAt.set` sits *before* the `try` rather than inside it --
> without it, a torrent whose tracker throws on every call is retried
> every single sweep, which is precisely the tracker-hammering the
> cooldown exists to prevent. An implementation that moved the `set`
> inside the `try` would have passed every original assertion. Phase 2
> Task 1 Step 2 now carries the missing assertion.

### Phase 3 -- `test/unit/engine-sweep-wiring.js` (unit, source scan)

| AC | Verified by | Asserts |
| --- | --- | --- |
| AC7.1 | `the engine imports the sweep` + `the sweep runs on its own interval` | `runAnnounceSweep` and `SWEEP_INTERVAL_MS` both imported from `./announce`; `setInterval(runSweep, SWEEP_INTERVAL_MS)`; `runAnnounceSweep({` called |
| AC7.2 | `the last-announced map is seeded and cleared` | `const lastAnnounceAt = new Map()` present, seeded by exactly `lastAnnounceAt.set(torrent.infoHash, Date.now())` |
| AC7.3 | `the last-announced map is seeded and cleared` | `lastAnnounceAt.delete(` present |
| AC7.4 | `test/unit/engine-entry.js:115`, `the engine entry point names no host or browser API` (**pre-existing**) | every `.send(` is `bus.send(`, after the `infoHash` handler is rewritten |

> **What AC7.1 through AC7.3 do not establish.** These are source-text
> assertions. They prove the parts are named and connected; they do not
> prove the interval fires, that the map is passed to the right place,
> or that a real torrent is ever announced. A refactor that renamed
> `runSweep` while keeping behaviour identical would fail them, and an
> implementation that passed a *different* empty Map to
> `runAnnounceSweep` would pass them.
>
> This is a deliberate trade, argued in Phase 3 under "Why this phase's
> test is a source scan": a once-a-minute interval cannot be driven
> from the spawned-sidecar harness, and a test-only interval override
> would be production code existing solely for a test. **The behavioural
> half of AC7 is discharged by AC8.2 and AC8.4 under human
> verification, not by automation.** If that trade is ever revisited,
> this is the paragraph to revisit.

### Expected suite state

| After | `engine-announce.js` | Other |
| --- | --- | --- |
| Phase 1 | 12 blocks, 20 assertions | unchanged |
| Phase 2 | 21 blocks, 46 assertions | unchanged |
| Phase 3 | 21 blocks, 46 assertions | `engine-sweep-wiring.js`: 3 blocks, 7 assertions |
| Phase 4 | 21 blocks, 46 assertions | `torrent-context-menu.js` falls 56 -> 51 |

---

## Human verification

These four cannot be automated, and the reason is the same in each
case: they are assertions about real tracker behaviour, a real peer
swarm, or **silence sustained over wall-clock minutes**. A unit test
can assert that a function returns an empty array; it cannot assert
that nothing was logged for five minutes without either waiting five
minutes or faking the clock inside a spawned child process.

Recorded in
`docs/implementation-plans/2026-08-05-stalled-torrent-announce-sweep/verification-notes.md`,
produced by Phase 4 Task 1.

| AC | Approach | Evidence to capture |
| --- | --- | --- |
| AC8.1 | Watch five minutes with every torrent showing peers | torrent count, duration watched, confirmation of zero `announce sweep:` lines |
| AC8.2 | Wait for a torrent to reach zero peers | time it hit zero, time the sweep line appeared, the raw line, and whether peers returned within 30s |
| AC8.3 | Keep watching a torrent that stays at zero | interval between repeat lines for the same info hash; must be >= 5 minutes |
| AC8.4 | Quit and restart with several torrents | torrent count, confirmation the first minute was silent |

Plus one open-ended observation with no AC, because the bug report that
started this work was behavioural rather than numeric: **does the
original symptom recur** -- downloads stopping and staying stopped
until a play click revives them?

### The stop condition

If the sweep fires and peers still do not return, the stall was never a
discovery problem. Phase 4 Task 1 says to record that and stop, rather
than shortening the interval -- a shorter interval against an
unresponsive tracker earns a rate limit, which makes the problem worse
while looking like progress. In that case Phase 4 Task 2 (retiring the
diagnostic) must be skipped: the manual instrument is the only
remaining way to investigate.

---

## Deliberately untested

| Thing | Why |
| --- | --- |
| `SWEEP_INTERVAL_MS`, `COOLDOWN_MS`, `MAX_PER_SWEEP` values | Constants. Tests reference them rather than hard-coding numbers, so tuning any of them does not break a test -- which is the point. |
| `announceNow` itself | Already covered by five pre-existing tests from the diagnostic plan. Unchanged here. |
| `webtorrent`'s tracker and DHT behaviour | A dependency with its own tests. The fakes assert what the sweep sends, not what the network does with it. |
| Phase 4 Task 2 (diagnostic removal) | Removal of instrumentation. Verified by the existing suite going green, not by new tests. |

### One known limitation, not a gap

`runAnnounceSweep` counts a torrent as announced when `announceNow`
returns without throwing, not when it actually sent something. A
torrent with an info hash but no `discovery` would be counted and named
in the log line. No test pins this, because pinning it would freeze
behaviour that Phase 2 explicitly flags as worth revisiting. See "A
known imprecision, recorded rather than hidden" in `phase_02.md`.

Related, and also recorded rather than tested: the design's constraint
that the sweep "must never throw out of its interval callback" is only
partly delivered -- `selectStalled`, the map write and the summary log
sit outside the `try`. See "How far the 'never throws' guarantee
actually reaches" in `phase_02.md` for why a blanket `try` would be
worse than the gap.
