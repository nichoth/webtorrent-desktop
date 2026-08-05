const test = require('tape')

const {
  detectEngine,
  mimeTypeFor,
  unsupportedMediaMessage,
  mediaElementError
} = require('../../build/renderer/lib/media-playability')
const mediaExtensions =
  require('../../build/renderer/lib/media-extensions').default

// The measured WKWebView answers (docs/codec-support.md). `canPlayType`
// takes the full type string, so a stub answers on the same keys the
// table records.
const WEBKIT = {
  'video/mp4': 'maybe',
  'video/webm': 'maybe',
  'video/quicktime': 'maybe',
  'video/x-matroska': '',
  'video/ogg': '',
  'video/x-ms-wmv': '',
  'audio/mpeg': 'maybe',
  'audio/x-matroska': '',
  'audio/x-ms-wma': '',
  'audio/ogg; codecs="opus"': 'probably'
}

function webkitProbe (type) {
  return WEBKIT[type] === undefined ? '' : WEBKIT[type]
}

// Chromium answers '' for the Matroska type and plays the file anyway,
// which is the false positive the engine gate exists to avoid.
function chromiumProbe (type) {
  return type === 'video/x-matroska' ? '' : 'maybe'
}

const WEBKIT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko)'
const WEBVIEW2_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 ' +
  'Edg/120.0.0.0'
const WEBKITGTK_UA = 'Mozilla/5.0 (X11; Linux x86_64) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'

test('detectEngine tells the three webviews apart', function (t) {
  t.equal(detectEngine(WEBKIT_UA), 'wkwebview', 'macOS WKWebView')
  // Two WebKits, two media stacks: WebKitGTK decodes through
  // GStreamer, so it cannot inherit the macOS measurements.
  t.equal(detectEngine(WEBKITGTK_UA), 'webkitgtk', 'Linux WebKitGTK')
  // Chromium says AppleWebKit too, so the Chrome token has to win.
  t.equal(detectEngine(WEBVIEW2_UA), 'webview2', 'Windows WebView2')
  t.equal(detectEngine(''), 'unknown', 'no user agent')
  t.equal(detectEngine(undefined), 'unknown', 'missing user agent')
  t.end()
})

test('mimeTypeFor maps a file name onto the type to probe', function (t) {
  t.equal(mimeTypeFor('The.Movie.mkv'), 'video/x-matroska')
  t.equal(mimeTypeFor('song.MP3'), 'audio/mpeg', 'case insensitive')
  t.equal(mimeTypeFor({ name: 'clip.mp4' }), 'video/mp4', 'file summary')
  t.equal(mimeTypeFor('notes.txt'), null, 'not media')
  t.equal(mimeTypeFor('poster.png'), null, 'images are not played')
  t.end()
})

test('every playable extension has a type to probe', function (t) {
  const playable = mediaExtensions.audio.concat(mediaExtensions.video)
  playable.forEach(function (ext) {
    t.ok(mimeTypeFor('file' + ext), ext + ' has a MIME type')
  })
  t.end()
})

test('unsupportedMediaMessage names a format WebKit measured as no', function (t) {
  const message = unsupportedMediaMessage('The.Movie.mkv', {
    userAgent: WEBKIT_UA,
    canPlayType: webkitProbe
  })
  t.ok(message, 'the modal gets a message')
  t.ok(message.includes('.mkv'), 'the message names the format')
  t.end()
})

test('unsupportedMediaMessage passes what WebKit can play', function (t) {
  const opts = { userAgent: WEBKIT_UA, canPlayType: webkitProbe }
  t.equal(unsupportedMediaMessage('clip.mp4', opts), null, 'mp4')
  t.equal(unsupportedMediaMessage('clip.webm', opts), null, 'webm')
  t.equal(unsupportedMediaMessage('clip.mov', opts), null, 'mov')
  t.equal(unsupportedMediaMessage('song.mp3', opts), null, 'mp3')
  t.equal(unsupportedMediaMessage('song.opus', opts), null, 'opus in ogg')
  t.end()
})

test('unsupportedMediaMessage ignores files that are not media', function (t) {
  const opts = { userAgent: WEBKIT_UA, canPlayType: webkitProbe }
  t.equal(unsupportedMediaMessage('notes.txt', opts), null)
  t.equal(unsupportedMediaMessage('', opts), null)
  t.end()
})

test('unsupportedMediaMessage refuses nothing on an unmeasured webview', function (t) {
  // Chromium answers '' for Matroska and plays it anyway, so a webview
  // with no measurements of its own must fall through to the media
  // element's own error rather than pre-empting playback.
  t.equal(unsupportedMediaMessage('The.Movie.mkv', {
    userAgent: WEBVIEW2_UA,
    canPlayType: chromiumProbe
  }), null, 'no pre-emptive refusal on WebView2')
  t.equal(unsupportedMediaMessage('The.Movie.mkv', {
    userAgent: WEBKITGTK_UA,
    canPlayType: webkitProbe
  }), null, 'nor on WebKitGTK, which decodes through GStreamer')
  t.end()
})

test('unsupportedMediaMessage needs the webview to agree', function (t) {
  // A WebKit build that grows Matroska support answers something other
  // than '', and the table must not overrule it.
  const message = unsupportedMediaMessage('The.Movie.mkv', {
    userAgent: WEBKIT_UA,
    canPlayType: function () { return 'probably' }
  })
  t.equal(message, null, 'the runtime answer wins over the table')
  t.end()
})

test('mediaElementError reports a video with no decodable track', function (t) {
  const noVideo = { videoTracks: [], audioTracks: [{}] }
  t.equal(mediaElementError('video', noVideo), 'Video codec unsupported')

  const noAudio = { videoTracks: [{}], audioTracks: [] }
  t.equal(mediaElementError('video', noAudio), 'Audio codec unsupported')

  const bothMissing = { videoTracks: [], audioTracks: [] }
  t.equal(mediaElementError('video', bothMissing), 'Video codec unsupported',
    'the video track is reported first')

  t.equal(mediaElementError('audio', { audioTracks: [] }),
    'Audio codec unsupported')
  t.end()
})

test('mediaElementError passes a media element with tracks', function (t) {
  t.equal(mediaElementError('video', {
    videoTracks: [{}], audioTracks: [{}]
  }), null)
  t.equal(mediaElementError('audio', { audioTracks: [{}] }), null)
  t.end()
})

test('mediaElementError survives a webview without the track lists', function (t) {
  // `audioTracks` and `videoTracks` are non-standard: Chromium ships
  // them disabled, so reading `.length` there threw and took the whole
  // loadedmetadata handler with it -- no error, no success, no
  // dimensions. Absent lists mean "no opinion", not "no tracks".
  t.equal(mediaElementError('video', {}), null, 'video, no lists')
  t.equal(mediaElementError('audio', {}), null, 'audio, no lists')
  t.equal(mediaElementError('video', { audioTracks: [{}] }), null,
    'only the audio list')
  t.end()
})
