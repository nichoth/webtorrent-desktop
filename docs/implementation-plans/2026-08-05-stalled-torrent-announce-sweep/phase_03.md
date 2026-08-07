# Stalled Torrent Announce Sweep -- Phase 3: Wire the sweep into the engine

**Goal:** Give the engine an interval that runs the sweep once a minute,
and a `lastAnnounceAt` map with a lifecycle -- seeded when a torrent
arrives, cleared when it stops.

**Architecture:** `src/engine/index.js` owns only three things: the
`setInterval`, the map, and the map's lifecycle. Every guard and every
decision stays in `announce.js`, where Phases 1 and 2 tested them. This
phase adds no new export and no new bus channel: the sweep is engine
behaviour the UI never asks for and never hears about.

**Tech Stack:** Node sidecar (`src/engine/`, ESM compiled by Babel to
`build/`), `webtorrent` 1.9.7, `tape` 5.10.2, `standard` style.

**Scope:** Phase 3 of 4, from
`/Users/nick/code/webtorrent-desktop/docs/superpowers/plans/2026-08-05-stalled-torrent-announce-sweep.md`

**Codebase verified:** 2026-08-05

**Depends on:** Phases 1 and 2. `runAnnounceSweep` and
`SWEEP_INTERVAL_MS` must exist and be exported.

---

## Acceptance Criteria Coverage

This phase implements and tests:

### stalled-torrent-announce-sweep.AC7: The engine drives the sweep

- **stalled-torrent-announce-sweep.AC7.1 Success:** `index.js` imports
  `runAnnounceSweep` and `SWEEP_INTERVAL_MS` from `./announce`, and a
  `setInterval` drives a `runSweep` function at `SWEEP_INTERVAL_MS`
  which calls into `runAnnounceSweep`.
- **stalled-torrent-announce-sweep.AC7.2 Success:** A new torrent seeds
  `lastAnnounceAt` when its info hash arrives, so it is not announced
  the moment it starts.
- **stalled-torrent-announce-sweep.AC7.3 Success:** A stopped torrent
  is removed from `lastAnnounceAt`, so the map cannot grow without
  bound.
- **stalled-torrent-announce-sweep.AC7.4 Success:** The existing engine
  source scan still passes after the `bus.send` call site is edited --
  in particular "every send goes through the bus".

---

## Why this phase's test is a source scan

The behaviour is already covered: Phases 1 and 2 test every guard
against fakes with an injected clock. What is left is wiring, and
wiring here is genuinely awkward to test any other way.

A sweep that fires once a minute is far too slow to drive from the
spawned-sidecar tests in `test/unit/engine-entry.js`, which poll with a
5 second timeout. The alternatives are worse: a test-only override of
`SWEEP_INTERVAL_MS` would be production code that exists only for a
test, and faking time inside a spawned child process is a large amount
of machinery for a `setInterval` call.

So this phase's test is a source-level check in the same shape as the
scan at `test/unit/engine-entry.js:115` and the engine walks at
`test/unit/platform-boundary.js:401-427`. **It asserts the parts are
connected, not that they work.** That is a real limitation and it is
the reason Phase 4 exists.

---

## Verified codebase state

All line numbers confirmed on branch `stalled-torrent-announce-sweep`
on 2026-08-05, **before** this phase's edits. They shift as you edit;
anchor on the code, not the number.

| What | Where | Current state |
| --- | --- | --- |
| Announce import | `src/engine/index.js:33` | `import { announceNow } from './announce'` |
| `servers` Map | `src/engine/index.js:82` | `const servers = new Map()` |
| `prevProgress` | `src/engine/index.js:84-85` | comment then `let prevProgress = null` |
| `init()` call | `src/engine/index.js:87` | `init()` |
| `init()` body | `src/engine/index.js:89-148` | -- |
| Progress interval | `src/engine/index.js:137` | `setInterval(updateTorrentProgress, 1000)` |
| `stopTorrenting` | `src/engine/index.js:193-197` | 4-line body |
| `ANNOUNCE_DIAG_DELAYS_MS` | `src/engine/index.js:202` | diagnostic, leave alone |
| `forceAnnounce` | `src/engine/index.js:208-235` | diagnostic, leave alone |
| `addTorrentEvents` | `src/engine/index.js:247` | -- |
| `infoHash` handler | `src/engine/index.js:252-253` | one-line arrow, confirmed |
| `announce.js` section | `src/engine/AGENTS.md:140-154` | two paragraphs; 154 is the last line of the file |
| Wiring test | `test/unit/engine-sweep-wiring.js` | **does not exist** |

