/**
 * The main process's read-only view of the saved state file.
 *
 * The renderer owns config.json: it creates a fresh profile, runs the
 * migrations and does every write (`src/renderer/lib/state.js`, US-055).
 * The main process only needs two things out of it at startup, before
 * the renderer exists -- the window's saved bounds and the folder
 * watcher's prefs -- so it reads the file itself rather than loading
 * the renderer's state module.
 *
 * Deliberately tolerant: a missing, unreadable or corrupt file is not
 * an error here. The renderer will create or replace it a moment
 * later, and neither reader has anything useful to say about a config
 * it cannot parse.
 */

const fs = require('fs')
const path = require('path')

const config = require('../config')

const STATE_FILE = path.join(config.CONFIG_PATH, 'config.json')

// `prefs` has to be an object even when there is no file:
// `FolderWatcher.isEnabled()` reads straight through it.
function defaults () {
  return { prefs: {} }
}

function load (cb) {
  fs.readFile(STATE_FILE, 'utf8', (err, text) => {
    if (err) return cb(null, { saved: defaults() })

    let saved
    try {
      saved = JSON.parse(text)
    } catch (parseErr) {
      return cb(null, { saved: defaults() })
    }

    cb(null, { saved: Object.assign(defaults(), saved) })
  })
}

module.exports = { load }
