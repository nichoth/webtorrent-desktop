# Stalled Torrent Announce Sweep -- Phase 4: Verify against the real app

**Goal:** Find out whether the sweep actually does what it was built to
do, against real torrents and real trackers, and then retire the manual
diagnostic that this work replaces.

**Architecture:** No new code. Phases 1-3 proved the guards against
fakes and proved the wiring by reading the source. Neither can tell you
whether a re-announce brings peers back, whether the cooldown holds
across real sweeps, or whether the original symptom is gone. Only
running the app can.

**Tech Stack:** A development run via `npm start` -- a Tauri dev build,
not a packaged app. Engine output is relayed to the host log with an
`Engine:` prefix by the Rust host in `src-tauri/src/engine.rs`:

- **line 373**, `println!("Engine: {line}")`, in the **stdout** loop.
  This is the one that matters here -- the sweep logs through
  `console.log`, which is stdout.
- line 363, `eprintln!("Engine: {line}")`, in the **stderr** thread.

Both carry the same prefix, so in practice you just watch for
`Engine: announce sweep:`. The distinction is recorded because getting
it backwards would send someone hunting the wrong stream.

Do not go looking for this in `src/engine/AGENTS.md`. Its stdout
contract section points at `src/main/log.js` and
`src/main/engine-process.js`, and **neither file exists** -- `src/main/`
was removed when the host moved to Tauri, and that paragraph was left
behind. The `WEBTORRENT_ENGINE_PORT=` half of what it describes is
still accurate; the ownership half is not.

**Scope:** Phase 4 of 4, from
`/Users/nick/code/webtorrent-desktop/docs/superpowers/plans/2026-08-05-stalled-torrent-announce-sweep.md`

**Codebase verified:** 2026-08-05

**Depends on:** Phase 3. The sweep must be wired and `npm test` green.

---

## Acceptance Criteria Coverage

This phase verifies, **by human observation only**:

### stalled-torrent-announce-sweep.AC8: The sweep behaves in the real app

- **stalled-torrent-announce-sweep.AC8.1 Failure:** With every torrent
  showing a peer count, no `announce sweep:` line appears for five
  minutes. A sweep that logs when nothing is wrong is a sweep that will
  be ignored.
- **stalled-torrent-announce-sweep.AC8.2 Success:** Within about a
  minute of a torrent dropping to zero peers, an `announce sweep:` line
  names it.
- **stalled-torrent-announce-sweep.AC8.3 Failure:** A torrent that
  stays at zero peers is not named again for five minutes.
- **stalled-torrent-announce-sweep.AC8.4 Failure:** After a restart
  with several torrents in the list, no `announce sweep:` line appears
  in the first minute.

**Why none of these are automated:** each one needs a real tracker, a
real peer swarm and wall-clock minutes. AC8.1 and AC8.4 are assertions
about *silence over time*, which a unit test cannot make without either
faking the clock inside a spawned sidecar or waiting five real minutes
per assertion. AC8.2 depends on a swarm actually having peers to give.
This is a genuine coverage boundary, not an oversight -- record the
results so it is auditable.

---

<!-- START_TASK_1 -->
### Task 1: Observe the sweep in the real app

**Verifies:** stalled-torrent-announce-sweep.AC8.1,
stalled-torrent-announce-sweep.AC8.2,
stalled-torrent-announce-sweep.AC8.3,
stalled-torrent-announce-sweep.AC8.4

**Files:**
- Create: `/Users/nick/code/webtorrent-desktop/docs/implementation-plans/2026-08-05-stalled-torrent-announce-sweep/verification-notes.md`

This task produces a written result. That file is the deliverable --
"I watched it and it seemed fine" is not.

**Step 1: Start the app with a visible terminal**

Run:

```bash
npm start
```

Engine stdout is relayed with an `Engine:` prefix, so sweep lines
appear as:

```
Engine: announce sweep: re-announced 1 stalled torrent(s), 0 deferred: <hash>
```

**Step 2: Confirm the sweep is quiet when nothing is stalled (AC8.1)**

