# Memory and resource leaks from the October 2026 audit

**Status:** ready-for-agent

## Problem Statement

A long session in WebTorrent Desktop holds on to things it no longer
needs, and some of what it holds on to breaks the app.

The worst case is the per-torrent streaming server. The engine counts
holders of each torrent's server (ADR-013), and the shim contract says
a caller that starts one must always stop it. In practice the count
drifts upward:

- A release that reaches the engine before the torrent is ready is
  dropped, because the engine only records the hold once `ready`
  fires. The server is then created with a holder nobody will ever
  release.
- The player registers one-shot "torrent ready" and "server running"
  listeners and throws their unsubscribe functions away. Closing the
  player before the torrent is ready leaves them armed, and the stale
  ready listener later asks for a fresh server that nothing releases.
  It also writes `isReady` into whatever is playing by then.
- A poster job that times out keeps its "server running" listener and
  its torrent summary alive, and if the torrent becomes ready later the
  job carries on outside the queue and takes a hold nobody releases.
- Stopping a torrent never forgets its server entry. When the user
  resumes that torrent, the engine hands out the old entry's URL, whose
  port is closed, and playback and poster fetches fail against it.

The engine has two more growing resources:

- Every audio track change on an unfinished file opens a file stream
  that is never closed. Each one keeps up to a piece buffer and a
  high-priority selection until the torrent is destroyed, and that
  selection keeps a file downloading after the user deselects it.
- Every file checkbox toggle adds a fresh selection per selected,
  unfinished file. Piece picking slows over time, and a file selected
  twice and then deselected keeps downloading.

Per-torrent diagnostic state (announce times, corrupt-peer counters,
stall samples) is only forgotten on an explicit stop. A torrent that
dies of a fatal error keeps its entries, so when the user resumes it,
it reports as stalled straight away. Every play and close cycle also
leaves a dead server in the torrent's own server list.

In the renderer:

- Deleting a torrent leaves its info hash in the list of torrents to
  resume after playback. The next resume throws on the missing
  torrent before the list is reset. After that the list grows on every
  play and is saved to the profile, torrents after the dead entry are
  never resumed, and the location history stays stuck, so back,
  forward and opening the player stop working.
- The player page's unmount hook is misnamed, so React never calls
  it. The media element is never unloaded, and the media session
  metadata is set on the first play of the session and never
  refreshed, so the system media controls show a stale title and
  stale next and previous actions.
- The error list grows forever and is filtered on every render.
- Memoized dispatch handlers are never evicted, so a large torrent
  that has been deleted leaves tens of thousands of closures behind.
- The external player's "server running" listener is never cancelled.
  If the server answers after the user has left, the app tries to open
  the external player with an empty URL.

In the host, there are three smaller issues:

- The window-bounds debounce starts one thread per move or resize
  event.
- When the OS errors on `try_wait`, the external player's child
  process is dropped without being reaped.
- The VLC version probe has no timeout, so a candidate that never
  exits strands a blocking thread on every check.

## Solution

Every resource that is acquired for a play, a poster job, a torrent or
a file selection is released when that thing ends:

- The engine counts a server hold when the request arrives. A release
  is honoured whether or not the torrent is ready yet, and a server
  with no holders is never left listening.
- When a torrent stops or closes, its server entry and its diagnostic
  state are forgotten.
- The player and the poster job cancel every subscription they made
  when they end, and they release only holds they actually took.
- Reading audio metadata never leaves a stream open.
- Changing file selections applies only the changes, so repeating the
  same selections does nothing.
- The resume list never names a deleted torrent, and a stale entry
  can no longer break resuming or navigation.
- Leaving the player unloads its media and resets the media session,
  so the next play shows the right title and actions.
- The error list and the dispatch memo stay bounded.
- The host's debounce, external player watcher and VLC probe no longer
  strand threads or child processes.

## User Stories

