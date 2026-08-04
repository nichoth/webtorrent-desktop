//! The application menu, and the context menu the renderer asks for.
//!
//! This is the Rust half of `src/main/menu.js` plus the host half of
//! `platform/menu.js`. Both are the same problem -- a menu described
//! as data, built by whichever host is running -- so both live here.
//!
//! The shape follows [`crate::window`] and [`crate::paths`]: the
//! decisions are pure functions of plain values, and what touches the
//! world is a thin layer at the bottom of the file and in `main.rs`.
//! [`template`] returns the whole menu as [`Item`] descriptors for a
//! given [`Platform`], so the macOS, Windows and Linux menus can each
//! be asserted from a `cargo test` run on any one of them. [`action`]
//! maps an item's id to what clicking it does, which is the other
//! half: `on_menu_event` gets an id back and nothing else.
//!
//! ADR-007 is why menus are data on both sides of the boundary. The
//! renderer's context menu sends descriptors and gets back the index
//! of what the user chose; no `MenuItem` -- and under Tauri no host
//! object at all -- crosses. The application menu is the host's own,
//! exactly as it is under Electron, so its descriptors are built here
//! rather than sent; what the renderer keeps is the two calls that
//! enable and disable items (`setAllowNav`, and the player
//! notifications behind `togglePlaybackControls`).
//!
//! Two items in `src/main/menu.js` have no Tauri equivalent and are
//! left out, both on macOS: Edit > Delete (Electron's `delete` role)
//! and Edit > Speech (`startspeaking` / `stopspeaking`). `muda`
//! offers no predefined item for either, and a normal item cannot
//! stand in because there is nothing to call. Cmd+Backspace still
//! deletes in a text field; the menu entry is what is missing.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Mutex;

use tauri::menu::{
    AboutMetadata, CheckMenuItem, IsMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem,
    Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
};
use tauri::{Manager, Runtime};

use crate::paths::APP_NAME;

// -- the values `src/config.js` holds -------------------------------

/// `HOME_PAGE_URL` in `src/config.js`.
const HOME_PAGE_URL: &str = "https://webtorrent.io";

/// `GITHUB_URL`.
const GITHUB_URL: &str = "https://github.com/webtorrent/webtorrent-desktop";

/// `GITHUB_URL_ISSUES`.
const GITHUB_URL_ISSUES: &str = "https://github.com/webtorrent/webtorrent-desktop/issues";

/// `GITHUB_URL_RELEASES`.
const GITHUB_URL_RELEASES: &str = "https://github.com/webtorrent/webtorrent-desktop/releases";

/// `TWITTER_PAGE_URL`.
const TWITTER_PAGE_URL: &str = "https://twitter.com/WebTorrentApp";

// -- item ids -------------------------------------------------------
//
// `src/main/menu.js` finds its items by label, because Electron's
// `Menu` offers nothing else. An id is stabler than a label -- it does
// not move when the wording does, and it is what a menu event carries
// -- so every item this host has to reach again has one. They are
// namespaced so that a context menu's ids (`ctx:`) cannot collide.

pub const NEW_TORRENT: &str = "menu:newTorrent";
pub const NEW_TORRENT_FROM_FILE: &str = "menu:newTorrentFromFile";
pub const OPEN_TORRENT_FILE: &str = "menu:openTorrentFile";
pub const OPEN_TORRENT_ADDRESS: &str = "menu:openTorrentAddress";
pub const QUIT: &str = "menu:quit";
pub const PREFERENCES: &str = "menu:preferences";
pub const FULL_SCREEN: &str = "menu:fullScreen";
pub const FLOAT_ON_TOP: &str = "menu:floatOnTop";
pub const GO_BACK: &str = "menu:goBack";
pub const DEVELOPER_TOOLS: &str = "menu:developerTools";
pub const PLAY_PAUSE: &str = "menu:playPause";
pub const SKIP_NEXT: &str = "menu:skipNext";
pub const SKIP_PREVIOUS: &str = "menu:skipPrevious";
pub const INCREASE_VOLUME: &str = "menu:increaseVolume";
pub const DECREASE_VOLUME: &str = "menu:decreaseVolume";
pub const STEP_FORWARD: &str = "menu:stepForward";
pub const STEP_BACKWARD: &str = "menu:stepBackward";
pub const INCREASE_SPEED: &str = "menu:increaseSpeed";
pub const DECREASE_SPEED: &str = "menu:decreaseSpeed";
pub const ADD_SUBTITLES: &str = "menu:addSubtitles";
pub const PAUSE_ALL: &str = "menu:pauseAll";
pub const RESUME_ALL: &str = "menu:resumeAll";
pub const REMOVE_ALL: &str = "menu:removeAll";
pub const REMOVE_ALL_DATA: &str = "menu:removeAllData";
pub const LEARN_MORE: &str = "menu:learnMore";
pub const RELEASE_NOTES: &str = "menu:releaseNotes";
pub const CONTRIBUTE: &str = "menu:contribute";
pub const REPORT_ISSUE: &str = "menu:reportIssue";
pub const FOLLOW_TWITTER: &str = "menu:followTwitter";

