# 10: The error list stays bounded

**What to build:** `state.errors` grows forever and the app filters the
whole list on every render to find the ones the error banner shows.

After this ticket, errors are recorded through one renderer lib
function, used by every site that pushes an error today. When it
records an error, it drops any errors older than the window the error
banner shows, so the list stays bounded however noisy the source is.
The banner keeps showing the same recent errors it shows today.

**Blocked by:** None (can start immediately)

**Touches:** a renderer lib module for the new function (for example
alongside `src/renderer/lib/errors.js`), `src/renderer/main.js`
(`onError`), `src/renderer/controllers/cast-controller.js` (the
`state.errors.push` site), `src/renderer/pages/app.js` (share the banner
window constant, currently 5000 ms), new unit test (prior art
`test/unit/time.js` and `test/unit/sound.js`)

**Status:** ready-for-agent

- [x] Recording many errors over a span longer than the banner window
      keeps the list bounded
- [x] Errors recorded within the banner window are kept
- [x] No site pushes to `state.errors` directly (source scan)
