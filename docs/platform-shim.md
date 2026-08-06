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
| `cast.js` | Casting to Chromecast, DLNA and AirPlay | US-075 (call sites US-079) |

Line references below are against the tree at US-018 and will drift
as call sites move. They are a starting point, not a contract.

### One implementation of that layout (US-052, US-072)

US-052 made the table above an *interface* with two implementations,
per ADR-014: `src/renderer/lib/platform/*.js` was the Electron one and
`src/renderer/lib/platform/tauri/*.js` the Tauri one, exactly one of
them in a given bundle. **US-072 cut that down to one.** The Tauri
tree was promoted to `src/renderer/lib/platform/`, the Electron tree
and the `WT_HOST` selection mechanism were deleted, and everything
this document says about a module's arguments, return values and error
behaviour is now the contract of the only implementation there is.

A handful of exports are still stubs, because their stories have not
landed: an unported export is `async`, takes the documented arguments,
and throws a `NotImplementedError` carrying
`code: 'WT_TAURI_NOT_IMPLEMENTED'` naming the module and the export.
`test/unit/platform-stubs.js` holds the register of which those are
(`UNIMPLEMENTED`) and fails in both directions -- a story that
implements one and does not remove it from the register, and a
regression that stubs one that is not in it. That file was
`platform-tauri.js` until US-072, where the parity half of its job
(same export names, same arities across the two trees) went away with
the second tree.

Ported so far:

| Export | Story | Backed by |
| --- | --- | --- |
| `ipcOs.onWindowBoundsChanged` | US-056 | a Tauri event, emitted by `src-tauri/src/window.rs` |
| `ipcOs.onFullscreenChanged` | US-057 | a Tauri event, emitted on the resize edge |
| `ipcOs.setTitle`, `setProgress`, `setBounds`, `setAspectRatio`, `toggleFullScreen`, `show` | US-057 | one host command each, in `src-tauri/src/main.rs` |
| `window.isVisible`, `window.isMaximized` | US-057 | host commands, for the same reason |
| `dialog.showOpenDialog`, `showSaveDialog` | US-058 | one host command each, over the dialog plugin's **Rust** API; the options translation is `src-tauri/src/dialog.rs` |
| `shell.openExternal`, `openPath`, `showItemInFolder` | US-059 | one host command each, over the opener plugin's **Rust** API |
| `shell.moveItemToTrash` | US-059 | a host command over the `trash` crate; the already-gone decision is `src-tauri/src/shell.rs` |
| `clipboard.readText`, `writeText` | US-059 | one host command each, over the clipboard-manager plugin's **Rust** API; the empty-clipboard decision is `src-tauri/src/clipboard.rs` |
| all nine `fs.js` exports | US-060 | one host command each, over `std::fs`; the directory allowlist is `src-tauri/src/fs.rs` |
| `menu.showContextMenu` | US-061 | descriptors to a host command, the choice back on an event; built in `src-tauri/src/menu.rs` |
| `ipcOs.setAllowNav`, `notifyPlayerOpen`, `notifyPlayerUpdate`, `notifyPlayerClose` | US-061 | one host command each; they enable and disable items of the host's own application menu |
| `ipcOs.onDispatch` | US-061 | a Tauri event, emitted by every application-menu item that is not a role |
| all fourteen `cast.js` exports | US-075 | eleven host commands and three events, in `src-tauri/src/cast.rs`; the protocols behind them are US-076 to US-078 |
| `ipcOs.checkForExternalPlayer`, `openExternalPlayer`, `quitExternalPlayer` | US-080 | one host command each; the VLC lookup, the spawn and the kill are `src-tauri/src/external_player.rs` |

The window operations are **commands rather than core window calls
from the webview**, although `@tauri-apps/api/window` could do several
of them directly. Two reasons. The behaviour is the Electron *main*
process's -- the fullscreen guard in `setBounds`, the centring, the
maximize bookkeeping are all in `src/main/windows/main.js`, not in its
renderer -- so it belongs in the host either way. And an app-defined
command needs no capability, so `src-tauri/capabilities/default.json`
stays at `core:default` (the event API) rather than growing a window
permission per operation.

Two host differences the shim absorbs, both documented at their call
site:

- **`setAspectRatio` does nothing under Tauri.** Tauri 2 has no
  aspect-ratio API. On macOS this means dragging the player window's
  edge no longer snaps to the video's shape and the video letterboxes
  inside whatever rectangle the drag makes. The window still *opens*
  at the video's shape, because every caller follows the call with a
  `setBounds`. The command stays so there is one place to fill in.
- **`fullscreenChanged` is edge-detected on resize.** Tauri has no
  enter/leave-fullscreen event, so the host reads the state whenever
  the window resizes and emits only the transitions. A fullscreen
  entered from the OS window chrome is still reported, as it is under
  Electron.

The dialogs are commands for the same two reasons, and the second one
is worth spelling out: `@tauri-apps/plugin-dialog` would have to be
granted `dialog:allow-open` and `dialog:allow-save` in
`capabilities/default.json`, which is a capability the *whole* webview
carries. Reaching the plugin's Rust API from a command instead leaves
the renderer with `core:default`, and the picker, the parent window and
the option translation all stay in the host -- which is where the
Electron version of them lives too.

