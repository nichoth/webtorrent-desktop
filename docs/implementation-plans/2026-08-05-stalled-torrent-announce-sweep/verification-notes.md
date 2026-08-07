# Verification Notes -- Stalled Torrent Announce Sweep

Phase 4 Task 1. Human observation against real torrents and real
trackers. Raw log lines, not summaries.

**Status: IN PROGRESS. No criterion is confirmed yet.**

Watch stdout for `Engine: announce sweep:`. To capture timestamped raw
lines:

```bash
npm start 2>&1 | while IFS= read -r l; do \
  printf '%s %s\n' "$(date +%H:%M:%S)" "$l"; done \
  | tee /tmp/sweep-verify.log
```

Then `grep 'announce sweep:' /tmp/sweep-verify.log`.

---

## Observations already captured

**2026-08-05, first run.** Roughly 12 torrents in the list, **some of
them at zero peers**. One raw line was recorded:

```
Engine: announce sweep: re-announced 5 stalled torrent(s)
```

What this establishes: the sweep is wired, fires in the real app, and
finds real stalled torrents. `5` is exactly `MAX_PER_SWEEP`, so the cap
was saturated -- at least five torrents were stalled, and any beyond
that were deferred to the next sweep. Firing here was **correct**: some
torrents were at zero peers, which is precisely the condition the sweep
exists to act on.

What it does not establish, and why AC8.1 is still open: AC8.1 is a
silence test whose precondition is that *every* torrent shows peers.
That precondition was not met on this run, so AC8.1 was not exercised
either way. The line was initially read as evidence for AC8.1; it is
not, but neither is it evidence against it. The property it actually
shows -- that the count is bounded below the torrent total -- is the
per-sweep cap, which is AC3.1 and AC5.1 and already unit-tested.

**Worth capturing next time:** the full line, including the `%d
deferred` field and the trailing info hashes. The quoted fragment stops
before them, so how many torrents were stalled in total is unknown. On
a 12-torrent list with the cap saturated, that number is the
interesting one.

---

## AC8.1 -- silent when nothing is stalled

**Asks:** with every torrent showing a peer count, no `announce sweep:`
line appears for five minutes.

**Precondition matters.** This cannot be observed while torrents are
sitting at zero peers. Given the run above found at least five stalled,
you will need a moment when the whole list is healthy: stop or remove
the dead torrents first, or test with a small set of known-live ones.

**Record:**

- Torrent count in the list:
- Every torrent confirmed showing peers at start (yes/no):
- Duration watched:
- Any `announce sweep:` line appeared (yes/no), and the raw line if so:

**Status: NOT YET OBSERVED**

---

## AC8.2 -- fires when something stalls

**Asks:** within about a minute of a torrent dropping to zero peers, an
`announce sweep:` line names it.

**This is the one the whole plan rests on.** The design's premise is
that re-announcing revives a stalled torrent. If the sweep fires and
peers do not come back, the stall is not a discovery problem.

**Record:**

- Time the torrent hit zero peers:
- Time the sweep line appeared:
- Raw log line:
- **Did peers return within 30 seconds (yes/no), and what count:**

**Status: NOT YET OBSERVED**

---

## AC8.3 -- the cooldown holds

**Asks:** a torrent that stays at zero peers is not named again for
five minutes.

If the same hash appears every minute, that is a Phase 3 wiring bug,
not a guard bug -- the map reaching `runAnnounceSweep` would not be the
one being written. Phase 2's tests prove the guards hold when the map
is passed correctly. Check the `lastAnnounceAt` declaration and
`runSweep` passing it through before touching `announce.js`.

**Record:**

- Info hash watched:
- Timestamps of each line naming it:
- Measured interval between repeats (must be >= 5 minutes):

**Status: NOT YET OBSERVED**

---

## AC8.4 -- a restart does not stampede

**Asks:** after quitting and restarting with several torrents in the
list, no `announce sweep:` line appears in the first minute. Every
torrent is seeded into the map as its info hash arrives.

**Record:**

- Torrent count in the list at restart:
- First minute silent (yes/no), and any raw line if not:

**Status: NOT YET OBSERVED**

---

## The original symptom

The bug report that started this work was behavioural, not numeric:
downloads stopping and staying stopped until a play click revives them.

**Record:**

- Did it recur (yes/no):
- If it did, what the sweep logged for the affected torrents:

**Status: NOT YET OBSERVED**

---

## Stop condition

If the sweep is firing and peers still do not come back, the stall is
not a discovery problem. Say so and stop. Do not tune the interval
down: a shorter interval against an unresponsive tracker gets the
client rate limited, which makes the problem worse while looking like
effort. Record the finding here, and do not run Task 2 -- the
force-announce diagnostic is the only remaining instrument if the
question is still open.