/// The items `menu.togglePlaybackControls(flag)` turns on and off:
/// everything in the Playback menu that acts on what is playing.
pub const PLAYBACK_ITEMS: &[&str] = &[
    PLAY_PAUSE,
    SKIP_NEXT,
    SKIP_PREVIOUS,
    INCREASE_VOLUME,
    DECREASE_VOLUME,
    STEP_FORWARD,
    STEP_BACKWARD,
    INCREASE_SPEED,
    DECREASE_SPEED,
    ADD_SUBTITLES,
];

/// The items `menu.setWindowFocus(flag)` turns on and off: the two
/// View items that act on the window itself.
pub const WINDOW_FOCUS_ITEMS: &[&str] = &[FULL_SCREEN, FLOAT_ON_TOP];

/// The platform whose menu is being described.
///
/// `src/main/menu.js` branches on `process.platform` in eight places.
/// Passing the platform in rather than reading it means all three
/// menus can be asserted from one `cargo test` run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Mac,
    Windows,
    Linux,
}

impl Platform {
    /// The platform this build runs on.
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Platform::Mac
        } else if cfg!(target_os = "windows") {
            Platform::Windows
        } else {
            Platform::Linux
        }
    }
}

/// The items `menu.setAllowNav(flag)` turns on and off.
///
/// "Disallow opening more screens on top of the current one": on macOS
/// Preferences lives in the app menu and there is one New Torrent
/// item, elsewhere Preferences is in Edit and there are two.
pub fn nav_items(platform: Platform) -> &'static [&'static str] {
    match platform {
        Platform::Mac => &[PREFERENCES, NEW_TORRENT],
        _ => &[PREFERENCES, NEW_TORRENT, NEW_TORRENT_FROM_FILE],
    }
}

/// A menu item Tauri already knows how to build, and the OS already
/// knows how to label and perform. Electron calls these roles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    About,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Quit,
    CloseWindow,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Minimize,
    Front,
}

/// One menu item, as data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Item {
    Separator,
    /// A role, optionally relabelled -- Electron's
    /// `{ label: 'Paste Torrent Address', role: 'paste' }`.
    Role {
        role: Role,
        label: Option<String>,
    },
    Normal {
        id: String,
        label: String,
        accelerator: Option<&'static str>,
        enabled: bool,
    },
    Check {
        id: String,
        label: String,
        accelerator: Option<&'static str>,
        enabled: bool,
        checked: bool,
    },
    Submenu {
        /// `HELP_SUBMENU_ID` or `WINDOW_SUBMENU_ID` where the platform
        /// adopts the submenu, which is Electron's `role: 'help'` and
        /// `role: 'window'`.
        id: Option<&'static str>,
        label: String,
        items: Vec<Item>,
    },
}

fn normal(id: &str, label: &str, accelerator: Option<&'static str>) -> Item {
    Item::Normal {
        id: id.to_string(),
        label: label.to_string(),
        accelerator,
        enabled: true,
    }
}

/// A Playback item: the same as [`normal`] but disabled until
/// something is playing, exactly as `enabled: false` does in
/// `src/main/menu.js`.
fn disabled(id: &str, label: &str, accelerator: Option<&'static str>) -> Item {
    Item::Normal {
        id: id.to_string(),
        label: label.to_string(),
        accelerator,
        enabled: false,
    }
}

fn check(id: &str, label: &str, accelerator: Option<&'static str>) -> Item {
    Item::Check {
        id: id.to_string(),
        label: label.to_string(),
        accelerator,
        enabled: true,
        checked: false,
    }
}

fn submenu(label: &str, items: Vec<Item>) -> Item {
    Item::Submenu {
        id: None,
        label: label.to_string(),
        items,
    }
}

fn role(role: Role) -> Item {
    Item::Role { role, label: None }
}

