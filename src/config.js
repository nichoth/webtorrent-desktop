// Shared configuration, consumed from three different module systems.
//
// Dual consumption
// ----------------
// `src/renderer/` is being converted to ESM, while `src/main/` stays
// CommonJS. Babel compiles this file to CommonJS for both, so the two
// consumption styles have to keep working side by side:
//
//   import config, { APP_NAME } from '../config'   // ESM renderer
//   const config = require('../config')            // CommonJS main
//   const { APP_NAME } = require('../config')      // CommonJS main
//
// That is why every value is exported twice: once as a named export
// (which Babel emits as `exports.APP_NAME`, so `config.APP_NAME` and
// destructuring both work from CommonJS) and once inside the default
// export object (so ESM `import config from '../config'` gets the same
// flat object it used to get from `require`). The two must be kept in
// sync -- a value added to one but not the other silently disappears
// for half the codebase.
//
// A third consumer exists: the dev scripts in `bin/` require this file
// straight from source, so Node loads it as real ESM rather than
// through Babel. See the `DIRNAME` note below.

import path from 'path'
import fs from 'fs'
import arch from 'arch'
import electron from 'electron'
import applicationConfig from 'application-config'
import pkg from '../package.json' with { type: 'json' }

const appConfig = applicationConfig('WebTorrent')

// Babel compiles this module to CommonJS for both Electron processes,
// so `__dirname` is defined in every runtime that actually runs the
// app. The fallback only fires when Node loads this file directly as
// ESM, which happens exclusively for the `bin/` dev scripts -- they are
// npm scripts, so they always run with the repo root as the cwd, and
// this file always sits in `<repo>/src`.
const DIRNAME = typeof __dirname !== 'undefined'
  ? __dirname
  : path.join(process.cwd(), 'src')

export const APP_NAME = 'WebTorrent'
export const APP_TEAM = 'WebTorrent, LLC'
export const APP_VERSION = pkg.version

export const IS_TEST = isTest()
const PORTABLE_PATH = IS_TEST
  ? path.join(process.platform === 'win32' ? 'C:\\Windows\\Temp' : '/tmp', 'WebTorrentTest')
  : path.join(path.dirname(process.execPath), 'Portable Settings')
export const IS_PRODUCTION = isProduction()
export const IS_PORTABLE = isPortable()

export const UI_HEADER_HEIGHT = 38
export const UI_TORRENT_HEIGHT = 100

export const ANNOUNCEMENT_URL = 'https://webtorrent.io/desktop/announcement'
export const AUTO_UPDATE_URL = 'https://webtorrent.io/desktop/update'
export const CRASH_REPORT_URL = 'https://webtorrent.io/desktop/crash-report'

export const APP_COPYRIGHT = `Copyright © 2014-${new Date().getFullYear()} ${APP_TEAM}`
export const APP_FILE_ICON = path.join(DIRNAME, '..', 'static', 'WebTorrentFile')
export const APP_ICON = path.join(DIRNAME, '..', 'static', 'WebTorrent')
export const APP_WINDOW_TITLE = APP_NAME

export const CONFIG_PATH = getConfigPath()

export const DEFAULT_TORRENTS = [
  {
    testID: 'bbb',
    name: 'Big Buck Bunny',
    posterFileName: 'bigBuckBunny.jpg',
    torrentFileName: 'bigBuckBunny.torrent'
  },
  {
    testID: 'cosmos',
    name: 'Cosmos Laundromat (Preview)',
    posterFileName: 'cosmosLaundromat.jpg',
    torrentFileName: 'cosmosLaundromat.torrent'
  },
  {
    testID: 'sintel',
    name: 'Sintel',
    posterFileName: 'sintel.jpg',
    torrentFileName: 'sintel.torrent'
  },
  {
    testID: 'tears',
    name: 'Tears of Steel',
    posterFileName: 'tearsOfSteel.jpg',
    torrentFileName: 'tearsOfSteel.torrent'
  },
  {
    testID: 'wired',
    name: 'The WIRED CD - Rip. Sample. Mash. Share',
    posterFileName: 'wiredCd.jpg',
    torrentFileName: 'wiredCd.torrent'
  }
]

export const DELAYED_INIT = 3000 /* 3 seconds */

export const DEFAULT_DOWNLOAD_PATH = getDefaultDownloadPath()

