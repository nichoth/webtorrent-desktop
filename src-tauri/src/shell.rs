//! Handing paths and URLs to the OS.
//!
//! This is the Rust half of `platform/shell.js`. Under Electron
//! `openExternal` is a renderer-side `shell.openExternal` and the other
//! three are relayed to the main process, where `src/main/shell.js`
//! answers them; under Tauri all four are host commands, for the reason
//! the window and dialog commands are (see `main.rs`) -- and with the
//! same consequence, that `capabilities/default.json` stays at
//! `core:default`. The opener plugin is reached from Rust, never from
//! the webview.
//!
//! `main.rs` holds the commands, as it does for every other concern.
//! What lives here is the one decision that is not a plugin call: what
//! `moveItemToTrash` should do about a path that is not there.
//!
//! The trash itself is the `trash` crate rather than anything in Tauri.
//! Tauri 2 has no equivalent of Electron's `shell.trashItem`, and the
//! acceptance criterion is that the file reaches the OS trash and can
//! be recovered from it -- so unlinking is not an option, and neither
//! is the opener plugin.

use std::fs;

/// What [`plan_trash`] decided.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrashPlan {
    /// The path is not there, so there is nothing to trash. Electron's
    /// `moveItemToTrash` is `ipcRenderer.send`, which resolves whatever
    /// the OS made of it, and `../shell.js` documents that a path
    /// already gone resolves rather than failing. The trash crate would
    /// report it as an error, so the decision is made before the call.
    AlreadyGone,
    /// The path is there; move it to the OS trash.
    Trash,
}

/// Whether there is anything at `path` to trash.
///
/// `symlink_metadata` rather than `Path::exists`, which follows
/// symlinks: a link whose target is gone is still a directory entry the
/// user asked to be rid of, and the trash crate can take it.
pub fn plan_trash(path: &str) -> TrashPlan {
    if fs::symlink_metadata(path).is_ok() {
        TrashPlan::Trash
    } else {
        TrashPlan::AlreadyGone
    }
}

/// Move `path` to the OS trash, or do nothing if it is already gone.
///
/// The error crosses to the renderer as its own message, the way every
/// other command's does: `trash::Error` is not `Serialize`.
pub fn to_trash(path: &str) -> Result<(), String> {
    match plan_trash(path) {
        TrashPlan::AlreadyGone => Ok(()),
        TrashPlan::Trash => trash::delete(path).map_err(|err| err.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::{plan_trash, to_trash, TrashPlan};
    use std::fs;

    /// A path inside the OS temp directory, named after the test so
    /// that two tests never collide. Every test sweeps up its own file,
    /// except the one that really trashes it -- see there for why.
    fn temp_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("wt-shell-test-{name}"))
    }

    #[test]
    fn a_missing_path_is_already_gone() {
        let path = temp_path("missing");
        let _ = fs::remove_file(&path);

        assert_eq!(
            plan_trash(path.to_str().unwrap()),
            TrashPlan::AlreadyGone,
            "nothing to trash"
        );
    }

    #[test]
    fn an_existing_file_is_trashed() {
        let path = temp_path("present");
        fs::write(&path, b"x").unwrap();

        assert_eq!(plan_trash(path.to_str().unwrap()), TrashPlan::Trash);
        fs::remove_file(&path).unwrap();
    }

    #[test]
    fn an_existing_directory_is_trashed() {
        let path = temp_path("dir");
        fs::create_dir_all(&path).unwrap();

        assert_eq!(plan_trash(path.to_str().unwrap()), TrashPlan::Trash);
        fs::remove_dir(&path).unwrap();
    }

    /// The contract `../shell.js` documents: a path already gone
    /// resolves, so the whole operation succeeds without reaching the
    /// trash at all.
    #[test]
    fn trashing_a_missing_path_succeeds() {
        let path = temp_path("gone");
        let _ = fs::remove_file(&path);

        assert!(to_trash(path.to_str().unwrap()).is_ok());
    }

    /// The whole operation against a real file, so that `trash::delete`
    /// itself is exercised rather than only the decision in front of
    /// it: a host that cannot trash at all -- a missing entitlement, a
    /// crate that does not work on this platform -- fails here.
    ///
    /// What this deliberately does *not* assert is the destination,
    /// even though "the file reaches the OS trash rather than being
    /// unlinked" is the story's criterion and nothing about the path
    /// being gone can tell those two apart. There is no sound way to
    /// look: the crate's `os_limited::list` is `#[cfg]`-gated to
    /// Windows and Linux, and on macOS the trash directory has to be
    /// named by hand -- but `~/.Trash` is TCC-protected, so reading it
    /// fails with `PermissionDenied` unless the terminal happens to
    /// have been granted Full Disk Access. Asserting on it would be a
    /// gate that passes or fails according to a setting outside the
    /// repository. The destination is instead established two other
    /// ways: `trash::delete` reaches `NSFileManager`'s
    /// `trashItemAtURL` (`trash-5.2.3/src/macos/mod.rs`), and a human
    /// opens the Trash in US-073's verification pass.
    ///
    /// The trashed file is therefore left in the Trash. It is named so
    /// that it is obvious where it came from, and the Trash is the one
    /// directory where an unswept file is what the user expects.
    #[test]
    fn a_real_file_goes_to_the_trash() {
        let path = temp_path("trashed-for-real");
        fs::write(&path, b"recover me").unwrap();

        assert_eq!(
            to_trash(path.to_str().unwrap()),
            Ok(()),
            "the host trashed it"
        );
        assert!(!path.exists(), "no longer where the user had it");
    }
}
