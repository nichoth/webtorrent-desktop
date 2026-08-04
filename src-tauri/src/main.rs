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
mod fs;
mod menu;
mod paths;
mod shell;
mod tray;
mod window;

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::window::{ProgressBarState, ProgressBarStatus};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewWindow, Wry};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder};
use tauri_plugin_opener::OpenerExt;

use fs::{Access, Allowlist, FileStats, Root};
use menu::{Action, AppMenu, ContextMenus, Platform};
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
    full_screen(&main, &watch, set_to)
}

/// The body of [`toggle_full_screen`], reachable without a command:
/// the View menu's Full Screen item toggles the same thing (US-061).
fn full_screen(
    main: &WebviewWindow,
    watch: &FullscreenWatch,
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
    report_fullscreen(main, watch);
    Ok(())
}

/// `ipcOs.show`. Electron's `win.show()` focuses as well as shows.
#[tauri::command]
fn show(main: WebviewWindow) -> Result<(), String> {
    show_main(main.app_handle()).map_err(failed)
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
///
/// What the user picked also becomes reachable through the `fs`
/// commands (US-060). A folder is granted for writing -- the only
/// folder this app asks for is the download folder -- and a file for
/// reading, because the only files it asks for are a `.torrent` and a
/// subtitle. That pairing is what the `fs` plugin gets from the dialog
/// plugin automatically; here it is explicit, and narrower.
#[tauri::command]
async fn show_open_dialog(
    main: WebviewWindow,
    allow: tauri::State<'_, Allowlist>,
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
    let chosen = dialog::plain_paths(picked.unwrap_or_default())?;
    grant_picked(&allow, plan.picker, &chosen);

    Ok(chosen)
}

/// Let the renderer reach what the user just picked.
///
/// A folder is granted for writing -- the only folder this app asks
/// for is a download folder -- and a file for reading. Shared with the
/// menu's own dialogs (US-061), which pick the same two kinds of thing.
fn grant_picked(allow: &Allowlist, picker: dialog::Picker, chosen: &[String]) {
    let folders = matches!(picker, dialog::Picker::Folder | dialog::Picker::Folders);

    for path in chosen {
        allow.grant(if folders {
            Root::writable(path)
        } else {
            Root::read_only(path)
        });
    }
}

/// `dialog.showSaveDialog`: the path chosen, or `null` on cancel.
///
/// The chosen path is granted for writing, since saving to it is the
/// whole reason the dialog was opened.
#[tauri::command]
async fn show_save_dialog(
    main: WebviewWindow,
    allow: tauri::State<'_, Allowlist>,
    options: dialog::DialogOptions,
) -> Result<Option<String>, String> {
    let plan = dialog::plan_save(&options);

    match file_dialog(&main, &plan).blocking_save_file() {
        Some(path) => {
            let chosen = dialog::plain_path(path)?;
            allow.grant(Root::writable(&chosen));
            Ok(Some(chosen))
        }
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

// -- the menus (US-061) -----------------------------------------------
//
// Two menus, one module. The application menu is this host's own, as
// it is the Electron main process's (`src/main/menu.js`): the
// descriptors are built in `menu::template` and never cross the
// boundary. The context menu is the renderer's, and its descriptors do
// cross -- plain objects in, the index of what was chosen back
// (ADR-007). Neither direction carries a `MenuItem`.
//
// A menu event carries an id and nothing else, so `on_menu_click`
// below is the whole click surface for both menus: `menu::action`
// turns an id into an [`Action`], and `perform` is the only place that
// touches the world.

/// The event the renderer hears menu-driven actions on. It is
/// Electron's channel name, because it is the same renderer listening
/// (`ipcOs.onDispatch`, `windows.main.dispatch` in
/// `src/main/windows/main.js`).
const DISPATCH_EVENT: &str = "dispatch";

/// `menu.showContextMenu(items)`: the descriptors the renderer sent,
/// built and popped up at the pointer.
///
/// The popup does not wait for a choice, exactly as
/// `Menu.popup({ window })` does not under Electron. What the user
/// picks comes back through [`menu::CONTEXT_MENU_CLICK_EVENT`], and
/// the shim calls the `click` it kept.
#[tauri::command]
fn show_context_menu(
    main: WebviewWindow,
    menus: tauri::State<'_, ContextMenus<Wry>>,
    menu: u64,
    items: Vec<menu::ContextItem>,
) -> Result<(), String> {
    let template = menu::context_template(menu, &items)?;
    let built = menu::build_menu(&main, &template).map_err(failed)?;

    main.popup_menu(&built).map_err(failed)?;
    menus.hold(built);
    Ok(())
}

/// `ipcOs.setAllowNav`: "disallow opening more screens on top of the
/// current one", which is `menu.setAllowNav` under Electron.
#[tauri::command]
fn set_allow_nav(app_menu: tauri::State<'_, AppMenu<Wry>>, allow: bool) {
    app_menu.set_group_enabled(menu::nav_items(Platform::current()), allow);
}

/// `ipcOs.notifyPlayerOpen`: the Playback items act on something now.
///
/// Electron's handler also starts the power save blocker and the media
/// keys (US-066, US-067), which land on this command as they are
/// ported. The menu half is here.
#[tauri::command]
fn notify_player_open(app_menu: tauri::State<'_, AppMenu<Wry>>) {
    app_menu.set_group_enabled(menu::PLAYBACK_ITEMS, true);
}

/// `ipcOs.notifyPlayerClose`: nothing is playing, so nothing in the
/// Playback menu applies.
#[tauri::command]
fn notify_player_close(app_menu: tauri::State<'_, AppMenu<Wry>>) {
    app_menu.set_group_enabled(menu::PLAYBACK_ITEMS, false);
}

/// `ipcOs.notifyPlayerUpdate`: whether there is a next or previous
/// track to skip to, which is `menu.onPlayerUpdate`.
#[tauri::command]
fn notify_player_update(
    app_menu: tauri::State<'_, AppMenu<Wry>>,
    has_next: bool,
    has_previous: bool,
) {
    app_menu.set_enabled(menu::SKIP_NEXT, has_next);
    app_menu.set_enabled(menu::SKIP_PREVIOUS, has_previous);
}

/// A menu item was chosen, in either menu.
fn on_menu_click(app: &AppHandle, id: &str) {
    // A context menu's item is the renderer's to act on: it kept the
    // `click` callbacks, and all that crosses back is which one.
    if let Some((serial, index)) = menu::context_choice(id) {
        let payload = json!({ "menu": serial, "item": index });
        if let Err(err) = app.emit(menu::CONTEXT_MENU_CLICK_EVENT, payload) {
            eprintln!("contextMenuClick: {err}");
        }
        return;
    }

    // Roles have no action: the OS performs them.
    if let Some(action) = menu::action(id) {
        perform(app, action);
    }
}

/// Do what an application-menu item says to do.
fn perform(app: &AppHandle, action: Action) {
    match action {
        Action::Dispatch(name, args) => dispatch(app, name, args),
        Action::OpenSeedFile => open_menu_dialog(app.clone(), MenuDialog::SeedFile),
        Action::OpenSeedDirectory => open_menu_dialog(app.clone(), MenuDialog::SeedDirectory),
        Action::OpenTorrentFile => open_menu_dialog(app.clone(), MenuDialog::TorrentFile),
        Action::OpenExternal(url) => {
            if let Err(err) = app.opener().open_url(url, None::<&str>) {
                eprintln!("menu openExternal: {err}");
            }
        }
        Action::ToggleFullScreen => {
            if let Some(main) = app.get_webview_window(MAIN_WINDOW) {
                let watch = app.state::<Arc<FullscreenWatch>>();
                if let Err(err) = full_screen(&main, &watch, None) {
                    eprintln!("menu toggleFullScreen: {err}");
                }
            }
        }
        Action::ToggleAlwaysOnTop => toggle_always_on_top(app),
        Action::ToggleDevTools => toggle_dev_tools(app),
        Action::Quit => quit(app),
    }
}

// -- the tray (US-062) ------------------------------------------------
//
// `src/main/tray.js`, whose menu is two items and whose whole point is
// that the window can go away without the app doing so. The shape is
// the menu's: [`tray::template`] and [`tray::action`] are data, and
// the three things a tray click can do are below.

/// A tray menu item was chosen.
fn on_tray_menu_click(app: &AppHandle, id: &str) {
    // The toggle item keeps one id across both of its labels, so what
    // the window is doing now decides what the click means -- the same
    // reading that chose the label.
    if let Some(action) = tray::action(id, is_main_visible(app)) {
        perform_tray(app, action);
    }
}

/// Do what a tray click says to do.
fn perform_tray(app: &AppHandle, action: tray::Action) {
    let done = match action {
        tray::Action::Show => show_main(app),
        tray::Action::Hide => hide_main(app),
        tray::Action::Quit => {
            quit(app);
            Ok(())
        }
    };

    if let Err(err) = done {
        eprintln!("tray {action:?}: {err}");
    }
}

/// `windows.main.show()`, and the tray menu follows the window.
fn show_main(app: &AppHandle) -> tauri::Result<()> {
    let Some(main) = app.get_webview_window(MAIN_WINDOW) else {
        return Ok(());
    };

    main.show()?;
    main.set_focus()?;
    tray::refresh(app, true);
    Ok(())
}

/// `windows.main.hide()`, which tells the renderer to leave the player
/// before the window goes -- hiding a playing video would keep playing
/// it.
fn hide_main(app: &AppHandle) -> tauri::Result<()> {
    let Some(main) = app.get_webview_window(MAIN_WINDOW) else {
        return Ok(());
    };

    dispatch(app, "backToList", vec![]);
    main.hide()?;
    tray::refresh(app, false);
    Ok(())
}

fn is_main_visible(app: &AppHandle) -> bool {
    app.get_webview_window(MAIN_WINDOW)
        .and_then(|main| main.is_visible().ok())
        .unwrap_or(false)
}

/// `app.quit()`.
///
/// The flag is Electron's `app.isQuitting`, and it is here for the
/// same reason: the window's close handler hides instead of closing,
/// so the quit has to say that this close is the app going away.
fn quit(app: &AppHandle) {
    QUITTING.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// Whether the app is on its way out. See [`quit`].
static QUITTING: AtomicBool = AtomicBool::new(false);

/// The window's close button, which is `win.on('close')` in
/// `src/main/windows/main.js`: with a tray to hide to, closing hides.
fn watch_close(main: &WebviewWindow) {
    let watched = main.clone();

    main.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            let app = watched.app_handle();
            let quitting = QUITTING.load(Ordering::SeqCst);

            if tray::on_close(tray::exists(app), quitting) == tray::Close::Hide {
                api.prevent_close();
                if let Err(err) = hide_main(app) {
                    eprintln!("close: {err}");
                }
            }
        }
    });
}

/// `windows.main.dispatch(name, ...args)`: the renderer's own action,
/// on the channel `ipcOs.onDispatch` listens to. The payload is the
/// argument list, so that the shim can spread it the way Electron's
/// multi-argument `send` arrives.
fn dispatch(app: &AppHandle, name: &str, args: Vec<Value>) {
    let mut payload = vec![json!(name)];
    payload.extend(args);

    if let Err(err) = app.emit(DISPATCH_EVENT, payload) {
        eprintln!("dispatch {name}: {err}");
    }
}

/// `windows.main.toggleAlwaysOnTop()`.
///
/// Tauri has no "is it on top" getter, so the menu's own checkbox is
/// where the flag lives -- which is where Electron keeps it too, by
/// way of `menu.onToggleAlwaysOnTop`.
fn toggle_always_on_top(app: &AppHandle) {
    let Some(main) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let app_menu = app.state::<AppMenu<Wry>>();
    let on_top = !app_menu.is_checked(menu::FLOAT_ON_TOP);

    match main.set_always_on_top(on_top) {
        Ok(()) => app_menu.set_checked(menu::FLOAT_ON_TOP, on_top),
        Err(err) => eprintln!("menu toggleAlwaysOnTop: {err}"),
    }
}

/// `windows.main.toggleDevTools()`. The devtools are compiled in for
/// debug builds only, which is Tauri's default and matches what a
/// packaged Electron build offers.
fn toggle_dev_tools(app: &AppHandle) {
    let Some(main) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };

    #[cfg(debug_assertions)]
    if main.is_devtools_open() {
        main.close_devtools();
    } else {
        main.open_devtools();
    }

    #[cfg(not(debug_assertions))]
    let _ = main;
}

