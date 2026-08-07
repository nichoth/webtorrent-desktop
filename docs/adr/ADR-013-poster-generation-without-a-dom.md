# ADR-013: Generate posters in the UI renderer, not in the engine

**Date:** 2026-07-29

**Amended by US-047 (2026-08-07).** The decision stands; one of its
rejection arguments no longer distinguishes the options. The ffmpeg
alternative below was rejected partly on "a 40 to 80 MB binary per
platform inside the app bundle" and the notarization surface it would
add. ADR-016 has since put a 116 MB Node binary and a nested `.node`
addon in that bundle, so both costs are paid regardless of what this
ADR decided. What still separates the options is the argument the
rejection ends on: ffmpeg duplicates a decoder the webview already
ships and already uses to play the same file. A future reader weighing
ffmpeg should price it as marginal, not as the first large binary.
That paragraph also cites a **US-084**, which is not in
`specs/prd.json` -- the story numbering moved and no such story was
written. Read it as US-083 alone.

## Context

ADR-012 moves the engine out of a hidden `BrowserWindow` and into a
standalone Node process. It names one casualty and defers it to this
ADR: the engine loses the DOM, and poster generation needs one.

The constraint is concrete. `generateTorrentPoster()` in
`src/renderer/webtorrent.js:224` calls `torrentPoster()` from
`src/renderer/lib/torrent-poster.js`, and the video branch of that
module cannot run outside a browser:

- `torrent-poster.js:138` calls `document.createElement('video')`,
  points it at a `torrent.createServer()` URL, seeks to 3% of the
  duration, and waits for `seeked`.
- `torrent-poster.js:155` calls `capture-frame`, which draws the video
  element into a `document.createElement('canvas')` and reads the
  bytes back out of `canvas.toDataURL()`
  (`node_modules/capture-frame/index.js`).

Neither `document`, nor a canvas, nor a video decoder exists in a Node
process. There is no shim that can fix this: the missing piece is a
media decoder plus a rasteriser, not an API name.

The rest of the module is unaffected. Scoring by media type, choosing
the best audio cover art, and the `poster.(jpg|png|gif)` fast path all
work on file names, file lengths, and file bytes, all of which the
engine has. Only the video frame grab needs a browser.

What the UI already has matters for the options below. The renderer
receives the full file list on `wt-metadata` -- `getTorrentInfo()`
sends `{ name, length, path }` per file (`webtorrent.js:189-195`) --
which is exactly the input the scorer reads. It already decides *when*
a poster is wanted, at `controllers/torrent-controller.js:85`. It can
write files through `lib/platform/fs.js`, which `lib/state.js:145`
already uses on `config.POSTER_PATH`. And it is a browser, so it has
the decoder and the canvas.

Alternatives considered:

- **Generate only image and audio posters in the engine, and give up
  on video frames.** The smallest change: delete the video branch,
  keep the wire contract untouched. Rejected. The scorer picks the
  media type with the most bytes in the torrent, so video wins for the
  majority of real torrents, and those torrents would all fall back to
  the placeholder. Posters are how the torrent list is read at a
  glance; this trades the feature away rather than porting it.
- **Shell out to `ffmpeg` from the engine.** Correct, robust, and
  codec-complete. Rejected on cost: a 40 to 80 MB binary per platform
  inside the app bundle, three more things to sign and notarize
  (US-083, US-084), an LGPL/GPL build-configuration decision the
  project has never had to make, and a new `spawn` surface taking
  paths derived from torrent contents. All of that to duplicate a
  decoder the webview already ships and already uses to play the same
  file.

## Decision

**Poster generation moves into the UI renderer.** It stops being an
engine responsibility entirely.

`lib/torrent-poster.js` is rewritten to run in the UI window:

- Scoring, the `poster.*` fast path, and audio cover-art selection
  read `torrentSummary.files`, which the UI already holds from
  `wt-metadata`. No new data crosses the wire.
- File bytes come from the engine's HTTP streaming server by index
  (`${serverURL}/${index}`) via `fetch`, replacing
  `file.getBuffer()`. This is the same URL shape the video branch
  already builds at `torrent-poster.js:137`.
