const test = require('tape')

// US-079: the device mirror, which is what is left of
// `src/renderer/lib/cast.js` once the three npm packages and the
// in-renderer HTTP server go to the host (ADR-015).
//
// ADR-015 keeps the cast UI unchanged by rebuilding
// `state.devices[protocol]` in the shape `player-page.js` already
// reads -- an object with a synchronous `getDevices()` and a `device`
// -- from the flat list the host pushes. That fold, the status fold
// and the media description are plain functions here precisely so
// they can be tested without a receiver on the network; everything
// that needs one is host code and is exercised by the manual pass.

const {
  PROTOCOLS,
  mirrorDevices,
  castPlayer,
  canSetRate,
  applyStatus,
  subtitlesVtt,
  mediaFor
} = require('../../build/renderer/lib/cast-mirror')

const config = require('../../build/config')

function device (id, protocol, capabilities) {
  return { id, protocol, name: id + '-name', capabilities }
}

test('the three protocols the UI knows about', function (t) {
  t.deepEqual(PROTOCOLS.slice().sort(),
    ['airplay', 'chromecast', 'dlna'],
    'the strings player-page.js switches on')
  t.end()
})

test('the mirror is one player per protocol, always', function (t) {
  const devices = mirrorDevices([], {})
  t.deepEqual(Object.keys(devices).sort(), PROTOCOLS.slice().sort(),
    'a player for every protocol, even with no devices at all')
  for (const protocol of PROTOCOLS) {
    t.deepEqual(devices[protocol].getDevices(), [],
      protocol + ' reports no devices')
    t.equal(devices[protocol].device, null,
      protocol + ' is not connected')
  }
  t.end()
})

test('each player sees only its own protocol', function (t) {
  const list = [
    device('a', 'chromecast'),
    device('b', 'dlna'),
    device('c', 'chromecast')
  ]
  const devices = mirrorDevices(list, {})
  t.deepEqual(devices.chromecast.getDevices().map((d) => d.id), ['a', 'c'],
    'both Chromecasts, in host order')
  t.deepEqual(devices.dlna.getDevices().map((d) => d.id), ['b'],
    'the one DLNA renderer')
  t.deepEqual(devices.airplay.getDevices(), [],
    'nothing claims to be an AirPlay receiver')
  t.end()
})

// `player-page.js` renders the tick beside the connected device with
// `player.device === device`, so the rebuilt player has to hand back
// the *same object* it lists, not an equal one.
test('a rebuild carries the connected device across by identity',
  function (t) {
    const first = mirrorDevices([device('a', 'chromecast')], {})
    first.chromecast.device = first.chromecast.getDevices()[0]

    const second = mirrorDevices(
      [device('a', 'chromecast'), device('z', 'chromecast')], first)
    t.equal(second.chromecast.device, second.chromecast.getDevices()[0],
      'the connection survives a device appearing, by identity')
    t.equal(second.chromecast.device.id, 'a', 'and it is the same device')
    t.end()
  })

test('a connected device that goes away leaves nothing connected',
  function (t) {
    const first = mirrorDevices([device('a', 'dlna')], {})
    first.dlna.device = first.dlna.getDevices()[0]

    const second = mirrorDevices([device('b', 'dlna')], first)
    t.equal(second.dlna.device, null, 'the vanished device is not held on to')
    t.end()
  })

test('castPlayer answers for the location being played, and only then',
  function (t) {
    const devices = mirrorDevices([device('a', 'airplay')], {})
    const state = { devices, playing: { location: 'airplay' } }

    t.equal(castPlayer(state), devices.airplay, 'the connected player')
    t.equal(castPlayer(state, 'dlna'), devices.dlna, 'or one named outright')

    state.playing.location = 'local'
    t.equal(castPlayer(state), null, 'nothing while playing locally')

    // The connecting screen is up but no device is driving playback
    // yet, which is what the '-pending' suffix means.
    state.playing.location = 'airplay-pending'
    t.equal(castPlayer(state), null, 'nothing while still connecting')
    t.end()
  })

// `playback-controller.js` needs this answer synchronously -- it is
// what `Cast.setRate()`'s boolean return has always meant -- so it
// comes off the mirrored device's capabilities rather than off a
// promise.
test('canSetRate reads the connected device capabilities', function (t) {
  const devices = mirrorDevices([
    device('a', 'airplay', ['play', 'pause', 'seek', 'rate']),
    device('b', 'chromecast', ['play', 'pause', 'seek', 'volume'])
  ], {})
  const state = { devices, playing: { location: 'local' } }

  t.equal(canSetRate(state), false, 'not while playing locally')

  state.playing.location = 'airplay'
  devices.airplay.device = devices.airplay.getDevices()[0]
  t.equal(canSetRate(state), true, 'an AirPlay receiver takes a rate')

  state.playing.location = 'chromecast'
  devices.chromecast.device = devices.chromecast.getDevices()[0]
  t.equal(canSetRate(state), false, 'a Chromecast does not')
  t.end()
})