export const GITHUB_URL = 'https://github.com/webtorrent/webtorrent-desktop'
export const GITHUB_URL_ISSUES = 'https://github.com/webtorrent/webtorrent-desktop/issues'
export const GITHUB_URL_RAW = 'https://raw.githubusercontent.com/webtorrent/webtorrent-desktop/master'
export const GITHUB_URL_RELEASES = 'https://github.com/webtorrent/webtorrent-desktop/releases'

export const HOME_PAGE_URL = 'https://webtorrent.io'
export const TWITTER_PAGE_URL = 'https://twitter.com/WebTorrentApp'

export const OS_SYSARCH = arch() === 'x64' ? 'x64' : 'ia32'

export const POSTER_PATH = path.join(getConfigPath(), 'Posters')
export const ROOT_PATH = path.join(DIRNAME, '..')
export const STATIC_PATH = path.join(DIRNAME, '..', 'static')
export const TORRENT_PATH = path.join(getConfigPath(), 'Torrents')

export const WINDOW_ABOUT = 'file://' + path.join(DIRNAME, '..', 'static', 'about.html')
export const WINDOW_MAIN = 'file://' + path.join(DIRNAME, '..', 'static', 'main.html')
export const WINDOW_WEBTORRENT = 'file://' + path.join(DIRNAME, '..', 'static', 'webtorrent.html')

export const WINDOW_INITIAL_BOUNDS = {
  width: 500,
  height: UI_HEADER_HEIGHT + (UI_TORRENT_HEIGHT * 6) // header + 6 torrents
}
export const WINDOW_MIN_HEIGHT = UI_HEADER_HEIGHT + (UI_TORRENT_HEIGHT * 2) // header + 2 torrents
export const WINDOW_MIN_WIDTH = 425

// Keep in sync with the named exports above.
export default {
  ANNOUNCEMENT_URL,
  AUTO_UPDATE_URL,
  CRASH_REPORT_URL,

  APP_COPYRIGHT,
  APP_FILE_ICON,
  APP_ICON,
  APP_NAME,
  APP_TEAM,
  APP_VERSION,
  APP_WINDOW_TITLE,

  CONFIG_PATH,

  DEFAULT_TORRENTS,

  DELAYED_INIT,

  DEFAULT_DOWNLOAD_PATH,

  GITHUB_URL,
  GITHUB_URL_ISSUES,
  GITHUB_URL_RAW,
  GITHUB_URL_RELEASES,

  HOME_PAGE_URL,
  TWITTER_PAGE_URL,

  IS_PORTABLE,
  IS_PRODUCTION,
  IS_TEST,

  OS_SYSARCH,

  POSTER_PATH,
  ROOT_PATH,
  STATIC_PATH,
  TORRENT_PATH,

  WINDOW_ABOUT,
  WINDOW_MAIN,
  WINDOW_WEBTORRENT,

  WINDOW_INITIAL_BOUNDS,
  WINDOW_MIN_HEIGHT,
  WINDOW_MIN_WIDTH,

  UI_HEADER_HEIGHT,
  UI_TORRENT_HEIGHT
}

function getConfigPath () {
  if (IS_PORTABLE) {
    return PORTABLE_PATH
  } else {
    return path.dirname(appConfig.filePath)
  }
}

function getDefaultDownloadPath () {
  if (IS_PORTABLE) {
    return path.join(getConfigPath(), 'Downloads')
  } else {
    return getPath('downloads')
  }
}

function getPath (key) {
  if (!process.versions.electron) {
    // Node.js process
    return ''
  } else if (process.type === 'renderer') {
    // Electron renderer process
    return require('@electron/remote').app.getPath(key)
  } else {
    // Electron main process
    return electron.app.getPath(key)
  }
}

function isTest () {
  return process.env.NODE_ENV === 'test'
}

function isPortable () {
  if (IS_TEST) {
    return true
  }

  if (process.platform !== 'win32' || !IS_PRODUCTION) {
    // Fast path: Non-Windows platforms should not check for path on disk
    return false
  }

  try {
    // This line throws if the "Portable Settings" folder does not exist, and does
    // nothing otherwise.
    fs.accessSync(PORTABLE_PATH, fs.constants.R_OK | fs.constants.W_OK)
    return true
  } catch (err) {
    return false
  }
}

function isProduction () {
  if (!process.versions.electron) {
    // Node.js process
    return false
  }
  if (process.platform === 'darwin') {
    return !/\/Electron\.app\//.test(process.execPath)
  }
  if (process.platform === 'win32') {
    return !/\\electron\.exe$/.test(process.execPath)
  }
  if (process.platform === 'linux') {
    return !/\/electron$/.test(process.execPath)
  }
}