/// What clicking the item with this id does.
///
/// The counterpart of the `click` handlers in `src/main/menu.js`. A
/// menu event carries an id and nothing else, so this is where an id
/// becomes a thing to do; `None` is an item with no handler, which is
/// every role.
pub fn action(id: &str) -> Option<Action> {
    let dispatch = |name: &'static str| Some(Action::Dispatch(name, vec![]));
    let dispatch_with = |name: &'static str, arg: Value| Some(Action::Dispatch(name, vec![arg]));

    match id {
        NEW_TORRENT => Some(Action::OpenSeedDirectory),
        NEW_TORRENT_FROM_FILE => Some(Action::OpenSeedFile),
        OPEN_TORRENT_FILE => Some(Action::OpenTorrentFile),
        OPEN_TORRENT_ADDRESS => dispatch("openTorrentAddress"),
        QUIT => Some(Action::Quit),
        PREFERENCES => dispatch("preferences"),
        FULL_SCREEN => Some(Action::ToggleFullScreen),
        FLOAT_ON_TOP => Some(Action::ToggleAlwaysOnTop),
        GO_BACK => dispatch("escapeBack"),
        DEVELOPER_TOOLS => Some(Action::ToggleDevTools),
        PLAY_PAUSE => dispatch("playPause"),
        SKIP_NEXT => dispatch("nextTrack"),
        SKIP_PREVIOUS => dispatch("previousTrack"),
        INCREASE_VOLUME => dispatch_with("changeVolume", json!(0.1)),
        DECREASE_VOLUME => dispatch_with("changeVolume", json!(-0.1)),
        STEP_FORWARD => dispatch_with("skip", json!(10)),
        STEP_BACKWARD => dispatch_with("skip", json!(-10)),
        INCREASE_SPEED => dispatch_with("changePlaybackRate", json!(1)),
        DECREASE_SPEED => dispatch_with("changePlaybackRate", json!(-1)),
        ADD_SUBTITLES => dispatch("openSubtitles"),
        PAUSE_ALL => dispatch("pauseAllTorrents"),
        RESUME_ALL => dispatch("resumeAllTorrents"),
        REMOVE_ALL => dispatch_with("confirmDeleteAllTorrents", json!(false)),
        REMOVE_ALL_DATA => dispatch_with("confirmDeleteAllTorrents", json!(true)),
        LEARN_MORE => Some(Action::OpenExternal(HOME_PAGE_URL)),
        RELEASE_NOTES => Some(Action::OpenExternal(GITHUB_URL_RELEASES)),
        CONTRIBUTE => Some(Action::OpenExternal(GITHUB_URL)),
        REPORT_ISSUE => Some(Action::OpenExternal(GITHUB_URL_ISSUES)),
        FOLLOW_TWITTER => Some(Action::OpenExternal(TWITTER_PAGE_URL)),
        _ => None,
    }
}

