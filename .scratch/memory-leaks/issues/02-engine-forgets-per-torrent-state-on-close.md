# 02: The engine forgets per-torrent diagnostic state when a torrent closes

**What to build:** The engine keeps three kinds of per-torrent
diagnostic state: announce times, corrupt-peer counters and stall
samples. Today they are only forgotten on an explicit
`wt-stop-torrenting`. A torrent that dies of a fatal error keeps its
entries, so when the user resumes it, it reports as stalled straight
away.

After this ticket, the engine forgets all three when the torrent itself
closes, whatever the reason (stop-torrenting, removal, a fatal error),
so a resumed info hash starts with a clean stall status. This is done
with one handler on the torrent's own close event, set up where the
engine wires the torrent's other events. Tickets 03 and 05 add their own
per-torrent cleanup to the same handler, so keep it as the single place
where a closing torrent is forgotten.

**Blocked by:** None (can start immediately)

**Touches:** `src/engine/index.js` (`stopTorrenting`,
`addTorrentEvents`, `lastAnnounceAt`, `corruptPeerStats`,
`stalls.forget`), new `test/unit/engine-torrent-close-wiring.js`
(source scan in the shape of `test/unit/engine-sweep-wiring.js` and
`test/unit/engine-hashfail-wiring.js`)

**Status:** ready-for-agent

- [ ] Announce times, corrupt-peer counters and stall samples are
      forgotten from the torrent's own close handler, not only from
      stop-torrenting (source scan)
- [ ] A torrent that closed and is started again under the same info
      hash does not report as stalled on its first progress update
