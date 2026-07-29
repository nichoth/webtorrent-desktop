import { ipcRenderer } from 'electron'

import { dispatch, reportErrors } from '../lib/dispatcher'
import * as ipcOs from '../lib/platform/ipc-os'
import * as Playlist from '../lib/playlist'

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
    else ipcRenderer.once('wt-server-running', onServerRunning)
  }

  externalPlayerNotFound () {
    const modal = this.state.modal
    if (modal && modal.id === 'unsupported-media-modal') {
      modal.externalPlayerNotFound = true
    }
  }
}