/// What a click does, as data the caller in `main.rs` performs.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    /// `src/main/dialog.js`: pick something to seed, or a `.torrent`
    /// to add. Each ends in a dispatch of its own.
    OpenSeedFile,
    OpenSeedDirectory,
    OpenTorrentFile,
    /// `windows.main.dispatch(name, ...args)` -- the renderer's own
    /// action, reached through the `dispatch` event.
    Dispatch(&'static str, Vec<Value>),
    ToggleFullScreen,
    ToggleAlwaysOnTop,
    ToggleDevTools,
    /// `shell.openExternal(url)`.
    OpenExternal(&'static str),
    /// Linux only: `app.quit()` from File > Quit, for the desktops
    /// where the tray icon is missing.
    Quit,
}

/// The whole application menu for a platform, as descriptors.
///
/// Reads top to bottom in the order `getMenuTemplate` builds it: the
/// six shared submenus, then the macOS additions, then the Windows and
/// Linux ones.
pub fn template(platform: Platform) -> Vec<Item> {
    let mac = platform == Platform::Mac;
    let mut items = vec![
        submenu("File", file_menu(platform)),
        submenu("Edit", edit_menu(platform)),
        submenu("View", view_menu(platform)),
        submenu("Playback", playback_menu(platform)),
        submenu("Transfers", transfers_menu()),
        Item::Submenu {
            id: Some(HELP_SUBMENU_ID),
            label: "Help".to_string(),
            items: help_menu(platform),
        },
    ];

    if mac {
        items.insert(0, submenu(APP_NAME, app_menu()));
        // `template.splice(6, 0, ...)`: after Transfers, before Help.
        items.insert(
            6,
            Item::Submenu {
                id: Some(WINDOW_SUBMENU_ID),
                label: "Window".to_string(),
                items: vec![role(Role::Minimize), Item::Separator, role(Role::Front)],
            },
        );
    }

    items
}

/// The macOS application menu, which has no equivalent elsewhere.
fn app_menu() -> Vec<Item> {
    vec![
        role(Role::About),
        Item::Separator,
        normal(PREFERENCES, "Preferences", Some("Cmd+,")),
        Item::Separator,
        role(Role::Services),
        Item::Separator,
        role(Role::Hide),
        role(Role::HideOthers),
        role(Role::ShowAll),
        Item::Separator,
        role(Role::Quit),
    ]
}

fn file_menu(platform: Platform) -> Vec<Item> {
    let mut items = vec![];

    // "On Windows and Linux, open dialogs do not support selecting
    // both files and folders", so those platforms get one item for
    // each type and macOS gets one item for both.
    if platform != Platform::Mac {
        items.push(normal(
            NEW_TORRENT_FROM_FILE,
            "Create New Torrent from File...",
            None,
        ));
    }

    items.push(normal(
        NEW_TORRENT,
        if platform == Platform::Mac {
            "Create New Torrent..."
        } else {
            "Create New Torrent from Folder..."
        },
        Some("CmdOrCtrl+N"),
    ));
    items.push(normal(
        OPEN_TORRENT_FILE,
        "Open Torrent File...",
        Some("CmdOrCtrl+O"),
    ));
    items.push(normal(
        OPEN_TORRENT_ADDRESS,
        "Open Torrent Address...",
        Some("CmdOrCtrl+U"),
    ));
    items.push(Item::Separator);
    items.push(role(Role::CloseWindow));

    // "Add File > Quit so Linux distros where the system tray icon is
    // missing will have a way to quit the app."
    if platform == Platform::Linux {
        items.push(normal(QUIT, "Quit", None));
    }

    items
}

fn edit_menu(platform: Platform) -> Vec<Item> {
    let mut items = vec![
        role(Role::Undo),
        role(Role::Redo),
        Item::Separator,
        role(Role::Cut),
        role(Role::Copy),
        Item::Role {
            role: Role::Paste,
            label: Some("Paste Torrent Address".to_string()),
        },
        role(Role::SelectAll),
    ];

    // Electron's `delete` role sits between Paste and Select All. See
    // the module comment: there is no Tauri equivalent.

    if platform != Platform::Mac {
        items.push(Item::Separator);
        items.push(normal(PREFERENCES, "Preferences", Some("CmdOrCtrl+,")));
    }

    // The macOS Speech submenu is the module comment's other omission.

    items
}

fn view_menu(platform: Platform) -> Vec<Item> {
    vec![
        check(
            FULL_SCREEN,
            "Full Screen",
            Some(if platform == Platform::Mac {
                "Ctrl+Command+F"
            } else {
                "F11"
            }),
        ),
        check(FLOAT_ON_TOP, "Float on Top", None),
        Item::Separator,
        normal(GO_BACK, "Go Back", Some("Esc")),
        Item::Separator,
        submenu(
            "Developer",
            vec![normal(
                DEVELOPER_TOOLS,
                "Developer Tools",
                Some(if platform == Platform::Mac {
                    "Alt+Command+I"
                } else {
                    "Ctrl+Shift+I"
                }),
            )],
        ),
    ]
}

fn playback_menu(platform: Platform) -> Vec<Item> {
    let mac = platform == Platform::Mac;
    vec![
        disabled(PLAY_PAUSE, "Play/Pause", Some("Space")),
        Item::Separator,
        disabled(SKIP_NEXT, "Skip Next", Some("N")),
        disabled(SKIP_PREVIOUS, "Skip Previous", Some("P")),
        Item::Separator,
        disabled(INCREASE_VOLUME, "Increase Volume", Some("CmdOrCtrl+Up")),
        disabled(DECREASE_VOLUME, "Decrease Volume", Some("CmdOrCtrl+Down")),
        Item::Separator,
        disabled(
            STEP_FORWARD,
            "Step Forward",
            Some(if mac {
                "CmdOrCtrl+Alt+Right"
            } else {
                "Alt+Right"
            }),
        ),
        disabled(
            STEP_BACKWARD,
            "Step Backward",
            Some(if mac {
                "CmdOrCtrl+Alt+Left"
            } else {
                "Alt+Left"
            }),
        ),
        Item::Separator,
        disabled(INCREASE_SPEED, "Increase Speed", Some("CmdOrCtrl+=")),
        disabled(DECREASE_SPEED, "Decrease Speed", Some("CmdOrCtrl+-")),
        Item::Separator,
        disabled(ADD_SUBTITLES, "Add Subtitles File...", None),
    ]
}

fn transfers_menu() -> Vec<Item> {
    vec![
        normal(PAUSE_ALL, "Pause All", None),
        normal(RESUME_ALL, "Resume All", None),
        normal(REMOVE_ALL, "Remove All From List", None),
        normal(REMOVE_ALL_DATA, "Remove All Data Files", None),
    ]
}

fn help_menu(platform: Platform) -> Vec<Item> {
    let mut items = vec![
        normal(LEARN_MORE, &format!("Learn more about {APP_NAME}"), None),
        normal(RELEASE_NOTES, "Release Notes", None),
        normal(CONTRIBUTE, "Contribute on GitHub", None),
        Item::Separator,
        normal(REPORT_ISSUE, "Report an Issue...", None),
        normal(FOLLOW_TWITTER, "Follow us on Twitter", None),
    ];

    // Electron opens its own About window here (`windows.about`).
    // There is no second window under Tauri, and the About role shows
    // the same three things that window did -- name, version, licence
    // -- so the role stands in for it.
    if platform != Platform::Mac {
        items.push(Item::Separator);
        items.push(Item::Role {
            role: Role::About,
            label: Some(format!("About {APP_NAME}")),
        });
    }

    items
}

// -- the context menu the renderer describes -------------------------

/// One descriptor as `platform/menu.js` sends it (ADR-007).
///
/// The vocabulary is the shim's, unchanged: a type, a label and an
/// enabled flag. There is no `click` -- a function cannot cross, which
/// is the point -- so the host answers with the index of what was
/// chosen and the shim calls the callback it kept.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContextItem {
    #[serde(default = "normal_type")]
    pub r#type: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
}

fn normal_type() -> String {
    "normal".to_string()
}