test('canSetRate survives a device that reports no capabilities',
  function (t) {
    const devices = mirrorDevices([device('a', 'dlna', undefined)], {})
    devices.dlna.device = devices.dlna.getDevices()[0]
    const state = { devices, playing: { location: 'dlna' } }
    t.equal(canSetRate(state), false, 'a missing list is no capabilities')
    t.end()
  })

test('the status fold writes the fields the player screen reads',
  function (t) {
    const playing = { isPaused: false, currentTime: 0, volume: 1 }
    applyStatus(playing, { isPaused: true, currentTime: 42.5, volume: 0.25 })
    t.deepEqual(playing, { isPaused: true, currentTime: 42.5, volume: 0.25 },
      'paused, position and volume all folded in')
    t.end()
  })

test('the status fold ignores fields the device did not report',
  function (t) {
    const playing = { isPaused: true, currentTime: 42.5, volume: 0.25 }
    applyStatus(playing, { isPaused: false })
    t.deepEqual(playing, { isPaused: false, currentTime: 42.5, volume: 0.25 },
      'an absent position does not reset the scrubber to zero')

    applyStatus(playing, null)
    t.deepEqual(playing, { isPaused: false, currentTime: 42.5, volume: 0.25 },
      'and no status at all changes nothing')
    t.end()
  })

test('subtitles cross as cue text, not as a data URL', function (t) {
  const vtt = 'WEBVTT\n\n00:00.000 --> 00:01.000\nhej hej\n'
  const subtitles = {
    selectedIndex: 1,
    tracks: [
      { buffer: 'data:text/vtt;base64,' + Buffer.from('no').toString('base64') },
      { buffer: 'data:text/vtt;base64,' + Buffer.from(vtt).toString('base64') }
    ]
  }
  t.equal(subtitlesVtt(subtitles), vtt, 'the selected track, decoded')

  subtitles.selectedIndex = -1
  t.equal(subtitlesVtt(subtitles), undefined, 'nothing selected, nothing sent')

  t.equal(subtitlesVtt({ selectedIndex: 0, tracks: [] }), undefined,
    'and no tracks at all is not a crash')
  t.end()
})

test('the media description is what the host is asked to play',
  function (t) {
    const state = {
      playing: {
        infoHash: 'abc',
        fileIndex: 3,
        currentTime: 90,
        subtitles: { selectedIndex: -1, tracks: [] }
      },
      server: { networkURL: 'http://10.0.0.2:8080' },
      saved: { torrents: [{ infoHash: 'abc', name: 'Sintel' }] }
    }

    t.deepEqual(mediaFor(state), {
      url: 'http://10.0.0.2:8080/3',
      title: config.APP_NAME + ' - Sintel',
      contentType: 'video/mp4',
      subtitlesVtt: undefined,
      startTime: 90
    }, 'the engine URL, a title, and where to resume from')
    t.end()
  })

// `lib/cast.js` only asked DLNA to seek on connect, and only past ten
// seconds; the host takes one `startTime` for all three, so the rule
// moves here rather than disappearing.
test('a barely-started file is cast from the beginning', function (t) {
  const state = {
    playing: {
      infoHash: 'abc',
      fileIndex: 0,
      currentTime: 4,
      subtitles: { selectedIndex: -1, tracks: [] }
    },
    server: { networkURL: 'http://10.0.0.2:8080' },
    saved: { torrents: [{ infoHash: 'abc', name: 'Sintel' }] }
  }
  t.equal(mediaFor(state).startTime, 0, 'under ten seconds starts over')

  state.playing.currentTime = undefined
  t.equal(mediaFor(state).startTime, 0, 'and an unknown position does too')
  t.end()
})

test('a torrent the saved list has lost still has a title', function (t) {
  const state = {
    playing: {
      infoHash: 'gone',
      fileIndex: 0,
      currentTime: 0,
      subtitles: { selectedIndex: -1, tracks: [] }
    },
    server: { networkURL: 'http://10.0.0.2:8080' },
    saved: { torrents: [] }
  }
  t.equal(mediaFor(state).title, config.APP_NAME,
    'the app name alone rather than a throw')
  t.end()
})