With every torrent showing a peer count, watch for five minutes. There
should be **no** `announce sweep:` lines at all.

Record: how many torrents were in the list, how long you watched, and
whether any line appeared.

**Step 3: Confirm it fires when something stalls (AC8.2)**

Wait for a torrent to drop to zero peers. Within about a minute you
should see a sweep line naming its info hash.

Record: the time the torrent hit zero peers, the time the sweep line
appeared, and -- the thing this whole plan is for -- whether the
torrent picked up peers within the next 30 seconds.

**Step 4: Confirm the cooldown holds (AC8.3)**

If the torrent stays at zero peers, the same info hash must **not**
appear again for five minutes.

A sweep line every minute for the same torrent means the map reaching
`runAnnounceSweep` is not the one being written. That is a bug in
Phase 3's wiring, not in the guards -- Phase 2's tests already prove
the guards work when the map is passed correctly. Check **Step 2** of
Phase 3 Task 2 (the declaration) and **Step 5** (`runSweep` passing
`lastAnnounceAt` through) before touching `announce.js`.

Not Step 3: that is the `infoHash` seed, which governs the restart
behaviour in AC8.4, not repeat lines.

Record: the interval between repeat lines for the same hash.

**Step 5: Confirm a restart does not stampede (AC8.4)**

Quit and restart the app with several torrents in the list. No
`announce sweep:` line should appear in the first minute: every torrent
was seeded into the map as its info hash arrived.

Record: how many torrents were in the list, and whether the first
minute was silent.

**Step 6: Confirm the original symptom is gone**

Use the app normally for a session. The thing to watch for is the
original report: **downloads stopping and staying stopped until a play
click revives them.**

Record: whether it recurred, and if it did, whether the sweep logged
anything for the affected torrents.

**Step 7: Write the notes file**

Write everything recorded above to `verification-notes.md` in this
plan's directory, with dates and times. Include the raw log lines, not
a summary of them.

**Stop condition -- read this before tuning anything.**

If the sweep is firing and peers still do not come back, the stall is
not a discovery problem after all. **Say so, and stop.** Do not tune
the interval down: a shorter interval against an unresponsive tracker
just gets the client rate limited, which makes the problem worse while
looking like effort. Write the finding in `verification-notes.md`,
leave the sweep in place or revert it on the user's call, and do not
proceed to Task 2 -- the diagnostic is still earning its keep if the
question is still open.

**Commit:**

```bash
git add docs/implementation-plans/2026-08-05-stalled-torrent-announce-sweep/verification-notes.md
git commit -m "docs: record real-app verification of the announce sweep"
```
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Retire the force-announce diagnostic

**Verifies:** None. This is removal of instrumentation that has served
its purpose.

**Gate:** Do this **only** if Task 1 confirmed the sweep works. If
Task 1 hit the stop condition, skip this task entirely -- the manual
instrument is the only way left to investigate.

The design calls this "a separate change", and it should be its own
commit for the same reason: it is a revert of the diagnostic plan, not
part of the sweep.

**`announceNow` in `src/engine/announce.js` stays.** The sweep is its
caller now. Only the manual trigger and its plumbing come out.

**Files -- the complete inventory, verified 2026-08-05:**

Every range below **includes the leading comment and the closing
brace**. Deleting a narrower range leaves a syntax error or an orphaned
comment.

**Two numbering conventions are in play here, and mixing them is the
main way this task goes wrong.** The table gives numbers as they stand
*before* this task's edits. The blank-line list further down gives two
numbers (250 and 341) as they stand *after* the other deletions in the
same file. Both are correct for the natural execution order -- work
top to bottom, file by file -- but every number shifts as you edit. As
in Phase 3: anchor on the code, not the number.