Two facts that make the ordering below safe:

- **`client` is created at module scope**, `src/engine/index.js:75`:
  `const client = new WebTorrent({ peerId: PEER_ID })`. It is never
  lazy, so `client.torrents` and `client.dht` are always available when
  an interval callback fires. `client.torrents` is already read at
  line 345 and `client.dht` at line 220.
- **`init()` is called at line 87.** The `lastAnnounceAt` declaration
  must go *above* that call or it is in the temporal dead zone when
  `init()` runs. Inserting immediately after line 82 satisfies this.
  `runSweep` itself is a hoisted function declaration, so it may be
  defined lower in the file.

---

## Constraints for this phase

- `src/engine/index.js` is scanned by `test/unit/engine-entry.js:115`.
  With comment lines dropped, that scan fails on: any
  `window.` / `document.` / `navigator.` reference; any `.send(` that
  is not `bus.send(`; any `.on('wt-` subscription that is not
  `bus.on(`; more than one `createWebSocketBus(`. Task 2 Step 3 edits a
  `bus.send` call site, which is why Task 2 Step 8 re-runs it
  explicitly.
- `test/unit/platform-boundary.js:401-427` additionally walks every
  `.js` file in `src/engine/` for Electron imports and DOM globals.
- Style is `standard`; lines under 80 columns; no em dashes, no arrow
  character.
- Do not touch `forceAnnounce` or `ANNOUNCE_DIAG_DELAYS_MS`. Removing
  the diagnostic is Phase 4's final step, deliberately after the sweep
  has been shown to work.

---

<!-- START_TASK_1 -->
### Task 1: The failing wiring test

**Verifies:** stalled-torrent-announce-sweep.AC7.1,
stalled-torrent-announce-sweep.AC7.2,
stalled-torrent-announce-sweep.AC7.3

**Files:**
- Create: `/Users/nick/code/webtorrent-desktop/test/unit/engine-sweep-wiring.js`
  -- unit (source scan)

**Step 1: Create the test file**

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

Note this file reads `src/engine/index.js`, **not** `build/`. That is
deliberate and matches `test/unit/platform-boundary.js:24`, which also
scans sources: the point is what the source says, and Babel output
would have the ESM `import` rewritten to `require`, breaking the first
assertion.

**Step 2: Run the test to verify it fails**

Run:

```bash
npx tape test/unit/engine-sweep-wiring.js
```

Expected: FAIL on all seven assertions. No build is needed for this one
file, because it reads `src/` directly.

> ### Expected red. Do not treat this task as failed.
>
> **This task ends with a failing test on purpose.** It is the red half
> of red-green, split out so the test is written before the code it
> checks rather than shaped to fit it.
>
> If you are an orchestrator running a green-suite gate per task: this
> task does not satisfy it and is not supposed to. The gate applies to
> Task 2, which commits the test and the implementation together. Do
> not "fix" the red by writing the wiring here -- that is Task 2 -- and
> do not report this task as a failure.
>
> Phases 1 and 2 keep test and implementation inside one task and so
> never go red between tasks. Phase 3 splits them because the
> implementation spans six separate edit sites across two files, and
> reviewing that as one blob alongside a new test file is worse than
> the momentary red.

**Commit:** none yet. This test is committed with its implementation in
Task 2, so no commit ever lands with a knowingly failing test.
<!-- END_TASK_1 -->

<!-- START_TASK_2 -->
### Task 2: Wire it up

**Verifies:** stalled-torrent-announce-sweep.AC7.1,
stalled-torrent-announce-sweep.AC7.2,
stalled-torrent-announce-sweep.AC7.3,
stalled-torrent-announce-sweep.AC7.4

**Files:**
- Modify: `/Users/nick/code/webtorrent-desktop/src/engine/index.js`
  (lines 33, 82, 137, 193-197, 252-253, and an insertion after 235)
- Modify: `/Users/nick/code/webtorrent-desktop/src/engine/AGENTS.md`
  (append to the `announce.js` section, after line 154)

**Step 1: Widen the import**

`src/engine/index.js:33`. Replace:

```js
import { announceNow } from './announce'
```

with:

```js
import { announceNow, runAnnounceSweep, SWEEP_INTERVAL_MS } from './announce'
```

That line is 77 characters, within the 80 column limit. `announceNow`
stays because the diagnostic `forceAnnounce` still calls it.

**Step 2: Add the map**

Insert immediately after `src/engine/index.js:82`
(`const servers = new Map()`) and before the `prevProgress` comment.
It must be above the `init()` call at line 87.