/// The event the shim hears a context-menu choice on.
pub const CONTEXT_MENU_CLICK_EVENT: &str = "contextMenuClick";

/// The prefix that tells a context-menu id from an application-menu
/// one. The rest is the menu's serial number and the item's index,
/// which is what the shim needs to find the callback it kept.
const CONTEXT_PREFIX: &str = "ctx:";

/// The id of item `index` in context menu `menu`.
///
/// The menu's id is the shim's, not this host's: it is what makes
/// `ctx:7:2` mean "the third item of the seventh menu the renderer
/// opened" rather than "the third item of some menu", so a click
/// arriving after the shim has moved on is ignored there rather than
/// mistaken for a choice in the menu that is open now.
pub fn context_id(menu: u64, index: usize) -> String {
    format!("{CONTEXT_PREFIX}{menu}:{index}")
}

/// Read a context-menu id back, or `None` if it is not one.
pub fn context_choice(id: &str) -> Option<(u64, usize)> {
    let rest = id.strip_prefix(CONTEXT_PREFIX)?;
    let (menu, index) = rest.split_once(':')?;
    Some((menu.parse().ok()?, index.parse().ok()?))
}

/// Turn the renderer's descriptors into descriptors of our own.
///
/// The validation is the shim's, repeated: a non-separator item needs
/// a label, and an unknown type is an error rather than something
/// half-built. The shim rejects both before they get here, so this is
/// the boundary refusing to trust its input rather than a duplicate
/// check anyone relies on (`docs/platform-shim.md`).
pub fn context_template(menu: u64, items: &[ContextItem]) -> Result<Vec<Item>, String> {
    items
        .iter()
        .enumerate()
        .map(|(index, item)| match item.r#type.as_str() {
            "separator" => Ok(Item::Separator),
            "normal" => {
                let label = item
                    .label
                    .as_deref()
                    .ok_or_else(|| "menu: an item needs a label".to_string())?;
                Ok(Item::Normal {
                    id: context_id(menu, index),
                    label: label.to_string(),
                    accelerator: None,
                    enabled: item.enabled != Some(false),
                })
            }
            other => Err(format!("menu: unsupported item type '{other}'")),
        })
        .collect()
}

// -- building the thing ----------------------------------------------

/// The built menu's items, by id.
///
/// `src/main/menu.js` walks `menu.items` looking for a label whenever
/// it has to enable or check something. Tauri's `Menu::get` only
/// searches the top level, so the items are collected as they are
/// built and kept here instead. Held as managed state; every mutation
/// the renderer can cause goes through it.
pub struct AppMenu<R: Runtime> {
    items: HashMap<String, MenuItemKind<R>>,
}

impl<R: Runtime> AppMenu<R> {
    /// Enable or disable one item. A missing id is ignored, which is
    /// what `getMenuItem` returning `{}` does under Electron -- the
    /// nav items differ by platform and every caller names all of
    /// them.
    pub fn set_enabled(&self, id: &str, enabled: bool) {
        match self.items.get(id) {
            Some(MenuItemKind::MenuItem(item)) => {
                let _ = item.set_enabled(enabled);
            }
            Some(MenuItemKind::Check(item)) => {
                let _ = item.set_enabled(enabled);
            }
            _ => {}
        }
    }

    /// Enable or disable a group of items.
    pub fn set_group_enabled(&self, ids: &[&str], enabled: bool) {
        for id in ids {
            self.set_enabled(id, enabled);
        }
    }

    /// Tick or untick a checkbox item.
    pub fn set_checked(&self, id: &str, checked: bool) {
        if let Some(MenuItemKind::Check(item)) = self.items.get(id) {
            let _ = item.set_checked(checked);
        }
    }

    /// Whether a checkbox item is ticked. Tauri has no getter for
    /// "always on top", so the menu is where that state lives -- the
    /// same place Electron keeps it.
    pub fn is_checked(&self, id: &str) -> bool {
        match self.items.get(id) {
            Some(MenuItemKind::Check(item)) => item.is_checked().unwrap_or(false),
            _ => false,
        }
    }
}

/// Build the application menu for a platform, and the index of the
/// items that can change afterwards.
pub fn build<R: Runtime, M: Manager<R>>(
    manager: &M,
    platform: Platform,
) -> tauri::Result<(Menu<R>, AppMenu<R>)> {
    let mut items = HashMap::new();
    let kinds = build_items(manager, &template(platform), &mut items)?;
    let menu = Menu::with_items(manager, &borrowed(&kinds))?;

    Ok((menu, AppMenu { items }))
}

/// Build a context menu from descriptors. Nothing is indexed: a
/// context menu lives for one popup and its items are never changed.
pub fn build_context<R: Runtime, M: Manager<R>>(
    manager: &M,
    items: &[Item],
) -> tauri::Result<Menu<R>> {
    let mut indexed = HashMap::new();
    let kinds = build_items(manager, items, &mut indexed)?;
    Menu::with_items(manager, &borrowed(&kinds))
}

