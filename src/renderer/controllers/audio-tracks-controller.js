import { dispatch } from '../lib/dispatcher'

// Multi-audio-track switching survived the port (US-082). It was
// expected not to: it is built on `HTMLMediaElement.audioTracks`, which
// Electron only had because of `enableBlinkFeatures:
// 'AudioVideoTracks'`. But that flag was turning on a *WebKit* API that
// Chromium had copied and kept disabled, and WKWebView and WebKitGTK
// implement it outright, so the feature works on two of the three
// webviews and disables its own control on the third. What each one
// reports is `lib/audio-tracks.js` and `docs/codec-support.md`.
export default class AudioTracksController {
  constructor (state) {
    this.state = state
  }

  selectAudioTrack (ix) {
    this.state.playing.audioTracks.selectedIndex = ix
    dispatch('skip', 0.2) // HACK: hardcoded seek value for smooth audio change
  }

  toggleAudioTracksMenu () {
    const audioTracks = this.state.playing.audioTracks
    audioTracks.showMenu = !audioTracks.showMenu
  }
}
