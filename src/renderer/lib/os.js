/**
 * Which operating system the UI is running on.
 *
 * Four call sites in `src/renderer/` asked `process.platform` --
 * `pages/app.js` for a font stack and a CSS class, `components/header.js`
 * for the macOS window title, `controllers/torrent-list-controller.js`
 * for "Show in Finder" versus "Show in Folder". Under Electron the
 * window ran with `nodeIntegration: true`, so the Node global was
 * simply there. A webview has no `process` at all, and the `app.js`
 * read is at module scope, so after US-072 the bundle threw
 * `ReferenceError: process is not defined` before anything rendered.
 *
 * **This is deliberately not part of the platform shim.** The shim is
 * the host boundary and every export of it is `async` (docs/README.md,
 * "What this means day to day"), because `invoke` crosses a process
 * boundary. None of the four call sites can await: two are inside
 * `render()`, one builds a `className`, and one is a module-scope
 * constant. They do not need to -- the webview can answer this itself,
 * from `navigator`, with no host round trip. Asking the Rust side
 * would mean an async bootstrap and a re-render for a value that
 * cannot change while the app is running.
 *
 * The returned spellings are Node's (`darwin`, `win32`, `linux`) and
 * must stay Node's: `static/main.css` styles `.app.is-win32` and
 * `.app.is-darwin`, and the call sites compare against what
 * `process.platform` used to return. This module changed where the
 * answer comes from, not what it is.
 */

/**
 * The three platform tokens, longest-lived first. Order matters: a
 * macOS WKWebView and a Linux WebKitGTK agent are both WebKit and both
 * say `like Gecko`, so only the token inside the parentheses tells
 * them apart, and `Linux` must not be tested before `Macintosh`
 * (Android agents say both, and are not a target either way).
 */
const AGENT_TOKENS = [
  ['darwin', /\b(Macintosh|Mac OS X)\b/],
  ['win32', /\b(Windows|Win64|Win32)\b/],
  ['linux', /\b(Linux|X11|CrOS)\b/]
]

/**
 * The fallback, used for an agent none of the patterns match and for
 * no `navigator` at all -- which happens under the unit suite, since
 * these modules are also compiled to CommonJS and loaded by plain
 * Node.
 *
 * Something has to be returned rather than `undefined`, because the
 * value becomes a CSS class (`'is-' + platform()`) where a missing one
 * is silent. Linux is the least-decorated of the three -- macOS insets
 * the header for the traffic lights and Windows draws its own title
 * bar -- so it is the guess whose consequences are smallest.
 */
const FALLBACK = 'linux'

export function platform () {
  const agent = typeof navigator !== 'undefined' && navigator
    ? navigator.userAgent
    : ''
  if (typeof agent !== 'string') return FALLBACK

  for (const [name, pattern] of AGENT_TOKENS) {
    if (pattern.test(agent)) return name
  }
  return FALLBACK
}

export function isDarwin () {
  return platform() === 'darwin'
}

export function isWindows () {
  return platform() === 'win32'
}

export function isLinux () {
  return platform() === 'linux'
}

export default { platform, isDarwin, isWindows, isLinux }
