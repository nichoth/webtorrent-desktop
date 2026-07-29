# Platform shim API surface

The shim lives at `src/renderer/lib/platform/` and is the sole source
of Electron and Node access for the renderer (FR-8). This document is
the design agreed in US-018: it maps every exported function onto the
call sites it will replace, so the migration stories (US-026 through
US-032) are mechanical rather than exploratory.

`ipc-os.js` is implemented as of US-020, `ipc-engine.js` as of
US-021, `shell.js` and `clipboard.js` as of US-022, `fs.js` as of
US-023, `dialog.js` and `window.js` as of US-024, and `menu.js` as of
US-025. The whole surface is implemented. The call sites move from
US-026 onwards; the `shell.openExternal` and `clipboard` ones are
migrated as of US-026, the `dialog` and `window` ones as of US-027,
the `fs` ones as of US-028, and the context menu as of US-029. US-030
moves the controller layer's non-`wt-*` `ipcRenderer` calls (plus the
one in `lib/migrations.js`) onto `ipc-os.js`, and US-031 does the same
for `src/renderer/main.js`. US-032 moves the remaining `wt-*` channels,
which now live only in the four engine-facing controllers.

US-031 also took `main.js`'s `wt-*` listeners onto `ipc-engine.js`,
ahead of US-032. Its acceptance criteria require `main.js` to stop
importing `electron` altogether, and those thirteen `ipcRenderer.on`
calls were the only thing left keeping the import alive. Splitting the
file across two stories would have meant leaving a direct Electron
import in the renderer entry point purely to satisfy a story boundary.

Three of those call sites landed on `shell.js` rather than `ipc-os.js`:
`openPath`, `showItemInFolder` and `moveItemToTrash` are IPC channels
but belong to the shell concern (see the `shell.js` section below).
US-026 migrated the `shell.openExternal` callers and missed these,
because they were spelled `ipcRenderer.send`, not `electron.shell`.

## Rules the surface follows

- **Everything is `async`** (FR-10), including wrappers around
  Electron APIs that are synchronous today (`clipboard.readText`,
  `dialog.showOpenDialogSync`, `window.isMaximized`, every `fs`
  operation). A host that has to cross a process boundary must not
  force a second refactor of every call site.
- **Engine IPC and OS IPC are separate modules that share no
  exports** (FR-9). `ipc-engine.js` covers the `wt-*` channels and
  only those; `ipc-os.js` covers every other renderer/main channel.
- **Channel names never reach a caller.** Each channel gets a named
  function. The two dynamic engine channels take the info hash as an
  argument instead of having callers concatenate strings.
- **Listener registration resolves to an unsubscribe function**, so
  no caller touches `removeListener`. Registrations take an optional
  `{ once: true }` to cover today's `ipcRenderer.once` call sites.
- **Menus are data** (FR-12). Callers pass descriptor objects; no
  `MenuItem` instance crosses the boundary.

## Module layout

| Module | Concern | Implemented in |
| --- | --- | --- |
| `index.js` | Namespace barrel | US-018 |
| `ipc-os.js` | Non-`wt-*` renderer/main IPC | US-020 |
| `ipc-engine.js` | The `wt-*` engine protocol | US-021 |
| `shell.js` | Handing paths and URLs to the OS | US-022 |
| `clipboard.js` | System clipboard | US-022 |
| `fs.js` | File system | US-023 |
| `dialog.js` | Native file dialogs | US-024 |
| `window.js` | Reading current-window state | US-024 |
| `menu.js` | Data-driven context menus | US-025 |

Line references below are against the tree at US-018 and will drift
as call sites move. They are a starting point, not a contract.

## `shell.js`

`openExternal` is the only one the renderer performs directly today.
The other three already go to the main process over IPC. They live in
`shell.js` rather than `ipc-os.js` because they are one concern and a
non-Electron host implements all four the same way. `ipc-os.js`
exports none of them.

| Function | Replaces |
| --- | --- |
| `openExternal(url)` | `components/unsupported-media-modal.js:39`, `components/update-available-modal.js:28` |
| `showItemInFolder(path)` | `controllers/torrent-list-controller.js:401` (`showItemInFolder` channel) |
| `openPath(path)` | `controllers/playback-controller.js:66` (`openPath` channel) |
| `moveItemToTrash(path)` | `controllers/torrent-list-controller.js:397` (`moveItemToTrash` channel) |

