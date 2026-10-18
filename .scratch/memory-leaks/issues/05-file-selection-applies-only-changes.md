# 05: File selection applies only what changed

**What to build:** Every file checkbox toggle sends the whole selection
list, and the engine adds a fresh webtorrent selection for every
selected, unfinished file. Piece picking slows down over time, and a
file selected twice and then deselected keeps downloading, because
webtorrent's deselect removes only one of its selections.

After this ticket, a new small engine module diffs the selections the
engine last applied to a torrent against the ones requested, and returns
which files to select and which to deselect. Only those changes reach
webtorrent, so repeating the same selections does nothing. The engine
keeps the applied selections per torrent and forgets them when the
torrent closes (close handler from ticket 02). The first
`wt-select-files` for a torrent still replaces webtorrent's default
whole-torrent selection, exactly as today.

**Blocked by:** 02 (shares the torrent close handler)

**Touches:** new `src/engine/selections.js`, `src/engine/index.js`
(`selectFiles`, `startTorrenting`, the close handler from 02), new
`test/unit/engine-selections.js` (plain values, like
`test/unit/engine-stall.js` and `test/unit/engine-hashfail.js`),
`test/unit/engine-torrent-close-wiring.js`

**Status:** done

- [x] Applying the same selections twice yields no changes the second
      time
- [x] A deselect after a repeated select yields exactly one deselect
- [x] The first application replaces the default whole-torrent
      selection
- [x] `wt-select-files` goes through the diff, and applied selections
      are forgotten from the torrent's close handler (source scan)