Two dialog options have no equivalent under Tauri, both recorded at the
top of `src-tauri/src/dialog.rs`:

- **`buttonLabel` is dropped.** `FileDialogBuilder` cannot relabel the
  accept button, so the save dialog reads "Save" (the platform
  default). The one caller passes exactly that, so there is nothing
  visible to lose today.
- **`['openFile', 'openDirectory']` opens a directory picker.** rfd
  picks files or directories, never both. This is what Electron itself
  does on Windows and Linux -- `src/main/dialog.js` writes the same
  fallback out by hand -- so the change is macOS-only, and no renderer
  call site asks for both: all three pass one property.

`shell.js` and `clipboard.js` are commands for the third time and the
same two reasons: three of the four shell operations are the Electron
main process's already (`src/main/shell.js`, reached over IPC), and the
JS plugins would need `opener:allow-open-url`, `opener:allow-open-path`,
`opener:allow-reveal-item-in-dir`, `clipboard-manager:allow-read-text`
and `allow-write-text` granted to the whole webview.

Three host differences the Tauri tree absorbs:

- **A shell failure rejects.** In the Electron tree
  `showItemInFolder`, `openPath` and `moveItemToTrash` are
  `ipcRenderer.send`, so they resolve whatever the OS made of them.
  Under Tauri the host answers, so a real failure reaches the caller.
  No call site needed changing: FR-10 already terminated every one of
  these rejections, `playback-controller.js` wrapping `openPath` in
  `reportErrors` and `torrent-list-controller.js` `.catch`ing both
  `showItemInFolder` and `moveItemToTrash` into `dispatch('error')`. So
  the difference is that a failure the Electron tree swallows now shows
  the user an error, not that anything goes unhandled.
- **`moveItemToTrash` still resolves for a path that is already gone**,
  which is what `../shell.js` documents. The `trash` crate reports that
  as an error, so `shell::plan_trash` checks for the entry first. It
  uses `symlink_metadata`, so a dangling symlink is still trashed.
- **`clipboard.readText()` answers `''` for an empty clipboard**, as
  Electron's synchronous version does. `arboard` reports empty -- and a
  clipboard holding an image or a file reference -- as
  `ContentNotAvailable`, so `clipboard::read_outcome` turns that one
  error into `''` and leaves every other clipboard failure a failure.

The trash is the `trash` crate rather than anything in Tauri, which has
no equivalent of Electron's `shell.trashItem`. It is pinned to 5.2.3 in
`src-tauri/Cargo.toml`: later patches need rustc 1.85, above the
`rust-version` ADR-014 fixed.

`fs.js` is nine commands over `std::fs`, and the fourth module to skip
the plugin -- but for a reason the other three did not have. The `fs`
plugin's JS API is scoped by a glob list written into
`capabilities/default.json`, and that list cannot name the config
directory (which is different on each platform, and different again for
a portable install) or the download folder the user picked in the
preferences pane a moment ago. The host knows both. So the allowlist is
`src-tauri/src/fs.rs`, and the renderer still holds no `fs:` permission
of its own.

What it grants at startup, and why each root is needed:

| Root | Access | Needed by |
| --- | --- | --- |
| `configPath` | write | `lib/state.js`'s `config.json`, and `Torrents/` and `Posters/` |
| `tempPath` | write | a streamed torrent's data, which `torrent-list-controller.js` stats and deletes |
| `defaultDownloadPath` | write | where torrents land before the user changes it |
| `prefs.downloadPath` | write | where they land after; read out of the saved state, because a restart does not re-pick it |
| `torrents[].path` | write | a torrent saved under a download folder the user has since changed |
| the resource directory | read | the five default torrents and posters `lib/state.js` copies into a fresh profile |

Plus, at runtime, whatever the user picks in a host dialog -- a folder
for writing, a file for reading, which is exactly what this app asks
each picker for. That pairing is what the `fs` plugin gets from the
dialog plugin automatically; here `show_open_dialog` and
`show_save_dialog` do it explicitly, and more narrowly.

Four things follow that the Electron tree has no equivalent of:

- **A path outside the allowlist rejects**, with a message naming the
  path and saying whether it was a read or a write. `exists` is the one
  export that does not surface it: its contract is the
  `try { statSync() } catch {}` probes in `lib/migrations.js`, so every
  failure, refusals included, is `false`.
- **`..` and symlinks cannot climb out of a root.** The path is
  normalized textually first (so a `..` in a not-yet-existing tail
  cannot survive), then its deepest existing ancestor is canonicalized,
  and the command operates on that resolved path rather than on the
  string it was handed.
- **The app's own resource directory is read-only**, which is the whole
  reason a root carries an access level at all.
- **A file dropped onto the window is not covered.** Under Electron the
  renderer reads `file.path` off the drop event; a Tauri webview has no
  such property, so dropped paths have to arrive from the host -- and
  US-065, which delivers them, is the story that should grant them.

