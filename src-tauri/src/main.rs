// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The Tauri host.
//!
//! ADR-014: this crate grows alongside `src/main/` for the whole of
//! Phase 4 and neither host is a branch. Both open one window onto the
//! same `static/main.html` and the same Vite output, so there is
//! nothing here that decides what the UI is -- only where it lives.
//! The window itself is declared in `tauri.conf.json`; every host
//! concern the UI calls (dialogs, menus, the tray) arrives in a later
//! story. Paths landed first, in `paths`, because the rest of Phase 4
//! is built on them.

mod paths;

use tauri::Manager;

use paths::AppPaths;

/// The renderer's one way to learn where its data lives. The layout is
/// resolved once at startup and handed over as plain data (ADR-007),
/// so the UI never sees a host path object and never re-derives a
/// path itself.
#[tauri::command]
fn app_paths(paths: tauri::State<'_, AppPaths>) -> AppPaths {
    paths.inner().clone()
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // `download_dir` is the one path Tauri resolves better than
            // this crate can: on Linux it reads the XDG user-dirs
            // config rather than assuming `~/Downloads`.
            let env = paths::Env::current(app.path().download_dir().ok())
                .expect("WebTorrent Desktop does not support this platform");
            app.manage(AppPaths::resolve(&env));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![app_paths])
        .run(tauri::generate_context!())
        .expect("failed to start the WebTorrent Desktop window");
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    /// The document root is assembled by `bin/build-tauri.js`, and the
    /// window URL has to sit at the same depth inside it that
    /// `static/main.html` sits at inside the repo -- otherwise the
    /// relative `<script src>` in that file escapes the root and the
    /// bundle 404s. Held here as well as in `test/unit/tauri-host.js`
    /// so that a change made from the Rust side does not need the npm
    /// suite to be caught.
    fn config() -> Value {
        serde_json::from_str(include_str!("../tauri.conf.json"))
            .expect("tauri.conf.json is not valid JSON")
    }

    #[test]
    fn opens_exactly_one_window() {
        let windows = config()["app"]["windows"]
            .as_array()
            .expect("app.windows is not a list")
            .clone();

        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0]["url"], "static/main.html");
    }

    #[test]
    fn serves_the_assembled_document_root() {
        assert_eq!(config()["build"]["frontendDist"], "../build-tauri");
        assert_eq!(config()["identifier"], "io.webtorrent.webtorrent");
    }
}
