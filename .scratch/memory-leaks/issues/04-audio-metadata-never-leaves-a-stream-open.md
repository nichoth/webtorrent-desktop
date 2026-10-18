# 04: Reading audio metadata never leaves a stream open

**What to build:** Every audio track change on an unfinished file opens
a file stream for `music-metadata` that is never closed. Each one keeps
up to a piece buffer and a high-priority selection until the torrent is
destroyed, and that selection keeps the file downloading after the user
deselects it. Memory climbs track by track while an album downloads.

After this ticket, a new small engine module reads audio metadata from a
file. It owns the read stream it opens and destroys it once the parse
settles, whether the parse resolved or rejected. Finished files keep
using the direct file path, which already closes its file. The
`wt-get-audio-metadata` handler calls this module instead of passing the
library a stream directly. The reply channel and its silence on failure
are unchanged.

**Blocked by:** None (can start immediately)

**Touches:** new `src/engine/audio-metadata.js`, `src/engine/index.js`
(`getAudioMetadata`), new `test/unit/engine-audio-metadata.js` (plain
values and a real Node Readable, prior art `test/unit/engine-stall.js`),
`test/unit/engine-torrent-close-wiring.js` or a sibling wiring scan

**Status:** done

- [x] The stream is destroyed after a parse that resolves
- [x] The stream is destroyed after a parse that rejects
- [x] `wt-get-audio-metadata` reads through the new module (source scan)
