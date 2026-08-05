import { dispatch, reportErrors } from '../lib/dispatcher'
import * as ipcEngine from '../lib/platform/ipc-engine'
import * as ipcOs from '../lib/platform/ipc-os'
import * as Playlist from '../lib/playlist'
import { unsupportedMediaMessage } from '../lib/media-playability'

// Controls local play back: the <video>/<audio> tag and VLC
// Does not control remote casting (Chromecast etc)
export default class MediaController {
  constructor (state) {
    this.state = state
  }

  // Dispatched by the <video>/<audio> tag; nothing to do, but the dispatcher
  // resolves every action by name so the method has to exist
  mediaSuccess () {}

  mediaStalled () {
    this.state.playing.isStalled = true
  }

  // Asked once per file, as soon as the player is open (US-081). Where
  // the webview has already been measured as unable to decode the
  // format, say so through the same modal a failed <video> would open,
  // rather than waiting to see whether an error event arrives at all.
  // An unmeasured webview answers nothing here and the media element
  // stays the only judge.
  checkMediaPlayability () {
    const state = this.state
    if (state.playing.location !== 'local') return
    const message = unsupportedMediaMessage(state.playing.fileName)
    if (message) dispatch('mediaError', message)
  }

  mediaError (error) {
    const state = this.state
    if (state.location.url() === 'player') {
      state.playing.location = 'error'
      ipcOs.checkForExternalPlayer(state.saved.prefs.externalPlayerPath)
        .then((isInstalled) => {
          state.modal = {
            id: 'unsupported-media-modal',
            error,
            externalPlayerInstalled: isInstalled
          }
          // The shim answers a turn later than the render that opened
          // the error screen, so the modal needs its own render (see
          // controllers/AGENTS.md).
          dispatch('update')
        })
        .catch((err) => dispatch('error', err))
    }
  }

  mediaTimeUpdate () {
    this.state.playing.lastTimeUpdate = new Date().getTime()
    this.state.playing.isStalled = false
  }

  mediaMouseMoved () {
    this.state.playing.mouseStationarySince = new Date().getTime()
  }

  controlsMouseEnter () {
    this.state.playing.mouseInControls = true
    this.state.playing.mouseStationarySince = new Date().getTime()
  }

  controlsMouseLeave () {
    this.state.playing.mouseInControls = false
    this.state.playing.mouseStationarySince = new Date().getTime()
  }

  openExternalPlayer () {
    const state = this.state
    state.playing.location = 'external'

    const onServerRunning = () => {
      state.playing.isReady = true

      const mediaURL = Playlist.getCurrentLocalURL(state)
      reportErrors(ipcOs.openExternalPlayer(
        state.saved.prefs.externalPlayerPath,
        mediaURL,
        state.window.title))
    }

    if (state.server != null) onServerRunning()
    else {
      // Addressed by info hash: since ADR-013 the broadcast channel can
      // carry a server started for poster generation.
      reportErrors(ipcEngine.onServerRunningFor(
        state.playing.infoHash, onServerRunning, { once: true }))
    }
  }

  externalPlayerNotFound () {
    const modal = this.state.modal
    if (modal && modal.id === 'unsupported-media-modal') {
      modal.externalPlayerNotFound = true
    }
  }
}
