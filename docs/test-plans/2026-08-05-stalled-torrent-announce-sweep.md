# Test Plan -- Stalled Torrent Announce Sweep

Human verification procedure for the AC8 family, which is the part of
this feature no unit test can reach. Generated after final code review
passed, from
`docs/implementation-plans/2026-08-05-stalled-torrent-announce-sweep/`.

The AC8 observations have been performed once already. The value here
is a repeatable procedure, and the structure for transcribing what was
seen into `verification-notes.md`.

## Automated coverage, for context

20 of 20 automatable criteria are covered and green. AC1.1-AC3.3 in
`selectStalled` tests, AC4.1-AC6.3 in `runAnnounceSweep` tests, both in
`test/unit/engine-announce.js` (21 blocks, 46 assertions). AC7.1-AC7.3
in `test/unit/engine-sweep-wiring.js` (3 blocks, 7 assertions). AC7.4
by the pre-existing scan at `test/unit/engine-entry.js:115`. Whole
suite 3757 assertions, green.

## Prerequisites

- `npm run test-unit` green.
- A torrent list mixing live and dead torrents. AC8.1 needs a moment
  when every torrent is healthy; AC8.2 and AC8.3 need at least one
  torrent that reaches and holds zero peers.
- Constants in play, from `src/engine/announce.js`: sweep every 60
  seconds, per-torrent cooldown 5 minutes, cap of 5 per sweep.
- Timestamped capture, since three of the four criteria are timing
  claims:

```bash
npm start 2>&1 | while IFS= read -r l; do \
  printf '%s %s\n' "$(date +%H:%M:%S)" "$l"; done \
  | tee /tmp/sweep-verify.log
```

Read back with `grep 'announce sweep:' /tmp/sweep-verify.log`.

**Copy whole lines.** The format is
`announce sweep: re-announced %d stalled torrent(s), %d deferred: %s`.
The trailing deferred count and info hashes are what distinguish a
saturated cap from a quiet sweep, and they are exactly what the first
transcription lost.

## Procedure

| Step | Action | Expected |
| --- | --- | --- |
| 1 | Start under the capture command. Note wall-clock start. | App launches, `Engine:` lines flow. |
| 2 | Confirm every torrent shows a non-zero peer count. Stop or remove dead ones to reach that state. | All rows show peers. Record the count and that the precondition was met. |
| 3 | Watch five minutes without touching the list, then grep. | **AC8.1:** zero matches across at least five sweep ticks. A match invalidates the run unless a torrent dropped to zero mid-watch -- note the time and restart. |
| 4 | Pick one torrent and wait for it to reach zero peers. Note the time. | Peer count reads 0. |
| 5 | Watch for the next sweep line naming that info hash. | **AC8.2:** a line within about 60 seconds, with the hash in the trailing list. Record zero-peer time, line time, and the full raw line. |
| 6 | Within 30 seconds of that line, re-check the peer count. | **AC8.2, the load-bearing half:** peers return, or they do not. Record the number either way. |
| 7 | Keep that torrent at zero peers, watch 12+ minutes, collect every line naming its hash. | **AC8.3:** consecutive timestamps for the same hash are at least 5 minutes apart. |
| 8 | Quit fully. Restart with 5+ torrents under the same capture. Note restart time. | **AC8.4:** no sweep line in the first 60 seconds. Record the torrent count and the silence, or the raw line if it broke. |

## Reading a failure

**Step 6 returns no peers.** This is a finding, not a failure to
record. If the sweep fires and peers never come back, the stall was
never a discovery problem. Write it down and stop. Do not shorten
`SWEEP_INTERVAL_MS`: a tighter interval against an unresponsive
tracker earns a rate limit that looks like progress.

**Step 7 shows repeats at roughly 60 seconds.** That is a wiring
fault, not a guard fault. The map reaching `runAnnounceSweep` would not
be the one being written. `test/unit/engine-announce.js` already proves
the guards hold when the map is passed correctly, so check the
`lastAnnounceAt` declaration and `runSweep` passing it through before
touching `announce.js`.

## End to end: does the original symptom recur

The bug report that started this work was behavioural, not numeric:
downloads stopping and staying stopped until a play click revives them.
A green AC8.2 that still leaves downloads dead means something else is
wrong.

Run a normal session of an hour or more with several active downloads.
If a download stops and stays stopped, grep the log for its info hash
and record whether the sweep named it, how many times, and whether
progress resumed without a play click.

## Why these four are manual

| Criterion | Why |
| --- | --- |
| AC8.1 | An assertion about silence sustained over wall-clock minutes. A unit test can assert an empty return; it cannot assert nothing was logged for five minutes without faking the clock inside a spawned child process. |
| AC8.2 | Needs a real tracker and a real swarm with peers to give. The fakes assert what the sweep sends, not what the network does with it. |
| AC8.3 | Same cooldown logic the unit tests cover, but measured against a real clock across real sweep ticks rather than an injected `now`. |
| AC8.4 | Silence again, plus a real process restart and real `infoHash` event ordering. |
| Original symptom | Behavioural and open-ended, with no numeric criterion. |

## Traceability

| Criterion | Automated | Manual |
| --- | --- | --- |
| AC1.1-AC1.5 | `engine-announce.js` | -- |
| AC2.1-AC2.3 | `engine-announce.js` | -- |
| AC3.1-AC3.3 | `engine-announce.js` | -- |
| AC4.1-AC4.2 | `engine-announce.js` | -- |
| AC5.1-AC5.2 | `engine-announce.js` | -- |
| AC6.1-AC6.3 | `engine-announce.js` | -- |
| AC7.1-AC7.3 structure | `engine-sweep-wiring.js` | -- |
| AC7.1-AC7.2 behaviour | none by design | steps 3, 5, 8 |
| AC7.4 | `engine-entry.js:115` | -- |
| AC8.1 | none by design | steps 1-3 |
| AC8.2 | none by design | steps 4-6 |
| AC8.3 | none by design | step 7 |
| AC8.4 | none by design | step 8 |
| Original symptom | none | end to end |
