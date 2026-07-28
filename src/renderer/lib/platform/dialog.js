/**
 * Platform shim: native file dialogs.
 *
 * Both of today's call sites use the *Sync variants of
 * `@electron/remote`'s dialog API. These wrappers are async anyway
 * (FR-10) so a message-passing host does not force a second refactor.
 *
 * Callers never pass a parent window: the shim parents every dialog
 * to the current window internally, which is what removes
 * `remote.getCurrentWindow()` from `components/path-selector.js` and
 * `controllers/torrent-list-controller.js`.
 *
 * Design-only stubs (US-018). Implemented in US-024, call sites
 * migrated in US-027. See docs/platform-shim.md.
 */

const NOT_IMPLEMENTED = 'platform/dialog: not implemented yet (US-024)'

/**
 * @typedef {object} FileFilter
 * @property {string} name       Human-readable filter name.
 * @property {string[]} extensions Extensions without a leading dot.
 */

/**
 * @typedef {object} OpenDialogOptions
 * @property {string} [title]
 * @property {string} [defaultPath]
 * @property {string} [buttonLabel]
 * @property {FileFilter[]} [filters]
 * @property {Array<'openFile'|'openDirectory'|'multiSelections'>} [properties]
 */

/**
 * @typedef {object} SaveDialogOptions
 * @property {string} [title]
 * @property {string} [defaultPath]
 * @property {string} [buttonLabel]
 * @property {FileFilter[]} [filters]
 */

/**
 * Show a native open dialog.
 *
 * @param {OpenDialogOptions} options
 * @returns {Promise<string[]>} Selected paths, or an empty array if
 *   the user cancelled. Note this differs from
 *   `showOpenDialogSync`, which returns `undefined` on cancel;
 *   callers currently guard with `Array.isArray(...)` and become a
 *   `.length` check.
 */
export async function showOpenDialog (options) {
  throw new Error(NOT_IMPLEMENTED)
}

/**
 * Show a native save dialog.
 *
 * @param {SaveDialogOptions} options
 * @returns {Promise<string|null>} The chosen path, or `null` if the
 *   user cancelled.
 */
export async function showSaveDialog (options) {
  throw new Error(NOT_IMPLEMENTED)
}
