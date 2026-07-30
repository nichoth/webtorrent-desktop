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
