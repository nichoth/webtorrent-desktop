# Controllers

Each file here exports a class whose public methods are dispatcher
**actions**. `src/renderer/main.js` builds a flat map of action name ->
handler, and `lib/dispatcher.js` looks actions up **by string name** at
call time.

Consequences when editing a controller:

- Never delete a public method just because its body became empty.
  Callers dispatch by name from JSX (`onClick={() => dispatch('foo')}`)
  and from the main process
  (`windows.main.dispatch('uncaughtError', ...)`), so a missing method
  is a runtime lookup failure, not a compile error. Leave an empty
  method with a comment instead.
- Renaming a method means grepping for the string, not for the
  identifier. Check `src/renderer/pages/`, `src/renderer/components/`
  and `src/main/` too.
- Controllers are lazily *constructed* via `fn-getter` in `main.js`, but
  since the ESM conversion they are no longer lazily *loaded* -- their
  `import` in `main.js` is hoisted, so every module-level import here is
  paid at startup. A heavy new dependency in a controller now costs
  startup time. There is no synchronous ESM equivalent of the old lazy
  `require`, so if that ever matters the fix is a bundler-level split,
  not an inner `require`.

Every file in this directory is ESM (`import` / `export default`) as of
US-010. Keep it that way -- `module.exports` or a top-level `require(`
here breaks the Vite renderer bundle.

To exercise a controller non-interactively without touching the user's
saved data, dispatch a pure state-mutating action and undo it:
`toggleSelectTorrent(infoHash)` twice (torrent-list) and
`preview(x)` then `clearPreview()` (playback) each round-trip through a
real controller method while only reading/writing in-memory state.
Avoid `addTorrent` / `deleteTorrent` / `openTorrentContextMenu` -- the
first two write the real saved-state file and the third opens a
blocking native menu.

Controllers reach the main process through `ipcRenderer` today. Phase 2
of the renderer-decoupling work replaces those calls with the platform
shim -- check `specs/prd.json` before adding a new direct `electron`
import here.

**Every shim call is async, and `dispatch()` re-renders synchronously.**
`dispatch(action)` calls the handler and then `update()` in the same
turn, so any state a controller writes inside a `.then()` lands *after*
the render that was meant to show it. End such a continuation with
`dispatch('update')` (there is a no-op `update` handler in `main.js`
for exactly this) -- unless the continuation already dispatches
something else, which re-renders on its own. And always terminate the
promise with `.catch(err => dispatch('error', err))`; a floating
rejection is invisible.
