<!-- nightralph:review from=ea58b79411138f893e16b5df1c931cae2560b06a to=da91cf474c0952d127d4c11e8fed26dedf7148cf status=fixed -->
## 2026-10-17 18:34 -- review ea58b79..da91cf4 -- 1 of 1 fixed
- [x] A player whose setup fails keeps its server hold and its armed subscriptions, because `closePlayer` never runs
    src/renderer/controllers/playback-controller.js:260 -- `openPlayer` calls `startServer` (sends `wt-start-server`, sets `serverInfoHash`, pushes onto `this.subscriptions`) before `updatePlayer` validates the file. When `updatePlayer` calls back with `UnplayableFileError` (for example, `playFile(infoHash)` on a torrent whose `findIndex(isPlayable)` is -1, or a stale `mostRecentFileIndex` on a forward navigation), `location-history` never calls the page's `destroy`. As a result, `closePlayer` is skipped, the hold is never released, and `state.playing` is not replaced, so the identity guards do not stop the still-armed ready listener. The next `openPlayer` overwrites `serverInfoHash`, which leaks the first hold for good. That breaks the spec's rule that a hold is released when the play ends. Release the hold and the subscriptions on the setup error path, or validate the file before `startServer`.

### Fix
- attempts: 1 of 4
- effort: medium
- agent exit code: 0
- result: merged

# Review fix: failed player setup leaks hold and subscriptions

## Done
- `openPlayer` in src/renderer/controllers/playback-controller.js now checks
  the file (missing or unplayable) before `startServer`, and calls back
  `UnplayableFileError` with nothing acquired. `mostRecentFileIndex` is
  cleared, matching `updatePlayer`'s own error path.
- Chose "validate before startServer" over "release on the error path":
  nothing is taken, so there is nothing to release, and `state.playing`
  is left as it was.
- A missing file (index -1 from `findIndex(isPlayable)`) used to throw a
  TypeError inside `isPlayable`; it now yields UnplayableFileError too.
- Tests: three cases appended to test/unit/playback-controller-subscriptions.js
  (unplayable file on a running and on a paused torrent, and index -1).
  Each asserts that no wt-start-server is sent and no subscription is live.
- AGENTS.md (controllers) got a note that a failed setup is never destroyed.
- npm test: 4480/4480 pass. Lint is clean.

## Notes
- `updatePlayer` still runs its own playability check. That is needed for
  next/previous, which do not go through `openPlayer`.
---
