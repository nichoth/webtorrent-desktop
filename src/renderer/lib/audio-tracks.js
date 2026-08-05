// The multi-audio-track menu, against what the webview really offers
// (US-082).
//
// `HTMLMediaElement.audioTracks` is non-standard. WebKit implements it,
// so WKWebView and WebKitGTK have it for real; Chromium ships it behind
// a flag, which is what Electron's `enableBlinkFeatures:
// 'AudioVideoTracks'` used to turn on and which Tauri has no way to
// set, so on WebView2 it is simply absent. `docs/codec-support.md`
// records the measurements.
//
// Absent is not the same as empty. An absent list means this webview
// says nothing about the file's tracks, and the menu stays disabled
// rather than the reads throwing from inside `loadedmetadata` (US-081).
//
// The element is the source of truth for which track is playing. The
// old code assumed track 0 and then forced it on, which overrode the
// default track of any file whose default was not the first one.

// What the menu needs to know: one entry per track, plus the index of
// the track the file itself starts with. `selectedIndex` is -1 when
// there is nothing to select, which is what keeps
// `applyAudioTrackSelection` from touching an element it knows nothing
// about.
export function readAudioTracks (mediaElement) {
  const list = mediaElement && mediaElement.audioTracks
  if (list == null || list.length === 0) {
    return { tracks: [], selectedIndex: -1 }
  }

  const tracks = []
  let selectedIndex = -1
  for (let i = 0; i < list.length; i++) {
    tracks.push({
      label: list[i].label || `Track ${i + 1}`,
      language: list[i].language
    })
    if (selectedIndex === -1 && list[i].enabled) selectedIndex = i
  }

  // A webview that reports no track as enabled still has to play
  // something, and that something is the first track.
  return { tracks, selectedIndex: selectedIndex === -1 ? 0 : selectedIndex }
}

// Put the user's choice back onto the element. Returns whether it had
// anything to apply, so a caller can tell "not selected" from "done".
export function applyAudioTrackSelection (mediaElement, selectedIndex) {
  const list = mediaElement && mediaElement.audioTracks
  if (list == null) return false
  if (!(selectedIndex >= 0 && selectedIndex < list.length)) return false

  for (let i = 0; i < list.length; i++) {
    list[i].enabled = i === selectedIndex
  }
  return true
}
