# src-tauri/

The Tauri host. It grows alongside `src/main/` for the whole of Phase 4
and neither host is a branch (ADR-014); `npm start` stays Electron,
`npm run start:tauri` is this one.

## The document root is generated, so Cargo depends on npm

`tauri.conf.json` sets `frontendDist` to `../build-tauri`, which
`bin/build-tauri.js` assembles by copying `static/` and `build-vite/`
side by side. That layout is not cosmetic: `static/main.html` is shared
with Electron and reaches the bundle through a relative
`<script src="../build-vite/renderer/main.js">`, so the two directories
have to be siblings inside the root or that `..` escapes it. Tauri
walks the root at compile time to embed it and does not follow
symlinks, so it has to be a copy.

The consequence for every Cargo command: **`cargo build`, `cargo test`
and `cargo clippy` all panic if `build-tauri/` does not exist**
(`tauri::generate_context!` expands the directory at compile time).
Run `npm run build:tauri` first in a fresh clone. For the same reason a
renderer change needs `npm run build:tauri` before the Rust binary
serves it -- `cargo run` alone reuses the embedded copy.

## The renderer in that root is built for *this* host

Since US-052 `npm run build:tauri` runs
`npm run build:renderer:tauri`, not `npm run build:renderer`: the
former sets `WT_HOST=tauri`, which swaps
`src/renderer/lib/platform/*.js` for `src/renderer/lib/platform/tauri/*.js`
in the bundle (ADR-014). Assembling the document root from a plain
`npm run build:renderer` gives a window full of Electron shim code
that cannot load, so use the npm script rather than running
`bin/build-tauri.js` by hand after some other build.

Most of that Tauri tree throws `NotImplementedError` today, on purpose
-- each Phase 4 story implements one module. A window that comes up and
reports not-implemented is the expected state, not a regression.

## Path resolution is a pure function of an `Env`

`src/paths.rs` mirrors the path block of `src/config.js`. Keep the two
in sync: `AppPaths::resolve` reads only the [`Env`] struct it is
handed, never process state, so `Env::current` is the one place that
touches env vars, `current_exe` and the disk. That is what lets a test
assert the Windows portable layout from macOS -- follow the pattern
when adding a host concern that varies by platform rather than
reaching for `cfg!(target_os)` in the logic.

`matches_src_config_js_on_this_platform` shells out to `node
--input-type=module -e "import('./src/config.js')..."` from the repo
root and compares the answers, so a layout change made on the JS side
alone fails `cargo test`. Node loads `src/config.js` as real ESM there
(the same path the `bin/` scripts take), and `IS_PRODUCTION` is false
under plain Node, so it takes the non-portable branch a debug `cargo
test` also takes. Do not add a comparison of
`DEFAULT_DOWNLOAD_PATH`: `getPath()` in `config.js` returns `''`
outside an Electron process.

`is_production` here is `!cfg!(debug_assertions)`, the closest analogue
of Electron's "am I a packaged binary" test. A debug build therefore
never looks portable, which also means the portable branch cannot be
exercised by running the dev binary -- assert it through `Env` instead.

## The window is opened by the host, not by the config

`tauri.conf.json` declares the window with `"visible": false`, the way
`src/main/windows/main.js` passes `show: false`. Everything about where
it opens is decided at runtime in `src/window.rs` and applied by
`restore()` in `main.rs`: the saved rectangle out of the renderer's
`config.json`, the minimum size, the maximized flag and whether a
`--hidden` launch shows it at all. Set the declared window visible
again and all four are lost -- it comes up at the default size before
any of them is applied.

`src/window.rs` follows `paths.rs`: the decisions are pure functions of
plain values (`WindowLayout::resolve`, `logical_bounds`, `is_hidden`),
and `main.rs` is the only part that touches a window. One conversion is
not optional -- Tauri reports **physical** pixels and Electron's
`getBounds()` is **logical**, so a rectangle read off the window goes
through `logical_bounds` before the renderer sees it, or the saved size
doubles on every restart on a retina display.

## Anything the renderer calls needs a capability

`capabilities/default.json` grants `core:default` to the `main` window.
App-defined `#[tauri::command]`s need no entry, but **core APIs the
renderer reaches through `@tauri-apps/api` do** -- event subscription
included. Without that file the shim's listener exports fail at
runtime with a permission error and nothing else looks wrong.

The same is true of a **plugin**, and it cuts the other way too: a
plugin's JS API (`@tauri-apps/plugin-dialog` and friends) needs its
permissions granted to the whole webview, while its *Rust* API does
not. So `register the plugin, wrap it in a command` is the cheaper
shape -- US-058's dialogs are `tauri_plugin_dialog::init()` plus
`show_open_dialog` / `show_save_dialog` in `main.rs`, and the renderer
still carries nothing but `core:default`. Two things to know when
following it: the plugin's own `blocking_*` helpers deadlock the event
loop on the main thread, so the command that calls them must be
`async` (which is what puts it on the async runtime), and a plugin adds
its ACL manifest to the regenerated `gen/schemas/`, which is
gitignored -- nothing to commit.

`async` is the safer default for any plugin command generally, not just
for the `blocking_*` pickers: the clipboard plugin's `read_text` is
`arboard`'s, which deadlocks on Linux if it runs on the main thread
while reading something the webview itself copied.

## File access is a host allowlist, not a capability scope