> ### Also delete one bounding blank line per range
>
> Six of the nine ranges below are surrounded by a blank line on each
> side. Deleting exactly the stated range therefore leaves **two
> consecutive blank lines**, which is `no-multiple-empty-lines` under
> `standard`.
>
> (The two exceptions need no blank-line handling and are listed here
> only so their absence does not read as an oversight: the
> `wt-force-announce` handler in `index.js` is preceded by code, and
> the menu item in `torrent-list-controller.js` sits between two other
> object literals. The six-file list below is the authoritative one.)
>
> This is not cosmetic. `npm test` is
> `npm run lint && depcheck && npm run test-unit`, so `standard` runs
> **first** and Step 7 goes red before a single test executes. Worse,
> the per-file `npx tape` gate in Step 3 still passes, because tape
> does not lint -- so the plan's own mid-flight check hands you a green
> light on a change that cannot reach the test runner.
>
> For each deletion, take the construct **plus one of its bounding
> blank lines.** Verified affected files and the line the doubled blank
> lands on if you do not: `test/unit/torrent-context-menu.js` 250,
> `src/renderer/controllers/torrent-list-controller.js` 161,
> `test/unit/engine-ipc-call-sites.js` 341,
> `src/renderer/lib/platform/ipc-engine.js` 338,
> `src/engine/index.js` 206 (post-Phase-3; it is 197 before),
> `test/unit/platform-ipc-engine.js` 253.
>
> **One range needs more than a blank line.** In
> `test/unit/engine-ipc-call-sites.js`, `'forceAnnounce'` at line 91 is
> the **last element of an array**. Removing only line 91 leaves
> `'selectFiles',` at line 90 with a trailing comma before the `]`,
> which is `comma-dangle`. Drop that comma as part of the same edit.

> ### The `src/engine/index.js` numbers below are post-Phase-3
>
> Every other file in this table is untouched by Phases 1-3, so its
> numbers are the ones you will find. **`src/engine/index.js` is not.**
> Phase 3 inserts roughly nine lines above the diagnostic: seven for
> the `lastAnnounceAt` map after line 82, one for the second
> `setInterval` in `init()`, and one for `lastAnnounceAt.delete` in
> `stopTorrenting`.
>
> The numbers in this row are therefore given **as they will be after
> Phase 3**, which is when this task runs. For reference, they were
> 110-111, 199-202 and 204-235 before Phase 3.
>
> Anchor on the code, not the number. Getting this wrong is not a near
> miss: post-Phase-3, lines 199-202 are the closing brace of
> `startTorrenting`, a blank line, the `function stopTorrenting
> (infoHash) {` signature and its `console.log`. Deleting the
> pre-Phase-3 range therefore decapitates two functions at once and
> leaves a syntax error, in a file whose other edits you have just
> spent Phase 3 getting right.

| File | What to remove |
| --- | --- |
| `src/engine/index.js` (post-Phase-3) | the `bus.on('wt-force-announce', ...)` handler at lines 117-118; `ANNOUNCE_DIAG_DELAYS_MS` with its comment at lines 208-211; `forceAnnounce` with its comment at lines 213-244 |
| `src/renderer/lib/platform/ipc-engine.js` | the `forceAnnounce` export at lines 350-352, plus its JSDoc block at lines 338-349 |
| `src/renderer/controllers/torrent-list-controller.js` | the `forceAnnounce` method at lines 164-167 (167 is its closing brace), plus its `DIAGNOSTIC:` comment at lines 161-163; the `Force Re-announce` menu item at lines 304-307 |
| `docs/platform-shim.md` | the shim table row at line 784; the protocol table row at line 948; the `wt-force-announce is diagnostic instrumentation` paragraph at lines 950-955; the "nine-item torrent context menu" wording at line 445 |
| `test/unit/engine-force-announce.js` | delete the whole file |
| `test/unit/engine-ipc-call-sites.js` | the `'forceAnnounce'` entry at line 91; the `a forced re-announce goes through the shim` test at lines 342-352 |
| `test/unit/platform-ipc-engine.js` | the `forceAnnounce names the torrent to re-announce` test at lines 253-261 |
| `test/unit/torrent-context-menu.js` | **five separate sites -- see the warning below** |

**Three of these rows are not in the design's removal list** --
`engine-ipc-call-sites.js`, `platform-ipc-engine.js` and
`torrent-context-menu.js` -- and the last of them turns the suite red
in a way the design's own verification step cannot see.