1. As a user who opens a paused torrent and closes the player before
   it starts, I want the torrent's streaming server to go away, so that
   it does not stay listening for the rest of the session.
2. As a user who closes the player before a torrent is ready, I want
   nothing from that play to change the player later, so that a
   different file I open next does not get marked ready by mistake.
3. As a user who pauses and resumes a torrent, I want playback of it
   to work after the resume, so that I am not handed a server that no
   longer exists.
4. As a user adding many torrents, I want a poster job that times out
   to stop all of its work, so that it does not keep a server up or
   write a poster after it has given up.
5. As a user listening to an album that is still downloading, I want
   each track change to release what the previous track used, so that
   memory use does not climb track by track.
6. As a user who deselects a file, I want it to stop downloading,
   however many times I toggled it before.
7. As a user who toggles files in a large torrent, I want the
   download to stay as fast as it was, so that file selection does not
   slow the engine down over time.
8. As a user who resumes a torrent that failed with an error, I want
   it to start with a clean stall status, so that it is not reported as
   stalled before it has had a chance to make progress.
9. As a user with playback priority on, I want deleting a torrent to
   take it out of the list of torrents to resume, so that resuming
   after playback still works.
10. As a user whose resume list already names a deleted torrent, I
    want the other torrents to resume and the back and forward buttons
    to keep working, so that one stale entry cannot break the app.
11. As a user using the system media controls, I want them to show
    the file I am playing now, so that the title and next and previous
    actions match what is on screen.
12. As a user in a long session, I want the app's memory use to stay
    flat while I keep using it, so that it does not need restarting.
13. As a user who leaves the player before the external player opens,
    I want nothing to open after I have left.

## Implementation Decisions

### Engine: server lifecycle

- A server entry is created when `wt-start-server` arrives, not when
  the torrent becomes ready. The entry carries a holder count, the
  server (absent until ready) and the server's info (absent until it
  is listening).
- Each `wt-start-server` adds one holder at once. If the torrent is
  not ready, the first request parks a single ready handler for the
  entry. Later early requests add holders and park nothing.
- A `wt-stop-server` takes away one holder whatever state the entry is
  in. When the count reaches zero, the entry is deleted and its server,
  if any, is destroyed. When the parked ready handler finds its entry
  gone, it does nothing.
- When a torrent closes, for any reason (stop-torrenting, removal, a
  fatal error), its server entry is deleted and its server destroyed.
  Hooking the torrent's own close is what covers the fatal-error path
  as well as the explicit stop.
- Destroying a server also removes it from the torrent's own server
  list, so play and close cycles leave nothing behind on the torrent.
- `wt-start-server` for a torrent the engine does not have still
  replies with nothing and counts no hold. The renderer's timeout is
  what covers that path, so the wire protocol does not change.
