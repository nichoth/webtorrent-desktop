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

**A controller under unit test is compiled by the test itself.**
`build:node` ignores `controllers/`, so there is no Babel output for
`test/unit/*.js` to require (ADR-010); the three call-site files
(`os-ipc-call-sites.js`, `engine-ipc-call-sites.js`,
`cast-call-sites.js`) run Babel over the source and emit into
`build/renderer/controllers/`, where the `../lib/...` imports resolve
against the real built tree. They share that directory and
`require.cache` is keyed by path, so **emit under a per-file
suffix** (`.cast-test.js`) or one file's stubs become another's.

Split the work so as little as possible needs that machinery: the
controller keeps the wiring -- the shim calls, the state writes, the
`update()` -- and anything with a decision in it goes in `lib/`, which
*is* built and needs no compile step to test. `cast-controller.js` and
`lib/cast-mirror.js` are the worked example: the device fold, the
status fold and the media description are plain functions over plain
data in `lib/` (`test/unit/cast-mirror.js`), and what is left in the
controller is checked against a stubbed shim
(`test/unit/cast-call-sites.js`). Neither needs a receiver on the
network.

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

Since US-032 there is no `ipcRenderer` and no `electron` import left in
this directory at all: OS channels go through
`lib/platform/ipc-os.js`, the `wt-*` engine protocol through
`lib/platform/ipc-engine.js`. Do not add one back --
`test/unit/platform-boundary.js` fails on any channel string here.

The two dynamic engine channels are addressed by info hash, not by
name: call `ipcEngine.onTorrentReadyFor(infoHash, listener, { once:
true })` rather than building `'wt-ready-' + infoHash`. A one-shot
listener is `{ once: true }`, not a separate export.

Subscriptions resolve to their unsubscribe function, so a wait that
has to be cancelled (on leaving the player, say) must cope with the
cancel arriving before that promise does: record that it was
cancelled and call the unsubscribe as soon as it arrives. The listener
should also check that the thing it was armed for is still current
(`state.playing` is replaced on close), because a delivery can race
the withdrawal. `openExternalPlayer` in `media-controller.js` is the
worked example.

**Every shim call is async, and `dispatch()` re-renders synchronously.**
`dispatch(action)` calls the handler and then `update()` in the same
turn, so any state a controller writes inside a `.then()` lands *after*
the render that was meant to show it. End such a continuation with
`dispatch('update')` (there is a no-op `update` handler in `main.js`
for exactly this) -- unless the continuation already dispatches
something else, which re-renders on its own. And always terminate the
promise. For fire-and-forget calls that is `reportErrors(...)` from
`lib/dispatcher`, which is `.catch(err => dispatch('error', err))` in
one call; a floating rejection is invisible.
