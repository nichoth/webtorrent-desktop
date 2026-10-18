<!-- nightralph:entry ticket=memory-leaks:9 attempt=1 outcome=done -->
## 2026-10-17 18:11 -- memory-leaks/09 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $0.47. Checked items: none.

### Agent notes
# Ticket 09: leaving the player resets the media session

## Implemented
- `src/renderer/pages/player-page.js`: renamed the misnamed
  `onComponentWillUnmount` to React's `componentWillUnmount`. It now
  unloads every `audio,video` element (the main element and
  `video#preview`): pause, removeAttribute('src'), load(). The old code
  only handled the first match, and `src = ''` makes the element try to
  load the page URL.
- It also resets `navigator.mediaSession.metadata` to null and clears
  the play/pause/nexttrack/previoustrack action handlers
  (`MEDIA_SESSION_ACTIONS`). renderMedia() registers next and previous
  only when the playlist has them, so a handler left over from the
  last play would otherwise stick. Each setActionHandler call sits in
  a try block because an engine may throw on an action it does not
  support. The metadata reset no longer depends on a media tag being
  found (the old code returned early before it).

## Testing decision
- No automated test was written. The spec's Testing Decisions list the
  player page lifecycle as "Not automated" (pages are Vite-only and
  cannot be required in the unit suite), and the ticket says it is
  verified by hand. I chose not to add a source-scan test for the hook
  name, because the spec rules out automating this.
- `npm test` (lint + depcheck + build + 4224 unit tests) passes.

## Manual checks (not run here, so they need a human with the app)
- Play one file, close the player, play a different file: the system
  media controls should show the second file's title.
- After closing the player, the main and preview media elements no
  longer hold a source.

---
<!-- nightralph:entry ticket=memory-leaks:4 attempt=1 outcome=done -->
## 2026-10-17 18:12 -- memory-leaks/04 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $0.74. Checked items: "The stream is destroyed after a parse that resolves", "The stream is destroyed after a parse that rejects", "`wt-get-audio-metadata` reads through the new module (source scan)".

### Agent notes
# Ticket 04 notes

## Items 1 and 2 (stream destroyed after resolve / reject)
- New `src/engine/audio-metadata.js`: `readAudioMetadata(file, torrentPath,
  options, parser = mm)`. Finished files -> `parser.parseFile(path)`;
  unfinished -> `parser.parseStream(stream).finally(() => stream.destroy())`.
- Parser injected so `test/unit/engine-audio-metadata.js` uses a real
  Readable and a fake parser. Both items share one module, so they landed
  in one red -> green cycle and one commit.

## Item 3 (wiring scan)
- `src/engine/index.js`: `getAudioMetadata` calls `readAudioMetadata(file,
  torrent.path, options)`; dropped the direct `music-metadata` import.
  Reply channel and silence-on-failure (console.log only) unchanged.
- New sibling scan `test/unit/engine-audio-metadata-wiring.js` (chose a
  sibling rather than `engine-torrent-close-wiring.js`, which does not
  exist yet on this branch).
- Added an `audio-metadata.js` section to `src/engine/AGENTS.md`.
- Full `npm test` passed: 4268/4268, lint clean.

---
<!-- nightralph:entry ticket=memory-leaks:2 attempt=1 outcome=done -->
## 2026-10-17 18:13 -- memory-leaks/02 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $0.91. Checked items: "Announce times, corrupt-peer counters and stall samples are forgotten from the torrent's own close handler, not only from stop-torrenting (source scan)", "A torrent that closed and is started again under the same info hash does not report as stalled on its first progress update".

### Agent notes
# Ticket 02: engine forgets per-torrent state on close

## Implemented
- `src/engine/index.js`: `addTorrentEvents` installs
  `torrent.once('close', torrentClose)`. `torrentClose` reads
  `torrent.infoHash` and deletes `lastAnnounceAt`, `corruptPeerStats`
  and `stalls.forget`. `stopTorrenting` no longer repeats the cleanup;
  `torrent.destroy()` emits `close` synchronously.
- Guard: `if (client.get(infoHash)) return`. WebTorrent 1.9.7 destroys a
  duplicate add after assigning the live torrent's infoHash
  (`_infoHash` event), and `_destroy` calls `client._remove(this)`
  before `emit('close')`, so a hit at close time is a different live
  torrent. Without the guard a duplicate start-torrenting would wipe the
  live torrent's stall/announce/corrupt state.