```js

// Info hash -> when the sweep last asked this torrent to announce. A
// torrent that has never been asked is eligible immediately, so a new
// torrent is seeded here when its info hash arrives: `client.add()`
// has just sent a `start` announce of its own and a second one a
// minute later would be pure waste.
const lastAnnounceAt = new Map()
```

**Step 3: Seed the map when a torrent arrives**

`src/engine/index.js:252-253`, inside `addTorrentEvents`. Replace the
one-line arrow:

```js
  torrent.on('infoHash', () =>
    bus.send('wt-parsed', torrent.key, torrent.infoHash, torrent.magnetURI))
```

with a block:

```js
  torrent.on('infoHash', () => {
    // `client.add()` announces `started` as it goes, so the sweep's
    // clock for this torrent starts here rather than at zero.
    lastAnnounceAt.set(torrent.infoHash, Date.now())
    bus.send('wt-parsed', torrent.key, torrent.infoHash, torrent.magnetURI)
  })
```

The `bus.send` line is unchanged and still spelled `bus.send(`, which
is what keeps the "every send goes through the bus" assertion green.

**Step 4: Clear the map when a torrent stops**

`src/engine/index.js:193-197`. Replace:

```js
function stopTorrenting (infoHash) {
  console.log('--- STOP TORRENTING: ', infoHash)
  const torrent = client.get(infoHash)
  if (torrent) torrent.destroy()
}
```

with:

```js
function stopTorrenting (infoHash) {
  console.log('--- STOP TORRENTING: ', infoHash)
  lastAnnounceAt.delete(infoHash)
  const torrent = client.get(infoHash)
  if (torrent) torrent.destroy()
}
```

The delete goes before the `client.get`, so the map is cleaned whether
or not the torrent is still there to destroy.

**Step 5: Add the sweep**

Insert after the closing brace of `forceAnnounce`
(`src/engine/index.js:235`), leaving the diagnostic itself untouched:

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

**Step 6: Start the interval**

`src/engine/index.js:137`, inside `init()`. Replace:

```js
  setInterval(updateTorrentProgress, 1000)
```

with:

```js
  setInterval(updateTorrentProgress, 1000)
  setInterval(runSweep, SWEEP_INTERVAL_MS)
```

`runSweep` is a hoisted function declaration, so referring to it here
before its definition lower in the file is fine -- the same pattern the
surrounding code already uses.

**Step 7: Run the wiring test to verify it passes**

Run:

```bash
npx tape test/unit/engine-sweep-wiring.js
```

Expected: PASS, seven assertions across three tests.

**Step 8: Verify the engine source scan still passes**

Step 3 edited a `bus.send` call site, which is exactly what the scan at
`test/unit/engine-entry.js:115` polices. This spawns the real sidecar,
so it is slower than the other unit files.

Run:

```bash
npm run build:node && npx tape test/unit/engine-entry.js
```

Expected: PASS, including `every send goes through the bus` and
`every subscription goes through the bus`.

**Step 9: Verify the engine boundary walk still passes**

Run:

```bash
npx tape test/unit/platform-boundary.js
```

Expected: PASS, including `index.js uses no DOM global`. The new
`runSweep` uses `console.log`, which is a Node global and not a DOM
one, so this should be green -- confirm rather than assume.

**Step 10: Document it**

Append to the `announce.js` section of
`/Users/nick/code/webtorrent-desktop/src/engine/AGENTS.md`, after
line 154 (the end of the `wt-force-announce` paragraph):

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

**Step 11: Lint**

Run:

```bash
npm run lint
```

Expected: no output, exit 0.

**Step 12: Run the whole suite**

Run:

```bash
npm test
```

Expected: PASS.

**Commit:**

```bash
git add src/engine/index.js src/engine/AGENTS.md \
  test/unit/engine-sweep-wiring.js
git commit -m "feat(engine): re-announce torrents that stall at zero peers"
```
<!-- END_TASK_2 -->

---

## Done when

- `src/engine/index.js` imports the sweep, declares `lastAnnounceAt`,
  seeds it on `infoHash`, clears it in `stopTorrenting`, and drives
  `runSweep` on a `SWEEP_INTERVAL_MS` interval.
- `test/unit/engine-sweep-wiring.js` exists and passes.
- `test/unit/engine-entry.js` and `test/unit/platform-boundary.js`
  still pass.
- `npm test` passes.
- The diagnostic `forceAnnounce` and `ANNOUNCE_DIAG_DELAYS_MS` are
  still present and untouched. They come out in Phase 4, after the
  sweep has earned it.
