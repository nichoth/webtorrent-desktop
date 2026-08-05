// The file extensions the app treats as media, and the MIME type each
// one is probed with before playback (US-081).
//
// The type matters as much as the extension now: the window is a
// webview, not Chromium, and `canPlayType` is the only thing that
// knows what this one can decode. Each entry is the *most favourable*
// type for that extension -- `.opus` is asked about as Opus in an Ogg
// container rather than as `audio/opus`, because that is the answer a
// real file gets. See `docs/codec-support.md` for the measurements and
// `lib/media-playability.js` for what is done with them.
export const audioMimeTypes = {
  '.aac': 'audio/aac',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.asf': 'video/x-ms-asf',
  '.dff': 'audio/x-dsf',
  '.dsf': 'audio/x-dsf',
  '.flac': 'audio/flac',
  '.m2a': 'audio/mpeg',
  '.m4a': 'audio/x-m4a',
  '.m4b': 'audio/mp4',
  '.mka': 'audio/x-matroska',
  '.mp2': 'audio/mpeg',
  '.mp3': 'audio/mpeg',
  '.mpc': 'audio/x-musepack',
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg; codecs="opus"',
  '.spx': 'audio/x-speex',
  '.wav': 'audio/wav',
  '.wma': 'audio/x-ms-wma',
  '.wv': 'audio/x-wavpack',
  '.wvp': 'audio/x-wavpack'
}

export const videoMimeTypes = {
  '.avi': 'video/x-msvideo',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.ogv': 'video/ogg',
  '.wmv': 'video/x-ms-wmv',
  '.m2ts': 'video/mp2t'
}

export const mimeTypes = { ...audioMimeTypes, ...videoMimeTypes }

// The lists are derived so that an extension can never be playable and
// unprobeable at the same time; `test/unit/media-playability.js` holds
// that as an assertion.
const mediaExtensions = {
  audio: Object.keys(audioMimeTypes),
  video: Object.keys(videoMimeTypes),
  image: ['.gif', '.jpg', '.jpeg', '.png']
}

export default mediaExtensions