- New test `test/unit/engine-torrent-close-wiring.js` (source scan).
- `src/engine/AGENTS.md`: new section on the close handler; removed the
  stale "orphans are inert" paragraph.

## How the ACs were read
- AC1 (source scan): covered directly by the new wiring test.
- AC2 ("resumed torrent not stalled on first progress update"): the
  behaviour of a forgotten key is already pinned against plain values in
  `test/unit/engine-stall.js` ("a forgotten torrent starts over"); the
  new scan pins that the close handler is what forgets. A real sidecar
  test would need a 60s stall per case and a way to trigger a fatal
  torrent error, so it was not automated. Same code change satisfies
  both items, so they share one commit.

## For tickets 03 and 05
- Add server-entry and selection cleanup inside `torrentClose`, after
  the duplicate guard. The scan asserts exactly one
  `.on/.once('close', torrentClose)` exists.
- Existing `engine-hashfail-wiring.js` pins the literal
  `corruptPeerStats.delete(infoHash)` and `stalls.forget(infoHash)`, so
  the handler binds a local `infoHash`.

---
<!-- nightralph:entry ticket=memory-leaks:1 attempt=1 outcome=done -->
## 2026-10-17 18:13 -- memory-leaks/01 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $0.98. Checked items: "Deleting a torrent removes its info hash from the resume list".

### Agent notes
# Notes: 01 resume list never names a deleted torrent

## Item 1: delete removes info hash from resume list
- `deleteTorrent` filters `state.saved.torrentsToResume`.
- Test: `test/unit/torrent-list-resume.js` (controller compiled under
  `.resume-test.js` suffix; all shim modules stubbed then withdrawn).

## Item 2: delete all empties the resume list
- `deleteAllTorrents` sets `torrentsToResume = []`.

## Item 3: resuming skips missing torrents and resets the list
- `resumePausedTorrents` snapshots the list, resets it before the loop
  (so a throw from one entry still leaves it reset), and skips any hash
  `TorrentSummary.getByKey` cannot find. Read "even if resuming one
  entry fails" as: the reset happens before any toggle, not that every
  entry's error is swallowed.

## Item 4: prioritizing twice adds no duplicates
- `prioritizeTorrent` pushes only hashes not already in the list.
- Duplicates arise when the user restarts a paused torrent by hand and
  plays again; the test models exactly that.
- Ran the new file with `torrent-context-menu.js` in both orders: green.

## Final
- npm test: 4242/4242 pass, lint clean. test/AGENTS.md notes the
  `.resume-test.js` emit suffix.

---
<!-- nightralph:entry ticket=memory-leaks:10 attempt=1 outcome=done -->
## 2026-10-17 18:14 -- memory-leaks/10 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $0.71. Checked items: "No site pushes to `state.errors` directly (source scan)", "Recording many errors over a span longer than the banner window keeps the list bounded", "Errors recorded within the banner window are kept".

### Agent notes
# Ticket 10: error list stays bounded

Implemented:
- `src/renderer/lib/error-list.js`: `ERROR_WINDOW_MS` (5000),
  `isRecent(error, now)`, `recordError(errors, message, now?)`.
  recordError prunes stale entries in place (same array, so
  `state.errors` references stay valid), then pushes.
- `main.js` onError and `cast-controller.js` raise use recordError.
- `pages/app.js` banner filter uses `isRecent` (shared window).
- `test/unit/error-list.js`: bounded-list, keeps-recent, same-array,
  and a source scan of src/renderer for `.errors.push/unshift/splice(`.
- AGENTS.md note in src/renderer/controllers.

Reading of criteria: "bounded" = at most window/interval + 1 entries
when errors arrive at a steady rate over 60 s.

Gotcha: compiling only `src/renderer/lib` with babel leaves `build/`
without `config`, breaking other tests; use `npm run build:node`.

---
<!-- nightralph:entry ticket=memory-leaks:7 attempt=1 outcome=done -->
## 2026-10-17 18:14 -- memory-leaks/07 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $0.95. Checked items: "Leaving the player before the server reply leaves no external-player subscription armed", "A server reply that arrives after leaving never opens the external player".

### Agent notes
# Ticket 07: leaving the player cancels the external player wait

## Implemented
- `media-controller.js`: `openExternalPlayer` keeps a `cancelServerWait`
  closure for its `onServerRunningFor` subscription. New action
  `playerClosed()` calls it. If the user leaves before the shim's
  promise resolves, the unsubscribe is called as soon as it arrives.
  `onServerRunning` also returns early when `state.playing` is no
  longer the play object it was armed for (closePlayer replaces it),
  which covers a reply racing the withdrawal.
