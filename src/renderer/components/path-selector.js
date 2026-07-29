import path from 'path'

import { grey50 } from 'material-ui/styles/colors'
import React from 'react'
import PropTypes from 'prop-types'

import RaisedButton from 'material-ui/RaisedButton'
import TextField from 'material-ui/TextField'

import * as platformDialog from '../lib/platform/dialog'
import { dispatch } from '../lib/dispatcher'

// Lets you pick a file or directory.
// Uses the system Open File dialog.
// You can't edit the text field directly.
class PathSelector extends React.Component {
  static propTypes () {
    return {
      className: PropTypes.string,
      dialog: PropTypes.object,
      id: PropTypes.string,
      onChange: PropTypes.func,
      title: PropTypes.string.isRequired,
      value: PropTypes.string
    }
  }

  constructor (props) {
    super(props)
    this.handleClick = this.handleClick.bind(this)
  }

  handleClick () {
    const opts = Object.assign({
      defaultPath: path.dirname(this.props.value || ''),
      properties: ['openFile', 'openDirectory']
    }, this.props.dialog)

    // The shim parents the dialog to the current window itself, and
    // resolves to [] rather than undefined when the user cancels.
    platformDialog.showOpenDialog(opts)
      .then(filenames => {
        if (filenames.length === 0) return
        this.props.onChange && this.props.onChange(filenames[0])
      })
      .catch(err => dispatch('error', err))
  }

  render () {
    const id = this.props.title.replace(' ', '-').toLowerCase()
    const wrapperStyle = {
      alignItems: 'center',
      display: 'flex',
      width: '100%'
    }
    const labelStyle = {
      flex: '0 auto',
      marginRight: 10,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    }
    const textareaStyle = {
      color: grey50
    }
    const textFieldStyle = {
      flex: '1'
    }
    const text = this.props.value || ''
    const buttonStyle = {
      marginLeft: 10
    }

    return (
      <div className={this.props.className} style={wrapperStyle}>
        <div className='label' style={labelStyle}>
          {this.props.title}:
        </div>
        <TextField
          className='control' disabled id={id} value={text}
          inputStyle={textareaStyle} style={textFieldStyle}
        />
        <RaisedButton
          className='control' label='Change' onClick={this.handleClick}
          style={buttonStyle}
        />
      </div>
    )
  }
}

export default PathSelector