- The video frame is captured with a detached `<video>` element and a
  canvas, as today, but through `canvas.toBlob('image/jpeg')` rather
  than `capture-frame`. The `capture-frame` dependency is dropped: it
  returns a Node `Buffer`, and no host object may cross the shim
  boundary (ADR-007). The UI window still has `nodeIntegration: true`
  today (`src/main/windows/main.js:44`), but Phase 4 removes it, so
  the new code must not depend on it.
- The poster is written with `platform/fs.writeFile()` to
  `path.join(config.POSTER_PATH, infoHash + extension)`, byte-for-byte
  the same naming as `webtorrent.js:231`, so state saved by earlier
  versions still resolves (`lib/torrent-summary.js:16`).

### What happens to the protocol

**`wt-generate-torrent-poster` and `wt-poster` are both deleted from
the wire.** They are not kept, and not moved to another transport:
after this change there is nothing for either to carry. The engine is
never asked to make a poster, and the poster's file name is known in
the process that wrote it, so it no longer has to be reported back.

The three call sites go with them:
`ipcEngine.generateTorrentPoster()` and `ipcEngine.onPosterSaved()`
disappear from `lib/platform/ipc-engine.js:126,297`,
`torrent-controller.js:85` calls the local poster module instead, and
the `onPosterSaved` subscription in `main.js:376` is removed --
`torrentPosterSaved()` becomes a direct call on the controller. The
command and event tables in `docs/platform-shim.md:372,392,470,505`
lose both rows, and the "silence on failure" note at
`docs/platform-shim.md:485` drops `wt-generate-torrent-poster` from
its list of three channels.

**`wt-start-server` and `wt-stop-server` become per-torrent.** This is
the one channel change the decision adds, and it replaces the two it
deletes. The engine holds a single module-level `server` today and
`startServerFromReadyTorrent()` returns early if it is set
(`webtorrent.js:302`), so a second request for a different torrent
never replies at all. Poster generation and playback can now want a
server at the same time, for different torrents, so the engine keeps a
map keyed by info hash, `wt-start-server` is idempotent per torrent
and always replies, and `wt-stop-server` takes the info hash whose
server should be released. The player's use of the channel is
unchanged apart from that argument.

## Consequences

The engine becomes pure torrent code with no media handling at all,
which is the point: the sidecar can be replaced by librqbit later
without anyone having to answer "and how does it decode video?".
`torrent-poster.js` also leaves the set of files Babel has to compile
for the hidden window, since the hidden window is gone.

Frame decoding now happens in the window the user is looking at.
Today it happens in an idle hidden renderer, so this is new work on
the UI process: a decode, a seek, and a canvas read for every newly
added video torrent. Mitigations are all in US-043's implementation --
the element stays detached from the document, `volume = 0` as today,
and one poster is generated at a time -- but the risk is real and the
smoke-test step in US-043 covers it.

Poster quality changes slightly, in the right direction. The current
code calls `captureFrame(video)` with no format argument, which
defaults to PNG, then writes the bytes as `.jpg`
(`webtorrent.js:230`, `capture-frame/index.js:16`). Every video poster
on disk today is a mislabelled PNG. Asking the canvas for
`image/jpeg` and keeping the `.jpg` name makes the file match its
extension and shrinks it, and nothing reads these files except an
`<img>` tag, which never cared.

Failure stays quiet and the fallback is unchanged. `torrentPoster()`
already calls back with `msgNoSuitablePoster` when no media type has a
significant presence, and the UI already renders the default
placeholder when `posterFileName` is unset. A decode that fails now
takes the same path: log, no poster, placeholder. Nothing new appears
in the console and no error is surfaced to the user, which matches the
existing behaviour of the three silent-on-failure channels.

The bet this makes is that the webview can decode what it plays. That
is true of Chromium today, and it is the same assumption the player
makes, so a torrent whose poster cannot be generated is a torrent that
could not have been played either. It is a weaker bet under Tauri:
WebKitGTK on Linux ships without the proprietary codecs Chromium
bundles, and if US-081 finds that the new webview cannot decode common
video, posters regress on exactly the platforms playback does. The
`ffmpeg` option rejected above is the escape hatch if that happens,
and it would then be paying for playback as well as posters, which is
a different and better trade than paying for posters alone.
