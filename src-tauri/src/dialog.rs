//! Native file dialogs: what the renderer asked for, translated.
//!
//! This is the Rust half of `platform/dialog.js`. Under Electron that
//! shim calls `dialog.showOpenDialogSync` / `showSaveDialogSync`
//! through `@electron/remote`, which is a main-process dialog parented
//! to the current window; under Tauri it is a host command for the
//! same reason (see the window commands in `main.rs`), which also
//! keeps `capabilities/default.json` at `core:default` -- the renderer
//! never reaches the dialog plugin itself.
//!
//! The renderer sends Electron's options object unchanged, so the
//! translating happens here. As in [`crate::window`], the decisions
//! are pure functions of plain values -- [`plan_open`], [`plan_save`]
//! and [`plain_path`] -- and `main.rs` is the only part that opens a
//! dialog.
//!
//! Two options have no equivalent in the dialog plugin and are
//! dropped, both recorded in `docs/platform-shim.md`:
//!
//! - **`buttonLabel`.** `FileDialogBuilder` cannot relabel the accept
//!   button, so the save dialog says "Save" (the platform default)
//!   rather than the caller's label. Every caller today passes
//!   exactly that.
//! - **`openFile` *and* `openDirectory` together.** rfd picks files or
//!   directories, never both, so a request for both opens a directory
//!   picker. This is what Electron itself does on Windows and Linux --
//!   `src/main/dialog.js` has the same fallback written out by hand --
//!   so the behaviour is only new on macOS.

use std::path::PathBuf;

use serde::Deserialize;
use tauri_plugin_dialog::FilePath;

/// The extension that means "everything" in an Electron filter. rfd
/// has no such spelling: it would become a filter offering files
/// ending in `.*`, which matches nothing.
const ALL_FILES: &str = "*";

/// Electron's `OpenDialogOptions` / `SaveDialogOptions`, as the shim
/// forwards them. Every field is optional because the shim forwards
/// what the caller passed and nothing else -- a missing key is a
/// caller that did not care, not a malformed request.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DialogOptions {
    pub title: Option<String>,
    pub default_path: Option<String>,
    #[serde(default)]
    pub filters: Vec<Filter>,
    /// Electron's `properties`, which decide *what* is being picked.
    /// Kept as strings rather than an enum: the list is open-ended
    /// (`showHiddenFiles`, `createDirectory` and friends) and an
    /// unrecognised entry has to be ignored, not fail the dialog.
    #[serde(default)]
    pub properties: Vec<String>,
}

/// One entry of Electron's `filters`: a name and extensions with no
/// leading dot, which is also what `add_filter` wants.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Filter {
    pub name: String,
    pub extensions: Vec<String>,
}

/// Which of the plugin's four pickers an open request means.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Picker {
    File,
    Files,
    Folder,
    Folders,
}

/// Everything `main.rs` has to put on a `FileDialogBuilder`, with the
/// Electron spellings already resolved.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DialogPlan {
    pub title: Option<String>,
    pub directory: Option<PathBuf>,
    pub file_name: Option<String>,
    pub filters: Vec<Filter>,
}

/// An open request: the plan, plus which picker to show it in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenPlan {
    pub picker: Picker,
    pub dialog: DialogPlan,
}

/// Translate an open request.
///
/// `defaultPath` is where the dialog starts, and every caller of the
/// open dialog passes a directory (`path.dirname(...)` in
/// `components/path-selector.js`), so it is taken as one.
pub fn plan_open(options: &DialogOptions) -> OpenPlan {
    OpenPlan {
        picker: picker(&options.properties),
        dialog: DialogPlan {
            title: options.title.clone(),
            directory: options.default_path.as_ref().map(PathBuf::from),
            file_name: None,
            filters: usable_filters(&options.filters),
        },
    }
}

/// Translate a save request.
///
/// Here `defaultPath` is a full path -- the download directory plus a
/// suggested filename -- and the two halves go to different setters.
pub fn plan_save(options: &DialogOptions) -> DialogPlan {
    let (directory, file_name) = match options.default_path.as_deref() {
        Some(path) => split_default_path(path),
        None => (None, None),
    };

    DialogPlan {
        title: options.title.clone(),
        directory,
        file_name,
        filters: usable_filters(&options.filters),
    }
}

