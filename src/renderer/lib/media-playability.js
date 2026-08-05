import path from 'path'

import { mimeTypes } from './media-extensions'

// What this window can actually decode (US-081).
//
// Electron gave every platform the same Chromium media stack. Tauri
// does not: the window is WKWebView on macOS, WebKitGTK on Linux and
// WebView2 -- Chromium -- on Windows, and the three decode different
// things. `docs/codec-support.md` holds the measurements.
//
// Two rules keep this from turning into a new set of assumptions.
// First, nothing is refused unless the *running* webview says so:
// `canPlayType` is consulted every time, and the table below can only
// stop a refusal, never cause one. Second, a webview nobody has
// measured refuses nothing at all -- Chromium answers '' for
// `video/x-matroska` and then plays the file, so its own answer is not
// trustworthy on its own, and a wrong refusal is worse than the media
// element's error arriving a second later.

// The webviews Tauri opens, told apart by their user agent. Chromium
// says `AppleWebKit` too, so the Chrome token is checked first.
export function detectEngine (userAgent) {
  const ua = userAgent || ''
  if (/\bChrome\/|\bEdg\//.test(ua)) return 'webview2'
  if (!/AppleWebKit/.test(ua)) return 'unknown'
  return /Macintosh|Mac OS X/.test(ua) ? 'wkwebview' : 'webkitgtk'
}

// Extensions measured as undecodable, per webview. Only entries with a
// real measurement behind them belong here; an absent webview is an
// unmeasured one, and pre-empts nothing.
export const MEASURED_UNPLAYABLE = {
  // macOS 26.5.1 (25F80), AppleWebKit 605.1.15, measured 2026-08-05 in
  // the app's own window. The full table, and how to run it again on a
  // platform with no row here, is `docs/codec-support.md`.
  wkwebview: [
    '.asf', '.dff', '.dsf', '.mka', '.mkv', '.mpc', '.ogv', '.spx',
    '.wma', '.wmv', '.wv', '.wvp'
  ]
}

// The type a file is probed with, or null when it is not media this
// app plays.
export function mimeTypeFor (file) {
  const name = typeof file === 'string' ? file : (file && file.name) || ''
  return mimeTypes[path.extname(name).toLowerCase()] || null
}

// The message for the unsupported-media modal, or null to let playback
// go ahead. `opts` exists so this is testable without a window.
export function unsupportedMediaMessage (file, opts = {}) {
  const userAgent = opts.userAgent !== undefined
    ? opts.userAgent
    : (typeof navigator !== 'undefined' && navigator.userAgent)
  const canPlayType = opts.canPlayType || probeWithMediaElement

  const type = mimeTypeFor(file)
  if (type == null) return null

  const extension = path.extname(
    typeof file === 'string' ? file : file.name).toLowerCase()
  const measured = MEASURED_UNPLAYABLE[detectEngine(userAgent)]
  if (!measured || !measured.includes(extension)) return null

  // The table says this one was undecodable when it was measured; the
  // running webview gets the last word.
  if (canPlayType(type) !== '') return null

  return `This window can't decode ${extension} files. ` +
    'Play it in an external player instead.'
}

// The check that used to live inline in `pages/player-page.js`.
// `videoTracks` and `audioTracks` are non-standard -- WebKit has them,
// Chromium ships them disabled -- so an absent list means "no
// opinion", not "no tracks". Reading `.length` off `undefined` threw,
// and the throw took the rest of the `loadedmetadata` handler with it:
// no error, no `mediaSuccess`, no window resize, and a black window
// with no modal. Which track is *selected* is US-082's.
export function mediaElementError (type, mediaElement) {
  const el = mediaElement || {}
  if (type === 'video' && isEmptyTrackList(el.videoTracks)) {
    return 'Video codec unsupported'
  }
  if (isEmptyTrackList(el.audioTracks)) return 'Audio codec unsupported'
  return null
}

function isEmptyTrackList (tracks) {
  return tracks != null && tracks.length === 0
}

function probeWithMediaElement (type) {
  const tagName = type.startsWith('audio/') ? 'audio' : 'video'
  return document.createElement(tagName).canPlayType(type)
}
