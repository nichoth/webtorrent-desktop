# What the webview can decode

Electron gave every platform the same Chromium media stack, so the app
could treat "is this a media file" and "can this window play it" as the
same question. Tauri does not. The window is **WKWebView** on macOS,
**WebKitGTK** on Linux and **WebView2** -- Chromium -- on Windows, and
the three decode different things.

This file records what was measured, on what, and what the app does
with it. The code that consumes it is
`src/renderer/lib/media-playability.js`; the extension-to-MIME map it
probes with is `src/renderer/lib/media-extensions.js`.

## The measurements

`canPlayType` was called for every extension the app treats as media,
with the most favourable MIME type for that extension -- `.opus` is
asked about as Opus in an Ogg container rather than as `audio/opus`,
because that is the answer a real file gets. `""` is a refusal;
`"maybe"` and `"probably"` are not.

| Extension | Type probed | WKWebView | WebKitGTK | WebView2 |
| --- | --- | --- | --- | --- |
| `.aac` | `audio/aac` | maybe | ? | ? |
| `.aif` | `audio/aiff` | maybe | ? | ? |
| `.aiff` | `audio/aiff` | maybe | ? | ? |
| `.asf` | `video/x-ms-asf` | **no** | ? | ? |
| `.dff` | `audio/x-dsf` | **no** | ? | ? |
| `.dsf` | `audio/x-dsf` | **no** | ? | ? |
| `.flac` | `audio/flac` | maybe | ? | ? |
| `.m2a` | `audio/mpeg` | maybe | ? | ? |
| `.m4a` | `audio/x-m4a` | maybe | ? | ? |
| `.m4b` | `audio/mp4` | maybe | ? | ? |
| `.mka` | `audio/x-matroska` | **no** | ? | ? |
| `.mp2` | `audio/mpeg` | maybe | ? | ? |
| `.mp3` | `audio/mpeg` | maybe | ? | ? |
| `.mpc` | `audio/x-musepack` | **no** | ? | ? |
| `.oga` | `audio/ogg` | maybe | ? | ? |
| `.ogg` | `audio/ogg` | maybe | ? | ? |
| `.opus` | `audio/ogg; codecs="opus"` | probably | ? | ? |
| `.spx` | `audio/x-speex` | **no** | ? | ? |
| `.wav` | `audio/wav` | maybe | ? | ? |
| `.wma` | `audio/x-ms-wma` | **no** | ? | ? |
| `.wv` | `audio/x-wavpack` | **no** | ? | ? |
| `.wvp` | `audio/x-wavpack` | **no** | ? | ? |
| `.avi` | `video/x-msvideo` | maybe | ? | ? |
| `.mp4` | `video/mp4` | maybe | ? | ? |
| `.m4v` | `video/x-m4v` | maybe | ? | ? |
| `.webm` | `video/webm` | maybe | ? | ? |
| `.mov` | `video/quicktime` | maybe | ? | ? |
| `.mkv` | `video/x-matroska` | **no** | ? | ? |
| `.mpg` | `video/mpeg` | maybe | ? | ? |
| `.mpeg` | `video/mpeg` | maybe | ? | ? |
| `.ogv` | `video/ogg` | **no** | ? | ? |
| `.wmv` | `video/x-ms-wmv` | **no** | ? | ? |
| `.m2ts` | `video/mp2t` | maybe | ? | ? |

WKWebView column measured 2026-08-05 on macOS 26.5.1 (build 25F80),
`AppleWebKit/605.1.15`, in the app's own window -- see *Reproducing*
below. The user agent Tauri's macOS webview reports carries no
`Version/` or `Safari/` token:

```
Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)
```

**The other two columns are `?` because there is no Windows or Linux
machine on this port.** They are not guesses that happen to be missing;
they are rows nobody has run yet, and the app is written so that an
unmeasured webview behaves exactly as it did before this file existed.
Filling one in is the *Reproducing* recipe on that platform, plus an
entry in `MEASURED_UNPLAYABLE`.

The track lists were measured on the same run, because the old codec
check read them:

| | WKWebView | WebKitGTK | WebView2 |
| --- | --- | --- | --- |
| `HTMLVideoElement.videoTracks` | present | ? | ? |
| `HTMLMediaElement.audioTracks` | present | ? | ? |

Both are non-standard. WebKit implements them; Chromium ships them
behind a flag, which is what Electron's
`enableBlinkFeatures: 'AudioVideoTracks'` was turning on, and Tauri has
no equivalent -- so on WebView2 they are expected to be `undefined`.

## What the app does with it

Two independent checks, and neither one trusts this table on its own.

**Before playback.** `unsupportedMediaMessage` opens the
unsupported-media modal for a file the running webview refuses. It
takes two agreeing answers to refuse: the extension has to be in
`MEASURED_UNPLAYABLE` for the *detected* engine **and** the live
`canPlayType` call has to return `""`. The table can only ever stop a
refusal, never cause one, so a WebKit build that grows Matroska support
plays the file with no code change, and an engine with no row refuses
nothing at all.

That second rule is there because `canPlayType` alone is not
trustworthy enough to gate on. Chromium answers `""` for
`video/x-matroska` and then plays the file. A wrong refusal is worse
than the media element's own error arriving a second later, so the
engine gate is what keeps the false positive out.

**During playback.** `mediaElementError` reads `videoTracks` and
`audioTracks` after `loadedmetadata`, and an **absent** list means "no
opinion", not "no tracks" -- reading `.length` off `undefined` threw,
and the throw took the rest of the handler with it: no error, no
`mediaSuccess`, no window resize, and a black window with no modal.

Either check dispatches `mediaError`, which is the modal the app
already had, and which offers the external player when one is
installed (US-080) or a VLC download link when one is not.

A `maybe` is not a promise: the type string says nothing about the
codecs actually inside the container, so an H.265 `.mp4` can still
fail. That is what the during-playback check is for. The point of the
before-playback check is only to skip the wait where the answer is
already known.

## Reproducing

`canPlayType` has no answer outside a real window, so this is a launch,
not a unit test. Add a throwaway probe to `src-tauri/src/main.rs` --
a `#[tauri::command] fn probe(message: String)` that `println!`s, and
an `append_invoke_initialization_script` that calls it with the
`canPlayType` answers for every type in
`media-extensions.js`'s `mimeTypes`. The recipe and its traps (the
leading `;`, the `setTimeout` wrapper, the stale single-instance
socket) are in `src-tauri/AGENTS.md`. Then:

```sh
npm run build:tauri && (cd src-tauri && cargo build)
rm -f /tmp/io_webtorrent_webtorrent_si.sock
HOME=/tmp/wt-probe-home src-tauri/target/debug/webtorrent-desktop
```

Kill the host afterwards -- and kill the engine sidecar with it, which
is a second process and does not go on its own. Revert `main.rs`; it is
source-controlled, unlike `build/`.