/// The three dialogs the File menu opens, which are
/// `src/main/dialog.js` minus the two the renderer already reaches
/// through `platform/dialog.js`.
#[derive(Debug, Clone, Copy)]
enum MenuDialog {
    SeedFile,
    SeedDirectory,
    TorrentFile,
}

impl MenuDialog {
    /// The Electron options, verbatim, so that `dialog::plan_open`
    /// makes the same decision it makes for the renderer's dialogs --
    /// including "`openDirectory` wins over `openFile`", which is what
    /// the macOS file-or-folder seed dialog becomes here.
    fn options(self) -> dialog::DialogOptions {
        let (title, properties, filters) = match self {
            MenuDialog::SeedFile => ("Select a file for the torrent.", vec!["openFile"], vec![]),
            MenuDialog::SeedDirectory => {
                if Platform::current() == Platform::Mac {
                    (
                        "Select a file or folder for the torrent.",
                        vec!["openFile", "openDirectory"],
                        vec![],
                    )
                } else {
                    (
                        "Select a folder for the torrent.",
                        vec!["openDirectory"],
                        vec![],
                    )
                }
            }
            MenuDialog::TorrentFile => (
                "Select a .torrent file.",
                vec!["openFile", "multiSelections"],
                vec![dialog::Filter {
                    name: "Torrent Files".to_string(),
                    extensions: vec!["torrent".to_string()],
                }],
            ),
        };

        dialog::DialogOptions {
            title: Some(title.to_string()),
            default_path: None,
            filters,
            properties: properties.into_iter().map(String::from).collect(),
        }
    }

