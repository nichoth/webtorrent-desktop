// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The Tauri host.
//!
//! ADR-014: this crate grows alongside `src/main/` for the whole of
//! Phase 4 and neither host is a branch. Both open one window onto the
//! same `static/main.html` and the same Vite output, so there is
//! nothing here that decides what the UI is -- only where it lives.
//! The remaining host concerns the UI calls (menus, the tray) arrive
//! in a later story. Paths landed first, in `paths`, because the rest
//! of Phase 4 is built on them; the window itself is `window`, the
//! file dialogs are `dialog`, and `shell` and `clipboard` are the two
//! halves of "hand this to the OS".
//!
//! `tauri.conf.json` declares the window **hidden**, exactly as
//! `src/main/windows/main.js` passes `show: false`. Everything about
//! where it opens is a runtime decision -- the saved rectangle, the
//! maximized flag, and whether a `--hidden` launch shows it at all --
//! so it is made below and the window is shown afterwards, rather than
//! flashing at the default size first.

mod clipboard;
mod dialog;
mod paths;
mod shell;
mod window;

use std::sync::Arc;

use tauri::window::{ProgressBarState, ProgressBarStatus};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewWindow};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder};
use tauri_plugin_opener::OpenerExt;

use paths::AppPaths;
use window::{Debounce, FullscreenWatch, ProgressBar, WindowLayout};

/// The label of the one window, as `tauri.conf.json` declares it.
const MAIN_WINDOW: &str = "main";

/// Every window command returns its failure to the renderer, where the
/// shim's promise rejects and `reportErrors` in `src/renderer/main.js`
/// picks it up. A `tauri::Error` is not serializable, so it crosses as
/// its own message -- which is all the renderer can do with it anyway.
fn failed(err: tauri::Error) -> String {
    err.to_string()
}

/// The renderer's one way to learn where its data lives. The layout is
/// resolved once at startup and handed over as plain data (ADR-007),
/// so the UI never sees a host path object and never re-derives a
/// path itself.
#[tauri::command]
fn app_paths(paths: tauri::State<'_, AppPaths>) -> AppPaths {
    paths.inner().clone()
}

// -- The window, as the renderer drives it (US-057) -------------------
//
// Everything the shim's `window.js` and the window half of its
// `ipc-os.js` do arrives here as a command rather than as a core
// window call from the webview. Two reasons: the behaviour is the
// Electron *main* process's -- the fullscreen guard, the centring, the
// maximize bookkeeping all live in `src/main/windows/main.js`, not in
// its renderer -- and an app command needs no capability, so the
// renderer's reach stays exactly this list.
//
// Each command takes the calling `WebviewWindow`, which is the one
// window `tauri.conf.json` declares.

/// `getCurrentWindow().isVisible()`.
#[tauri::command]
fn window_is_visible(main: WebviewWindow) -> Result<bool, String> {
    main.is_visible().map_err(failed)
}

/// `getCurrentWindow().isMaximized()`.
#[tauri::command]
fn window_is_maximized(main: WebviewWindow) -> Result<bool, String> {
    main.is_maximized().map_err(failed)
}

/// `ipcOs.setTitle`.
#[tauri::command]
fn set_title(main: WebviewWindow, title: String) -> Result<(), String> {
    main.set_title(&title).map_err(failed)
}

/// `ipcOs.setProgress`: the taskbar bar, in Electron's units.
///
/// The dock badge and the rest of `src/main/dock.js` are US-063; this
/// is `win.setProgressBar` alone, which is the window's own.
#[tauri::command]
fn set_progress(main: WebviewWindow, progress: f64) -> Result<(), String> {
    let state = match window::progress_bar(progress) {
        ProgressBar::Hidden => ProgressBarState {
            status: Some(ProgressBarStatus::None),
            progress: None,
        },
        ProgressBar::Indeterminate => ProgressBarState {
            status: Some(ProgressBarStatus::Indeterminate),
            progress: None,
        },
        ProgressBar::Normal(percent) => ProgressBarState {
            status: Some(ProgressBarStatus::Normal),
            progress: Some(percent),
        },
    };

    main.set_progress_bar(state).map_err(failed)
}

