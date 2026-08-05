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
import applicationConfig from 'application-config'
import pkg from '../package.json' with { type: 'json' }

// `process` is a Node global, and since US-072 this module has a
// consumer that has no such thing: the webview. The engine sidecar
// (ADR-012) and the `bin/` dev scripts still do, so the reads below
// are guarded rather than deleted -- `null` here is "ask the host
// instead", and every use of it says what it falls back to.
//
// Tested on `process.versions` rather than on `process` alone because
// a bundler is entitled to substitute a stub: Vite rewrites bare
// `process.env` to `{}` for the browser, and a stub with an `env` and
// nothing else would pass a bare `typeof` check and then fail on the
// first real read.
const NODE_PROCESS =
  typeof process !== 'undefined' && process.versions != null
    ? process
    : null

// Constructed on demand, not at module load. `application-config`
// resolves the config directory through `os.platform()` and
// `process.env.HOME`, neither of which the webview can answer; in the
// bundle both are empty objects, so merely *constructing* this threw
// and took the whole renderer down before anything rendered. Nothing
// in the webview reaches it now -- see `getConfigPath()`.
let appConfig = null
function applicationConfigFor (name) {
  if (appConfig === null) appConfig = applicationConfig(name)
  return appConfig
}

// Babel compiles this module to CommonJS for both Electron processes,
// so `__dirname` is defined in every runtime that actually runs the
// app. The fallback only fires when Node loads this file directly as
// ESM, which happens exclusively for the `bin/` dev scripts -- they are
// npm scripts, so they always run with the repo root as the cwd, and
// this file always sits in `<repo>/src`.
// The third branch is the webview, which has neither. Every value
// derived from `DIRNAME` is a path into the repo or the app bundle,
// and the webview addresses those over the asset protocol rather than
// as files, so an empty base is the honest answer there.
const DIRNAME = typeof __dirname !== 'undefined'
  ? __dirname
  : NODE_PROCESS
    ? path.join(NODE_PROCESS.cwd(), 'src')
    : ''

export const APP_NAME = 'WebTorrent'
export const APP_TEAM = 'WebTorrent, LLC'
export const APP_VERSION = pkg.version

export const IS_TEST = isTest()
// `process.execPath` is the packaged binary, so only a Node runtime
// can answer this. The webview gets `''`, which `isPortable()` below
// never compares against because it returns early there.
const PORTABLE_PATH = !NODE_PROCESS
  ? ''
  : IS_TEST
    ? path.join(NODE_PROCESS.platform === 'win32' ? 'C:\\Windows\\Temp' : '/tmp', 'WebTorrentTest')
    : path.join(path.dirname(NODE_PROCESS.execPath), 'Portable Settings')
export const IS_PRODUCTION = isProduction()
export const IS_PORTABLE = isPortable()

export const UI_HEADER_HEIGHT = 38
export const UI_TORRENT_HEIGHT = 100

export const AUTO_UPDATE_URL = 'https://webtorrent.io/desktop/update'

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

export const WINDOW_INITIAL_BOUNDS = {
  width: 500,
  height: UI_HEADER_HEIGHT + (UI_TORRENT_HEIGHT * 6) // header + 6 torrents
}
export const WINDOW_MIN_HEIGHT = UI_HEADER_HEIGHT + (UI_TORRENT_HEIGHT * 2) // header + 2 torrents
export const WINDOW_MIN_WIDTH = 425

// Keep in sync with the named exports above.
export default {
  AUTO_UPDATE_URL,

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

  WINDOW_INITIAL_BOUNDS,
  WINDOW_MIN_HEIGHT,
  WINDOW_MIN_WIDTH,

  UI_HEADER_HEIGHT,
  UI_TORRENT_HEIGHT
}

function getConfigPath () {
  if (IS_PORTABLE) {
    return PORTABLE_PATH
  }

  // The webview cannot resolve this: the directory depends on the
  // platform and on `$HOME`, and it has neither. The host already
  // knows it -- `src-tauri/src/paths.rs` resolves the whole layout and
  // `app_paths` hands it over -- but nothing in the renderer consumes
  // that command yet, so `CONFIG_PATH` is empty in the webview and
  // `lib/state.js` falls back to a default state rather than reading a
  // saved one. That gap is recorded for US-072 in progress.log; it is
  // the renderer half of US-054 and it needs a bootstrap that can
  // await the host, which is a decision rather than an oversight.
  if (!NODE_PROCESS) {
    return ''
  }

  return path.dirname(applicationConfigFor(APP_NAME).filePath)
}

function getDefaultDownloadPath () {
  if (IS_PORTABLE) {
    return path.join(getConfigPath(), 'Downloads')
  } else {
    return getPath('downloads')
  }
}

// The OS directory lookup this used to do was `app.getPath()`, which
// belonged to Electron and left with it in US-072. The host owns it
// now: `src-tauri/src/paths.rs` resolves the whole layout, downloads
// directory included, and hands it to the renderer through the
// `app_paths` command.
//
// Nothing in the renderer consumes that command yet, so this returns
// `''` -- which is exactly what it already returned in the two
// processes that are left. The engine sidecar (ADR-012) is a plain
// Node process and never had a `process.type`, and the Tauri webview
// has no `process` at all. The remaining caller is
// `DEFAULT_DOWNLOAD_PATH`, so a profile created before the renderer
// reads `app_paths` gets an empty default download directory. That is
// recorded as an open gap in progress.log for US-072, not a decision.
function getPath (key) {
  return ''
}

// Read off `NODE_PROCESS` rather than off `process.env` directly so
// this keeps working without a bundler substitution: Vite rewrites
// bare `process.env` for the browser, and relying on that would make
// the answer depend on the build rather than on the runtime.
function isTest () {
  return NODE_PROCESS != null && NODE_PROCESS.env.NODE_ENV === 'test'
}

function isPortable () {
  if (IS_TEST) {
    return true
  }

  // Only a packaged Windows build can be portable, and the webview
  // cannot be one: the host decides, and `src-tauri/src/paths.rs`
  // reports the portable layout for real.
  if (!NODE_PROCESS) {
    return false
  }

  if (NODE_PROCESS.platform !== 'win32' || !IS_PRODUCTION) {
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

// This asked whether the running binary was the packaged app or the
// `electron` development binary, by matching `process.execPath`
// against the three platforms' spellings of it. Both the binary and
// the question left with US-072: the host decides now, and it decides
// it at compile time -- `src-tauri/src/paths.rs` uses
// `!cfg!(debug_assertions)`, so a debug build is never production.
//
// Everything reachable from here runs under `node` (the engine
// sidecar, ADR-012) or in the webview, and neither can answer it, so
// this is `false` rather than a guess. The one consequence is that
// `isPortable()` below takes its fast path on Windows; the host's
// `AppPaths` reports the portable layout for real.
function isProduction () {
  return false
}