    /// What the renderer is told about what was picked.
    fn dispatch(self, app: &AppHandle, chosen: Vec<String>) {
        match self {
            MenuDialog::SeedFile | MenuDialog::SeedDirectory => {
                dispatch(app, "showCreateTorrent", vec![json!(chosen)])
            }
            // One dispatch per file, as `openTorrentFile` sends one.
            MenuDialog::TorrentFile => {
                for path in chosen {
                    dispatch(app, "addTorrent", vec![json!(path)]);
                }
            }
        }
    }
}

/// Open one of the File menu's dialogs, and tell the renderer what
/// came back.
///
/// On its own thread because the pickers are the plugin's blocking
/// ones, and a menu event is delivered on the main thread -- which is
/// the thread they would deadlock (see the dialog commands above).
fn open_menu_dialog(app: AppHandle, which: MenuDialog) {
    std::thread::spawn(move || {
        let Some(main) = app.get_webview_window(MAIN_WINDOW) else {
            return;
        };

        let options = which.options();
        let plan = dialog::plan_open(&options);

        // "Dialogs do not show a title on Mac, so the window title is
        // used instead" -- and the renderer owns the title, so it is
        // asked to change it and change it back.
        let titled = Platform::current() == Platform::Mac;
        if titled {
            if let Some(title) = &plan.dialog.title {
                dispatch(&app, "setTitle", vec![json!(title)]);
            }
        }

        let picker = file_dialog(&main, &plan.dialog);
        let picked = match plan.picker {
            dialog::Picker::File => picker.blocking_pick_file().map(|path| vec![path]),
            dialog::Picker::Files => picker.blocking_pick_files(),
            dialog::Picker::Folder => picker.blocking_pick_folder().map(|path| vec![path]),
            dialog::Picker::Folders => picker.blocking_pick_folders(),
        };

        if titled {
            dispatch(&app, "resetTitle", vec![]);
        }

        // Cancelling dispatches nothing, exactly as the `Array.isArray`
        // guard in `src/main/dialog.js` returns early.
        let chosen = match dialog::plain_paths(picked.unwrap_or_default()) {
            Ok(chosen) if !chosen.is_empty() => chosen,
            Ok(_) => return,
            Err(err) => {
                eprintln!("menu dialog: {err}");
                return;
            }
        };

        grant_picked(&app.state::<Allowlist>(), plan.picker, &chosen);
        which.dispatch(&app, chosen);
    });
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

// -- the files the UI reads and writes (US-060) -----------------------
//
// `platform/fs.js`, as nine commands over `std::fs`. Commands rather
// than the `fs` plugin's JS API for the reason the rest of Phase 4 is:
// an app command needs no capability, so the webview carries no file
// access of its own and `capabilities/default.json` stays at
// `core:default`. What it may reach instead is [`Allowlist`], which the
// setup hook below builds and the dialog commands extend; `fs.rs` is
// where the directories and the reasons for them are.
//
// Every one of these is `async`, so the file work happens off the main
// thread. A subtitle file or a torrent's poster is small, but a
// `readdir` over a download folder on a network volume is not, and a
// sync command would block the event loop for the length of it.
//
// Each begins by resolving its path through the allowlist and then
// operates on what that returns -- the resolved path, not the string it
// was given -- so that the check and the operation cannot be looking at
// two different files.

/// `std::io` failures, as the renderer can use them. Same crossing as
/// every other command: the error is not `Serialize`, so it goes as its
/// own message, and the path is named because `io::Error` does not name
/// it.
fn io_failed(path: &Path, err: std::io::Error) -> String {
    format!("{}: {err}", path.display())
}

/// `fs.readFile`.
///
/// The bytes cross as bytes: `tauri::ipc::Response` hands the webview a
/// raw body it receives as an `ArrayBuffer`, where a `Vec<u8>` would be
/// JSON-encoded into an array of numbers -- several times the size, for
/// a file the renderer immediately turns back into a `Uint8Array`.
#[tauri::command]
async fn fs_read_file(
    allow: tauri::State<'_, Allowlist>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let path = allow.resolve(&path, Access::Read)?;

    std::fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|err| io_failed(&path, err))
}