/// Which picker Electron's `properties` describe. `openFile` is
/// Electron's own default, so an empty list is a file picker.
fn picker(properties: &[String]) -> Picker {
    let many = properties.iter().any(|p| p == "multiSelections");

    // `openDirectory` wins over `openFile` when both are asked for;
    // see the module comment.
    if properties.iter().any(|p| p == "openDirectory") {
        if many {
            Picker::Folders
        } else {
            Picker::Folder
        }
    } else if many {
        Picker::Files
    } else {
        Picker::File
    }
}

/// Split a save dialog's `defaultPath` into the directory to open in
/// and the filename to suggest. A bare filename has no directory, and
/// a path ending in a separator has no filename.
fn split_default_path(path: &str) -> (Option<PathBuf>, Option<String>) {
    let path = PathBuf::from(path);
    let directory = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(PathBuf::from);
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned());

    (directory, file_name)
}

/// Drop what rfd cannot express: the `*` extension, and any filter
/// left with nothing to match once it is gone. A filter list that
/// ends up empty is no filter list, which is the same thing as
/// offering every file.
fn usable_filters(filters: &[Filter]) -> Vec<Filter> {
    filters
        .iter()
        .filter_map(|filter| {
            let extensions: Vec<String> = filter
                .extensions
                .iter()
                .filter(|extension| *extension != ALL_FILES)
                .cloned()
                .collect();

            if extensions.is_empty() {
                None
            } else {
                Some(Filter {
                    name: filter.name.clone(),
                    extensions,
                })
            }
        })
        .collect()
}

/// A picked path as the renderer has to see it: a plain string, never
/// a host object (ADR-007).
///
/// The desktop pickers always answer with a real path, so the `Url`
/// variant and a non-UTF-8 path are both reported rather than guessed
/// at -- the shim's promise rejects and `reportErrors` in
/// `src/renderer/main.js` picks the message up.
pub fn plain_path(picked: FilePath) -> Result<String, String> {
    picked
        .into_path()
        .map_err(|err| err.to_string())?
        .into_os_string()
        .into_string()
        .map_err(|path| format!("dialog returned a non-UTF-8 path: {:?}", path))
}

