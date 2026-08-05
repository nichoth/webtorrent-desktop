//! The tray icon and its menu.
//!
//! This is the Rust half of `src/main/tray.js`. It follows
//! [`crate::menu`]: what the tray *is* -- whether this platform has
//! one, which items it shows, what an item does, which icon file it
//! uses -- is a pure function of plain values, and the part that
//! touches the world is the bottom of the file plus the wiring in
//! `main.rs`.
//!
//! The tray menu is described with [`crate::menu::Item`], the same
//! descriptors the application and context menus use, so it is built
//! by the same code and asserted the same way.

use std::process::Command;

use tauri::image::Image;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::AppHandle;

use crate::menu::{Item, Platform};

/// The tray's id, which is how it is found again to have its menu
/// swapped and to be taken down on quit.
const TRAY_ID: &str = "main";

// -- item ids -------------------------------------------------------
//
// Namespaced `tray:` so that they cannot collide with the application
// menu's ids or a context menu's, all three of which arrive at the
// same place: a menu event carries an id and nothing else.

/// The item that hides or shows the window, depending on which of the
/// two the window is doing now. `src/main/tray.js` rebuilds the whole
/// menu to swap it, so both states share the one id.
pub const TOGGLE: &str = "tray:toggle";

/// Quit.
pub const QUIT: &str = "tray:quit";

/// What clicking a tray item does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// `windows.main.show()`.
    Show,
    /// `windows.main.hide()`.
    Hide,
    /// `app.quit()`.
    Quit,
}

/// What a request to close the window should do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Close {
    /// Hide the window and keep running -- the tray is how the user
    /// gets it back.
    Hide,
    /// Let the close proceed, which ends the app.
    Exit,
}

/// Whether this platform gets a tray icon at all.
///
/// `src/main/index.js` skips it on macOS ("Mac apps generally do not
/// have menu bar icons"), Windows always gets one, and Linux gets one
/// only where libappindicator is installed -- which is
/// `checkLinuxTraySupport`, and is [`has_appindicator`] below.
pub fn is_supported(platform: Platform, appindicator: bool) -> bool {
    match platform {
        Platform::Mac => false,
        Platform::Windows => true,
        Platform::Linux => appindicator,
    }
}

/// The tray menu, for a window that is currently visible or not.
///
/// `getMenuTemplate` in `src/main/tray.js`: the toggle item, whose
/// label and effect follow the window, and Quit.
pub fn template(visible: bool) -> Vec<Item> {
    vec![
        item(
            TOGGLE,
            if visible {
                "Hide to tray"
            } else {
                "Show WebTorrent"
            },
        ),
        item(QUIT, "Quit"),
    ]
}

fn item(id: &str, label: &str) -> Item {
    Item::Normal {
        id: id.to_string(),
        label: label.to_string(),
        accelerator: None,
        enabled: true,
    }
}

/// What clicking the item with this id does, given what the window is
/// doing now.
///
/// The toggle item keeps one id across both of its labels, so the
/// window's visibility is what decides between showing and hiding --
/// exactly as it decides which label was built.
pub fn action(id: &str, visible: bool) -> Option<Action> {
    match id {
        TOGGLE if visible => Some(Action::Hide),
        TOGGLE => Some(Action::Show),
        QUIT => Some(Action::Quit),
        _ => None,
    }
}

/// What clicking the tray icon itself does: `tray.on('click', () =>
/// windows.main.show())`.
pub fn click_action() -> Action {
    Action::Show
}

/// Whether the OS shows the tray menu on a left click.
///
/// "On Windows, left click opens the app, right click opens the
/// context menu. On Linux, any click (left or right) opens the context
/// menu." Left click therefore belongs to the app on Windows and to
/// the menu everywhere else.
pub fn menu_on_left_click(platform: Platform) -> bool {
    platform != Platform::Windows
}