/// `ipcOs.setBounds`, which is `setBounds` in
/// `src/main/windows/main.js`: [`window::plan_bounds`] decides, this
/// applies.
#[tauri::command]
fn set_bounds(
    main: WebviewWindow,
    bounds: window::BoundsRequest,
    maximize: Option<bool>,
) -> Result<(), String> {
    let state = window::WindowState {
        fullscreen: main.is_fullscreen().map_err(failed)?,
        maximized: main.is_maximized().map_err(failed)?,
    };
    let plan = window::plan_bounds(maximize, state);

    match plan.maximize {
        Some(true) => main.maximize().map_err(failed)?,
        Some(false) => main.unmaximize().map_err(failed)?,
        None => {}
    }

    if !plan.resize {
        return Ok(());
    }

    let scale = main.scale_factor().map_err(failed)?;
    let inner = main.inner_size().map_err(failed)?.to_logical::<f64>(scale);
    let outer = main.outer_size().map_err(failed)?.to_logical::<f64>(scale);

    // A request with no size keeps the size it has.
    let width = bounds.width.unwrap_or(outer.width);
    let height = bounds.height.unwrap_or(outer.height);

    // Tauri sizes the content area; Electron's plain `setBounds` sizes
    // the whole window and its `setContentBounds` does what Tauri
    // does, so only the first spelling needs the chrome taken off.
    let content = if bounds.content_bounds.unwrap_or(false) {
        (width, height)
    } else {
        window::outer_size(
            (width, height),
            (outer.width - inner.width, outer.height - inner.height),
        )
    };
    main.set_size(LogicalSize::new(content.0, content.1))
        .map_err(failed)?;

    let origin = match (bounds.x, bounds.y) {
        (Some(x), Some(y)) => Some((x, y)),
        // No origin means "centre on the display the window is on",
        // which is what the player asks for when a video opens.
        (None, None) => monitor_bounds(&main)?.map(|m| window::centered_origin((width, height), m)),
        // A half-specified origin is not one; leave the window where
        // it is rather than guessing the other half.
        _ => None,
    };

    if let Some((x, y)) = origin {
        main.set_position(LogicalPosition::new(x, y))
            .map_err(failed)?;
    }

    Ok(())
}

/// The logical rectangle of the display the window is mostly on --
/// Tauri's answer to `screen.getDisplayMatching(win.getBounds())`.
/// `None` when no monitor can be identified, in which case the window
/// keeps the position it has rather than being centred on a guess.
fn monitor_bounds(main: &WebviewWindow) -> Result<Option<window::Bounds>, String> {
    let monitor = match main.current_monitor().map_err(failed)? {
        Some(monitor) => monitor,
        None => return Ok(None),
    };
    let position = *monitor.position();
    let size = *monitor.size();

    Ok(Some(window::logical_bounds(
        (position.x, position.y),
        (size.width, size.height),
        monitor.scale_factor(),
    )))
}

/// `ipcOs.setAspectRatio` -- **not supported under Tauri**, and this
/// is the whole of it.
///
/// Electron's `win.setAspectRatio` locks a window's proportions while
/// the user drags its edge, on macOS. Tauri 2 exposes no equivalent
/// (there is no `set_aspect_ratio` on `WebviewWindow`, and tao has no
/// hook for the live-resize callback it would need). The visible
/// consequence: on macOS, dragging the player window's edge no longer
/// snaps to the video's shape, so the video letterboxes inside
/// whatever rectangle the user drags. Nothing else changes -- the
/// window is still *opened* at the video's aspect ratio by the
/// `setBounds` call that follows every `setAspectRatio` call in
/// `src/renderer/main.js`, and playback is unaffected.
///
/// The command stays rather than the shim resolving on its own, so
/// that the day Tauri grows the API there is one place to fill in.
#[tauri::command]
fn set_aspect_ratio(aspect_ratio: f64) {
    let _ = aspect_ratio;
}

/// `ipcOs.toggleFullScreen`.
#[tauri::command]
fn toggle_full_screen(
    main: WebviewWindow,
    watch: tauri::State<'_, Arc<FullscreenWatch>>,
    set_to: Option<bool>,
) -> Result<(), String> {
    // A hidden window cannot go fullscreen; Electron returns here too.
    if !main.is_visible().map_err(failed)? {
        return Ok(());
    }

    let fullscreen = match set_to {
        Some(flag) => flag,
        None => !main.is_fullscreen().map_err(failed)?,
    };
    main.set_fullscreen(fullscreen).map_err(failed)?;

    // The resize this causes reports the change on its own, but only
    // once it arrives; saying so here as well makes the renderer's
    // state right by the time the call resolves. The watch is
    // edge-triggered, so whichever gets there first is the only one
    // the renderer hears.
    report_fullscreen(&main, &watch);
    Ok(())
}

