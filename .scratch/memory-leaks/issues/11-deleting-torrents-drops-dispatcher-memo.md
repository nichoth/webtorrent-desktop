# 11: Deleting torrents drops the dispatcher's memoized handlers

**What to build:** `dispatcher(...)` memoizes one handler per distinct
argument list and never evicts them, so a large torrent that has been
deleted leaves tens of thousands of closures behind.

After this ticket, the dispatcher has a way to drop its memoized
handlers, and deleting one torrent or all torrents calls it. Dropping
everything is acceptable: the next render rebuilds the handlers it
needs.

**Blocked by:** 01 (both edit the delete methods in the torrent-list
controller)

**Touches:** `src/renderer/lib/dispatcher.js` (`dispatcher`, the
`dispatchers` memo, a new exported drop function),
`src/renderer/controllers/torrent-list-controller.js` (`deleteTorrent`,
`deleteAllTorrents`), new unit test (prior art `test/unit/time.js`)

**Status:** ready-for-agent

- [x] Without a drop, `dispatcher` returns the same handler for the same
      arguments
- [x] After a drop, `dispatcher` returns a fresh handler for the same
      arguments
- [x] Deleting a torrent and deleting all torrents both drop the memo
