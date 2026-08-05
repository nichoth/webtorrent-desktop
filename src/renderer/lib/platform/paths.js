/**
 * Platform shim.
 *
 * Where the user's data lives (US-054, US-072).
 *
 * `src/config.js` used to answer this itself, by handing the app name
 * to `application-config` and taking the directory it named. That
 * reads `os.platform()` and `process.env.HOME`, so it is a Node
 * question, and the webview cannot ask it -- the platform's convention
 * for application support directories is not something a document
 * knows.
 *
 * The host has resolved the same layout since US-054, in
 * `src-tauri/src/paths.rs`, including the two cases `config.js` used
 * to special-case: the portable Windows install that keeps everything
 * beside the executable, and the Linux downloads directory, which
 * comes from the XDG user-dirs config rather than from `$HOME`. So the
 * whole layout crosses at once, as plain data (ADR-007), rather than a
 * path at a time.
 *
 * `src/renderer/main.js` calls this once, before `State.load`, and
 * feeds the answer to `config.useHostPaths`. Nothing else should need
 * it: every consumer reads `config.CONFIG_PATH` and its siblings the
 * way it always did.
 *
 * `docs/platform-shim.md` is the contract each export is written
 * against.
 */

import { invoke } from '@tauri-apps/api/core'

/**
 * @typedef {object} AppPaths
 * @property {string} configPath          The profile directory.
 * @property {string} torrentPath         Saved .torrent files.
 * @property {string} posterPath          Generated posters.
 * @property {string} tempPath            Scratch space.
 * @property {string} defaultDownloadPath Where downloads go by default.
 * @property {boolean} isPortable         A self-contained install.
 */

/**
 * The resolved layout.
 *
 * @returns {Promise<AppPaths>}
 */
export async function appPaths () {
  return invoke('app_paths')
}