/// `ipcOs.show`. Electron's `win.show()` focuses as well as shows.
#[tauri::command]
fn show(main: WebviewWindow) -> Result<(), String> {
    main.show().map_err(failed)?;
    main.set_focus().map_err(failed)
}

// -- the dialogs (US-058) --------------------------------------------
//
// `platform/dialog.js` against the dialog plugin's *Rust* API rather
// than its JS one, which is what keeps the renderer's capability at
// `core:default`: registering the plugin does not grant the webview
// its commands. The translation from Electron's options object is
// [`dialog::plan_open`] / [`dialog::plan_save`].
//
// Both commands are `async` because the pickers below are the plugin's
// blocking variants, which deadlock the event loop if they run on the
// main thread -- an `async` command does not.

/// `dialog.showOpenDialog`: the paths chosen, empty on cancel.
#[tauri::command]
async fn show_open_dialog(
    main: WebviewWindow,
    options: dialog::DialogOptions,
) -> Result<Vec<String>, String> {
    let plan = dialog::plan_open(&options);
    let picker = file_dialog(&main, &plan.dialog);

    let picked = match plan.picker {
        dialog::Picker::File => picker.blocking_pick_file().map(|path| vec![path]),
        dialog::Picker::Files => picker.blocking_pick_files(),
        dialog::Picker::Folder => picker.blocking_pick_folder().map(|path| vec![path]),
        dialog::Picker::Folders => picker.blocking_pick_folders(),
    };

    // Cancelling is not a failure: the shim resolves to `[]`, which is
    // what `showOpenDialogSync` returning `undefined` becomes under
    // Electron.
    dialog::plain_paths(picked.unwrap_or_default())
}

/// `dialog.showSaveDialog`: the path chosen, or `null` on cancel.
#[tauri::command]
async fn show_save_dialog(
    main: WebviewWindow,
    options: dialog::DialogOptions,
) -> Result<Option<String>, String> {
    let plan = dialog::plan_save(&options);

    match file_dialog(&main, &plan).blocking_save_file() {
        Some(path) => dialog::plain_path(path).map(Some),
        None => Ok(None),
    }
}

/// A dialog builder with the plan applied, parented to the one window.
///
/// Parenting is the shim's contract rather than a nicety: callers pass
/// no parent window and the shim promises to supply one, which is what
/// took `remote.getCurrentWindow()` out of `path-selector.js` and
/// `torrent-list-controller.js` in US-027.
fn file_dialog(main: &WebviewWindow, plan: &dialog::DialogPlan) -> FileDialogBuilder<tauri::Wry> {
    let mut builder = main.dialog().file().set_parent(main);

    if let Some(title) = &plan.title {
        builder = builder.set_title(title);
    }
    if let Some(directory) = &plan.directory {
        builder = builder.set_directory(directory);
    }
    if let Some(file_name) = &plan.file_name {
        builder = builder.set_file_name(file_name);
    }
    for filter in &plan.filters {
        let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
        builder = builder.add_filter(&filter.name, &extensions);
    }

    builder
}

// -- the OS, and the clipboard (US-059) -------------------------------
//
// `platform/shell.js` and `platform/clipboard.js`. Commands rather than
// webview calls for the third time and the same two reasons: three of
// the four shell operations are the Electron main process's already
// (`src/main/shell.js`), and reaching the opener and clipboard plugins
// from Rust leaves `capabilities/default.json` at `core:default`.
//
// The opener plugin's own error type is not serializable either, so
// these do what the window commands do and cross as a message. Failure
// is a change from the Electron tree, where three of the four are
// `ipcRenderer.send` and cannot report anything; the call sites already
// handle a rejection (`docs/platform-shim.md`).

/// The opener plugin's failures, as the renderer can use them.
fn opener_failed(err: tauri_plugin_opener::Error) -> String {
    err.to_string()
}

/// `shell.openExternal`: a URL in the user's default browser.
#[tauri::command]
async fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    // `None` is "whichever application the OS associates with it",
    // which is the whole of what Electron's `openExternal` does.
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(opener_failed)
}

