/**
 * No-op stub for `inline-style-prefixer` (a `material-ui` dependency).
 *
 * Loading the real package costs ~40ms and buys us nothing: auto-prefixing
 * is disabled in `src/renderer/pages/app.js` via `userAgent = false`, so
 * the prefixer is constructed but never asked to prefix anything.
 *
 * This replaces the `Module.prototype.require` hook that used to sit at the
 * top of `src/renderer/main.js` and return `{}` for this specifier. That
 * hook was invisible to bundlers; `resolve.alias` in `vite.config.js` does
 * the same job in a way Vite can see.
 */
export default {}