A listener export is a `listen()` (or `once()`) from
`@tauri-apps/api/event`, wrapped so the caller sees the payload alone
and gets the unsubscribe function back -- the same contract the
Electron tree's private `listen()` provided over `ipcRenderer`. The
host emits on the **Electron channel name unchanged**
(`windowBoundsChanged`), because the renderer above the shim is the
same renderer.

`ipc-engine.js` is the one module the cutover carried across
untouched. It has been host-free since US-044 -- a WebSocket client of
the sidecar, and banned from importing a host module by a per-file
override in the boundary config that survives the blanket shim
exemption. The host knowledge it depends on is
`ipc-os.getEngineEndpoint()`, and US-070 gave that a host:
`src-tauri/src/engine.rs` supervises the sidecar and answers the same
`{ url, token }` the Electron main process did.

There is nothing left to select. `npm run build:renderer` is the one
renderer build; `bin/shim-resolver.js`, `bin/build-renderer.js`, the
`resolveId` plugin they fed and the `WT_HOST` variable were all
deleted by US-072, along with `npm run build:renderer:tauri`.
`test/unit/electron-removed.js` is what keeps them gone.

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
| `getBounds()` | `main.js:453-458`, the DOM reads (see below) |

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

#### The geometry reads were the wrong reads

Keeping the four DOM reads was right for the risk US-027 was managing
and wrong about what they measure. They are only the OS window's
rectangle when the page *is* the OS window, which it was under
Chromium and is not under a webview. Measured in the Tauri host, on a
2560x1440 display, with the window at `(0, 1408)` sized `425x238`:

| | `screenX` | `screenY` | `outerWidth` | `outerHeight` |
| --- | --- | --- | --- | --- |
| DOM | 0 | 1440 | 0 | 0 |
| window | 0 | 1408 | 425 | 238 |

`outerWidth`/`outerHeight` are 0 -- WebKit fills them in for browser
windows and a webview is not one -- and `screenY` is the *content
area's* origin, one 32px title bar below the window's. So
`restoreBounds()` in `controllers/playback-controller.js`, which sends
the saved rectangle back through `ipcOs.setBounds` when the player
closes, asked for `{x: 0, y: 1440, width: 0, height: 0}`: the host
clamped the size up to the `MIN_WIDTH`/`MIN_HEIGHT` floor and moved the
window past the bottom edge of the screen, where AppKit pinned it with
a sliver showing. The rectangle was then saved to `config.json`, so
every later launch restored the window off-screen too.

The fix is `getBounds()`, one host command (`window_bounds`) returning
the window's outer rectangle in logical pixels *and* its maximize
state. That also retires the risk this section is about: the two
values now come from one read on the side of the boundary that owns
the window handle, so there is no interval for the window to move in
and nothing to order carefully. `setDimensions()` keeps its shape --
one shim call, spread into `applyDimensions(dimensions, bounds,
maximized)`, terminated with `.catch(err => dispatch('error', err))`.

`test/unit/platform-boundary.js` bans the four DOM properties across
`src/renderer/` so the reads cannot come back. `window.screen.width`
and `window.screen.height` are deliberately *not* banned:
`applyDimensions()` uses them to keep the player inside the display,
they describe the screen rather than this window, and they measure
correctly in the webview.

## `menu.js`

| Function | Replaces |
| --- | --- |
| `showContextMenu(items)` | `controllers/torrent-list-controller.js:257-304`, the seven-item torrent context menu |

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
Verified at US-025: `controllers/torrent-list-controller.js:257-304`
is the only `remote.Menu` in `src/renderer/`, and it uses labels,
`click` handlers, one `enabled` flag on "Save Torrent File As...",
three separators, and a manual `'checkmark '` label prefix for "Sort
by Name" (which stays a label, not a checkbox type). Add a submenu
type when a menu needs one, on the same "no more than today" rule the
rest of the shim follows.

The existing menu is therefore expressible as-is. US-029 does the
rewrite; it builds ten descriptors when `torrentSummary.files` is set
(seven items and three separators) and eight when it is not.

### Under Tauri the descriptors genuinely cross a boundary (US-061)

The Electron shim hands the descriptors to `@electron/remote` in the
same process; the Tauri one sends them to the host as JSON. The
contract above does not change, but two things about it start being
load-bearing rather than merely tidy.

A `click` cannot be sent, so it stays in the renderer. The shim gives
each menu a serial number, sends `{ menu, items }`, and the host
answers on a `contextMenuClick` event with `{ menu, item }` -- which
menu, and the index of the item chosen. The serial number is what
makes a late click safe: a menu dismissed without a choice reports
nothing, so there is no event that says "forget these", and a click
naming a menu that is no longer open is ignored rather than run
against whatever is open now.

Descriptors are validated on **both** sides. The shim rejects a
missing label and an unknown type before anything is sent, and
`menu::context_template` rejects them again on arrival. The second
check is the boundary refusing to trust its input, not a duplicate
anyone relies on.