/// The context menu that is on screen.
///
/// A `Menu` dropped while the OS is showing it takes the menu with it,
/// so the one being shown is held here until the next one replaces it
/// -- there is never more than one context menu open.
pub struct ContextMenus<R: Runtime> {
    current: Mutex<Option<Menu<R>>>,
}

// Derived `Default` would demand `R: Default`, which no runtime is.
impl<R: Runtime> Default for ContextMenus<R> {
    fn default() -> Self {
        Self {
            current: Mutex::new(None),
        }
    }
}

impl<R: Runtime> ContextMenus<R> {
    /// Keep this menu alive until another one is shown.
    pub fn hold(&self, menu: Menu<R>) {
        if let Ok(mut current) = self.current.lock() {
            *current = Some(menu);
        }
    }
}

fn borrowed<R: Runtime>(kinds: &[MenuItemKind<R>]) -> Vec<&dyn IsMenuItem<R>> {
    kinds
        .iter()
        .map(|kind| kind as &dyn IsMenuItem<R>)
        .collect()
}

fn build_items<R: Runtime, M: Manager<R>>(
    manager: &M,
    items: &[Item],
    indexed: &mut HashMap<String, MenuItemKind<R>>,
) -> tauri::Result<Vec<MenuItemKind<R>>> {
    items
        .iter()
        .map(|item| build_item(manager, item, indexed))
        .collect()
}

fn build_item<R: Runtime, M: Manager<R>>(
    manager: &M,
    item: &Item,
    indexed: &mut HashMap<String, MenuItemKind<R>>,
) -> tauri::Result<MenuItemKind<R>> {
    let kind = match item {
        Item::Separator => MenuItemKind::Predefined(PredefinedMenuItem::separator(manager)?),
        Item::Role { role, label } => {
            MenuItemKind::Predefined(build_role(manager, *role, label.as_deref())?)
        }
        Item::Normal {
            id,
            label,
            accelerator,
            enabled,
        } => {
            let built = MenuItem::with_id(manager, id.as_str(), label, *enabled, *accelerator)?;
            indexed.insert(id.clone(), MenuItemKind::MenuItem(built.clone()));
            MenuItemKind::MenuItem(built)
        }
        Item::Check {
            id,
            label,
            accelerator,
            enabled,
            checked,
        } => {
            let built = CheckMenuItem::with_id(
                manager,
                id.as_str(),
                label,
                *enabled,
                *checked,
                *accelerator,
            )?;
            indexed.insert(id.clone(), MenuItemKind::Check(built.clone()));
            MenuItemKind::Check(built)
        }
        Item::Submenu { id, label, items } => {
            let children = build_items(manager, items, indexed)?;
            let built = match id {
                Some(id) => {
                    Submenu::with_id_and_items(manager, *id, label, true, &borrowed(&children))?
                }
                None => Submenu::with_items(manager, label, true, &borrowed(&children))?,
            };
            MenuItemKind::Submenu(built)
        }
    };

    Ok(kind)
}

fn build_role<R: Runtime, M: Manager<R>>(
    manager: &M,
    role: Role,
    label: Option<&str>,
) -> tauri::Result<PredefinedMenuItem<R>> {
    match role {
        Role::About => PredefinedMenuItem::about(manager, label, Some(about_metadata())),
        Role::Services => PredefinedMenuItem::services(manager, label),
        Role::Hide => PredefinedMenuItem::hide(manager, label),
        Role::HideOthers => PredefinedMenuItem::hide_others(manager, label),
        Role::ShowAll => PredefinedMenuItem::show_all(manager, label),
        Role::Quit => PredefinedMenuItem::quit(manager, label),
        Role::CloseWindow => PredefinedMenuItem::close_window(manager, label),
        Role::Undo => PredefinedMenuItem::undo(manager, label),
        Role::Redo => PredefinedMenuItem::redo(manager, label),
        Role::Cut => PredefinedMenuItem::cut(manager, label),
        Role::Copy => PredefinedMenuItem::copy(manager, label),
        Role::Paste => PredefinedMenuItem::paste(manager, label),
        Role::SelectAll => PredefinedMenuItem::select_all(manager, label),
        Role::Minimize => PredefinedMenuItem::minimize(manager, label),
        Role::Front => PredefinedMenuItem::bring_all_to_front(manager, label),
    }
}

