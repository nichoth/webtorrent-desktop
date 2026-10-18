# 06: Closing the player cancels its subscriptions and releases only the hold it took

**What to build:** The playback controller registers one-shot "torrent
ready" and "server running" engine subscriptions for a play and throws
their unsubscribe functions away. If the player closes before the
torrent is ready, they stay armed. The stale ready listener later asks
for a fresh server that nothing releases, and it writes `isReady` into
whatever is playing by then. Closing the player also sends
`wt-stop-server` whether or not this play started a server, so it can
release a poster job's hold.

After this ticket, the playback controller keeps the unsubscribe
function of every one-shot engine subscription it makes for a play: the
torrent-ready wait, the server-running wait, and the audio-metadata wait
that is deferred until ready. Closing the player calls all of them. The
same goes for each subscription made by a file change inside the play
(next or previous). The controller tracks whether this play actually
sent `wt-start-server`, and on close sends `wt-stop-server` only if it
did.

The spec says this half must land with or after the engine fix in
ticket 03.

**Blocked by:** 03

**Touches:** `src/renderer/controllers/playback-controller.js` (the
`onTorrentReadyFor` and `onServerRunningFor` waits, the close path that
sends `wt-stop-server`), new
`test/unit/playback-controller-subscriptions.js` (controller-compile
recipe in `test/AGENTS.md`, prior art `test/unit/engine-ipc-call-sites.js`
and `test/unit/media-controller-playability.js`; the ipc-engine stub
records live subscriptions and the unsubscribe calls made on them; emit
under a distinct suffix and run alongside the existing controller tests
in both orders)

**Status:** done

- [x] After the player closes, none of its subscriptions is left,
      including ones made by a next or previous file change
- [x] A ready or server-running delivery that arrives after close sends
      no `wt-start-server` and changes no playback state
- [x] Closing a play that never sent start-server sends no stop-server