The **application** menu is not in this module under either host. It
is the Electron main process's (`src/main/menu.js`) and the Rust
host's (`src-tauri/src/menu.rs`), built from descriptors of the same
shape that never cross. What the renderer keeps of it is
`ipcOs.setAllowNav`, the three player notifications, and
`ipcOs.onDispatch` -- the event every non-role item fires.

## `fs.js`

Exactly the operations the renderer performs today, no more. The list
was re-enumerated at US-023 by grepping `src/renderer/` for `fs` usage
excluding `webtorrent.js` (then exempt from the shim under FR-4; the
file is gone since US-045) and excluding `lib/platform/` itself. That
grep finds five files --
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

US-055 added one caller the US-023 grep could not see, because it went
through a dependency rather than through `fs`: the saved-state file
itself. `lib/state.js` now does `readFile` / `mkdir` / `writeFile` on
`<CONFIG_PATH>/config.json` where it used to call
`application-config`'s `read()` and `write()`. No new export was
needed. The Tauri `fs.js` (US-060) therefore has to be good enough to
carry config persistence, not just torrent bookkeeping.

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
| `getEngineEndpoint()` | `getEngineEndpoint` | new in US-042; caller is `ipc-engine.js` from US-044 |

`checkForExternalPlayer` and `getEngineEndpoint` each collapse a `send`
plus an `ipcRenderer.once` reply into a single promise. They are the
only request/response pairs on the OS side.

`getEngineEndpoint()` resolves with `{ url, token }` -- the sidecar's
loopback WebSocket URL and the per-launch credential it expects -- or
`null` when the host has no engine. Both values are plain data held in
the host (`src/main/engine-process.js`); no Electron object crosses the
boundary, and nothing about the sidecar is discoverable from the
renderer's own environment (no `process.env`, no global). The port
changes when the sidecar restarts, so this is a question to ask on
every connect rather than a value to cache; the host makes the reply
wait while a restart is in flight instead of answering `null` for an
engine that is about to come back.

The `notify*` prefix avoids confusion: the main process named these
channels `onPlayerPlay` and so on, but they are outbound commands,
not listeners.

The three external-player exports carry the arguments
`src/main/external-player.js` took and nothing else. What the host does
with them is `src-tauri/src/external_player.rs` (US-080), and three
parts of it are visible from up here:

- **A player the user configured is taken on trust.** With
  `externalPlayerPath` set, `checkForExternalPlayer` answers `true`
  without looking; with it empty -- which is its default -- the host
  goes looking for VLC, a `--version` probe per candidate. The shim
  passes the empty string through rather than normalising it, so
  `if (!playerPath)` is decided in one place.
- **`openExternalPlayer` resolves nothing.** Everything the renderer
  learns about the player afterwards arrives as an ordinary dispatch:
  `exitModal` once it has stayed up a second, `backToList` on a clean
  exit, `externalPlayerNotFound` on any other exit or when there was
  nothing to run. A player the renderer killed dispatches nothing.
- **The Playback menu and the media keys go quiet for the duration**,
  because this application is no longer the one playing anything. The
  next `notifyPlayerOpen` brings them back; nothing else does.

### Events

| Function | Channel | Replaces |
| --- | --- | --- |
| `onLog(listener, opts)` | `log` | `main.js:340` |
| `onError(listener, opts)` | `error` | `main.js:341` |
| `onDispatch(listener, opts)` | `dispatch` | `main.js:343` |
| `onFullscreenChanged(listener, opts)` | `fullscreenChanged` | `main.js:345` |
| `onWindowBoundsChanged(listener, opts)` | `windowBoundsChanged` | `main.js:346` |

## `cast.js`

New in US-075, and unlike every other module here it replaces nothing
in `src/main/`: casting ran in the *renderer*
(`src/renderer/lib/cast.js`, three npm packages and an `http` server)
until ADR-015 moved all of it into the host. The module is the
interface that work lands behind, so US-076 (Chromecast), US-077
(DLNA) and US-078 (AirPlay) each fill in a protocol without the
renderer changing again.

The host holds a **single session**, because the UI already forbids
two ("Never cast to two devices at the same time", now
`cast-controller.js:toggleMenu`). That is why nothing but `connect`
names a device.

### Commands

| Function | Command | Resolves to |
| --- | --- | --- |
| `startDiscovery()` | `cast_start_discovery` | -- |
| `stopDiscovery()` | `cast_stop_discovery` | -- |
| `getDevices()` | `cast_get_devices` | `[{ id, protocol, name, capabilities }]` |
| `connect(deviceId, media)` | `cast_connect` | -- |
| `play()` | `cast_play` | -- |
| `pause()` | `cast_pause` | -- |
| `stop()` | `cast_stop` | -- |
| `seek(seconds)` | `cast_seek` | -- |
| `setVolume(volume)` | `cast_set_volume` | -- |
| `setRate(rate)` | `cast_set_rate` | -- |
| `getStatus()` | `cast_get_status` | `{ deviceId, isPaused, currentTime, volume, ended }` |

### Events