The US-022 implementation keeps that split: `openExternal` calls
Electron's renderer-side `shell.openExternal`, while the other three
still `ipcRenderer.send` on their existing channels, which the main
process already handles (`src/main/ipc.js`). `moveItemToTrash` is
main-only in Electron, so routing all three the same way keeps the
module's behaviour uniform.

## `clipboard.js`

| Function | Replaces |
| --- | --- |
| `readText()` | `main.js:497`, `components/open-torrent-address-modal.js:35` |
| `writeText(text)` | `controllers/torrent-list-controller.js:286`, `:291` |

## `dialog.js`

Callers do not pass a parent window; the shim parents every dialog to
the current window internally. That is what removes
`remote.getCurrentWindow()` from `path-selector.js` and
`torrent-list-controller.js`.

| Function | Replaces |
| --- | --- |
| `showOpenDialog(options)` | `components/path-selector.js:37`, `controllers/subtitles-controller.js:18` |
| `showSaveDialog(options)` | `controllers/torrent-list-controller.js:331` |

Shape changes for the migration:

- `showOpenDialog` resolves to `string[]`, empty on cancel, where
  `showOpenDialogSync` returns `undefined`. The two
  `Array.isArray(filenames)` guards become `filenames.length` checks.
- `showSaveDialog` resolves to `string|null`, where
  `showSaveDialogSync` returns `undefined`. `if (!savePath) return`
  guards keep working unchanged.

All three call sites are migrated as of US-027. `path-selector.js` and
`torrent-list-controller.js` no longer call `remote.getCurrentWindow()`
for a dialog parent -- but `torrent-list-controller.js` still imports
`@electron/remote` for `remote.Menu` / `remote.MenuItem` and one more
`remote.getCurrentWindow()` in `menu.popup()`. That is the third
concern, and it leaves with US-029.

## `window.js`

Only the reads `@electron/remote` supplies. Everything that *changes*
the window already goes over IPC and lives in `ipc-os.js`.

| Function | Replaces |
| --- | --- |
| `isVisible()` | `main.js:149` |
| `isMaximized()` | `main.js:410`, `main.js:422` |

There is deliberately **no exported current-window handle**. Both
reads resolve the window internally, per call, and only a boolean
crosses the boundary: a `BrowserWindow` proxy is not serialisable, so
handing one out would put an Electron object back in front of exactly
the callers this shim exists to keep clean (FR-12). `dialog.js`
parents its dialogs the same way, through its own
`getCurrentWindow()` call rather than through `window.js`.

`main.js:422` used to assign `.isMaximized` without calling it, so
`state.window.wasMaximized` was set to a function. US-027 replaced it
with the awaited boolean, which -- because the write is only reached
when the window is *not* maximized -- means the field went from
always-truthy to always `false`. Nothing reads it, but it is a
behaviour change rather than a pure refactor.

Migrating `main.js:149` also fixed a larger latent bug: the
`electron.remote` spelling there had been throwing since Electron 14,
which aborted the rest of `onState()` and meant `delayedInit()` never
ran. It runs now, so `checkDownloadPath()`, the visibility listener
and `Cast.init()` all execute for the first time in a long while.

`screen.getAllDisplays()` is **excluded**. Its only consumer was
`lib/telemetry.js`, which US-002 deleted, so there is nothing left to
support.

### Sync-to-async risk site: the window-bounds save path

