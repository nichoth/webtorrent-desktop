# 01: The resume list never names a deleted torrent

**What to build:** With playback priority on, starting a play pauses the
other torrents and records them in the resume list
(`state.saved.torrentsToResume`), and they resume after playback. Today,
deleting a torrent leaves its info hash in that list. The next resume
throws on the missing torrent before the list is reset. After that the
list grows on every play and is saved to the profile, torrents after the
dead entry are never resumed, and the location history stays stuck, so
back, forward and opening the player stop working until a restart.

After this ticket, deleting a torrent removes its info hash from the
resume list and deleting all torrents empties it. Resuming skips any
info hash that no longer names a torrent and always resets the list,
even if resuming one entry fails, so a profile that already holds a
stale entry recovers on its own. Prioritizing a torrent never adds an
info hash that is already in the list.

The spec calls this the most visible bug in the audit, so it goes first.

**Blocked by:** None (can start immediately)

**Touches:** `src/renderer/controllers/torrent-list-controller.js`
(`deleteTorrent`, `deleteAllTorrents`, `prioritizeTorrent`,
`resumePausedTorrents`), `state.saved.torrentsToResume` in
`src/renderer/lib/state.js` (shape unchanged), new
`test/unit/torrent-list-resume.js` (controller-compile recipe in
`test/AGENTS.md`, prior art `test/unit/torrent-context-menu.js`)

**Status:** ready-for-agent

- [ ] Deleting a torrent removes its info hash from the resume list
- [ ] Deleting all torrents leaves the resume list empty
- [ ] Resuming a list that names a missing torrent resumes every other
      torrent in it and leaves the list empty
- [ ] Prioritizing the same torrent twice adds its info hash once
