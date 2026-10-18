# 03: Server holds are counted when the request arrives, and forgotten when the torrent closes

**What to build:** The engine counts the holders of each torrent's
streaming server (ADR-013), and the shim contract says a caller that
starts one must always stop it. In practice the count drifts upward.
The engine only records a hold once the torrent fires `ready`, so a
`wt-stop-server` that arrives first is dropped and the server is later
created with a holder nobody releases. Stopping a torrent never forgets
its server entry either, so after the user resumes that torrent, the
engine hands out the old entry's URL, whose port is closed, and playback
and poster fetches fail.

After this ticket:

- A server entry is created when `wt-start-server` arrives, not when the
  torrent becomes ready. The entry carries a holder count, the server
  (absent until ready) and the server's info (absent until it is
  listening).
- Each `wt-start-server` adds one holder at once. If the torrent is not
  ready, the first request parks a single ready handler for the entry.
  Later early requests add holders and park nothing.
- `wt-stop-server` takes away one holder whatever state the entry is in.
  When the count reaches zero, the entry is deleted and its server, if
  any, is destroyed. A parked ready handler that finds its entry gone
  does nothing.
- When a torrent closes, for any reason, its server entry is deleted and
  its server destroyed. Use the close handler from ticket 02.
- Destroying a server also removes it from the torrent's own server
  list, so play and close cycles leave nothing behind on the torrent.
- `wt-start-server` for a torrent the engine does not have still replies
  with nothing and counts no hold. The wire protocol does not change.

This brings the engine in line with the contract it already documents.
No ADR is contradicted.

**Blocked by:** 02 (shares the torrent close handler)

**Touches:** `src/engine/index.js` (`servers`, `startServer`,
`startServerFromReadyTorrent`, `stopServer`, `stopAllServers`, the close
handler from 02), `test/unit/engine-entry.js` (real sidecar, real
socket), a `static/*.torrent` fixture with every file deselected,
`test/unit/engine-torrent-close-wiring.js`

**Status:** ready-for-agent

- [ ] Sending start-torrenting, start-server and stop-server in one
      burst, before `ready`, leaves no server accepting connections once
      the torrent is ready. If this turns out flaky, give the fixture
      more to verify rather than moving the test to a lower seam
- [ ] Two starts and two stops leave the port refusing connections
- [ ] Two starts and one stop leave the port accepting connections
- [ ] Start-server, then stop-torrenting with no stop-server, then
      start-torrenting again, then start-server reports a URL that
      accepts connections
- [ ] The server entry is forgotten from the torrent's close handler
      (source scan)
