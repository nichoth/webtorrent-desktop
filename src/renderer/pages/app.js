import React from 'react'

import { grey50, grey600, redA100, redA200, redA400 } from 'material-ui/styles/colors'
import darkBaseTheme from 'material-ui/styles/baseThemes/darkBaseTheme'
import lightBaseTheme from 'material-ui/styles/baseThemes/lightBaseTheme'
import getMuiTheme from 'material-ui/styles/getMuiTheme'
import MuiThemeProvider from 'material-ui/styles/MuiThemeProvider'

import Header from '../components/header'

import * as os from '../lib/os'

import TorrentListPage from './torrent-list-page'
import PlayerPage from './player-page'
import CreateTorrentPage from './create-torrent-page'
import PreferencesPage from './preferences-page'

import OpenTorrentAddressModal from '../components/open-torrent-address-modal'
import RemoveTorrentModal from '../components/remove-torrent-modal'
import UpdateAvailableModal from '../components/update-available-modal'
import UnsupportedMediaModal from '../components/unsupported-media-modal'
import DeleteAllTorrentsModal from '../components/delete-all-torrents-modal'

// These used to be lazy `require()` calls wrapped in fn-getter. ESM has no
// synchronous import, so every view and modal is now loaded up front.
const Views = {
  home: TorrentListPage,
  player: PlayerPage,
  'create-torrent': CreateTorrentPage,
  preferences: PreferencesPage
}

const Modals = {
  'open-torrent-address-modal': OpenTorrentAddressModal,
  'remove-torrent-modal': RemoveTorrentModal,
  'update-available-modal': UpdateAvailableModal,
  'unsupported-media-modal': UnsupportedMediaModal,
  'delete-all-torrents-modal': DeleteAllTorrentsModal
}

const fontFamily = os.isWindows()
  ? '"Segoe UI", sans-serif'
  : 'BlinkMacSystemFont, "Helvetica Neue", Helvetica, sans-serif'

darkBaseTheme.fontFamily = fontFamily
darkBaseTheme.userAgent = false
darkBaseTheme.palette.primary1Color = grey50
darkBaseTheme.palette.primary2Color = grey50
darkBaseTheme.palette.primary3Color = grey600
darkBaseTheme.palette.accent1Color = redA200
darkBaseTheme.palette.accent2Color = redA400
darkBaseTheme.palette.accent3Color = redA100

let darkMuiTheme
let lightMuiTheme

class App extends React.Component {
  render () {
    const state = this.props.state

    // Hide player controls while playing video, if the mouse stays still for a while
    // Never hide the controls when:
    // * The mouse is over the controls or we're scrubbing (see CSS)
    // * The video is paused
    // * The video is playing remotely on Chromecast or Airplay
    const hideControls = state.shouldHidePlayerControls()

    const cls = [
      'view-' + state.location.url(), /* e.g. view-home, view-player */
      'is-' + os.platform() /* e.g. is-darwin, is-win32, is-linux */
    ]
    if (state.window.isFullScreen) cls.push('is-fullscreen')
    if (state.window.isFocused) cls.push('is-focused')
    if (hideControls) cls.push('hide-video-controls')

    if (!darkMuiTheme) {
      darkMuiTheme = getMuiTheme(darkBaseTheme)
    }

    return (
      <MuiThemeProvider muiTheme={darkMuiTheme}>
        <div className={'app ' + cls.join(' ')}>
          <Header state={state} />
          {this.getErrorPopover()}
          <div key='content' className='content'>{this.getView()}</div>
          {this.getModal()}
        </div>
      </MuiThemeProvider>
    )
  }

  getErrorPopover () {
    const state = this.props.state
    const now = new Date().getTime()
    const recentErrors = state.errors.filter((x) => now - x.time < 5000)
    const hasErrors = recentErrors.length > 0

    const errorElems = recentErrors.map((error, i) => <div key={i} className='error'>{error.message}</div>)
    return (
      <div
        key='errors'
        className={'error-popover ' + (hasErrors ? 'visible' : 'hidden')}
      >
        <div key='title' className='title'>Error</div>
        {errorElems}
      </div>
    )
  }

  getModal () {
    const state = this.props.state
    if (!state.modal) return

    if (!lightMuiTheme) {
      lightBaseTheme.fontFamily = fontFamily
      lightBaseTheme.userAgent = false
      lightMuiTheme = getMuiTheme(lightBaseTheme)
    }

    const ModalContents = Modals[state.modal.id]
    return (
      <MuiThemeProvider muiTheme={lightMuiTheme}>
        <div key='modal' className='modal'>
          <div key='modal-background' className='modal-background' />
          <div key='modal-content' className='modal-content'>
            <ModalContents state={state} />
          </div>
        </div>
      </MuiThemeProvider>
    )
  }

  getView () {
    const state = this.props.state
    const View = Views[state.location.url()]
    return (<View state={state} />)
  }
}

export default App