/// `fs.writeFile`, replacing the file if it is there.
///
/// `data` is a plain array of bytes, because a `Uint8Array` JSONifies
/// to a keyed object; the shim converts before sending.
#[tauri::command]
async fn fs_write_file(
    allow: tauri::State<'_, Allowlist>,
    path: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let path = allow.resolve(&path, Access::Write)?;

    std::fs::write(&path, data).map_err(|err| io_failed(&path, err))
}

/// `fs.copyFile`, overwriting the destination. The source is only read,
/// which is what lets a fresh profile be seeded from the app's own
/// read-only resource directory.
#[tauri::command]
async fn fs_copy_file(
    allow: tauri::State<'_, Allowlist>,
    src: String,
    dest: String,
) -> Result<(), String> {
    let src = allow.resolve(&src, Access::Read)?;
    let dest = allow.resolve(&dest, Access::Write)?;

    std::fs::copy(&src, &dest)
        .map(|_| ())
        .map_err(|err| io_failed(&dest, err))
}

/// `fs.mkdir`. Always recursive, and succeeding on a directory that is
/// already there -- the `{ recursive: true }` the shim documents.
#[tauri::command]
async fn fs_mkdir(allow: tauri::State<'_, Allowlist>, path: String) -> Result<(), String> {
    let path = allow.resolve(&path, Access::Write)?;

    std::fs::create_dir_all(&path).map_err(|err| io_failed(&path, err))
}

