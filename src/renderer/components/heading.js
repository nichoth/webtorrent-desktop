import React from 'react'
import PropTypes from 'prop-types'

import { grey100 } from 'material-ui/styles/colors'

class Heading extends React.Component {
  static get propTypes () {
    return {
      level: PropTypes.number
    }
  }

  static get defaultProps () {
    return {
      level: 1
    }
  }

  render () {
    const HeadingTag = 'h' + this.props.level
    const style = {
      color: grey100,
      fontSize: 20,
      marginBottom: 15,
      marginTop: 30
    }
    return (
      <HeadingTag style={style}>
        {this.props.children}
      </HeadingTag>
    )
  }
}

export default Heading