The design says only "the `forceAnnounce` export in `ipc-engine.js`"
without a directory. That is worth pinning down rather than guessing:
`src/main/` does not exist in this tree at all, and the shim lives at
`src/renderer/lib/platform/ipc-engine.js`.

### The context menu test is the one that will bite

Removing the menu item breaks **five** sites in
`test/unit/torrent-context-menu.js`, and only three of them mention
re-announce:

1. **Line 166** -- inside the full-menu `deepEqual` at lines 155-171.
2. **Line 201** -- inside the no-files `deepEqual` at lines 191-206.
3. **Lines 252-258** -- `test('the menu offers a forced re-announce')`,
   delete the whole test.
4. **Lines 185-186** -- `t.equal(labels.filter(Boolean).length, 8,`
   followed by the message `` `${platform} gets the same eight items` ``.
   The count becomes **7** and the word "eight" in the message becomes
   "seven". Change both: a passing assertion whose message says
   "eight" is a lie that survives the suite.
5. **Line 235** -- `t.equal(items.length, 7, 'seven unconditionally
   enabled items')`. The count becomes **6**, and the message needs
   rewording to "six".

Sites 4 and 5 are the trap. They are bare numbers with no mention of
announcing anything, so an engineer who fixes the two `deepEqual`
blocks and deletes the named test still lands red twice, with failure
messages that give no hint where to look.

Two further consequences need no edit but are worth knowing so the
final count is not a surprise. Several loops iterate the menu, and each
one shrinks by one assertion: the plain-object loop, the `enabled` loop
inside `test('no other item sets enabled')` at lines 236-238 -- which
walks the very array whose length site 5 decrements -- and the arity
loop around line 324. Add the two assertions the deleted test takes
with it and the total loss is **five**.

So the file's assertion count falls from **56** today to **51** after a
correct removal.

They are also invisible to a `forceAnnounce` grep, because what appears
in this file is the **label** `Force Re-announce`. That is why Step 6's
guard grep below searches for the label and the log prefix too, not
just the function name.

**Step 1: Remove the engine side**

Delete the handler, the constant and the function from
`src/engine/index.js` as listed above.

Then **narrow the import**. The `announceNow` call inside
`forceAnnounce` -- line 229 post-Phase-3, 220 before it -- is the only
place `index.js` calls it; `runSweep` reaches it indirectly
through `runAnnounceSweep`. So once `forceAnnounce` is gone the import
must lose `announceNow` or `standard` fails on an unused binding:

```js
import { runAnnounceSweep, SWEEP_INTERVAL_MS } from './announce'
```

`announceNow` itself stays exported from `announce.js`. Only this
import narrows.

**Step 2: Remove the renderer side**

Delete the export and its JSDoc from
`src/renderer/lib/platform/ipc-engine.js`, and the method, its comment
and the menu item from
`src/renderer/controllers/torrent-list-controller.js`.

**Step 3: Remove the tests**

```bash
git rm test/unit/engine-force-announce.js
```

Then remove the two entries in `test/unit/engine-ipc-call-sites.js`,
the one test in `test/unit/platform-ipc-engine.js`, and **all five
sites** in `test/unit/torrent-context-menu.js` -- including the two
count assertions at lines 185 and 235, which must be decremented to 7
and 6 respectively and the "seven unconditionally enabled items"
message reworded.

Run that file on its own before moving on, because it is the one most
likely to be left half-fixed:

```bash
npx tape test/unit/torrent-context-menu.js
```

Expected: PASS, **51 assertions** (it is 56 before the removal). If it
passes with 56 you have not removed anything; if it passes with some
other number, one of the five sites was handled differently than
described above.

Note this gate does **not** lint. Passing here says nothing about the
blank-line and comma-dangle problems described at the top of this task
-- those surface only at Step 7.

**Step 4: Remove the docs**

Delete the first three pieces in `docs/platform-shim.md` listed above.

Line 445 is **reworded, not deleted** -- the row documents
`showContextMenu`, which stays. It currently reads:

