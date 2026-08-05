/**
 * Unreachable-in-the-webview stub for `application-config`.
 *
 * `src/config.js` is shared by three runtimes, and only two of them can
 * use this package: the engine sidecar and the `bin/` dev scripts,
 * which load `src/config.js` through the Babel build and so never see
 * this file. The webview loads the Vite bundle, and there
 * `getConfigPath()` returns before it constructs anything -- the
 * config directory depends on `os.platform()` and `$HOME`, which a
 * webview cannot answer.
 *
 * The alias is needed anyway, because "never called" is not the same
 * as "never loaded". `src/config.js` imports the package statically,
 * and a static ESM import of a CommonJS module evaluates that module
 * at the importer's own initialization whether or not any binding is
 * read. The real package's dependency chain reaches `graceful-fs`,
 * whose module body reassigns `process.cwd` at load, so merely
 * importing it threw `ReferenceError: process is not defined` in the
 * webview and nothing rendered (US-072).
 *
 * It throws rather than returning a plausible-looking object, so that
 * a future renderer path reaching for a real config directory fails
 * where the mistake is instead of writing to `/config.json`. The
 * answer for such a caller is the host: `src-tauri/src/paths.rs`
 * resolves the layout and the `app_paths` command hands it over.
 */
export default function applicationConfig (name) {
  throw new Error(
    `application-config is not available in the renderer (asked for ${name}). ` +
    'Use the app_paths command; see stubs/application-config.js.'
  )
}
