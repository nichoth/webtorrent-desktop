import React from 'react'
import TextField from 'material-ui/TextField'
import { clipboard } from 'electron'

import ModalOKCancel from './modal-ok-cancel'
import { dispatch, dispatcher } from '../lib/dispatcher'
import { isMagnetLink } from '../lib/torrent-player'

export default class OpenTorrentAddressModal extends React.Component {
  render () {
    return (
      <div className='open-torrent-address-modal'>
        <p><label>Enter torrent address or magnet link</label></p>
        <div>
          <TextField
            id='torrent-address-field'
            className='control'
            ref={(c) => { this.torrentURL = c }}
            fullWidth
            onKeyDown={handleKeyDown.bind(this)}
          />
        </div>
        <ModalOKCancel
          cancelText='CANCEL'
          onCancel={dispatcher('exitModal')}
          okText='OK'
          onOK={handleOK.bind(this)}
        />
      </div>
    )
  }

  componentDidMount () {
    this.torrentURL.input.focus()
    const clipboardContent = clipboard.readText()

    if (isMagnetLink(clipboardContent)) {
      this.torrentURL.input.value = clipboardContent
      this.torrentURL.input.select()
    }
  }
}

function handleKeyDown (e) {
  if (e.which === 13) handleOK.call(this) /* hit Enter to submit */
}

function handleOK () {
  dispatch('exitModal')
  dispatch('addTorrent', this.torrentURL.input.value)
}
