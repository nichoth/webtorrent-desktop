// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The Tauri host.
//!
//! ADR-014: this crate grows alongside `src/main/` for the whole of
//! Phase 4 and neither host is a branch. Both open one window onto the
//! same `static/main.html` and the same Vite output, so there is
//! nothing here that decides what the UI is -- only where it lives.
//! Every host concern the UI calls (dialogs, menus, the tray) arrives
//! in a later story. Paths landed first, in `paths`, because the rest
//! of Phase 4 is built on them; the window itself is `window`.
//!
//! `tauri.conf.json` declares the window **hidden**, exactly as
//! `src/main/windows/main.js` passes `show: false`. Everything about
//! where it opens is a runtime decision -- the saved rectangle, the
//! maximized flag, and whether a `--hidden` launch shows it at all --
//! so it is made below and the window is shown afterwards, rather than
//! flashing at the default size first.

mod paths;
mod window;

use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, WebviewWindow};

use paths::AppPaths;
use window::{Debounce, WindowLayout};

/// The label of the one window, as `tauri.conf.json` declares it.
const MAIN_WINDOW: &str = "main";

/// The renderer's one way to learn where its data lives. The layout is
/// resolved once at startup and handed over as plain data (ADR-007),
/// so the UI never sees a host path object and never re-derives a
/// path itself.
#[tauri::command]
fn app_paths(paths: tauri::State<'_, AppPaths>) -> AppPaths {
    paths.inner().clone()
}

/// Open the window where the last session left it.
///
/// The order matters: the minimum size is set before the size, so a
/// saved rectangle smaller than the minimum is clamped the way
/// Electron clamps it, and the window is shown last so none of this is
/// visible as a resize.
fn restore(main: &WebviewWindow, layout: WindowLayout, hidden: bool) -> tauri::Result<()> {
    main.set_min_size(Some(LogicalSize::new(
        window::MIN_WIDTH,
        window::MIN_HEIGHT,
    )))?;
    main.set_size(LogicalSize::new(layout.width, layout.height))?;

    // A first run has no saved origin, and the platform places the
    // window better than a guessed corner would.
    if let (Some(x), Some(y)) = (layout.x, layout.y) {
        main.set_position(LogicalPosition::new(x, y))?;
    }

    if layout.maximized {
        main.maximize()?;
    }

    // `--hidden` is the login launch: the app runs, the window does
    // not appear until something asks for it.
    if !hidden {
        main.show()?;
    }

    Ok(())
}

/// Push the window's rectangle to the renderer, which saves it.
///
/// The renderer hears this through `ipcOs.onWindowBoundsChanged` on
/// the same event name the Electron host sends, so nothing above the
/// shim can tell the two hosts apart.
fn send_bounds(main: &WebviewWindow) {
    let read = || -> tauri::Result<window::Bounds> {
        let position = main.outer_position()?;
        let size = main.outer_size()?;
        Ok(window::logical_bounds(
            (position.x, position.y),
            (size.width, size.height),
            main.scale_factor()?,
        ))
    };

    match read().and_then(|bounds| main.emit(window::BOUNDS_CHANGED_EVENT, bounds)) {
        Ok(()) => {}
        // A window being torn down under a pending debounce is the
        // ordinary way this fails, and there is no caller left to tell.
        Err(err) => eprintln!("windowBoundsChanged: {err}"),
    }
}

/// Report every move and resize to the renderer, debounced.
fn watch_bounds(main: &WebviewWindow) {
    let debounce = Debounce::new(window::BOUNDS_DEBOUNCE);
    let watched = main.clone();

    main.on_window_event(move |event| {
        if !matches!(
            event,
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
        ) {
            return;
        }

        let main = watched.clone();
        debounce.call(move || send_bounds(&main));
    });
}

fn main() {
    // The single-instance lock writes into the user's profile, so the
    // portable app skips it for the same reason `src/main/index.js`
    // does: a portable install leaves nothing behind. The check needs
    // no window and no Tauri path resolver, only the environment.
    let portable = paths::Env::current(None)
        .map(|env| paths::is_portable(&env))
        .unwrap_or(false);

    let mut builder = tauri::Builder::default();

    if !portable {
        // A second launch signals this one and exits, which is
        // `app.requestSingleInstanceLock()` plus the `second-instance`
        // handler in `src/main/index.js`. Delivering the argv of that
        // second launch (a magnet link, a .torrent path) to the UI is
        // US-065; showing the window it was aimed at is this story.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(main) = app.get_webview_window(MAIN_WINDOW) {
                let _ = main.show();
                let _ = main.set_focus();
            }
        }));
    }

    builder
        .setup(|app| {
            // `download_dir` is the one path Tauri resolves better than
            // this crate can: on Linux it reads the XDG user-dirs
            // config rather than assuming `~/Downloads`.
            let env = paths::Env::current(app.path().download_dir().ok())
                .expect("WebTorrent Desktop does not support this platform");
            let paths = AppPaths::resolve(&env);

            let layout = WindowLayout::resolve(window::read_saved_bounds(&paths.config_path));
            let hidden = window::is_hidden(std::env::args());
            let main = app
                .get_webview_window(MAIN_WINDOW)
                .expect("tauri.conf.json declares no main window");
            restore(&main, layout, hidden)?;
            watch_bounds(&main);

            app.manage(paths);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![app_paths])
        .run(tauri::generate_context!())
        .expect("failed to start the WebTorrent Desktop window");
}

#[cfg(test)]
mod tests {
    use super::MAIN_WINDOW;
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

    /// Where the window opens is decided at runtime from the saved
    /// bounds, so the declared window must not show itself first --
    /// the same `show: false` `src/main/windows/main.js` passes. A
    /// visible window here would flash at the default size on every
    /// launch, and would ignore `--hidden` entirely.
    #[test]
    fn the_declared_window_starts_hidden() {
        assert_eq!(config()["app"]["windows"][0]["visible"], false);
    }

    /// The declared size is only what the window is built with before
    /// `restore` runs, but a mismatch with the constants would show as
    /// a resize on launch, so the two are held together.
    #[test]
    fn the_declared_geometry_matches_the_constants() {
        let main = config()["app"]["windows"][0].clone();

        assert_eq!(main["width"], crate::window::INITIAL_WIDTH);
        assert_eq!(main["height"], crate::window::INITIAL_HEIGHT);
        assert_eq!(main["minWidth"], crate::window::MIN_WIDTH);
        assert_eq!(main["minHeight"], crate::window::MIN_HEIGHT);
    }

    /// The renderer subscribes to the bounds event through
    /// `@tauri-apps/api`, which needs the core event permission. With
    /// no capability granting it, the subscription fails at runtime
    /// and the window silently stops saving where it is.
    #[test]
    fn the_renderer_may_listen_for_events() {
        let capability: Value = serde_json::from_str(include_str!("../capabilities/default.json"))
            .expect("capabilities/default.json is not valid JSON");

        let permissions = capability["permissions"]
            .as_array()
            .expect("no permissions list");
        assert!(
            permissions.iter().any(|p| p == "core:default"),
            "the core defaults, which include event listening"
        );
        assert!(capability["windows"]
            .as_array()
            .expect("no window list")
            .iter()
            .any(|w| w == MAIN_WINDOW));
    }
}