/// What the About panel says. Electron's `about` role reads the same
/// three values out of the app bundle.
fn about_metadata() -> AboutMetadata<'static> {
    AboutMetadata {
        name: Some(APP_NAME.to_string()),
        version: Some(env!("CARGO_PKG_VERSION").to_string()),
        website: Some(HOME_PAGE_URL.to_string()),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use muda::accelerator::Accelerator;
    use std::collections::HashSet;
    use std::str::FromStr;

    const PLATFORMS: [Platform; 3] = [Platform::Mac, Platform::Windows, Platform::Linux];

    /// Every item in the tree, depth first.
    fn flatten(items: &[Item]) -> Vec<&Item> {
        let mut out = vec![];
        for item in items {
            out.push(item);
            if let Item::Submenu { items, .. } = item {
                out.extend(flatten(items));
            }
        }
        out
    }

    fn ids(items: &[Item]) -> Vec<&str> {
        flatten(items)
            .into_iter()
            .filter_map(|item| match item {
                Item::Normal { id, .. } | Item::Check { id, .. } => Some(id.as_str()),
                _ => None,
            })
            .collect()
    }

    fn labels(items: &[Item]) -> Vec<String> {
        items
            .iter()
            .filter_map(|item| match item {
                Item::Submenu { label, .. } => Some(label.clone()),
                _ => None,
            })
            .collect()
    }

    fn find<'a>(items: &'a [Item], wanted: &str) -> Option<&'a Item> {
        flatten(items).into_iter().find(|item| match item {
            Item::Normal { id, .. } | Item::Check { id, .. } => id == wanted,
            _ => false,
        })
    }

    /// The top-level menus, in the order `getMenuTemplate` leaves them
    /// in. macOS gets the app menu in front and Window between
    /// Transfers and Help.
    #[test]
    fn the_menu_bar_matches_the_electron_template() {
        assert_eq!(
            labels(&template(Platform::Mac)),
            vec![
                APP_NAME,
                "File",
                "Edit",
                "View",
                "Playback",
                "Transfers",
                "Window",
                "Help"
            ]
        );

        for platform in [Platform::Windows, Platform::Linux] {
            assert_eq!(
                labels(&template(platform)),
                vec!["File", "Edit", "View", "Playback", "Transfers", "Help"],
                "{platform:?}"
            );
        }
    }

    /// A menu event carries an id and nothing else, so an item whose
    /// id has no action is a dead item.
    #[test]
    fn every_item_has_an_action() {
        for platform in PLATFORMS {
            for id in ids(&template(platform)) {
                assert!(action(id).is_some(), "{id} does nothing on {platform:?}");
            }
        }
    }

    /// Two items sharing an id would make one of them unreachable and
    /// the other impossible to enable on its own.
    #[test]
    fn ids_are_unique_within_a_platform() {
        for platform in PLATFORMS {
            let items = template(platform);
            let found = ids(&items);
            let unique: HashSet<_> = found.iter().collect();
            assert_eq!(found.len(), unique.len(), "{platform:?}: {found:?}");
        }
    }

    /// `MenuItem::with_id` parses the accelerator and **drops it if it
    /// does not parse** -- no error, no item without a shortcut that
    /// anyone would notice until they pressed the key. So every one of
    /// them is parsed here, by the same parser.
    #[test]
    fn every_accelerator_parses() {
        for platform in PLATFORMS {
            for item in flatten(&template(platform)) {
                let accelerator = match item {
                    Item::Normal { accelerator, .. } | Item::Check { accelerator, .. } => {
                        *accelerator
                    }
                    _ => None,
                };
                if let Some(accelerator) = accelerator {
                    assert!(
                        Accelerator::from_str(accelerator).is_ok(),
                        "{accelerator} on {platform:?}"
                    );
                }
            }
        }
    }

    /// The Playback items start disabled and are turned on by
    /// `togglePlaybackControls(true)` when a player opens, which is
    /// `enabled: false` on all ten in `src/main/menu.js`.
    #[test]
    fn the_playback_items_are_present_and_start_disabled() {
        for platform in PLATFORMS {
            let items = template(platform);
            for id in PLAYBACK_ITEMS {
                match find(&items, id) {
                    Some(Item::Normal { enabled, .. }) => {
                        assert!(!enabled, "{id} starts enabled on {platform:?}");
                    }
                    _ => panic!("{id} is missing on {platform:?}"),
                }
            }
        }
    }

    /// `setAllowNav` names the items that open another screen. macOS
    /// has one New Torrent item; the others have two.
    #[test]
    fn the_nav_items_exist_on_every_platform() {
        for platform in PLATFORMS {
            let items = template(platform);
            for id in nav_items(platform) {
                assert!(find(&items, id).is_some(), "{id} missing on {platform:?}");
            }
        }

        assert!(!nav_items(Platform::Mac).contains(&NEW_TORRENT_FROM_FILE));
        assert!(nav_items(Platform::Windows).contains(&NEW_TORRENT_FROM_FILE));
    }

    /// The two View items `setWindowFocus` toggles are checkboxes:
    /// Electron ticks them from `onToggleFullScreen` and
    /// `onToggleAlwaysOnTop`, and so does this host.
    #[test]
    fn the_window_items_are_checkboxes() {
        for platform in PLATFORMS {
            let items = template(platform);
            for id in WINDOW_FOCUS_ITEMS {
                assert!(
                    matches!(find(&items, id), Some(Item::Check { .. })),
                    "{id} is not a checkbox on {platform:?}"
                );
            }
        }
    }

    /// Preferences is in the app menu on macOS and in Edit elsewhere,
    /// and File > Quit is Linux only.
    #[test]
    fn the_platform_branches_land_where_electron_puts_them() {
        let mac = template(Platform::Mac);
        assert!(find(&mac, QUIT).is_none(), "no File > Quit on macOS");
        assert!(find(&template(Platform::Windows), QUIT).is_none());
        assert!(find(&template(Platform::Linux), QUIT).is_some());

        // On macOS Preferences is the third item of the first menu.
        match &mac[0] {
            Item::Submenu { items, .. } => match &items[2] {
                Item::Normal {
                    id, accelerator, ..
                } => {
                    assert_eq!(id, PREFERENCES);
                    assert_eq!(*accelerator, Some("Cmd+,"));
                }
                other => panic!("{other:?}"),
            },
            other => panic!("{other:?}"),
        }

        // Elsewhere it is the last item of Edit.
        match &template(Platform::Windows)[1] {
            Item::Submenu { items, .. } => match items.last() {
                Some(Item::Normal {
                    id, accelerator, ..
                }) => {
                    assert_eq!(id, PREFERENCES);
                    assert_eq!(*accelerator, Some("CmdOrCtrl+,"));
                }
                other => panic!("{other:?}"),
            },
            other => panic!("{other:?}"),
        }
    }

    /// The dispatches carry the arguments the Electron handlers pass.
    #[test]
    fn the_dispatch_actions_carry_their_arguments() {
        assert_eq!(
            action(INCREASE_VOLUME),
            Some(Action::Dispatch("changeVolume", vec![json!(0.1)]))
        );
        assert_eq!(
            action(DECREASE_VOLUME),
            Some(Action::Dispatch("changeVolume", vec![json!(-0.1)]))
        );
        assert_eq!(
            action(STEP_BACKWARD),
            Some(Action::Dispatch("skip", vec![json!(-10)]))
        );
        assert_eq!(
            action(REMOVE_ALL_DATA),
            Some(Action::Dispatch(
                "confirmDeleteAllTorrents",
                vec![json!(true)]
            ))
        );
        assert_eq!(
            action(PLAY_PAUSE),
            Some(Action::Dispatch("playPause", vec![]))
        );
    }

    /// The Help links are the URLs in `src/config.js`.
    #[test]
    fn the_help_items_open_the_configured_urls() {
        assert_eq!(
            action(LEARN_MORE),
            Some(Action::OpenExternal(HOME_PAGE_URL))
        );
        assert_eq!(
            action(RELEASE_NOTES),
            Some(Action::OpenExternal(GITHUB_URL_RELEASES))
        );
        assert_eq!(action(CONTRIBUTE), Some(Action::OpenExternal(GITHUB_URL)));
        assert_eq!(
            action(REPORT_ISSUE),
            Some(Action::OpenExternal(GITHUB_URL_ISSUES))
        );
        assert_eq!(
            action(FOLLOW_TWITTER),
            Some(Action::OpenExternal(TWITTER_PAGE_URL))
        );
    }

    /// A context-menu id round-trips, and an application-menu id is
    /// not mistaken for one.
    #[test]
    fn context_ids_round_trip() {
        assert_eq!(context_choice(&context_id(7, 3)), Some((7, 3)));
        assert_eq!(context_choice(PLAY_PAUSE), None);
        assert_eq!(context_choice("ctx:nope"), None);
        assert_eq!(context_choice("ctx:1:x"), None);
    }

    /// The descriptors the renderer sends, translated: labels and the
    /// enabled flag survive, a separator stays one, and the two things
    /// the shim rejects are rejected here too.
    #[test]
    fn context_descriptors_become_items() {
        let items = vec![
            ContextItem {
                r#type: "normal".to_string(),
                label: Some("Remove From List".to_string()),
                enabled: None,
            },
            ContextItem {
                r#type: "separator".to_string(),
                label: None,
                enabled: None,
            },
            ContextItem {
                r#type: "normal".to_string(),
                label: Some("Save Torrent File As...".to_string()),
                enabled: Some(false),
            },
        ];

        let built = context_template(1, &items).expect("rejected a valid menu");
        assert_eq!(built.len(), 3);
        match &built[0] {
            Item::Normal {
                id, label, enabled, ..
            } => {
                assert_eq!(id, &context_id(1, 0));
                assert_eq!(label, "Remove From List");
                assert!(enabled, "omitted enabled means enabled");
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(built[1], Item::Separator);
        match &built[2] {
            Item::Normal { id, enabled, .. } => {
                assert_eq!(id, &context_id(1, 2));
                assert!(!enabled);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn context_descriptors_are_validated() {
        let unlabelled = vec![ContextItem {
            r#type: "normal".to_string(),
            label: None,
            enabled: None,
        }];
        let err = context_template(1, &unlabelled).expect_err("accepted no label");
        assert!(err.contains("label"), "{err}");

        let unknown = vec![ContextItem {
            r#type: "checkbox".to_string(),
            label: Some("Nope".to_string()),
            enabled: None,
        }];
        let err = context_template(1, &unknown).expect_err("accepted a checkbox");
        assert!(err.contains("checkbox"), "{err}");
    }
}