/// `fs.rename`. Both ends are writes: the old path loses its entry.
#[tauri::command]
async fn fs_rename(
    allow: tauri::State<'_, Allowlist>,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    let old_path = allow.resolve(&old_path, Access::Write)?;
    let new_path = allow.resolve(&new_path, Access::Write)?;

    std::fs::rename(&old_path, &new_path).map_err(|err| io_failed(&old_path, err))
}

/// `fs.unlink`.
#[tauri::command]
async fn fs_unlink(allow: tauri::State<'_, Allowlist>, path: String) -> Result<(), String> {
    let path = allow.resolve(&path, Access::Write)?;

    std::fs::remove_file(&path).map_err(|err| io_failed(&path, err))
}

/// `fs.readdir`: entry names, not paths, which is what `readdir` gives
/// the Electron tree.
#[tauri::command]
async fn fs_readdir(
    allow: tauri::State<'_, Allowlist>,
    path: String,
) -> Result<Vec<String>, String> {
    let path = allow.resolve(&path, Access::Read)?;
    let entries = std::fs::read_dir(&path).map_err(|err| io_failed(&path, err))?;

    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|err| io_failed(&path, err))?;
        // A name that is not UTF-8 cannot cross to the renderer as a
        // string. Skipping it is what `readdir` cannot do and what this
        // must: the alternative is failing the whole listing over one
        // file the UI could not have named back to us anyway.
        if let Some(name) = entry.file_name().to_str() {
            names.push(name.to_owned());
        }
    }

    Ok(names)
}

/// `fs.stat`, resolving the plain object the shim promises rather than
/// a host handle.
#[tauri::command]
async fn fs_stat(allow: tauri::State<'_, Allowlist>, path: String) -> Result<FileStats, String> {
    let path = allow.resolve(&path, Access::Read)?;

    std::fs::metadata(&path)
        .map(FileStats::from)
        .map_err(|err| io_failed(&path, err))
}