/// [`plain_path`] over a multi-selection.
pub fn plain_paths(picked: Vec<FilePath>) -> Result<Vec<String>, String> {
    picked.into_iter().map(plain_path).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(json: &str) -> DialogOptions {
        serde_json::from_str(json).expect("options are not valid")
    }

    /// `controllers/subtitles-controller.js`.
    #[test]
    fn an_open_file_request_picks_one_file() {
        let plan = plan_open(&options(
            r#"{
                "title": "Select a subtitles file.",
                "filters": [{ "name": "Subtitles",
                              "extensions": ["vtt", "srt"] }],
                "properties": ["openFile"]
            }"#,
        ));

        assert_eq!(plan.picker, Picker::File);
        assert_eq!(
            plan.dialog.title.as_deref(),
            Some("Select a subtitles file.")
        );
        assert_eq!(
            plan.dialog.filters,
            vec![Filter {
                name: "Subtitles".into(),
                extensions: vec!["vtt".into(), "srt".into()],
            }]
        );
        assert_eq!(
            plan.dialog.file_name, None,
            "an open dialog suggests no name"
        );
    }

    /// The download-directory and watched-folder preferences.
    #[test]
    fn an_open_directory_request_picks_one_folder() {
        let plan = plan_open(&options(
            r#"{ "title": "Select download directory",
                 "defaultPath": "/Users/me/Downloads",
                 "properties": ["openDirectory"] }"#,
        ));

        assert_eq!(plan.picker, Picker::Folder);
        assert_eq!(
            plan.dialog.directory,
            Some(PathBuf::from("/Users/me/Downloads")),
            "an open dialog's defaultPath is the directory to start in"
        );
    }

    #[test]
    fn multi_selections_picks_many() {
        assert_eq!(
            plan_open(&options(
                r#"{ "properties": ["openFile", "multiSelections"] }"#
            ))
            .picker,
            Picker::Files
        );
        assert_eq!(
            plan_open(&options(
                r#"{ "properties": ["openDirectory", "multiSelections"] }"#
            ))
            .picker,
            Picker::Folders
        );
    }

    /// Electron's own default, and `path-selector.js`'s fallback for a
    /// caller that passes no `dialog` prop.
    #[test]
    fn no_properties_picks_one_file() {
        assert_eq!(plan_open(&options("{}")).picker, Picker::File);
    }

    /// The macOS-only "a file *or* a folder" request. See the module
    /// comment: the folder picker is the documented fallback, and the
    /// same one Electron takes off macOS.
    #[test]
    fn a_request_for_both_picks_a_folder() {
        assert_eq!(
            plan_open(&options(
                r#"{ "properties": ["openFile", "openDirectory"] }"#
            ))
            .picker,
            Picker::Folder
        );
    }

    #[test]
    fn an_unrecognised_property_is_ignored() {
        assert_eq!(
            plan_open(&options(
                r#"{ "properties": ["openFile", "showHiddenFiles"] }"#
            ))
            .picker,
            Picker::File,
            "an option with no equivalent does not change the picker"
        );
    }

    /// `controllers/torrent-list-controller.js`'s save-as, verbatim.
    #[test]
    fn a_save_request_splits_the_default_path() {
        let plan = plan_save(&options(
            r#"{
                "title": "Save Torrent File",
                "defaultPath": "/Users/me/Downloads/Sintel.torrent",
                "filters": [
                    { "name": "Torrent Files", "extensions": ["torrent"] },
                    { "name": "All Files", "extensions": ["*"] }
                ],
                "buttonLabel": "Save"
            }"#,
        ));

        assert_eq!(plan.title.as_deref(), Some("Save Torrent File"));
        assert_eq!(plan.directory, Some(PathBuf::from("/Users/me/Downloads")));
        assert_eq!(plan.file_name.as_deref(), Some("Sintel.torrent"));
        assert_eq!(
            plan.filters,
            vec![Filter {
                name: "Torrent Files".into(),
                extensions: vec!["torrent".into()],
            }],
            "the `*` filter is dropped rather than offered as an extension"
        );
    }

    #[test]
    fn a_bare_filename_suggests_a_name_and_no_directory() {
        let plan = plan_save(&options(r#"{ "defaultPath": "Sintel.torrent" }"#));

        assert_eq!(plan.directory, None);
        assert_eq!(plan.file_name.as_deref(), Some("Sintel.torrent"));
    }

    #[test]
    fn a_save_request_with_no_default_path_suggests_nothing() {
        let plan = plan_save(&options(r#"{ "title": "Save As" }"#));

        assert_eq!(plan.directory, None);
        assert_eq!(plan.file_name, None);
    }

    /// The one option the plugin cannot honour has to be *ignored*,
    /// not rejected: a failed deserialize would fail the whole call.
    #[test]
    fn an_unsupported_option_does_not_fail_the_request() {
        let plan = plan_save(&options(
            r#"{ "buttonLabel": "Save", "properties": ["createDirectory"] }"#,
        ));

        assert_eq!(plan.title, None);
    }

    #[test]
    fn a_filter_keeps_its_real_extensions_alongside_a_wildcard() {
        let plan = plan_open(&options(
            r#"{ "filters": [{ "name": "Torrents",
                               "extensions": ["torrent", "*"] }] }"#,
        ));

        assert_eq!(
            plan.dialog.filters,
            vec![Filter {
                name: "Torrents".into(),
                extensions: vec!["torrent".into()],
            }]
        );
    }

    #[test]
    fn a_picked_path_crosses_as_a_string() {
        let picked = FilePath::Path(PathBuf::from("/tmp/a.torrent"));

        assert_eq!(plain_path(picked).unwrap(), "/tmp/a.torrent");
    }

    #[test]
    fn a_multi_selection_crosses_as_strings() {
        let picked = vec![
            FilePath::Path(PathBuf::from("/tmp/a.torrent")),
            FilePath::Path(PathBuf::from("/tmp/b.torrent")),
        ];

        assert_eq!(
            plain_paths(picked).unwrap(),
            vec!["/tmp/a.torrent".to_string(), "/tmp/b.torrent".to_string()]
        );
    }

    /// A `content://`-style answer is a mobile one and cannot be a
    /// path. Reporting it is the only honest thing the host can do --
    /// the renderer hands these straight to `fs`.
    #[test]
    fn a_path_that_is_not_a_path_is_reported() {
        let picked = FilePath::Url("content://media/1".parse().unwrap());

        assert!(plain_path(picked).is_err());
    }
}
