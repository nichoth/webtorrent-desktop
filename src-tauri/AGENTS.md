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