| Function | Event | Payload |
| --- | --- | --- |
| `onDevices(listener, opts)` | `castDevices` | the whole device list, on every change |
| `onStatus(listener, opts)` | `castStatus` | the same shape `getStatus()` resolves to |
| `onError(listener, opts)` | `castError` | a message for `state.errors` |

`protocol` is `chromecast`, `dlna` or `airplay` -- the strings
`player-page.js` already keys `state.devices` by and compares
`state.playing.location` against. `capabilities` is the subset of
`play`, `pause`, `seek`, `volume` and `rate` a device answers, and it
is what keeps `playback-controller.js`'s synchronous
`if (!Cast.setRate(rate))` working across an all-async shim: the
answer comes from the mirrored device rather than from the promise.

`onDevices` carries the **whole list** rather than a delta, so a
receiver that goes away can finally disappear -- the bug `lib/cast.js`
documented and did not fix. `onStatus` replaces that module's
one-second `setInterval`: the host polls and pushes, so a
poll that hangs cannot stall the UI thread. `onError` exists because
discovery finding nothing and discovery *failing* are the same empty
list, and only the second should raise anything.

`connect`'s media description is `{ url, title, contentType,
subtitlesVtt, startTime }`. The URL is the engine's own `networkURL`,
untouched by any of this. Subtitles cross as **cue text**, not as a
URL, because the host publishes them itself -- which is what lets the
renderer stop running an HTTP server. The two optional halves cross as
`null` rather than being omitted, for the reason `ipc-os.js`'s
`optional()` gives: a dropped key and a track the user did not select
are not the same thing.

### What answers today

A stub (`src-tauri/src/cast.rs`). Discovery reports an **empty device
list** and raises nothing; every session command rejects with a
message naming the operation, ADR-015 and the story that owes the
protocol. Both halves are deliberate. ADR-015 has an unimplemented
protocol report no devices and no error, and `player-page.js`'s
existing rule -- no devices and not casting means no button -- then
hides it with no UI change and no dead control. A command reached
anyway means the UI got somewhere it should not have, so it says so.

### Who calls it (US-079)

`src/renderer/lib/cast.js` is gone, and with it the three npm
packages, the last renderer `require()` and the last renderer `http`
import. Two callers replace it, and no third one is intended:

- **`controllers/cast-controller.js`** owns the session. It is a
  controller like any other -- `toggleCastMenu`, `selectCastDevice`
  and `stopCasting` are its dispatcher actions -- and it holds the
  three subscriptions, `startDiscovery`, `connect` and the writes to
  `state.devices`, `state.playing.location` and `state.errors`.
- **`controllers/playback-controller.js`** calls the five commands
  that only forward a value: `play`, `pause`, `seek`, `setVolume`,
  `setRate`. Ending a session goes through the cast controller
  (`dispatch('stopCasting')`) instead, because dropping the mirrored
  device is state playback does not own.

Between them sits `lib/cast-mirror.js`, which is plain functions and
talks to nothing: it folds the host's flat device list back into the
`state.devices[protocol]` shape `player-page.js` reads, folds a status
into `state.playing`, and builds the media description `connect()`
takes. That is where `capabilities` becomes `setRate`'s synchronous
answer.

Discovery itself is still deferred to `delayedInit()`, as
`lazyLoadCast()` was -- not for load time any more, which is now the
host's, but because it is network traffic nobody has asked for during
startup.

## `ipc-engine.js`

This is the seam the torrent engine is swapped at. A librqbit
implementation has to satisfy exactly this surface and nothing more.
The full protocol, including payload shapes and delivery semantics, is
in **The `wt-*` protocol** below (US-033); the tables here map the
functions onto the call sites they replaced.

The counterparty is the engine sidecar, `src/engine/index.js`, reached
over a localhost WebSocket since US-044. It is the only engine in the
tree: US-045 deleted the hidden window and the copy that ran in it.

### Commands

| Function | Channel | Replaces |
| --- | --- | --- |
| `setGlobalTrackers(trackers)` | `wt-set-global-trackers` | `controllers/torrent-list-controller.js:117` |
| `startTorrenting(key, id, path, modtimes, selections)` | `wt-start-torrenting` | `controllers/torrent-list-controller.js:40`, `:107` |
| `stopTorrenting(infoHash)` | `wt-stop-torrenting` | `controllers/torrent-list-controller.js:138`, `:156`, `:405`, `controllers/torrent-controller.js:23` |
| `createTorrent(key, options)` | `wt-create-torrent` | `controllers/torrent-list-controller.js:75` |
| `saveTorrentFile(key)` | `wt-save-torrent-file` | `controllers/torrent-controller.js:78` |
| `getAudioMetadata(infoHash, index)` | `wt-get-audio-metadata` | `controllers/playback-controller.js:310` |
| `startServer(infoHash)` | `wt-start-server` | `controllers/playback-controller.js:261` |
| `stopServer(infoHash)` | `wt-stop-server` | `controllers/playback-controller.js:365` |
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
| `onAudioMetadata` | `wt-audio-metadata` | `main.js:360` |
| `onServerRunning` | `wt-server-running` | `main.js:361` |
| `onServerRunningFor(infoHash, ...)` | `wt-server-${infoHash}` | `controllers/playback-controller.js:262`, `controllers/media-controller.js:76`, `lib/torrent-poster.js` |

`onTorrentReady` has no renderer-UI call site: the engine emits
`wt-ready` but the UI listens on `wt-ready-${infoHash}` instead. It is
declared because it is part of the protocol a replacement engine has to
emit, and US-013's criteria call for both dynamic channels to be
covered.

`onServerRunningFor` gained its callers in US-043 (ADR-013). Poster
generation now starts servers too, so the broadcast channel can carry a
server for a torrent the user is not watching; anything that wants *its*
server waits on the per-torrent channel. `main.js` still subscribes to
the broadcast, and `torrent-controller.js` ignores an info that is not
the playing torrent's.

Two `wt-*` channels are deliberately **not** in the shim, because the
sidecar is their only sender and nothing subscribes to either:

- `wt-new-torrent`, sent by `createTorrent()` in `src/engine/index.js`
- `wt-uncaught-error`, sent by `onUncaughtError()` there

## The `wt-*` protocol

**This is the contract any librqbit implementation must satisfy.**
Everything below is what the UI sends and what it expects back. An
engine that implements exactly these channels, with these payloads,
can replace `src/engine/index.js` without any other renderer change.
An engine that implements less will break the UI; an engine that
implements more is adding surface nothing consumes.

Recorded in US-033, after US-031 and US-032 moved the last call sites
onto `ipc-engine.js`. The tables in the `ipc-engine.js` section above
map functions onto the call sites they replaced; this section is the
wire contract those functions carry.

### Transport, and what "the engine" is today

There is exactly one engine and it is a separate process: the sidecar
at `src/engine/index.js` (ADR-012). US-044 pointed the UI at it and
US-045 deleted the hidden window, the second engine that ran in it, and
the `ipcMain.emit` relay that used to carry `wt-*` between the two. No
`wt-*` message goes through the Electron main process any more; nothing
in the tree relays one.

The topology, end to end:

```
UI renderer                     host                    sidecar
-----------                     ----                    -------
ipc-engine.js  --getEngineEndpoint()->  engine-process.js
               <--{ url, token }------  (holds port + token)