```
| `showContextMenu(items)` | `controllers/torrent-list-controller.js:258-310`, the nine-item torrent context menu |
```

One thing is wrong with it:

- **"nine-item" becomes "seven-item".** Seven is the count of actual
  labels after the removal, matching the number Step 3 puts at line 185
  of `torrent-context-menu.js`. Do not count separators; the sentence
  says "item" and the test counts labels.

> ### Correction, added 2026-08-05 during execution
>
> **This step used to carry a second bullet instructing you to update
> the cited range `258-310`, on the grounds that it was stale. That
> instruction was wrong. Do not update the range.**
>
> Citations in `docs/platform-shim.md` are **historical**, pinned to
> `d187b0d` (US-018, the commit that created the document). They record
> what the pre-migration source looked like; they do not track current
> line numbers. Every citation in that file resolves exactly against
> `d187b0d` -- all nineteen into `torrent-list-controller.js`, plus the
> `fs.js`, `state.js` and `migrations.js` tables. An audit run against
> any later commit will appear to find half a dozen errors in them and
> will be wrong.
>
> `258-310` is correct: at that baseline, line 258 is
> `const menu = new remote.Menu()` and line 310 is
> `menu.popup({ window: remote.getCurrentWindow() })` -- exactly the
> `remote.Menu` block the surrounding prose describes, and the reason
> line 469 can say it is the only one in `src/renderer/`.
>
> Following the old instruction broke the line twice in one sitting:
> once to `265-312` as written, then to `257-304` when a reviewer
> re-anchored it to the current post-shim file. The second was worse,
> because `remote.Menu` no longer appears anywhere in `src/renderer/`,
> so line 469 ended up naming a range that provably does not contain
> the thing it claims. Both were reverted.
>
> The root confusion is worth naming: the old bullet said the builder
> "is at `265-316` today", but after Step 3 the menu descriptors live
> in `torrent-context-menu.js`, so that range named a location in a
> different file from the one the citation references.

Line 469 of the same file carries the identical range in "Verified at
US-025: `controllers/torrent-list-controller.js:258-310`". It is also
correct and also must not be updated. Both are left exactly as they
are; only the "nine-item" wording on line 445 changes.

**Step 5: Update the engine notes**

In `src/engine/AGENTS.md`, delete the `wt-force-announce` paragraph at
lines 149-154. Keep the `announceNow` paragraph and the sweep
paragraph Phase 3 added -- both are still true.

**Step 6: Confirm nothing references it any more**

Run:

```bash
grep -rn \
  "forceAnnounce\|wt-force-announce\|ANNOUNCE_DIAG\|Force Re-announce\|DIAG announce" \
  src/ test/ docs/platform-shim.md
```

Expected: no output. Hits under `docs/superpowers/plans/` and
`docs/implementation-plans/` are the historical design and plan
documents and stay.

The last two patterns are the point of this step. The identifier
`forceAnnounce` never appears in
`test/unit/torrent-context-menu.js` -- what appears there is the user
facing label `Force Re-announce` -- so a grep for the function name
alone reports a clean removal while five assertions sit broken.

**Step 7: Verify the suite**

Run:

```bash
npm test
```

Expected: PASS.

Two things this step is checking that are easy to miss:

- The engine source scan asserts `subs.length > 5` over bus
  subscriptions. `src/engine/index.js` has 10 `bus.on(` calls today, so
  removing one leaves 9 and the assertion holds.
- `test/unit/torrent-context-menu.js` passes with its two counts
  decremented. If this file is red here, Step 3 was left half-done --
  go back to sites 4 and 5, not to the engine.

**Commit:**

```bash
git commit -am "chore: remove the force-announce diagnostic"
```
<!-- END_TASK_2 -->

---

## Done when

- `verification-notes.md` exists and records real observations with
  times and raw log lines, for all four AC8 criteria plus the original
  symptom.
- **Either** the sweep is confirmed working and the diagnostic is
  removed with `npm test` green, **or** the stop condition was hit, it
  is written down, and Task 2 was deliberately skipped.