`src/fs.rs` holds the directories the renderer may reach, and every
`fs_*` command in `main.rs` starts by resolving its path through it.
Three things to keep true when touching it:

- **A command operates on what `Allowlist::resolve` returns**, never on
  the string it was given. The returned path has had `..` taken out and
  its existing ancestors canonicalized; using the original would leave
  the check and the operation looking at different files.
- **A new root needs its reason written down** in the table at the top
  of `src/fs.rs` and in `docs/platform-shim.md`. "Exactly the
  directories the shim needs" is a claim the two documents make on the
  code's behalf.
- **A host concern that learns a path the user chose should grant it.**
  The dialog commands do (a folder for writing, a file for reading);
  the drag-and-drop delivery in US-065 will have to.

`capabilities/default.json` stays at `core:default` through all of
this, which is the point: the webview has no file access of its own to
misuse.

## An ordinary crate can outrun the declared MSRV

`rust-version` is 1.77.2 (ADR-014), and Cargo's resolver does not
honour it -- `cargo add` warns about a too-new version and then the
lockfile picks it anyway. So a non-Tauri dependency needs its
`rust-version` checked, and pinning exactly (`trash = "=5.2.3"`, US-059)
is how the declaration stays true. Note *why* in `Cargo.toml`, because
the next person's instinct is to unpin it.

## Gates

`cargo fmt --check` and `cargo clippy -- -D warnings` are gates from
US-051 onward, as is `cargo test`. Clippy recompiles the whole
dependency tree the first time (several minutes); budget for it rather
than assuming it hung.

## Observing the webview non-interactively

WKWebView console output does not reach stdout, and there is no
`console-message` event as in Electron. The way to get evidence out of
the window is a throwaway probe build of `main.rs`: a
`#[tauri::command] fn probe(message: String)` that `println!`s, plus
`.append_invoke_initialization_script(...)` that hooks
`window.addEventListener('error', ...)` and `console.error` and invokes
it. An app-defined command needs no capability entry. Revert `main.rs`
afterwards -- unlike `build/`, it is source-controlled.

**The appended script is concatenated onto Tauri's own, so it must not
begin with `(` or `[`.** An init script that opens with
`(async () => { ... })()` is parsed as a call on whatever the previous
statement evaluated to, the whole init script throws, and the symptom
is total silence: no output, no error, and the page still loads and
reports `Finished` from `on_page_load`. Start it with a statement (or
a bare `;`) and the same script works. When a probe prints nothing,
suspect this before suspecting the window, the capabilities or the
sandbox.

## Both menus are built in `src/menu.rs`

The application menu is the host's own, as it is the Electron main
process's; the renderer's context menu arrives as descriptors and its
choice goes back as an index (ADR-007). `template(Platform)` returns
the whole application menu as `Item` values and `action(id)` says what
clicking one does, so all three platforms' menus are asserted from a
`cargo test` run on any one of them -- the same shape as `window.rs`.
Four things about the Tauri side are worth knowing before changing it:

- **`Menu::get` only searches the top level**, so items are indexed by
  id into `AppMenu` as they are built. Everything that enables, checks
  or disables an item afterwards goes through that index.
- **An accelerator that does not parse is dropped, not reported.**
  `MenuItem::with_id` swallows it, and the item then has no shortcut
  and no error. `every_accelerator_parses` runs all of them through
  `muda`'s parser, which is why `muda` is pinned as a dev-dependency
  at the version Tauri already resolves.
- **A `Menu` dropped while the OS is showing it takes the popup with
  it**, so `ContextMenus` holds the current one until the next
  replaces it.
- **Tauri has no "is it always on top" getter**, so the Float on Top
  check item is where that state lives -- which is where Electron
  keeps it too.

An item id is what a menu event carries and the only thing it carries.
Adding an item therefore means adding its id to `action`, or it is a
dead item; `every_item_has_an_action` fails if it is missed.

## Driving a real menu without a human (macOS)

A menu is the one host concern a `cargo test` cannot reach: the
template is asserted as data, but "is it in the menu bar, and does the
shortcut fire" is the OS's answer. On macOS `osascript` gives it, with
no UI work and no human, provided the terminal has Accessibility
permission (this machine has it):

```
osascript -e 'tell application "System Events" to tell process \
  "webtorrent-desktop" to get name of every menu bar item of menu bar 1'
```

The process name is the executable's, and it takes a second or two to
appear -- poll `exists process "..."` rather than sleeping a fixed
time. `keystroke "u" using command down` and `key code 49` (space)
fire real accelerators once the app is frontmost, and
`click menu item "Pause All" of menu 1 of menu bar item "Transfers" of
menu bar 1` clicks an item that has none. Pair either with a temporary
`println!` in the host's `dispatch` and the whole path is visible.

**Do not assert on the `enabled` attribute of a menu item.** System
Events reports a stale value for it: after `notify_player_open` had
demonstrably enabled the Playback items, every read still said
`enabled=false`, and reads taken seconds apart disagreed with each
other about the same untouched item. `name` is stale the same way -- a
renamed item kept its old title. The reliable assertion is
**behavioural**: press the accelerator and see whether the dispatch
arrives. A disabled item's accelerator does nothing, which makes
"enabled" observable without reading the attribute, and makes the
comparison a controlled one when the same key is pressed either side
of the call.
