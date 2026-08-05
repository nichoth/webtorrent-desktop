import * as cast from '../lib/platform/cast'
import * as CastMirror from '../lib/cast-mirror'
import { reportErrors } from '../lib/dispatcher'
import { CastingError } from '../lib/errors'

// Controls remote playback on Chromecast, DLNA and AirPlay receivers.
//
// This replaces `src/renderer/lib/cast.js`, which drove the three
// protocols itself through three npm packages and served subtitles
// from an HTTP server inside the renderer. ADR-015 moved all of that
// to the Rust host; what is left here is the session state the UI
// reads -- `state.devices`, `state.playing.location`, `castName` --
// and it is written from the same three actions the old module
// exported plus the events the host now pushes.
//
// Local playback is `playback-controller.js`, which calls the cast
// shim directly for the five commands that only forward a value
// (play, pause, seek, volume, rate). Nothing there needs this class,
// because everything it does to a session is already in `state`.
export default class CastController {
  constructor (state, update) {
    this.state = state
    this.update = update
    this.started = false
  }

  // Start looking for receivers on the local network.
  //
  // Deferred to `delayedInit()` in `main.js` for the reason the old
  // `lazyLoadCast()` existed: discovery is not worth doing during
  // startup. It costs the renderer nothing now -- the scan runs on the
  // host -- but it is still network traffic nobody has asked for yet.
  //
  // The listeners are registered before discovery starts, so a device
  // the host already knows about cannot be missed between the two;
  // `getDevices()` afterwards covers a host that found something
  // before this window existed.
  start () {
    if (this.started) return
    this.started = true

    reportErrors(Promise.all([
      cast.onDevices((devices) => this.setDevices(devices)),
      cast.onStatus((status) => this.setStatus(status)),
      cast.onError((message) => this.raise(message))
    ])
      .then(() => cast.startDiscovery())
      .then(() => cast.getDevices())
      .then((devices) => this.setDevices(devices)))
  }

  /*
   * Shows the device menu for a given cast type ('chromecast', 'airplay', etc)
   * The menu lists eg. all Chromecasts detected; the user can click one to cast.
   * If the menu was already showing for that type, hides the menu.
   */
  toggleMenu (location) {
    const state = this.state

    // If the menu is already showing, hide it
    if (state.devices.castMenu && state.devices.castMenu.location === location) {
      state.devices.castMenu = null
      return
    }

    // Never cast to two devices at the same time
    if (state.playing.location !== 'local') {
      throw new CastingError(
        `You can't connect to ${location} when already connected to another device`
      )
    }

    // Find all cast devices of the given type
    const player = CastMirror.castPlayer(state, location)
    const devices = player ? player.getDevices() : []
    if (devices.length === 0) {
      throw new CastingError(`No ${location} devices available`)
    }

    // Show a menu
    state.devices.castMenu = { location, devices }
  }

  // Start casting to the device the user picked out of that menu.
  //
  // The host answers when the receiver has accepted the session, so
  // `location` sits on the '-pending' suffix -- the Connecting...
  // screen -- until then, exactly as it did while the old module
  // waited for its `open()` callback.
  selectDevice (index) {
    const state = this.state
    const { location, devices } = state.devices.castMenu
    const device = devices[index]
    const player = CastMirror.castPlayer(state, location)

    player.device = device

    // Show the Connecting... screen
    state.devices.castMenu = null
    state.playing.castName = device.name
    state.playing.location = location + '-pending'

    reportErrors(cast.connect(device.id, CastMirror.mediaFor(state)).then(
      () => {
        state.playing.location = location
        this.update()
      },
      (err) => {
        player.device = null
        state.playing.location = 'local'
        this.raise('Could not connect to ' + device.name + '. ' + err.message)
      }))
  }

  // Stops casting, move video back to local screen.
  //
  // The video resumes locally from wherever the receiver had got to,
  // which is what `state.playing.currentTime` holds -- the host pushes
  // it on every status while a session is up.
  stop () {
    const state = this.state
    const player = CastMirror.castPlayer(state)

    if (player) {
      player.device = null
      reportErrors(cast.stop())
    }

    state.playing.location = 'local'
    state.playing.jumpToTime = Number.isFinite(state.playing.currentTime)
      ? state.playing.currentTime
      : 0
    this.update()
  }

  // The host's device list changed. It sends the whole list every
  // time, so this rebuilds rather than appends.
  setDevices (devices) {
    const state = this.state
    Object.assign(state.devices, CastMirror.mirrorDevices(devices, state.devices))
    this.update()
  }

  // The connected receiver reported where it is. Replaces the
  // one-second `setInterval` the old module ran in the renderer.
  setStatus (status) {
    CastMirror.applyStatus(this.state.playing, status)
    this.update()
  }

  // Casting failed, at any point: discovery, connecting, or a session
  // that dropped. Pushed onto `state.errors` the way the old module
  // did rather than dispatched as an error, so it stays a message in
  // the corner and not an error sound.
  raise (message) {
    this.state.errors.push({ time: new Date().getTime(), message })
    this.update()
  }
}