/// What closing the window does.
///
/// `win.on('close')` in `src/main/windows/main.js`: with a tray the
/// window hides and the app keeps running, without one the close ends
/// the app, and once the app is quitting the close is the quit
/// happening and is left alone.
///
/// Electron hides on close on macOS as well, where there is never a
/// tray, because the dock icon brings the window back. Until the dock
/// is ported (US-063) there would be no way back, so here macOS falls
/// out of the `has_tray == false` branch and closes.
pub fn on_close(has_tray: bool, quitting: bool) -> Close {
    if quitting || !has_tray {
        Close::Exit
    } else {
        Close::Hide
    }
}

/// The tray icon's bytes.
///
/// `getIconPath` in `src/main/tray.js`: `config.APP_ICON` with `.ico`
/// on Windows and `.png` elsewhere, which is `static/WebTorrent.*`.
/// They are embedded rather than read at runtime because the document
/// root Tauri serves `static/` from is compiled into the binary
/// (`src-tauri/AGENTS.md`), so there is no file to read in a packaged
/// build.
pub fn icon_bytes(platform: Platform) -> &'static [u8] {
    match platform {
        Platform::Windows => include_bytes!("../../static/WebTorrent.ico"),
        _ => include_bytes!("../../static/WebTorrent.png"),
    }
}

// -- the part that touches the world --------------------------------

/// Whether libappindicator is installed, which is
/// `checkLinuxTraySupport` in `src/main/tray.js` -- there it is
/// `ldconfig -p | grep libappindicator`, here the same listing read
/// rather than piped. Only Linux asks; everywhere else the answer is
/// unused, and `ldconfig` does not exist to give one.
pub fn has_appindicator() -> bool {
    if !cfg!(target_os = "linux") {
        return false;
    }

    Command::new("ldconfig")
        .arg("-p")
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).contains("libappindicator"))
        .unwrap_or(false)
}

/// Create the tray, on the platforms that have one.
///
/// `tray.init()` in `src/main/tray.js`, called from
/// `src/main/index.js`. Doing nothing is the macOS answer and the
/// Linux-without-libappindicator one, and [`exists`] is how the rest
/// of the host asks which happened -- `tray.hasTray()`.
pub fn init(app: &AppHandle, visible: bool) -> tauri::Result<()> {
    let platform = Platform::current();
    if !is_supported(platform, has_appindicator()) {
        return Ok(());
    }

    let menu = crate::menu::build_menu(app, &template(visible))?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(icon_bytes(platform))?)
        .menu(&menu)
        .show_menu_on_left_click(menu_on_left_click(platform))
        .on_menu_event(|app, event| crate::on_tray_menu_click(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            // The whole of `tray.on('click', ...)`: a completed left
            // click, which is the only one Windows leaves to the app
            // (the others put the menu up).
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::perform_tray(tray.app_handle(), click_action());
            }
        })
        .build(app)?;

    Ok(())
}

/// `tray.hasTray()`: whether there is a tray icon to hide to.
pub fn exists(app: &AppHandle) -> bool {
    app.tray_by_id(TRAY_ID).is_some()
}

/// `updateTrayMenu()`: the toggle item's label and effect follow the
/// window, so the menu is rebuilt whenever the window may have
/// changed. A platform without a tray has nothing to rebuild.
pub fn refresh(app: &AppHandle, visible: bool) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };

    let rebuild = || -> tauri::Result<()> {
        let menu = crate::menu::build_menu(app, &template(visible))?;
        tray.set_menu(Some(menu))
    };

    if let Err(err) = rebuild() {
        eprintln!("updateTrayMenu: {err}");
    }
}