/// `fs.exists`. A refused path answers `false` here as well as in the
/// shim: the contract is the `try { statSync() } catch {}` probes in
/// `lib/migrations.js`, which have no channel for a reason.
///
/// The `Result` never carries an error and is there because an `async`
/// command must return one. The shim treats a rejection as `false`
/// anyway, so the two agree either way.
#[tauri::command]
async fn fs_exists(allow: tauri::State<'_, Allowlist>, path: String) -> Result<bool, String> {
    Ok(match allow.resolve(&path, Access::Read) {
        Ok(path) => path.exists(),
        Err(_) => false,
    })
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
            // `menu.onToggleFullScreen`: the View menu's checkbox
            // follows the window, however the window got there
            // (US-061).
            if let Some(app_menu) = main.try_state::<AppMenu<Wry>>() {
                app_menu.set_checked(menu::FULL_SCREEN, fullscreen);
            }
            main.emit(window::FULLSCREEN_CHANGED_EVENT, fullscreen)?;
        }
        Ok(())
    };

    if let Err(err) = report() {
        eprintln!("fullscreenChanged: {err}");
    }
}

/// `menu.setWindowFocus`: the two View items that act on the window
/// are disabled while it is not the focused window, exactly as
/// `onWindowFocus` and `onWindowBlur` do in
/// `src/main/windows/main.js`.
fn watch_focus(main: &WebviewWindow) {
    let watched = main.clone();

    main.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(focused) = event {
            if let Some(app_menu) = watched.try_state::<AppMenu<Wry>>() {
                app_menu.set_group_enabled(menu::WINDOW_FOCUS_ITEMS, *focused);
            }
            // `tray.setWindowFocus`: the tray menu's toggle item reads
            // the window's visibility, and a focus change is where
            // `src/main/windows/main.js` has it catch up.
            let app = watched.app_handle();
            tray::refresh(app, is_main_visible(app));
        }
    });
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

            // The saved state is read once, for two things: the window
            // rectangle, and the download folders the user chose in an
            // earlier session -- which a restart does not re-pick, so
            // the allowlist would lose them (`fs::startup_roots`).
            let saved_state = window::read_saved_state(&paths.config_path);
            let allowlist = Allowlist::new(fs::startup_roots(
                &paths,
                app.path().resource_dir().ok(),
                &saved_state,
            ));

            let layout = WindowLayout::resolve(window::saved_bounds(&saved_state));
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

            // The application menu, and the index of the items that
            // change afterwards (US-061). It is set as the *app* menu
            // rather than the window's: on macOS there is only the one
            // menu bar, and on Windows and Linux Tauri gives it to
            // every window, which is the one window here.
            let (menu, app_menu) = menu::build(app.handle(), Platform::current())?;
            menu.set_as_app_menu()?;
            watch_focus(&main);

            // The tray, on the platforms that have one (US-062). It is
            // created after the window because its menu describes what
            // the window is doing, and it is what makes closing the
            // window a hide rather than a quit -- so `watch_close`
            // follows it.
            tray::init(app.handle(), main.is_visible().unwrap_or(false))?;
            watch_close(&main);

            app.manage(paths);
            app.manage(watch);
            app.manage(allowlist);
            app.manage(app_menu);
            app.manage(ContextMenus::<Wry>::default());

            // Both menus arrive here: an application item's id maps to
            // an action, a context item's to the choice the renderer is
            // waiting for.
            app.on_menu_event(|app, event| on_menu_click(app, event.id().as_ref()));
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
            show_context_menu,
            set_allow_nav,
            notify_player_open,
            notify_player_close,
            notify_player_update,
            open_external,
            open_path,
            show_item_in_folder,
            move_item_to_trash,
            clipboard_read_text,
            clipboard_write_text,
            fs_read_file,
            fs_write_file,
            fs_copy_file,
            fs_mkdir,
            fs_rename,
            fs_unlink,
            fs_readdir,
            fs_stat,
            fs_exists
        ])
        .build(tauri::generate_context!())
        .expect("failed to start the WebTorrent Desktop window")
        .run(|app, event| match event {
            // Whatever asked for the exit -- the menu, the tray, the
            // OS -- the app is quitting from here on, which is what
            // the window's close handler needs to know.
            tauri::RunEvent::ExitRequested { .. } => {
                QUITTING.store(true, Ordering::SeqCst);
            }
            // Take the tray icon down with the app rather than leaving
            // it for the notification area to notice.
            tauri::RunEvent::Exit => tray::destroy(app),
            _ => {}
        });
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