/// `shell.openPath`: a file in whichever application the OS associates
/// with it.
#[tauri::command]
async fn open_path(app: AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(opener_failed)
}

/// `shell.showItemInFolder`: reveal the item in the file manager,
/// selected where the platform can select it.
#[tauri::command]
async fn show_item_in_folder(app: AppHandle, path: String) -> Result<(), String> {
    app.opener().reveal_item_in_dir(path).map_err(opener_failed)
}

/// `shell.moveItemToTrash`. The decision -- including what to do about
/// a path that is already gone -- is [`shell::to_trash`].
#[tauri::command]
async fn move_item_to_trash(path: String) -> Result<(), String> {
    shell::to_trash(&path)
}

/// `clipboard.readText`. Empty is `''`, not a failure; see
/// [`clipboard::read_outcome`].
///
/// `async` deliberately: the plugin's `read_text` is `arboard`'s, which
/// deadlocks on Linux if it runs on the main thread while reading
/// something the webview itself copied. A non-`async` command would.
#[tauri::command]
async fn clipboard_read_text(app: AppHandle) -> Result<String, String> {
    clipboard::read_outcome(app.clipboard().read_text().map_err(|err| err.to_string()))
}

/// `clipboard.writeText`.
#[tauri::command]
async fn clipboard_write_text(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard()
        .write_text(text)
        .map_err(|err| err.to_string())
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

/// Tell the renderer the window entered or left fullscreen, and only
/// when it did.
///
/// Electron sends this from its `enter-full-screen` and
/// `leave-full-screen` handlers. Tauri has neither event, so the state
/// is read whenever the window resizes and [`FullscreenWatch`] decides
/// whether it is news. Reading it costs a window call and nothing
/// else, and going through the watch means the renderer sees exactly
/// the two transitions it would under Electron -- including one the
/// user made from the OS window chrome rather than through the app.
fn report_fullscreen(main: &WebviewWindow, watch: &FullscreenWatch) {
    let report = || -> tauri::Result<()> {
        let fullscreen = main.is_fullscreen()?;
        if watch.changed(fullscreen) {
            main.emit(window::FULLSCREEN_CHANGED_EVENT, fullscreen)?;
        }
        Ok(())
    };

    if let Err(err) = report() {
        eprintln!("fullscreenChanged: {err}");
    }
}

/// Report every move and resize to the renderer: the rectangle
/// debounced, the fullscreen state immediately.
///
/// The two share the one handler because they share the one event.
/// The rectangle is debounced because a drag emits hundreds of them
/// and each is a state write; the fullscreen edge is not, because it
/// is a rare transition the UI lays itself out around and a second of
/// letterboxed video would be visible.
fn watch_bounds(main: &WebviewWindow, watch: Arc<FullscreenWatch>) {
    let debounce = Debounce::new(window::BOUNDS_DEBOUNCE);
    let watched = main.clone();

    main.on_window_event(move |event| {
        if !matches!(
            event,
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
        ) {
            return;
        }

        if matches!(event, tauri::WindowEvent::Resized(_)) {
            report_fullscreen(&watched, &watch);
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
        // The dialogs are opened by `show_open_dialog` and
        // `show_save_dialog` below, through this plugin's Rust API. The
        // renderer cannot reach the plugin's own commands: they are not
        // in `capabilities/default.json`, and nothing above the shim
        // should want them (ADR-005).
        .plugin(tauri_plugin_dialog::init())
        // Same arrangement as the dialog plugin: `open_external`,
        // `open_path`, `show_item_in_folder` and the clipboard commands
        // below use these plugins' Rust APIs, and the renderer cannot
        // reach the plugins' own commands because they are not in
        // `capabilities/default.json`.
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
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

            // Shared between the resize handler and
            // `toggle_full_screen`, so that a transition is reported
            // once however it was reached.
            let watch = Arc::new(FullscreenWatch::new());
            watch_bounds(&main, Arc::clone(&watch));

            app.manage(paths);
            app.manage(watch);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_paths,
            window_is_visible,
            window_is_maximized,
            set_title,
            set_progress,
            set_bounds,
            set_aspect_ratio,
            toggle_full_screen,
            show,
            show_open_dialog,
            show_save_dialog,
            open_external,
            open_path,
            show_item_in_folder,
            move_item_to_trash,
            clipboard_read_text,
            clipboard_write_text
        ])
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