/// Take the tray down.
///
/// Electron destroys it with the process; a `TrayIcon` Tauri still
/// holds is only removed from the notification area when it is
/// dropped, and on Windows a tray icon whose owner went away without
/// removing it stays on screen until something repaints the area. So
/// the app removes its own on the way out.
pub fn destroy(app: &AppHandle) {
    app.remove_tray_by_id(TRAY_ID);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The first eight bytes of every PNG file.
    const PNG_MAGIC: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

    /// An ICO header: reserved 0, type 1, then the image count.
    const ICO_MAGIC: &[u8] = &[0x00, 0x00, 0x01, 0x00];

    fn ids(items: &[Item]) -> Vec<&str> {
        items
            .iter()
            .filter_map(|item| match item {
                Item::Normal { id, .. } => Some(id.as_str()),
                _ => None,
            })
            .collect()
    }

    fn labels(items: &[Item]) -> Vec<&str> {
        items
            .iter()
            .filter_map(|item| match item {
                Item::Normal { label, .. } => Some(label.as_str()),
                _ => None,
            })
            .collect()
    }

    /// `src/main/index.js` calls `tray.init()` on everything but
    /// macOS, and `init` itself creates the tray on Windows
    /// unconditionally and on Linux only with libappindicator.
    #[test]
    fn only_the_platforms_electron_gives_a_tray_get_one() {
        assert!(!is_supported(Platform::Mac, true));
        assert!(!is_supported(Platform::Mac, false));
        assert!(is_supported(Platform::Windows, true));
        assert!(is_supported(Platform::Windows, false));
        assert!(is_supported(Platform::Linux, true));
        assert!(!is_supported(Platform::Linux, false));
    }

    /// Two items, in the order `getMenuTemplate` builds them.
    #[test]
    fn the_menu_matches_the_electron_template() {
        assert_eq!(labels(&template(true)), vec!["Hide to tray", "Quit"]);
        assert_eq!(labels(&template(false)), vec!["Show WebTorrent", "Quit"]);

        for visible in [true, false] {
            assert_eq!(ids(&template(visible)), vec![TOGGLE, QUIT]);
        }
    }

    /// A menu event carries an id and nothing else, so an item whose
    /// id has no action is a dead item.
    #[test]
    fn every_item_has_an_action() {
        for visible in [true, false] {
            for id in ids(&template(visible)) {
                assert!(
                    action(id, visible).is_some(),
                    "{id} does nothing with visible={visible}"
                );
            }
        }

        assert_eq!(action(TOGGLE, true), Some(Action::Hide));
        assert_eq!(action(TOGGLE, false), Some(Action::Show));
        assert_eq!(action(QUIT, true), Some(Action::Quit));
        assert_eq!(action("nope", true), None);
    }

    /// Both menus reach the host through the same event, so a tray id
    /// must not look like an application-menu item or a context
    /// choice.
    #[test]
    fn tray_ids_are_not_application_menu_ids() {
        for id in [TOGGLE, QUIT] {
            assert!(crate::menu::action(id).is_none(), "{id}");
            assert!(crate::menu::context_choice(id).is_none(), "{id}");
        }
    }

    /// Clicking the icon shows the window on every platform that has
    /// one; only Windows gives the left click to the app rather than
    /// to the menu.
    #[test]
    fn clicking_the_icon_shows_the_window() {
        assert_eq!(click_action(), Action::Show);
        assert!(!menu_on_left_click(Platform::Windows));
        assert!(menu_on_left_click(Platform::Linux));
    }

    /// Closing hides to the tray where there is one, ends the app
    /// where there is not, and never interferes with a quit already
    /// under way.
    #[test]
    fn closing_hides_only_when_there_is_a_tray_to_hide_to() {
        assert_eq!(on_close(true, false), Close::Hide);
        assert_eq!(on_close(false, false), Close::Exit);
        assert_eq!(on_close(true, true), Close::Exit);
        assert_eq!(on_close(false, true), Close::Exit);
    }

    /// The same two files `getIconPath` picks between.
    #[test]
    fn the_icon_is_the_electron_asset_for_the_platform() {
        assert!(icon_bytes(Platform::Windows).starts_with(ICO_MAGIC));

        for platform in [Platform::Mac, Platform::Linux] {
            assert!(icon_bytes(platform).starts_with(PNG_MAGIC), "{platform:?}");
        }
    }
}