`setDimensions()` in `src/renderer/main.js` (lines 407-422 today; the
PRD's "443-455" predates the US-002 deletions) is the one place where
maximize state is read *while* window bounds are being saved, and it
is the riskiest conversion in US-027:

```js
if (electron.remote.getCurrentWindow().isMaximized()) {
  state.window.bounds = null
  return
}
state.window.bounds = { x: window.screenX, ... }
state.window.wasMaximized = electron.remote.getCurrentWindow().isMaximized
```

Today the guard, the four `window.screenX`/`outerWidth` reads and the
`wasMaximized` write all happen in one synchronous turn, so they
describe a single instant. Awaiting `window.isMaximized()` twice puts
two suspension points in the middle of that, and `setDimensions` is
called from the video-resize path while the user may still be
dragging or maximizing. Three things follow for US-027:

- The `window.screen*`/`outer*` reads must be taken *before* the
  first `await`, or the saved bounds can belong to a different window
  size than the maximize check they are guarded by.
- `setDimensions` becomes `async`, so every caller has to await it or
  accept that `state.window.bounds` is set after they return. Chase
  the callers; do not stop at the function itself.
- The two `isMaximized()` reads are one read. Await once and reuse
  the boolean rather than awaiting twice -- that also fixes the
  `wasMaximized`-is-a-function bug above.

US-027 resolved it as: `setDimensions()` takes the four geometry
reads synchronously into a local `bounds` object, then hands it plus
the single awaited `maximized` boolean to a new `applyDimensions()`
that holds the rest of the old body in its original order. The only
caller is `dispatch('setDimensions')` from `pages/player-page.js`,
which ignores the return value, so `setDimensions()` stays
non-`async` and terminates the promise with
`.catch(err => dispatch('error', err))` like every other migrated
call site. `applyDimensions()` ends with its own `update()`, because
`dispatch()`'s update already ran while the shim call was in flight.

## `menu.js`

| Function | Replaces |
| --- | --- |
| `showContextMenu(items)` | `controllers/torrent-list-controller.js:258-310`, the nine-item torrent context menu |

Migrated in US-029. The controller now builds one flat descriptor
array -- the reveal item and the separator that follows it are spread
in from a ternary on `torrentSummary.files` -- and ends with
`menu.showContextMenu(items).catch(err => dispatch('error', err))`.
`@electron/remote` is gone from the controller entirely.

A descriptor is a plain object:

| Field | Type | Meaning |
| --- | --- | --- |
| `type` | `'normal'` \| `'separator'` | Defaults to `'normal'`. Any other value throws. |
| `label` | `string` | Required unless `type` is `'separator'`; a missing label throws. |
| `click` | `() => void` | Optional. Called with **no arguments** when the user picks the item. |
| `enabled` | `boolean` | Defaults to `true`. Only `false` disables. |

A separator ignores every other field. `click` is wrapped inside the
shim, so Electron's `(menuItem, browserWindow, event)` arguments never
reach the caller -- a handler that wants the window asks `window.js`.
Descriptors are validated before the menu is built, so a bad one
rejects without a half-built menu appearing.

There is **no submenu type**, because the renderer has no submenu.
Verified at US-025: `controllers/torrent-list-controller.js:258-310`
is the only `remote.Menu` in `src/renderer/`, and it uses labels,
`click` handlers, one `enabled` flag on "Save Torrent File As...",
three separators, and a manual `'checkmark '` label prefix for "Sort
by Name" (which stays a label, not a checkbox type). Add a submenu
type when a menu needs one, on the same "no more than today" rule the
rest of the shim follows.

The existing menu is therefore expressible as-is. US-029 does the
rewrite; it builds ten descriptors when `torrentSummary.files` is set
(seven items and three separators) and eight when it is not.

## `fs.js`

Exactly the operations the renderer performs today, no more. The list
was re-enumerated at US-023 by grepping `src/renderer/` for `fs` usage
excluding `webtorrent.js` (which FR-4 exempts from the shim) and
excluding `lib/platform/` itself. That grep finds five files --
`main.js`, `lib/state.js`, `lib/migrations.js`,
`controllers/torrent-list-controller.js` and
`controllers/subtitles-controller.js` -- and nine distinct operations,
which is the table below unchanged from US-018. Nothing was added or
removed.

| Function | Replaces |
| --- | --- |
| `readFile(path)` | `controllers/torrent-list-controller.js:336`, `lib/state.js:166` (`readFileSync`), `controllers/subtitles-controller.js:93` (`createReadStream`) |
| `writeFile(path, data)` | `controllers/torrent-list-controller.js:338` |
| `copyFile(src, dest)` | `lib/state.js:152`, `:156`, `lib/migrations.js:69`, `:84`, `:196` |
| `mkdir(path)` | `lib/state.js:146`, `:147` |
| `rename(oldPath, newPath)` | `lib/migrations.js:188`, `:205` |
| `unlink(path)` | `controllers/torrent-list-controller.js:389` |
| `readdir(path)` | `controllers/torrent-list-controller.js:379` |
| `stat(path)` | `main.js:566`, `controllers/torrent-list-controller.js:97`, `:364` |
| `exists(path)` | `lib/migrations.js:135` (`try { statSync() } catch {}`) |

Shape changes for the migration:

- `stat` resolves to a plain `{ size, isDirectory, isFile }` object,
  not a Node `Stats` instance, so it survives message passing.
  `stat.isDirectory()` becomes `stat.isDirectory`.
- There is no `createReadStream`. `subtitles-controller.js` reads the
  whole file with `readFile` instead. Subtitle files are small and
  the existing code concatenates the stream before parsing anyway.
- `mkdir` is always recursive. That is the only mode the renderer
  uses.
- `readFile` resolves to a plain `Uint8Array` view, not a `Buffer`, on
  the same rule that flattens `stat`: no Node object crosses the
  boundary. Text callers must decode --
  `JSON.parse(await fs.readFile(p))` does **not** work where
  `JSON.parse(readFileSync(p))` did, because a `Uint8Array` stringifies
  to `"1,2,3"`. `lib/state.js` is the caller this bites; US-028 has to
  add a `TextDecoder`.
- US-028 has to reckon with `lib/state.js` and `lib/migrations.js`
  being synchronous today and being loaded by `src/main/` as well as
  the renderer. That is the largest single piece of the fs migration.

As migrated in US-028: `migrations.run()` and `state`'s
`setupStateSaved()` are `async`, and `State.load(cb)` -- already an
`async function` -- awaits both before calling `cb`. Nothing outside
`state.js` calls either, so the async spread stops there. `readFile`'s
`Uint8Array` needed one more accommodation than the note above
predicted: `parse-torrent` 9 rejects a bare `Uint8Array` with "Invalid
torrent identifier", so `state.js` wraps the same memory in a
`Buffer`.

## `ipc-os.js`

### Commands

| Function | Channel | Replaces |
| --- | --- | --- |
| `setTitle(title)` | `setTitle` | `main.js:197` |
| `setProgress(progress)` | `setProgress` | `main.js:201` |
| `setBadge(count)` | `setBadge` | `main.js:205` |
| `setBounds(bounds, maximize)` | `setBounds` | `main.js:442`, `controllers/playback-controller.js:390` |
| `setAspectRatio(aspectRatio)` | `setAspectRatio` | `main.js:441`, `main.js:552`, `controllers/playback-controller.js:388` |
| `toggleFullScreen(setTo)` | `toggleFullScreen` | `main.js:306` |
| `show()` | `show` | `controllers/torrent-controller.js:181` |
| `signalReady()` | `ipcReady` | `main.js:363` |
| `signalStateSaved()` | `stateSaved` | `main.js:365` |
| `openTorrentFileDialog()` | `openTorrentFile` | `main.js:211` |
| `openFilesDialog()` | `openFiles` | `main.js:212` |
| `setAllowNav(allow)` | `setAllowNav` | `controllers/prefs-controller.js:20`, `:24` |
| `setDefaultFileHandler(v)` | `setDefaultFileHandler` | `controllers/prefs-controller.js:32`, `lib/migrations.js:45` |
| `setStartup(startup)` | `setStartup` | `controllers/prefs-controller.js:33` |
| `startFolderWatcher()` | `startFolderWatcher` | `controllers/folder-watcher-controller.js:6` |
| `stopFolderWatcher()` | `stopFolderWatcher` | `controllers/folder-watcher-controller.js:11` |
| `checkForExternalPlayer(path)` | `checkForExternalPlayer` | `controllers/media-controller.js:24-25` |
| `openExternalPlayer(path, url, title)` | `openExternalPlayer` | `controllers/media-controller.js:62` |
| `quitExternalPlayer()` | `quitExternalPlayer` | `controllers/playback-controller.js:348` |
| `notifyPlayerPlay()` | `onPlayerPlay` | `controllers/playback-controller.js:129` |
| `notifyPlayerPause()` | `onPlayerPause` | `controllers/playback-controller.js:140` |
| `notifyPlayerOpen()` | `onPlayerOpen` | `controllers/playback-controller.js:244` |
| `notifyPlayerUpdate(hasNext, hasPrevious)` | `onPlayerUpdate` | `controllers/playback-controller.js:335` |
| `notifyPlayerClose()` | `onPlayerClose` | `controllers/playback-controller.js:367` |
| `notifyDownloadFinished(path)` | `downloadFinished` | `controllers/torrent-controller.js:96` |

`checkForExternalPlayer` collapses a `send` plus an
`ipcRenderer.once` reply into a single promise. It is the only
request/response pair on the OS side.

The `notify*` prefix avoids confusion: the main process named these
channels `onPlayerPlay` and so on, but they are outbound commands,
not listeners.

### Events

| Function | Channel | Replaces |
| --- | --- | --- |
| `onLog(listener, opts)` | `log` | `main.js:340` |
| `onError(listener, opts)` | `error` | `main.js:341` |
| `onDispatch(listener, opts)` | `dispatch` | `main.js:343` |
| `onFullscreenChanged(listener, opts)` | `fullscreenChanged` | `main.js:345` |
| `onWindowBoundsChanged(listener, opts)` | `windowBoundsChanged` | `main.js:346` |

## `ipc-engine.js`

This is the seam the torrent engine is swapped at. A librqbit
implementation has to satisfy exactly this surface and nothing more.
The full protocol, including payload shapes and delivery semantics, is
in **The `wt-*` protocol** below (US-033); the tables here map the
functions onto the call sites they replaced.

The counterparty is `src/renderer/webtorrent.js` in the hidden
window. Per FR-4 it is not migrated and stays a direct `ipcRenderer`
consumer.

### Commands

| Function | Channel | Replaces |
| --- | --- | --- |
| `setGlobalTrackers(trackers)` | `wt-set-global-trackers` | `controllers/torrent-list-controller.js:117` |
| `startTorrenting(key, id, path, modtimes, selections)` | `wt-start-torrenting` | `controllers/torrent-list-controller.js:40`, `:107` |
| `stopTorrenting(infoHash)` | `wt-stop-torrenting` | `controllers/torrent-list-controller.js:138`, `:156`, `:405`, `controllers/torrent-controller.js:23` |
| `createTorrent(key, options)` | `wt-create-torrent` | `controllers/torrent-list-controller.js:75` |
| `saveTorrentFile(key)` | `wt-save-torrent-file` | `controllers/torrent-controller.js:78` |
| `generateTorrentPoster(key)` | `wt-generate-torrent-poster` | `controllers/torrent-controller.js:81` |
| `getAudioMetadata(infoHash, index)` | `wt-get-audio-metadata` | `controllers/playback-controller.js:310` |
| `startServer(infoHash)` | `wt-start-server` | `controllers/playback-controller.js:261` |
| `stopServer()` | `wt-stop-server` | `controllers/playback-controller.js:365` |
| `selectFiles(infoHash, selections)` | `wt-select-files` | `controllers/torrent-list-controller.js:193` |

### Events

| Function | Channel | Replaces |
| --- | --- | --- |
| `onTorrentParsed` | `wt-parsed` | `main.js:349` |
| `onTorrentMetadata` | `wt-metadata` | `main.js:350` |
| `onTorrentReady` | `wt-ready` | no UI listener today |
| `onTorrentReadyFor(infoHash, ...)` | `wt-ready-${infoHash}` | `controllers/playback-controller.js:254`, `:303` |
| `onTorrentDone` | `wt-done` | `main.js:351`, `:352` |
| `onTorrentWarning` | `wt-warning` | `main.js:353` |
| `onTorrentError` | `wt-error` | `main.js:354` |
| `onProgress` | `wt-progress` | `main.js:356` |
| `onFileModtimes` | `wt-file-modtimes` | `main.js:357` |
| `onTorrentFileSaved` | `wt-file-saved` | `main.js:358` |
| `onPosterSaved` | `wt-poster` | `main.js:359` |
| `onAudioMetadata` | `wt-audio-metadata` | `main.js:360` |
| `onServerRunning` | `wt-server-running` | `main.js:361`, `controllers/playback-controller.js:262`, `controllers/media-controller.js:69` |
| `onServerRunningFor(infoHash, ...)` | `wt-server-${infoHash}` | no UI listener today |

`onTorrentReady` and `onServerRunningFor` have no renderer-UI call
site: `webtorrent.js` emits `wt-ready` and `wt-server-${infoHash}`,
but the UI listens on `wt-ready-${infoHash}` and `wt-server-running`
instead. They are declared because they are part of the protocol a
replacement engine has to emit, and US-013's criteria call for both
dynamic channels to be covered.

Two `wt-*` channels are deliberately **not** in the shim, because
their only sender is `webtorrent.js` and their only receiver is
`src/main/`:

- `wt-new-torrent` (`webtorrent.js:134`)
- `wt-uncaught-error` (`webtorrent.js:86`)

## The `wt-*` protocol

**This is the contract any librqbit implementation must satisfy.**
Everything below is what the UI sends and what it expects back. An
engine that implements exactly these channels, with these payloads,
can replace `src/renderer/webtorrent.js` without any other renderer
change. An engine that implements less will break the UI; an engine
that implements more is adding surface nothing consumes.

Recorded in US-033, after US-031 and US-032 moved the last call sites
onto `ipc-engine.js`. The tables in the `ipc-engine.js` section above
map functions onto the call sites they replaced; this section is the
wire contract those functions carry.

### Transport, and what "the engine" is today

There is no direct renderer-to-renderer channel. Every `wt-*` message
goes renderer -> `ipcMain` -> the other renderer, relayed by the
`ipcMain.emit` override in `src/main/ipc.js:220-244`. The main process
inspects nothing but the channel prefix and the sending window's
title: anything starting with `wt-` from the `'WebTorrent Hidden
Window'` is forwarded to the main window, and anything else starting
with `wt-` is forwarded to the hidden window, or queued until it has
finished loading.

Two consequences for a replacement engine. First, the relay is
transport, not protocol: a librqbit host is free to deliver these
messages any way it likes, as long as the channel names and argument
lists match. Second, the pre-ready queue is part of the behaviour the
UI depends on. `main.js` sends `wt-set-global-trackers` and
`wt-start-torrenting` during startup, before the engine can possibly
be listening, and expects them to be delivered rather than dropped.

### Direction and delivery

Two directions only:

- **UI -> engine** (commands). Every one is `ipcRenderer.send` from
  the shim: fire and forget, no return value, no acknowledgement.
  Failures come back as `wt-error` or `wt-warning`, or as nothing at
  all.
- **Engine -> UI** (events). Every one is `ipcRenderer.send` from the
  engine, delivered to a listener the shim registered.

"One-shot" below means the UI registers the listener with
`{ once: true }` for a single expected reply. "Subscription" means a
standing listener registered at startup and never removed. A command
is "one-shot" when it triggers exactly one reply message, and
"fire-and-forget" when it triggers no reply at all.

### Commands: UI -> engine

| Channel | Payload | Kind |
| --- | --- | --- |
| `wt-set-global-trackers` | `(trackers: string[])` | fire-and-forget |
| `wt-start-torrenting` | `(torrentKey: number, torrentID: string, path?: string, fileModtimes?: FileModtimes, selections?: boolean[])` | fire-and-forget; drives the whole event stream for this torrent |
| `wt-stop-torrenting` | `(infoHash: string)` | fire-and-forget |
| `wt-create-torrent` | `(torrentKey: number, options: CreateOptions)` | fire-and-forget; drives the same event stream |
| `wt-save-torrent-file` | `(torrentKey: number)` | one-shot; replies on `wt-file-saved` |
| `wt-generate-torrent-poster` | `(torrentKey: number)` | one-shot; replies on `wt-poster` |
| `wt-get-audio-metadata` | `(infoHash: string, index: number)` | replies 1 to 3 times on `wt-audio-metadata` (see below) |
| `wt-start-server` | `(infoHash: string)` | one-shot; replies on `wt-server-running` and `wt-server-${infoHash}` |
| `wt-stop-server` | `()` | fire-and-forget |
| `wt-select-files` | `(infoHash: string, selections: boolean[])` | fire-and-forget |

`torrentKey` is a **number**, not a string: it is
`state.nextTorrentKey++`, seeded at `1` in `lib/state.js:64`. The
engine treats it as opaque and echoes it back on every event about
that torrent. Do not derive anything from it.

`torrentID` is whatever the user supplied: a magnet URI, a path to a
`.torrent` file, an info hash, or an HTTP URL.

Three of these commands have a reply channel but **no failure reply**.
`wt-save-torrent-file`, `wt-generate-torrent-poster` and
`wt-get-audio-metadata` all log and return on error today rather than
sending anything back, so the UI's `{ once: true }` listener simply
never fires. A librqbit implementation should preserve that (silence
on failure) or the UI will need new error handling; it must not send a
malformed reply on the success channel.

### Events: engine -> UI

| Channel | Payload | Kind |
| --- | --- | --- |
| `wt-parsed` | `(torrentKey: number, infoHash: string, magnetURI: string)` | subscription (`main.js`) |
| `wt-metadata` | `(torrentKey: number, info: TorrentInfo)` | subscription (`main.js`) |
| `wt-ready` | `(torrentKey: number, info: TorrentInfo)` | no UI listener today (see below) |
| `wt-done` | `(torrentKey: number, info: TorrentInfo)` | subscription (`main.js`, two listeners) |
| `wt-warning` | `(torrentKey: number\|null, message: string)` | subscription (`main.js`) |
| `wt-error` | `(torrentKey: number\|null, message: string)` | subscription (`main.js`) |
| `wt-progress` | `(progress: Progress)` | subscription (`main.js`) |
| `wt-file-modtimes` | `(torrentKey: number, fileModtimes: FileModtimes)` | subscription (`main.js`) |
| `wt-file-saved` | `(torrentKey: number, fileName: string)` | subscription (`main.js`) |
| `wt-poster` | `(torrentKey: number, posterFileName: string)` | subscription (`main.js`) |
| `wt-audio-metadata` | `(infoHash: string, index: number, metadata: AudioMetadata)` | subscription (`main.js`) plus a one-shot per request (`playback-controller.js:307`) |
| `wt-server-running` | `(info: ServerInfo)` | subscription (`main.js`) plus one-shots (`playback-controller.js:262`, `media-controller.js:76`) |

`torrentKey` is `null` on `wt-warning` and `wt-error` when the fault
is client-level rather than attached to one torrent
(`webtorrent.js:94-95`).

`wt-progress` is not event-driven in the usual sense: the engine
recomputes the whole aggregate on a 1s timer and on every torrent
state change, and suppresses the send when the object is deeply equal
to the previous one. A replacement engine may send it more or less
often; the UI treats each message as a full replacement, not a delta.

### Dynamic channel families

Two channel *families*, not two channels. Each info hash the engine
knows about gets its own channel name, so the set is open-ended and
grows at runtime:

| Family | Payload | Kind |
| --- | --- | --- |
| `wt-ready-${infoHash}` | `(torrentKey: number, info: TorrentInfo)` | one-shot, per torrent (`playback-controller.js:254`, `:303`) |
| `wt-server-${infoHash}` | `(info: ServerInfo)` | no UI listener today |

Both are emitted alongside their broadcast twin: `wt-ready` and
`wt-ready-${infoHash}` are sent back to back with identical arguments
(`webtorrent.js:157-158`), as are `wt-server-running` and
`wt-server-${infoHash}` (`webtorrent.js:316-317`). The families exist
so a caller waiting on one specific torrent does not have to filter a
broadcast stream.

Callers never build these strings. `onTorrentReadyFor(infoHash, ...)`
and `onServerRunningFor(infoHash, ...)` take the info hash as an
argument and do the concatenation inside the shim, which is what keeps
the family shape private to `ipc-engine.js`.

`wt-ready` and `wt-server-${infoHash}` are each the unused half of
their pair: the UI waits per-torrent for readiness, and broadcast for
the server. Both are still part of the contract. An engine that emits
only the half currently consumed would break the moment a caller
switches, and US-013 requires both families to be covered.

### Payload shapes

`TorrentInfo` (`webtorrent.js:177-186`), the JSON-saveable summary
sent with `wt-metadata`, `wt-ready`, `wt-ready-${infoHash}` and
`wt-done`:

```
{
  infoHash: string,
  magnetURI: string,
  name: string,
  path: string,          // download directory
  files: Array<{ name: string, length: number, path: string }>,
  bytesReceived: number
}
```

`Progress` (`webtorrent.js:253-292`), the whole-client aggregate sent
with `wt-progress`:

```
{
  progress: number,               // 0..1 across all torrents
  hasActiveTorrents: boolean,
  torrents: Array<{
    torrentKey: number,
    ready: boolean,
    progress: number,             // 0..1
    downloaded: number,           // bytes
    downloadSpeed: number,        // bytes/sec
    uploadSpeed: number,          // bytes/sec
    numPeers: number,
    length: number,               // bytes
    bitfield: BitField,
    files: Array<{
      startPiece: number,
      endPiece: number,
      numPieces: number,
      numPiecesPresent: number
    }>
  }>
}
```

`bitfield` is the only payload field anywhere in the protocol that is
not plain JSON. The engine puts a `bitfield` instance on the wire, but
structured clone strips the prototype, so what arrives is a plain
object carrying the backing buffer. The single reader,
`pages/player-page.js:943`, already accounts for this: it calls
`BitField.prototype.get.call(prog.bitfield, i)` rather than
`prog.bitfield.get(i)`. A librqbit implementation therefore only has
to deliver something whose fields that borrowed method can read, not a
`bitfield` instance.

`ServerInfo` (`webtorrent.js:308-313`), sent with `wt-server-running`
and `wt-server-${infoHash}`:

```
{
  torrentKey: number,
  localURL: string,        // http://localhost:PORT
  networkURL: string,      // http://LAN-IP:PORT
  networkAddress: string   // LAN IP
}
```

The port is chosen by the engine (`server.listen(0)`), so the UI never
assumes one.

`FileModtimes`, sent with `wt-file-modtimes` and accepted back on
`wt-start-torrenting`: a map of file path to mtime. The UI stores it
verbatim and hands it back so an already-complete torrent can skip
re-verification. Its contents are opaque to the renderer, so a
librqbit implementation is free to redefine it, as long as it round
trips.

`CreateOptions`, sent with `wt-create-torrent`
(`pages/create-torrent-page.js:193-206`):

```
{
  name: string,
  path: string,                  // base path the files sit under
  files: Array<{ path: string }>,  // full file objects; only .path is read
  announce: string[],
  comment: string,
  private?: true                 // omitted entirely when not private
}
```

`AudioMetadata`, sent with `wt-audio-metadata`. One request produces
up to three messages, each superseding the last
(`webtorrent.js:325-366`):

1. `{ title: string }` immediately, so the UI can show the filename.
2. `{ common, format }` from the parser's progress observer, zero or
   more times.
3. The full `music-metadata` result on success.

Nothing is sent on failure. The UI's one-shot listener therefore
receives message 1 and stops listening; the standing listener in
`main.js` receives all of them.

### Cross-check against what the renderer actually sends

Grepping `src/renderer/**/*.js` for `wt-` string literals yields 24
distinct static channels plus the two dynamic family prefixes. All 24
appear in `webtorrent.js`; 22 of them also appear in `ipc-engine.js`,
along with both families. The two that do not are accounted for:

- `wt-new-torrent` (`webtorrent.js:134`), sent with no arguments after
  `client.seed()`.
- `wt-uncaught-error` (`webtorrent.js:86`), the engine's
  `window.onerror` hook, payload `{ message, stack }`.

Both are engine-outbound only, and **neither has a listener anywhere
in the repo**. The `ipcMain.emit` override sees them, forwards them to
the main window because they carry the `wt-` prefix, and nothing there
subscribes. They are correctly out of the shim -- the shim exists to
serve the UI renderer, and these never reach a consumer in it -- but a
librqbit implementation should treat them as optional rather than as
contract. `wt-uncaught-error` in particular is worth reviving as a
real error path rather than reimplementing as a message into the void.

No other `wt-` literal exists in any `.js` file under `src/renderer/`
outside `webtorrent.js` and `ipc-engine.js`. (There is prose mentioning
`wt-ready-` in `controllers/AGENTS.md`; that is documentation, not a
call site.) Keeping that true is the job of
`test/unit/platform-boundary.js` and, from US-034, the lint rule.

## Files exempt from the shim

Per FR-4 and FR-11, and after US-002 deleted `lib/telemetry.js`,
exactly two renderer files keep direct Electron and Node imports:

- `src/renderer/webtorrent.js`, the engine counterparty, which is
  replaced wholesale by librqbit later.
- `src/renderer/lib/cast.js`, which runs an `http` server in the
  renderer and needs a full reimplementation.

## Enforcing the boundary

US-034 makes the boundary a build failure rather than a convention.

`eslint-boundary.config.js` at the repo root is a standalone ESLint
config -- it does not extend, override, or read `standard`'s settings,
and `standard` does not read it. It sets exactly one rule,
`no-restricted-imports`, over `src/renderer/**/*.js`, banning
`electron`, `@electron/remote`, `fs`, `os`, `crypto` and `http`, plus
the `fs/promises`, `node:` and `original-fs` spellings of the same
modules. `os` and `crypto` are preventive: no renderer file has used
either since the US-002 telemetry deletion and neither has a shim
module, so the ban means the next use has to add one.

Exemptions, in override order:

1. `src/renderer/lib/platform/**/*.js` -- the shim is the boundary,
   and is the one place these imports belong. This is a directory
   glob, so a new shim module is exempt without editing the config.
2. `src/renderer/webtorrent.js` -- deferred casualty (FR-4).
3. `src/renderer/lib/cast.js` -- deferred casualty (US-013).

Those two files are the only per-file overrides, and
`test/unit/lint-boundary.js` asserts that stays true.

Wiring: `npm run lint:boundary` runs the config with `--no-eslintrc`;
`npm run lint` is `standard && npm run lint:boundary`; `npm test` runs
`npm run lint` first, so a direct host import fails the build. Adding
`import os from 'os'` to `lib/dispatcher.js` and running `npm test`
stops the run at `lint:boundary` with `'os' import is restricted from
being used`, before `depcheck` or the unit tests execute.

`no-restricted-imports` sees `import` declarations only. The
`require()` spellings of the same specifiers, and the usage-level
concerns no import rule can express (`ipcRenderer.` member reads,
`wt-` channel strings, `new remote.Menu`, `remote.dialog`), stay in
the source scan in `test/unit/platform-boundary.js`. The two checks
are complementary; neither replaces the other. Add a new banned
specifier to the lint config, a new banned usage to the scan.
