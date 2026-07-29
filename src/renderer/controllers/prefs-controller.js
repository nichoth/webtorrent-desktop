import { dispatch, reportErrors } from '../lib/dispatcher'
import * as ipcOs from '../lib/platform/ipc-os'

// Controls the Preferences screen
export default class PrefsController {
  constructor (state, config) {
    this.state = state
    this.config = config
  }

  // Goes to the Preferences screen
  show () {
    const state = this.state
    state.location.go({
      url: 'preferences',
      setup (cb) {
        // initialize preferences
        state.window.title = 'Preferences'
        reportErrors(ipcOs.setAllowNav(false))
        cb()
      },
      destroy: () => {
        reportErrors(ipcOs.setAllowNav(true))
      }
    })
  }

  // Updates a single property in the saved prefs
  // For example: updatePreferences('isFileHandler', true)
  update (property, value) {
    if (property === 'isFileHandler') {
      reportErrors(ipcOs.setDefaultFileHandler(value))
    } else if (property === 'startup') {
      reportErrors(ipcOs.setStartup(value))
    }

    this.state.saved.prefs[property] = value
    dispatch('stateSaveImmediate')
    dispatch('checkDownloadPath')
  }
}