ipc-engine.js  ==== ws://127.0.0.1:PORT?token=... ====>  bus-websocket.js
               <=== { channel, args } frames, wire.js ==>  index.js
```

- `src/main/engine-process.js` spawns the sidecar (Electron in Node
  mode, `ELECTRON_RUN_AS_NODE=1`), reads the port off its one
  `WEBTORRENT_ENGINE_PORT=<port>` stdout line, and holds the port and
  the per-launch token. Neither is discoverable from the renderer's own
  environment. `src-tauri/src/engine.rs` is the same supervisor for the
  Tauri host (US-070): same stdout line, same restart policy, same
  `{ url, token }`, and `node` off the `PATH` in place of Electron in
  Node mode.
- `ipc-engine.js` asks `ipc-os.getEngineEndpoint()` for
  `{ url, token }` on **every** connect rather than caching it, because
  the port changes when the sidecar restarts. A `null` reply means wait,
  not fail: the host makes the reply wait out a restart in flight rather
  than answering `null` for an engine that is about to come back.
- The token rides on the query string and
  `src/engine/bus-websocket.js` checks it in `verifyClient`, answering a
  bad upgrade with HTTP 401 before any frame is read.
- Every message either way is one `{ channel, args }` frame encoded by
  `src/shared/wire.js`. The engine never names a transport API itself:
  it is handed a bus of `send(channel, ...args)` and
  `on(channel, handler)`, and `bus-websocket.js` is the only
  implementation left.

Three consequences for a replacement engine. First, the socket is
transport, not protocol: a librqbit host is free to deliver these
messages any way it likes, as long as the channel names and argument
lists match. Second, the queues are asymmetric, and that is deliberate
(see below). Third, the connection can drop, which `ipcMain` could not.
`ipc-engine.js` reconnects with capped backoff and keeps every
subscription in its own map, so a reconnect is invisible to callers and
the unsubscribe functions handed out before a drop still work after it.

### The pre-connect queue is protocol

**A replacement engine's transport has to queue UI -> engine commands
until the engine is reachable, and deliver them in order.** This is not
a detail of the WebSocket implementation; it is behaviour the UI
depends on.

`main.js` sends `wt-set-global-trackers` and `wt-start-torrenting`
during startup, before any socket to the engine can exist, and expects
them to be delivered rather than dropped. Drop them and the app comes
up with no trackers and none of the user's saved torrents resumed --
silently, because commands are fire-and-forget and there is nothing to
reject.

Today that queue is the `outbox` in `ipc-engine.js`: `send()` pushes an
encoded frame, asks for a connection, and flushes in order once the
socket is open; a frame that fails to send stays at the head of the
queue for the next open socket. A reconnect flushes the same way, so a
command issued while the sidecar is restarting is delivered after it
comes back.

The queue lives on the **UI** side, and the mirror behaviour in
`bus-websocket.js` is the opposite: an engine -> UI send with nobody
connected is dropped, not queued. Commands always originate from the
UI, so a connected client is the normal case for anything the engine
has to say, and an event queued for a UI that never returns is a leak.
A replacement engine should keep that split rather than queueing in
both directions.

### Direction and delivery

Two directions only:

- **UI -> engine** (commands). Every one is one frame out of the
  shim's socket: fire and forget, no return value, no acknowledgement.
  Failures come back as `wt-error` or `wt-warning`, or as nothing at
  all.
- **Engine -> UI** (events). Every one is one frame out of the engine's
  bus, delivered to a listener the shim registered.

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
| `wt-get-audio-metadata` | `(infoHash: string, index: number)` | replies 1 to 3 times on `wt-audio-metadata` (see below) |
| `wt-start-server` | `(infoHash: string)` | one-shot; replies on `wt-server-running` and `wt-server-${infoHash}` |
| `wt-stop-server` | `(infoHash: string)` | fire-and-forget |
| `wt-select-files` | `(infoHash: string, selections: boolean[])` | fire-and-forget |

`torrentKey` is a **number**, not a string: it is
`state.nextTorrentKey++`, seeded at `1` in `lib/state.js:64`. The
engine treats it as opaque and echoes it back on every event about
that torrent. Do not derive anything from it.

`torrentID` is whatever the user supplied: a magnet URI, a path to a
`.torrent` file, an info hash, or an HTTP URL.

`wt-start-server` and `wt-stop-server` are **per torrent**, and the
engine counts holders (US-043, ADR-013). Poster generation and playback
can each want a server, for different torrents, at the same time, so the
engine keeps one server per info hash: `wt-start-server` is idempotent
and always replies, even when the server is already listening, and
`wt-stop-server` releases the caller's hold. The server is destroyed
when its last holder releases it, so a caller that starts one must
always stop it.

Two of these commands have a reply channel but **no failure reply**.
`wt-save-torrent-file` and `wt-get-audio-metadata` both log and return
on error today rather than sending anything back, so the UI's
`{ once: true }` listener simply never fires. A librqbit implementation
should preserve that (silence on failure) or the UI will need new error
handling; it must not send a malformed reply on the success channel.

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
| `wt-audio-metadata` | `(infoHash: string, index: number, metadata: AudioMetadata)` | subscription (`main.js`) plus a one-shot per request (`playback-controller.js:307`) |
| `wt-server-running` | `(info: ServerInfo)` | subscription (`main.js`) |

`torrentKey` is `null` on `wt-warning` and `wt-error` when the fault
is client-level rather than attached to one torrent
(`listenToClientEvents()` in `src/engine/index.js`; the per-torrent
spellings are in `addTorrentEvents()`).

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
| `wt-server-${infoHash}` | `(info: ServerInfo)` | one-shots (`playback-controller.js:262`, `media-controller.js:76`, `lib/torrent-poster.js`) |

Both are emitted alongside their broadcast twin: `wt-ready` and
`wt-ready-${infoHash}` are sent back to back with identical arguments
(`addTorrentEvents()` in `src/engine/index.js`), as are
`wt-server-running` and `wt-server-${infoHash}`
(`sendServerRunning()` there). The families exist so a caller waiting
on one specific torrent does not have to filter a broadcast stream.

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

`TorrentInfo` (`getTorrentInfo()` in `src/engine/index.js`), the
JSON-saveable summary
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

`Progress` (`getTorrentProgress()` in `src/engine/index.js`), the
whole-client aggregate sent
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

`ServerInfo` (`startServerFromReadyTorrent()` in
`src/engine/index.js`), sent with `wt-server-running` and
`wt-server-${infoHash}`:

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
(`getAudioMetadata()` in `src/engine/index.js`):

1. `{ title: string }` immediately, so the UI can show the filename.
2. `{ common, format }` from the parser's progress observer, zero or
   more times.
3. The full `music-metadata` result on success.

Nothing is sent on failure. The UI's one-shot listener therefore
receives message 1 and stops listening; the standing listener in
`main.js` receives all of them.

### Cross-check against the two ends

The channel names now live in exactly two files, one per process, which
makes the contract greppable in both directions.

Grepping `src/engine/index.js` for `wt-` string literals yields 22
distinct static channels plus the two dynamic family prefixes.
`ipc-engine.js` carries 20 of the 22, plus both families. The two it
does not are accounted for:

- `wt-new-torrent`, sent with no arguments after `client.seed()`.
- `wt-uncaught-error`, the sidecar's `uncaughtException` /
  `unhandledRejection` hook, payload `{ message, stack }`.

Both are engine-outbound only, and **neither has a listener anywhere in
the repo**: they are encoded, put on the socket, and dropped by
`dispatch()` in `ipc-engine.js`, which finds no handler for the channel.
They are correctly out of the shim -- the shim exists to serve the UI
renderer, and these never reach a consumer in it -- but a librqbit
implementation should treat them as optional rather than as contract.
`wt-uncaught-error` in particular is worth reviving as a real error path
rather than reimplementing as a message into the void.

On the UI side, no `wt-` literal exists in any `.js` file under
`src/renderer/` outside `ipc-engine.js`. (There is prose mentioning
`wt-ready-` in `controllers/AGENTS.md` and a bare `wt-` in a comment in
`ipc-os.js`; those are documentation, not call sites.) Keeping that true
is the job of `test/unit/platform-boundary.js` and, from US-034, the
lint rule.

## Files exempt from the shim

**None, since US-079.** Every renderer file is behind the shim, which
is what ADR-008 set out to reach.

All three exemptions are spent. US-002 deleted `lib/telemetry.js`.
US-045 deleted `src/renderer/webtorrent.js` -- the engine counterparty
is a separate process now, so it is not a renderer file to exempt.
US-079 deleted `src/renderer/lib/cast.js`, whose in-renderer `http`
server was the reason the list existed at all; casting is
`platform/cast.js` and a host implementation now (ADR-015).

## Enforcing the boundary

US-034 makes the boundary a build failure rather than a convention, and
US-046 extended it to the sidecar.

`eslint-boundary.config.js` at the repo root is a standalone ESLint
config -- it does not extend, override, or read `standard`'s settings,
and `standard` does not read it. It sets exactly one rule,
`no-restricted-imports`, over `src/renderer/**/*.js`, banning
`electron`, `@electron/remote`, `fs`, `os`, `crypto` and `http`, plus
the `fs/promises`, `node:` and `original-fs` spellings of the same
modules. `os` and `crypto` are preventive: no renderer file has used
either since the US-002 telemetry deletion and neither has a shim
module, so the ban means the next use has to add one.

Overrides, in order:

1. `src/renderer/lib/platform/**/*.js` -- the rule is **off**. The shim
   is the boundary, and is the one place these imports belong. This is a
   directory glob, so a new shim module is exempt without editing the
   config -- and it covers `platform/tauri/` too, which is why the
   Tauri tree's own relative imports are not caught by the ban below.
2. `src/renderer/lib/platform/ipc-engine.js` -- the Electron half goes
   back **on** (US-046). It needed `ipcRenderer` while the `wt-*`
   protocol rode Electron IPC; since US-044 it is a WebSocket client of
   the sidecar and needs no host module at all, so the blanket shim
   exemption would let that quietly regress. The Node half stays off: it
   is still a shim module and the next thing it needs may legitimately
   be a builtin.
3. `src/engine/**/*.js` -- the other side of the same seam (US-046). The
   sidecar is a plain Node process, so it does not match the renderer
   rules and its Node builtins are unrestricted. It is policed for the
   mirror-image mistake instead: `electron`, `@electron/remote` and
   `original-fs` are banned there too, and `no-restricted-globals` bans
   `window`, `document`, `navigator`, `localStorage`, `sessionStorage`
   and `XMLHttpRequest`. An Electron import in the sidecar fails at load
   rather than degrading -- it runs under `ELECTRON_RUN_AS_NODE`, where
   `require('electron')` has no `app`, and a packaged sidecar has no
   `node_modules/electron` at all.

No override switches the rule off for a single file any more -- the
last one went with `lib/cast.js` at US-079 -- and
`test/unit/lint-boundary.js` asserts that stays true.

US-056 adds `@tauri-apps/api` and its subpaths to the same `patterns`
list: it is the second host's `electron`, so only the shim may name it,
and the `ipc-engine.js` override bans it there too -- that module is
meant to need no host at all under either host.

On top of the specifier list, US-052 adds one `patterns` entry:
`**/platform/tauri` and `**/platform/tauri/**` are banned under
`src/renderer/` and pointed at `WT_HOST`. Which shim tree a build talks
to is a fact about the build, not about a caller. The `require()`
spelling and the Windows slash are covered by the source scan in
`test/unit/platform-boundary.js`, as usual.

`src/shared/` is covered by neither: it is loaded by both processes, so
no host import is legitimate there at all. That rule is prose in
`src/shared/AGENTS.md` today rather than a lint override.

Wiring: `npm run lint:boundary` runs the config with `--no-eslintrc`
over **two** trees, `src/renderer` and `src/engine`; `npm run lint` is
`standard && npm run lint:boundary`; `npm test` runs
`npm run lint` first, so a direct host import fails the build. Adding
`import os from 'os'` to `lib/dispatcher.js` and running `npm test`
stops the run at `lint:boundary` with `'os' import is restricted from
being used`, before `depcheck` or the unit tests execute.

`no-restricted-imports` sees `import` declarations only. The
`require()` spellings of the same specifiers, and the usage-level
concerns no import rule can express (`ipcRenderer.` member reads,
`wt-` channel strings, `new remote.Menu`, `remote.dialog`), stay in
the source scan in `test/unit/platform-boundary.js`, which since US-046
scans the sidecar for its own two bans as well. The two checks are
complementary; neither replaces the other. Add a new banned specifier to
the lint config, a new banned usage to the scan.
