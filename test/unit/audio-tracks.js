const test = require('tape')
const fs = require('fs')
const path = require('path')

const {
  readAudioTracks,
  applyAudioTrackSelection
} = require('../../build/renderer/lib/audio-tracks')

// A stand-in for the webview's AudioTrackList. The real one is
// array-like with `length` and indexed access, which is all the code
// under test uses, so a plain array of track objects is faithful.
function trackList (tracks) {
  return tracks
}

test('readAudioTracks describes each track for the menu', function (t) {
  const el = {
    audioTracks: trackList([
      { label: 'English', language: 'en' },
      { label: 'Deutsch', language: 'de' }
    ])
  }
  const read = readAudioTracks(el)
  t.deepEqual(read.tracks, [
    { label: 'English', language: 'en' },
    { label: 'Deutsch', language: 'de' }
  ])
  t.end()
})

test('readAudioTracks names an unlabelled track by position', function (t) {
  // Matroska and MP4 both allow a track with no title. The menu still
  // has to say something clickable.
  const el = { audioTracks: trackList([{}, { language: 'de' }]) }
  const read = readAudioTracks(el)
  t.equal(read.tracks[0].label, 'Track 1')
  t.equal(read.tracks[1].label, 'Track 2')
  t.end()
})

test('readAudioTracks keeps the file\'s own default track', function (t) {
  // US-082. The old code set selectedIndex to 0 unconditionally and
  // then forced that track on, which overrode the default track of
  // every file whose default was not the first one.
  const el = {
    audioTracks: trackList([
      { label: 'Commentary', enabled: false },
      { label: 'English', enabled: true }
    ])
  }
  t.equal(readAudioTracks(el).selectedIndex, 1, 'the enabled track wins')
  t.end()
})

test('readAudioTracks falls back to the first track', function (t) {
  const el = { audioTracks: trackList([{ label: 'a' }, { label: 'b' }]) }
  t.equal(readAudioTracks(el).selectedIndex, 0,
    'no track reports itself enabled')
  t.end()
})

test('readAudioTracks reports no opinion without the list', function (t) {
  // `audioTracks` is non-standard: WebKit implements it, Chromium
  // ships it behind the flag Electron used to set and Tauri cannot.
  // Absent means "this webview does not say", not "no tracks", and it
  // must not throw -- that is what took out the whole loadedmetadata
  // handler in US-081.
  t.deepEqual(readAudioTracks({}), { tracks: [], selectedIndex: -1 })
  t.deepEqual(readAudioTracks(null), { tracks: [], selectedIndex: -1 })
  t.deepEqual(readAudioTracks({ audioTracks: trackList([]) }),
    { tracks: [], selectedIndex: -1 }, 'an empty list selects nothing')
  t.end()
})

test('applyAudioTrackSelection enables exactly one track', function (t) {
  const tracks = [
    { enabled: true },
    { enabled: false },
    { enabled: false }
  ]
  t.equal(applyAudioTrackSelection({ audioTracks: trackList(tracks) }, 2),
    true, 'reports that it applied')
  t.deepEqual(tracks.map((track) => track.enabled), [false, false, true])
  t.end()
})

test('applyAudioTrackSelection leaves the element alone otherwise',
  function (t) {
    const tracks = [{ enabled: true }, { enabled: false }]
    const el = { audioTracks: trackList(tracks) }

    t.equal(applyAudioTrackSelection(el, -1), false, 'nothing selected')
    t.equal(applyAudioTrackSelection(el, 5), false, 'out of range')
    t.deepEqual(tracks.map((track) => track.enabled), [true, false],
      'the default track is still the one playing')

    t.equal(applyAudioTrackSelection({}, 0), false, 'no list to apply to')
    t.equal(applyAudioTrackSelection(null, 0), false, 'no element')
    t.end()
  })

// When the track lists are read is as load-bearing as what is read out
// of them, and it lives in `pages/player-page.js`, which is JSX with a
// media element in it and so is not loadable here. Assert it against
// the source instead, the way the call-site tests do.
//
// Measured on WKWebView (docs/codec-support.md): at `loadedmetadata`
// both `videoTracks` and `audioTracks` are present and empty, and they
// fill from `addtrack` before `loadeddata`. Reading them on
// `loadedmetadata` therefore finds no tracks on every file, which
// `mediaElementError` reports as an undecodable one.
const PLAYER_PAGE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'renderer', 'pages',
    'player-page.js'), 'utf8')

// The body of `function name (...) { ... }`, by brace matching.
function functionBody (source, name) {
  const start = source.indexOf(`function ${name} (`)
  if (start === -1) return null
  const i = source.indexOf('{', start)
  let depth = 0
  for (let j = i; j < source.length; j++) {
    if (source[j] === '{') depth++
    else if (source[j] === '}' && --depth === 0) return source.slice(i, j)
  }
  return null
}

test('the player reads the track lists on loadeddata', function (t) {
  t.ok(/onLoadedData=\{onLoadedData\}/.test(PLAYER_PAGE),
    'the media element has a loadeddata handler')

  const onLoadedData = functionBody(PLAYER_PAGE, 'onLoadedData')
  t.ok(onLoadedData, 'onLoadedData exists')
  t.ok(/mediaElementError\(/.test(onLoadedData),
    'the codec check runs there')
  t.ok(/readAudioTracks\(/.test(onLoadedData),
    'the audio track menu is filled there')

  const onLoadedMetadata = functionBody(PLAYER_PAGE, 'onLoadedMetadata')
  t.ok(onLoadedMetadata, 'onLoadedMetadata exists')
  t.notOk(/mediaElementError\(|readAudioTracks\(|\.audioTracks|\.videoTracks/
    .test(onLoadedMetadata),
  'and nothing reads a track list before the lists are filled')
  t.end()
})
