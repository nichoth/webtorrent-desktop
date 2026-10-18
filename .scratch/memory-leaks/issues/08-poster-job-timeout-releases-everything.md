# 08: A poster job that times out releases its subscription and its hold

**What to build:** A poster job that times out keeps its "server
running" subscription and its torrent summary alive. If the torrent
becomes ready later, the job carries on outside the queue, takes a
server hold nobody releases, and can write a poster after it gave up.

After this ticket, when a poster job times out it removes its
server-running subscription and releases its hold, and the work it
started cannot write a poster afterwards. Jobs still run one at a time.
Releasing a hold before the torrent is ready only takes effect once the
engine counts holds on request (ticket 03).

**Blocked by:** 03

**Touches:** `src/renderer/lib/torrent-poster.js` (`JOB_TIMEOUT`,
`queue`, `runPosterJob`, `startServer`), `test/unit/poster.js` (use a
short injected timeout or a controllable clock, never a real 60
seconds)

**Status:** done

- [x] A job whose server never answers leaves no server-running
      subscription once it times out
- [x] A job that times out sends `wt-stop-server` for the hold it took
- [x] A server reply that arrives after the timeout writes no poster
- [x] The next queued job still starts after a timed-out one