- `playback-controller.js` `closePlayer` dispatches `playerClosed`;
  `main.js` maps `playerClosed` to `controllers.media().playerClosed()`.
  (Ticket listed only media-controller.js, but the controller has no
  other way to learn the player closed.)

## Tests
- New `test/unit/media-controller-external-player.js` (suffix
  `.external-player-test.js`): armed while open, cancelled on leave,
  cancelled when leaving before the shim answers, late reply opens
  nothing and leaves new play state alone, normal reply still opens.
- `engine-ipc-call-sites.js`: closePlayer dispatches `playerClosed`
  (verified red by stashing the playback-controller change).
- Ran the controller tests together in both orders: 139/139.

## For later tickets
- The playback-controller ticket (subscriptions on close) will touch
  closePlayer near the new `dispatch('playerClosed')` line.

---
<!-- nightralph:entry ticket=memory-leaks:12 attempt=1 outcome=done -->
## 2026-10-17 18:18 -- memory-leaks/12 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $0.93. Checked items: "The job does not run before the delay has passed since the last call", "After a burst of calls, the job runs exactly once".

### Agent notes
# Notes: ticket 12 -- window-bounds debounce uses one worker thread

## Reading of the criteria
- "one worker thread" is made observable by asserting every job, across
  several bursts, runs on the same thread id (and not the caller's).
- "not before the delay since the last call" is tested with a burst that
  lasts several times the delay; nothing may run during it.
- Existing tests a_burst_of_calls_runs_the_job_once and
  a_later_burst_is_debounced_on_its_own stay as they are.

## Environment
- cargo test needs build-tauri/ -> ran `npm run build:tauri` first.

## Implemented
- src-tauri/src/window.rs: `Debounce` now holds an `Arc<Handle>` over a
  `Mutex<Pending>` + `Condvar`. `call` stores the newest job, moves the
  deadline to now + delay, and lazily spawns the single worker. The worker
  waits until the deadline passes unmoved, runs the job outside the lock
  (wrapped in catch_unwind so a panicking job cannot kill the worker), and
  exits once every clone is dropped and nothing is pending.
- Public API unchanged (`new`, `call`, Clone, Debug); main.rs untouched.

## Tests (src-tauri/src/window.rs)
- every_burst_runs_on_the_one_worker: red on the old code (jobs on
  different threads), green after.
- a_burst_longer_than_the_delay_waits_for_its_last_call: passes on both
  old and new code (characterises item 2); mutation check -- counting the
  deadline from the first call makes it fail.
- Ran the window tests 3x, stable.

## AGENTS.md
- Added a section to src-tauri/AGENTS.md on the one-worker pattern.

---
<!-- nightralph:entry ticket=memory-leaks:13 attempt=1 outcome=done -->
## 2026-10-17 18:18 -- memory-leaks/13 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $0.84. Checked items: "The VLC probe returns "not answering" within its deadline for a command that never exits", "Not automated: the `try_wait` error path kills and reaps the child (the OS error cannot be triggered on demand)".

### Agent notes
# Ticket 13 notes

## Implemented
1. VLC probe deadline -- `src-tauri/src/external_player.rs`:
   `answers_version` now delegates to `answers_version_within(candidate,
   PROBE_TIMEOUT)` (5 s). It spawns, polls `try_wait` every `POLL`, and
   past the deadline (or on a `try_wait` error) calls `end(child)`
   (kill + wait) and returns false. Tests:
   `a_candidate_that_never_answers_is_not_vlc_once_the_deadline_passes`
   (node script that never exits; asserts false, elapsed < deadline+2s,
   and the pid is no longer alive) and
   `a_candidate_that_answers_in_time_is_vlc`.
2. `watch`'s `try_wait` Err arm now `take()`s the child and `end()`s it
   instead of dropping it. Not automated (OS error cannot be triggered),
   recorded as the ticket says. Test-first skipped for that reason.

## Notes for next attempt
- `cargo test` needs `build-tauri/`: run `npm run build:tauri` first.
- The binary crate has no lib target: use `cargo test external_player`,
  not `cargo test --lib`.

---
<!-- nightralph:entry ticket=memory-leaks:11 attempt=1 outcome=done -->
## 2026-10-17 18:21 -- memory-leaks/11 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $0.67. Checked items: "Without a drop, `dispatcher` returns the same handler for the same arguments", "After a drop, `dispatcher` returns a fresh handler for the same arguments", "Deleting a torrent and deleting all torrents both drop the memo".

### Agent notes
# Notes: 11 deleting torrents drops dispatcher memo

## Item 1: same handler without a drop
- Existing behaviour; added characterization test `test/unit/dispatcher.js`
  (passed immediately -- nothing to implement).

## Item 2: fresh handler after a drop
- `src/renderer/lib/dispatcher.js`: `dispatchers` is now `let`, new export
  `dropDispatchers()` replaces it with `{}`.
- Test in `test/unit/dispatcher.js` (red -> green).

## Item 3: delete one / delete all drop the memo
- `torrent-list-controller.js`: `deleteTorrent` (inside the found branch)
  and `deleteAllTorrents` call `dropDispatchers()`.
- Tests added to `test/unit/torrent-list-resume.js` (reuses its compiled
  controller and stubs), observed through the real `dispatcher`.
  Ran with `torrent-context-menu.js` in both orders: green.

## Final
- npm test: 4378/4378 pass, lint clean. Added a paragraph to src/AGENTS.md.

---
<!-- nightralph:entry ticket=memory-leaks:5 attempt=1 outcome=done -->
## 2026-10-17 18:22 -- memory-leaks/05 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $0.78. Checked items: "`wt-select-files` goes through the diff, and applied selections are forgotten from the torrent's close handler (source scan)".

### Agent notes
# Ticket 05: file selection applies only what changed

## Item 1-3 (diff module)
- New `src/engine/selections.js`: pure `diffSelections(applied, requested)`
  -> `{ replaceDefault, select, deselect }`. `applied` undefined = first
  application: replaceDefault true, every true selected, every false
  deselected (same as the old code).
- New `test/unit/engine-selections.js` (plain values). Items 1-3 share
  one module and one commit.

## Item 4 (wiring)
- `src/engine/index.js`: module-level `appliedSelections` Map;
  `selectFiles` diffs against it, deselects the default only on first
  application, applies only changed indexes, stores a copy. Deleted in
  `torrentClose` after the duplicate guard.
- `test/unit/engine-torrent-close-wiring.js`: two new scan tests.
- `src/engine/AGENTS.md`: `selections.js` section, close-handler list.
- Full `npm test` green (4400 pass).

---
<!-- nightralph:entry ticket=memory-leaks:3 attempt=1 outcome=done -->
## 2026-10-17 18:24 -- memory-leaks/03 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $1.37. Checked items: "The server entry is forgotten from the torrent's close handler (source scan)".

### Agent notes
# Ticket 03: server holds counted on request, forgotten on close

## Implemented
- `src/engine/index.js`: `startServer` creates the entry
  `{ torrent, holders, server: null, info: null }` on arrival and counts
  the hold at once; the first early request parks one ready handler
  (`listenForEntry`). `listenForEntry` and the `listen` callback bail if
  `servers.get(infoHash) !== entry`. `stopServer` decrements in any
  state and calls `forgetServer` at zero. `forgetServer` deletes the
  entry and `destroyServer`s (splices from `torrent._servers`, then
  `server.destroy()`). `stopAllServers` and `torrentClose` (after the
  duplicate guard) call `forgetServer`. Unknown torrent: still no hold,
  no reply.
- `test/unit/engine-entry.js`: four real-sidecar tests plus helpers
  `withEngine`, `startServer`, `accepts` (net.connect probe),
  `waitForPort`, `delay`.
- `test/unit/engine-torrent-close-wiring.js`: scan that torrentClose
  calls `forgetServer(infoHash)` after the guard, and that forgetServer
  deletes and destroys.
- `src/engine/AGENTS.md`: server lifecycle + sidecar test gotchas.

## How ACs were read
- Burst test: a .torrent path parses asynchronously, so start-server in
  the same burst as start-torrenting finds no torrent (passes trivially).
  The test waits for `wt-parsed`, then sends start+stop in one burst and
  asserts ready had not yet arrived. Missing files verified too fast
  (ready beat the burst), so per the ticket the fixture got more to
  verify: a full-length sparse file of zeros in the download dir. Stable
  over 5 runs; failed on old code for the right reason.
- Two starts / two stops and two starts / one stop run after ready (they
  need the reply's URL). Pre-ready counting is covered by the burst test.
- Removing from `torrent._servers` is not automated (spec says so).
- Items 1-4 share one engine change and one commit; item 5 (scan) is a
  second commit.

---
<!-- nightralph:entry ticket=memory-leaks:6 attempt=1 outcome=done -->
## 2026-10-17 18:29 -- memory-leaks/06 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $1.22. Checked items: "After the player closes, none of its subscriptions is left, including ones made by a next or previous file change", "A ready or server-running delivery that arrives after close sends no `wt-start-server` and changes no playback state", "Closing a play that never sent start-server sends no stop-server".

### Agent notes
# Ticket 06: player close cancels subscriptions and releases only its hold

## Implemented
- `src/renderer/controllers/playback-controller.js`:
  - constructor: `this.subscriptions = []`, `this.serverInfoHash = null`.
  - `keepSubscription(promise)`: records a cancel that sets `cancelled`
    and calls the unsubscribe once the shim answers (the
    media-controller pattern), so a close before the shim resolves still
    withdraws.
  - `startServer`: ready wait and server-running wait go through
    `keepSubscription`; both listeners check `state.playing === playing`
    (captured at arm time) so a delivery racing the close does nothing.
    `serverInfoHash` is set right before `ipcEngine.startServer`.
  - `updatePlayer`: deferred audio-metadata wait goes through
    `keepSubscription` and checks play identity (covers next/previous).
  - `closePlayer`: cancels all subscriptions after `playerClosed`;
    sends `stopServer(serverInfoHash)` only if set, then clears it.
- New `test/unit/playback-controller-subscriptions.js` (emitted as
  `playback-controller.subscriptions-test.js`; stubs every lib module
  the graph reaches except dispatcher/errors/torrent-player).
- `test/unit/engine-ipc-call-sites.js`: "closing the player stops the
  server" now starts a server first -- under the new rule a play that
  never started one sends no stop. Behaviour change required by the
  ticket, not a weakening; it still asserts routing by info hash.
- `src/renderer/controllers/AGENTS.md`: keepSubscription / matched-stop
  conventions.

## Notes
- All three checklist items are one change in one function set, so they
  land in one commit.
- Ran new file with engine-ipc-call-sites and the other controller tests
  in both orders: green. Full `npm test`: 4453/4453.
- Stale metadata waits from an earlier file *within the same play*
  (next before ready) still fire with their own index when ready; they
  are withdrawn on close. Pre-existing, out of scope.

---
<!-- nightralph:entry ticket=memory-leaks:8 attempt=1 outcome=done -->
## 2026-10-17 18:29 -- memory-leaks/08 attempt 1 -- done

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $0.99. Checked items: "A job whose server never answers leaves no server-running subscription once it times out", "A job that times out sends `wt-stop-server` for the hold it took", "A server reply that arrives after the timeout writes no poster", "The next queued job still starts after a timed-out one", "A job whose server never answers leaves no server-running subscription once it times out. The test failed before the fix.", "A job that times out sends `wt-stop-server` for the hold it took. The old code already did this, so I added a test for the other half of the spec: a job that gives up before its subscription is set up asks for no server and releases none, even if the subscription arrives later. That test failed before the fix, and it also caught the old code writing a poster after it had given up.", "A server reply that arrives after the timeout writes no poster. The tests (one for a late reply, one for a timeout during a capture) fail when I take out the matching checks and pass with them.", "The next queued job still starts after a timed-out one. This already worked, so the test passed from the start and now guards it.".

### Agent notes
# Ticket 08: poster job timeout releases everything

## Implemented
- `src/renderer/lib/torrent-poster.js`: `generateTorrentPoster(summary,
  { timeout })` (defaults to JOB_TIMEOUT). `runPosterJob` makes a
  per-job `{ over, unsubscribe, heldServer }`. Its finally sets `over`,
  calls any live unsubscribe, and sends `wt-stop-server` only if
  `heldServer`. `startServer` records the unsubscribe and the hold on
  the job; if the subscription resolves after the job is over it
  unsubscribes at once and sends no start-server. `savePoster` returns
  early if the job is over after the server wait and after the capture,
  so nothing is written late.
- `test/unit/poster.js`: stub gained `record.silent` (hashes whose
  server never answers) and `record.subscribeGate`. Six new tests with a
  30 ms injected timeout.
- `test/AGENTS.md`: note on injecting timeouts.

## How ACs were read
- Item 2 ("sends wt-stop-server for the hold it took"): the old code
  already sent stop on timeout. Added a red test for the "only holds it
  actually took" half: a job that gives up before its subscription
  resolves sends neither start nor stop, even when the subscription
  lands later.
- Item 3: confirmed red by removing the `job.over` checks (both the
  after-server-wait and after-capture checks each have a test).
- Item 4: passed without changes (the queue already advanced after a
  timeout); the test guards it.

---