- These changes bring the engine in line with the contract it already
  documents (the shim contract and ADR-013: "always replies", "a caller
  that starts one must always stop it"). No ADR is contradicted.

### Engine: per-torrent state

- Announce times, corrupt-peer counters and stall samples are
  forgotten when the torrent closes, not only on stop-torrenting. A
  resumed info hash then starts fresh.

### Engine: audio metadata

- A new small engine module reads audio metadata from a file. It owns
  the read stream it opens and destroys it once the parse settles,
  whether the parse resolved or rejected. Finished files keep the
  direct file path, which already closes its file.
- The engine's `wt-get-audio-metadata` handler calls this module
  instead of handing the library a stream directly. The reply channel
  and its silence on failure are unchanged.

### Engine: file selections

- A new small engine module diffs the selections the engine last
  applied to a torrent against the ones requested. It returns which
  files to select and which to deselect, and only those changes reach
  webtorrent.
- The engine keeps the applied selections per torrent and forgets them
  when the torrent closes. The first `wt-select-files` for a torrent
  still replaces webtorrent's default whole-torrent selection, exactly
  as today.

### Renderer: playback

- The playback controller keeps the unsubscribe function of every
  one-shot engine subscription it makes for a play. That means the
  torrent-ready wait, the server-running wait, and the audio-metadata
  wait that is deferred until ready. Closing the player calls all of
  them. The same goes for each subscription made by a file change
  inside the play (next or previous).
- The controller tracks whether this play actually sent
  `wt-start-server`. Closing the player sends `wt-stop-server` only if
  it did, so the player can never release a poster job's hold.
- The media controller's external-player server wait is cancelled
  when the user leaves the player, and a reply that arrives after
  leaving never opens the external player.

### Renderer: poster jobs

- When a poster job times out, it removes its server-running
  subscription and releases its hold, and the work it started cannot
  write a poster afterwards. Jobs still run one at a time.

### Renderer: resume list

- Deleting a torrent removes its info hash from the resume list, and
  deleting all torrents empties it.
- Resuming skips any info hash that no longer names a torrent, and the
  list is always reset, even if resuming one entry fails.
- Prioritizing a torrent does not add an info hash that is already in
  the list.

### Renderer: player page

- The player page's unmount hook gets React's real lifecycle name, so
  it runs. When it runs, it unloads both the main media element and
  the preview element, and it resets the media session metadata, so
  the next play sets fresh metadata and media-key actions.

### Renderer: bounded collections

- Errors are recorded through one renderer lib function, used by every
  site that pushes an error today. When it records an error, it drops
  any errors older than the window the error banner shows, so the list
  stays bounded however noisy the source is.
- The dispatcher gains a way to drop its memoized handlers. Deleting
  one torrent or all torrents calls it. Dropping everything is
  acceptable: the next render rebuilds the handlers it needs.

### Host

- The window-bounds `Debounce` runs one worker thread. Each call moves
  the deadline forward, and the job runs once after the calls stop.
  The behaviour is unchanged; only the thread-per-event churn goes
  away.
- When the external player watcher gets an error from `try_wait`, it
  kills the child and waits on it instead of dropping it.
- The VLC version probe has a bounded wait. A candidate that has not
  exited by the deadline is killed, reaped, and treated as not
  answering.

## Testing Decisions

- Good tests here assert external behaviour that a user or a peer
  could observe: a port that does or does not accept connections, a
  subscription that does or does not fire, a stream that is or is not
  destroyed, a list that is or is not bounded. They do not assert on
  webtorrent's private fields, rendered text, or the order of internal
  calls.
- **Engine server lifecycle**, tested on the real sidecar over a real
  socket, with prior art in `engine-entry.js`. Use a
  `static/*.torrent` fixture with every file deselected, so no peers
  and no downloads are needed:
  - Sending start-torrenting, start-server and stop-server in one
    burst, before `ready`, leaves no server accepting connections
    once the torrent is ready.
  - Two starts and two stops leave the port refusing connections; two
    starts and one stop leave it accepting them.
  - Start-server, stop-torrenting with no stop-server, start-torrenting
    again, then start-server reports a URL that accepts connections.

  The first case relies on the burst arriving before verification
  finishes. If that turns out flaky, add more files to the fixture's
  verification rather than moving the test to a lower seam.
- **Engine audio-metadata module**, tested with plain values and a real
  Node Readable. Its stream is destroyed after a parse that resolves
  and after one that rejects.
- **Engine selection diff**, tested with plain values, like the tests
  for `stall.js` and `hashfail.js`. Applying the same selections twice
  yields no changes, a deselect after a repeated select yields exactly
  one deselect, and the first application replaces the default.
- **Engine wiring**, checked by source scan in the shape of
  `engine-sweep-wiring.js` and `engine-hashfail-wiring.js`. The audio
  handler goes through the new module, selections go through the diff,
  and per-torrent state and server entries are forgotten on the
  torrent's close.
- **Playback and media controllers**, compiled with the
  controller-compile recipe in `test/AGENTS.md`, with prior art in
  `engine-ipc-call-sites.js` and `media-controller-playability.js`. The
  ipc-engine stub records live subscriptions and the unsubscribe calls
  made on them:
  - After the player closes, none of its subscriptions is left.
  - A late ready or server-running delivery after close sends no
    `wt-start-server` and changes no state.
  - Closing a play that never sent start-server sends no stop-server.
  - Leaving before the external player's server reply means it never
    opens.

  Mind the documented collision hazard: emit under a distinct suffix,
  and run alongside the existing controller tests in both orders.
- **Torrent list controller**, using the same recipe, with prior art in
  `torrent-context-menu.js`:
  - Deleting removes the hash from the resume list.
  - Deleting all torrents empties it.
  - Resuming a list that names a missing torrent resumes the rest and
    resets the list.
  - Prioritizing twice adds no duplicates.
- **Poster jobs**, extending `poster.js`. A job whose server never
  answers releases its subscription and its hold when it times out,
  and a later reply writes nothing. Use a short injected timeout or a
  controllable clock rather than waiting a real 60 seconds.
- **Renderer lib**, with prior art in `time.js` and `sound.js`:
  - Recording many errors keeps the list bounded and keeps recent
    ones.
  - Dropping the dispatcher memo hands out a fresh handler for the
    same arguments, while handlers stay stable without a drop.
- **Host**, using in-module `#[cfg(test)]` tests, with prior art in
  `ready.rs` and the existing tests in `window.rs` and
  `external_player.rs`:
  - The debounce runs its job once after a burst of calls and not
    before the delay.
  - The VLC probe returns "not answering" within its deadline for a
    command that never exits.
- **Not automated:**
  - The player page lifecycle, since pages are Vite-only and cannot be
    required in the unit suite.
  - The `try_wait` error path, since the OS error cannot be triggered
    on demand.
  - Removing the server from the torrent's private server list.

  The page lifecycle gets a manual check: play two different files in
  turn and confirm the system media controls show the second one.

## Out of Scope

- **The fs allowlist only grows.** Revoking granted roots is a
  permission-scope decision that needs its own design, and the growth
  is one path per dialog pick.
- **The ipc-engine outbox has no cap.** The pre-connect queue is
  protocol (ADR-012), so delivery is expected, not a drop. It grows
  only with user actions while the engine is down. Replaying stale
  server frames to a restarted engine belongs with sidecar-restart
  handling.
- **Websocket backpressure in the engine bus.** Dropping or cutting off
  a slow reader needs a resync design for the UI. On loopback a dead
  or reloaded page closes the socket anyway.
- **Hash-fail strike and ban lists.** These last the whole session by
  design, are keyed by peer address only, and grow with distinct bad
  peers.
- **Hash-fail contributors keyed by piece index across torrents.** This
  is a correctness bug, not a leak. Track it separately.
- **The `MediaShortcuts` Arc cycle in the host.** It is created once
  for the life of the process, and the media keys are released
  explicitly on exit.
- **Making `wt-start-server` reply when the engine has no torrent by
  that hash.** That would be a wire protocol change. The renderer
  timeout covers the gap.

## Further Notes

- All findings come from a static audit of HEAD `4834c8b` on the
  `redesign` branch, which covered the engine, the renderer and the
  host. The server-hold, audio-stream, selection, poster-timeout,
  resume-list, unmount-hook and error-list findings were confirmed
  against the source, including webtorrent 1.9.7's `createServer`,
  `select` and `deselect` and music-metadata 7.14's `parseStream`.
  The rest come from the audit reports.
- The server-hold fix spans the engine and the renderer, and the two
  halves depend on each other. With only the engine fix, a stale
  player listener still takes a hold nobody releases. With only the
  renderer fix, a release sent before `ready` is still dropped. Land
  them together, or land the engine half first.
- The resume-list bug is the most visible one to users: once it
  triggers, navigation is broken until a restart. If this spec is
  split into tickets, schedule it early.
