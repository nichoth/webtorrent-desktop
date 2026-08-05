#!/usr/bin/env node

/**
 * Remove all traces of WebTorrent Desktop from the system (config and temp files).
 * Useful for developers.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const rimraf = require('rimraf')

const config = require('../src/config')

// First, remove generated files
rimraf.sync('build/')
rimraf.sync('build-vite/')
rimraf.sync('build-tauri/')
rimraf.sync('dist/')

// Remove any saved configuration
rimraf.sync(config.CONFIG_PATH)

// Remove any temporary files
let tmpPath
try {
  tmpPath = path.join(fs.statSync('/tmp') && '/tmp', 'webtorrent')
} catch (err) {
  tmpPath = path.join(os.tmpdir(), 'webtorrent')
}
rimraf.sync(tmpPath)

// Registering (and so unregistering) the .torrent and magnet handlers
// was `src/main/handlers.js`, which left with the Electron main
// process in US-072. The Rust host owns it from US-064; this script
// gets its uninstall step back when that lands.
