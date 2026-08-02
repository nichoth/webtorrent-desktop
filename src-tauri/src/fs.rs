//! Files, and the directories the renderer is allowed to reach them in.
//!
//! This is the Rust half of `platform/fs.js`. Under Electron the shim
//! is `fs/promises` in the renderer and every path the UI can name is a
//! path it can read; under Tauri the nine operations are host commands
//! (`main.rs`), for the reason the window, dialog and shell commands
//! are -- an app command needs no capability, so
//! `capabilities/default.json` stays at `core:default`.
//!
//! The alternative was the `fs` plugin, whose JS API would put
//! `fs:allow-read-file` and its siblings on the whole webview, scoped
//! by a glob list written into a JSON capability file. That list cannot
//! say "the config directory, wherever it is on this platform", and it
//! cannot say "the folder the user picked in the preferences pane a
//! moment ago". Both are known here, so the allowlist is [`Allowlist`]
//! and it is built from resolved paths and extended at runtime.
//!
//! What it grants, and why each is needed:
//!
//! | Root | Access | Needed by |
//! | --- | --- | --- |
//! | `configPath` | write | `lib/state.js` (`config.json`), `Torrents/`, `Posters/` |
//! | `tempPath` | write | torrent data for a streamed torrent, which `torrent-list-controller.js` stats and deletes |
//! | `defaultDownloadPath` | write | where torrents land before the user changes it |
//! | `prefs.downloadPath` | write | where they land after -- read from the saved state, because a restart does not re-pick it |
//! | `torrents[].path` | write | a torrent saved under a download folder the user has since changed |
//! | the resource directory | read | the five default torrents and posters `lib/state.js` copies into a fresh profile |
//!
//! Plus, at runtime, whatever the user picks in a host dialog: a file
//! for reading (a `.torrent`, a subtitle), a folder for writing (the
//! download folder). That is the same arrangement the `fs` plugin has
//! with the dialog plugin, done from the host rather than the webview.
//!
//! **Not covered, and owned by US-065:** a file dropped onto the
//! window. Under Electron the renderer reads `file.path` off the drop
//! event; a Tauri webview has no such property, so dropped paths have
//! to arrive from the host, and whichever story delivers them is the
//! one that should [`Allowlist::grant`] them.

use std::path::{Component, Path, PathBuf};
use std::sync::RwLock;

use serde::{Deserialize, Serialize};

use crate::paths::AppPaths;

/// What a command wants to do with a path. Read access is not write
/// access: the app's own shipped files are read on a fresh profile and
/// should never be written, and nothing else distinguishes them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Read,
    Write,
}

/// One directory -- or one file -- the shim may use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Root {
    /// Stored as [`real_path`] produces it, which is the same form
    /// every path is checked in.
    pub path: PathBuf,
    pub writable: bool,
}

impl Root {
    pub fn read_only(path: impl AsRef<Path>) -> Root {
        Root {
            path: real_path(path.as_ref()),
            writable: false,
        }
    }

    pub fn writable(path: impl AsRef<Path>) -> Root {
        Root {
            path: real_path(path.as_ref()),
            writable: true,
        }
    }
}

/// The directories the renderer may reach, as the host knows them.
///
/// Managed by Tauri and shared by every `fs_*` command. The lock is a
/// plain `RwLock` because grants are rare (a dialog the user just
/// dismissed) and checks are not.
#[derive(Debug)]
pub struct Allowlist {
    roots: RwLock<Vec<Root>>,
}

impl Allowlist {
    pub fn new(roots: Vec<Root>) -> Allowlist {
        Allowlist {
            roots: RwLock::new(roots),
        }
    }

    /// Add a root the user just chose. Called after a host dialog
    /// resolves, which is the only way a path outside the app's own
    /// directories becomes reachable.
    pub fn grant(&self, root: Root) {
        let mut roots = self.write();
        if !roots.contains(&root) {
            roots.push(root);
        }
    }

    /// The path a command should operate on, or the reason it may not.
    ///
    /// The returned path is the resolved one -- symlinks in its
    /// existing ancestors already followed -- so a command must use it
    /// rather than the string it was given, or the check and the
    /// operation would be looking at two different files.
    pub fn resolve(&self, path: &str, access: Access) -> Result<PathBuf, String> {
        let requested = Path::new(path);
        if !requested.is_absolute() {
            return Err(format!("{path} is not an absolute path"));
        }

        let resolved = real_path(requested);
        if permits(&self.read(), &resolved, access) {
            Ok(resolved)
        } else {
            Err(refusal(path, access))
        }
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, Vec<Root>> {
        self.roots.read().unwrap_or_else(|err| err.into_inner())
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, Vec<Root>> {
        self.roots.write().unwrap_or_else(|err| err.into_inner())
    }
}

/// Whether `path` -- already resolved -- falls under a root that
/// grants `access`.
///
/// `Path::starts_with` compares whole components, so a root of
/// `/tmp/WebTorrent` does not admit `/tmp/WebTorrent-elsewhere`.
pub fn permits(roots: &[Root], path: &Path, access: Access) -> bool {
    roots
        .iter()
        .any(|root| (access == Access::Read || root.writable) && path.starts_with(&root.path))
}

/// Why a path was refused, in terms the renderer can show a user.
///
/// The promise rejects with this and `reportErrors` in
/// `src/renderer/main.js` picks it up -- so it names the path, and says
/// which of the two answers it is. "Nothing happened" is what the
/// alternative looks like from the UI.
pub fn refusal(path: &str, access: Access) -> String {
    match access {
        Access::Read => format!("{path} is outside the directories WebTorrent Desktop may read"),
        Access::Write => format!("{path} is outside the directories WebTorrent Desktop may write"),
    }
}

/// A path with `.` and `..` taken out **textually**, before anything
/// touches the disk.
///
/// This has to happen first. Resolving the deepest existing ancestor of
/// `/granted/missing/../../etc/passwd` would leave the `..` components
/// in the unresolved tail, and the result would still start with
/// `/granted` -- an escape that passes the check.
pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();

    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }

    out
}

/// A path as the filesystem sees it: [`normalize`]d, then with its
/// deepest existing ancestor canonicalized and the rest put back.
///
/// Canonicalizing the whole path is not an option -- most of these
/// paths are files about to be created, and `canonicalize` fails on a
/// path that is not there. Canonicalizing the part that does exist is
/// what closes the symlink escape: a link inside the config directory
/// pointing at `/etc` resolves to `/etc` here and is refused, rather
/// than being admitted on the strength of where the link file sits.
pub fn real_path(path: &Path) -> PathBuf {
    let normalized = normalize(path);
    let mut tail = Vec::new();
    let mut cursor = normalized.as_path();

    loop {
        if let Ok(real) = cursor.canonicalize() {
            let mut resolved = real;
            resolved.extend(tail.iter().rev());
            return resolved;
        }

        match (cursor.parent(), cursor.file_name()) {
            (Some(parent), Some(name)) => {
                tail.push(name.to_os_string());
                cursor = parent;
            }
            // Nothing along the path exists -- a first run on a profile
            // whose whole directory tree is still to be created. The
            // textual form is the best answer available, and it is a
            // sound one: there are no symlinks to follow.
            _ => return normalized,
        }
    }
}

/// The roots the app has before the user picks anything.
///
/// `saved_state` is the contents of `config.json`, or `""` when there
/// is none. It is read rather than trusted blindly: the paths in it
/// were themselves chosen by the user through a dialog in an earlier
/// session, and a restart is not a reason to lose them.
pub fn startup_roots(paths: &AppPaths, resources: Option<PathBuf>, saved_state: &str) -> Vec<Root> {
    let mut roots = vec![
        Root::writable(&paths.config_path),
        Root::writable(&paths.temp_path),
    ];

    // Empty when the platform could not name a downloads directory,
    // which is `''` in `src/config.js` too. An empty root would be a
    // relative path and would match nothing, but leaving it out says
    // so rather than relying on that.
    if !paths.default_download_path.as_os_str().is_empty() {
        roots.push(Root::writable(&paths.default_download_path));
    }

    // The app's own files: the five default torrents and their posters,
    // which `lib/state.js` copies into a fresh profile. Read-only,
    // because nothing should ever write into an installed application.
    if let Some(resources) = resources {
        roots.push(Root::read_only(resources));
    }

    for path in saved_roots(saved_state) {
        roots.push(Root::writable(path));
    }

    roots
}

/// The download folders recorded in a `config.json` document: the
/// current preference, and the folder each saved torrent was put in.
///
/// Tolerant in exactly the way [`crate::window::saved_bounds`] is. A
/// missing or corrupt file is a fresh profile as far as this is
/// concerned, and the renderer is about to rewrite it.
pub fn saved_roots(document: &str) -> Vec<PathBuf> {
    let saved: SavedPaths = match serde_json::from_str(document) {
        Ok(saved) => saved,
        Err(_) => return Vec::new(),
    };

    let download_path = saved.prefs.and_then(|prefs| prefs.download_path);
    let torrents = saved
        .torrents
        .unwrap_or_default()
        .into_iter()
        .filter_map(|torrent| torrent.path);

    download_path
        .into_iter()
        .chain(torrents)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .collect()
}

/// The keys of `config.json` this module needs. Everything else in the
/// document, including the `bounds` `window.rs` reads, is ignored.
#[derive(Deserialize)]
struct SavedPaths {
    prefs: Option<SavedPrefs>,
    torrents: Option<Vec<SavedTorrent>>,
}

#[derive(Deserialize)]
struct SavedPrefs {
    #[serde(rename = "downloadPath")]
    download_path: Option<String>,
}

#[derive(Deserialize)]
struct SavedTorrent {
    /// The directory a torrent's files live in, which is what
    /// `TorrentSummary.getFileOrFolder` joins a file name onto.
    path: Option<String>,
}

/// What `stat` resolves to: a plain object, not a host handle, so
/// `stat.isDirectory()` under Electron is `stat.isDirectory` here
/// (ADR-007, and `docs/platform-shim.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStats {
    pub size: u64,
    pub is_directory: bool,
    pub is_file: bool,
}

impl From<std::fs::Metadata> for FileStats {
    fn from(metadata: std::fs::Metadata) -> FileStats {
        FileStats {
            size: metadata.len(),
            is_directory: metadata.is_dir(),
            is_file: metadata.is_file(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::{Env, Platform};

    fn allowed(roots: Vec<Root>) -> Allowlist {
        Allowlist::new(roots)
    }

    /// A directory inside the OS temp dir, named after the test so two
    /// tests never collide, created and returned resolved.
    fn temp_dir(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("wt-fs-test-{name}"));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("could not make a test directory");
        path.canonicalize().expect("could not resolve it")
    }

    #[test]
    fn a_path_inside_a_root_is_allowed() {
        let list = allowed(vec![Root::writable("/granted")]);

        assert_eq!(
            list.resolve("/granted/Torrents/a.torrent", Access::Read),
            Ok(PathBuf::from("/granted/Torrents/a.torrent"))
        );
        assert_eq!(
            list.resolve("/granted/Torrents/a.torrent", Access::Write),
            Ok(PathBuf::from("/granted/Torrents/a.torrent"))
        );
    }

    #[test]
    fn a_path_outside_every_root_is_refused() {
        let list = allowed(vec![Root::writable("/granted")]);

        assert_eq!(
            list.resolve("/etc/passwd", Access::Read),
            Err("/etc/passwd is outside the directories WebTorrent Desktop may read".into())
        );
        assert_eq!(
            list.resolve("/etc/passwd", Access::Write),
            Err("/etc/passwd is outside the directories WebTorrent Desktop may write".into())
        );
    }

    /// The whole point of the read/write split: an installed
    /// application's own files are copied out of and never into.
    #[test]
    fn a_read_only_root_refuses_writes_and_allows_reads() {
        let list = allowed(vec![Root::read_only("/app/resources")]);

        assert!(list
            .resolve("/app/resources/bigBuckBunny.torrent", Access::Read)
            .is_ok());
        assert_eq!(
            list.resolve("/app/resources/bigBuckBunny.torrent", Access::Write),
            Err(
                "/app/resources/bigBuckBunny.torrent is outside the directories \
                 WebTorrent Desktop may write"
                    .into()
            )
        );
    }

    /// `starts_with` on a string would admit this one.
    #[test]
    fn a_sibling_sharing_a_name_prefix_is_not_inside() {
        let list = allowed(vec![Root::writable("/granted")]);

        assert!(list.resolve("/granted-elsewhere/a", Access::Read).is_err());
    }

    #[test]
    fn a_relative_path_is_refused_by_name() {
        let list = allowed(vec![Root::writable("/granted")]);

        assert_eq!(
            list.resolve("granted/a.torrent", Access::Read),
            Err("granted/a.torrent is not an absolute path".into())
        );
    }

    #[test]
    fn normalize_takes_out_dot_and_dotdot() {
        assert_eq!(
            normalize(Path::new("/granted/./Torrents/../Posters/a.jpg")),
            Path::new("/granted/Posters/a.jpg")
        );
    }

    /// The escape a purely lexical check on the *unresolved* path would
    /// miss, and the one resolving the ancestor first would miss too.
    #[test]
    fn dotdot_cannot_climb_out_of_a_root() {
        let list = allowed(vec![Root::writable("/granted")]);

        for escape in [
            "/granted/../etc/passwd",
            "/granted/Torrents/../../etc/passwd",
            "/granted/missing/../../etc/passwd",
        ] {
            assert_eq!(
                list.resolve(escape, Access::Read),
                Err(refusal(escape, Access::Read)),
                "{escape} climbed out"
            );
        }
    }

    /// The escape a lexical check alone would miss: a link inside a
    /// granted directory pointing at one that is not.
    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_a_root_is_refused() {
        let granted = temp_dir("symlink-granted");
        let elsewhere = temp_dir("symlink-elsewhere");
        std::fs::write(elsewhere.join("secret"), b"x").unwrap();

        let link = granted.join("way-out");
        std::os::unix::fs::symlink(&elsewhere, &link).unwrap();

        let list = allowed(vec![Root::writable(&granted)]);
        let through_the_link = link.join("secret");
        let asked = through_the_link.to_str().unwrap();

        assert_eq!(
            list.resolve(asked, Access::Read),
            Err(refusal(asked, Access::Read)),
            "the link resolves outside the root"
        );

        // And the directory it is in is still reachable, so the refusal
        // is the link's doing rather than the root having gone missing.
        assert!(list
            .resolve(granted.join("a").to_str().unwrap(), Access::Read)
            .is_ok());

        std::fs::remove_dir_all(&granted).unwrap();
        std::fs::remove_dir_all(&elsewhere).unwrap();
    }

    /// A path under a root that does not exist yet -- a first run,
    /// before `mkdir` has made the config directory.
    #[test]
    fn a_root_that_is_not_there_yet_still_admits_its_children() {
        let missing = std::env::temp_dir().join("wt-fs-test-never-created");
        let _ = std::fs::remove_dir_all(&missing);
        let list = allowed(vec![Root::writable(&missing)]);

        assert!(list
            .resolve(
                missing.join("Posters").join("a.jpg").to_str().unwrap(),
                Access::Write
            )
            .is_ok());
    }

    #[test]
    fn a_granted_path_becomes_reachable() {
        let list = allowed(vec![]);
        assert!(list.resolve("/picked/movie.srt", Access::Read).is_err());

        list.grant(Root::read_only("/picked"));

        assert!(list.resolve("/picked/movie.srt", Access::Read).is_ok());
        assert!(
            list.resolve("/picked/movie.srt", Access::Write).is_err(),
            "a file chosen for reading is not a file chosen for writing"
        );
    }

    #[test]
    fn granting_the_same_root_twice_adds_it_once() {
        let list = allowed(vec![]);
        list.grant(Root::writable("/picked"));
        list.grant(Root::writable("/picked"));

        assert_eq!(list.read().len(), 1);
    }

    fn app_paths() -> AppPaths {
        AppPaths::resolve(&Env {
            platform: Platform::Linux,
            home: Some(PathBuf::from("/home/tester")),
            xdg_config_home: Some(PathBuf::from("/xdg")),
            local_app_data: None,
            user_profile: None,
            system_temp: PathBuf::from("/system/temp"),
            downloads: Some(PathBuf::from("/home/tester/Downloads")),
            exe_dir: PathBuf::from("/apps/WebTorrent"),
            is_test: false,
            is_production: true,
            portable_settings_present: false,
        })
    }

    #[test]
    fn the_startup_roots_are_the_apps_own_directories() {
        let roots = startup_roots(&app_paths(), Some(PathBuf::from("/apps/resources")), "");

        assert_eq!(
            roots,
            vec![
                Root::writable("/xdg/WebTorrent"),
                Root::writable("/system/temp"),
                Root::writable("/home/tester/Downloads"),
                Root::read_only("/apps/resources"),
            ]
        );
    }

    /// `src/config.js` yields `''` for the downloads directory when the
    /// platform cannot name one, and a root that is the empty path
    /// would be a relative path matching nothing.
    #[test]
    fn an_unknown_downloads_directory_is_not_a_root() {
        let mut paths = app_paths();
        paths.default_download_path = PathBuf::new();

        let roots = startup_roots(&paths, None, "");

        assert_eq!(roots.len(), 2, "the config and temp directories only");
    }

    #[test]
    fn the_saved_download_folders_are_roots_too() {
        let document = r#"{
            "prefs": { "downloadPath": "/media/torrents" },
            "torrents": [
                { "path": "/media/old-torrents" },
                { "name": "no path here" }
            ],
            "bounds": { "width": 640 }
        }"#;

        assert_eq!(
            saved_roots(document),
            vec![
                PathBuf::from("/media/torrents"),
                PathBuf::from("/media/old-torrents")
            ]
        );

        let roots = startup_roots(&app_paths(), None, document);
        assert!(roots.contains(&Root::writable("/media/torrents")));
        assert!(roots.contains(&Root::writable("/media/old-torrents")));
    }

    #[test]
    fn a_missing_or_corrupt_saved_state_yields_no_roots() {
        assert!(saved_roots("").is_empty());
        assert!(saved_roots("{ not json").is_empty());
        assert!(saved_roots("{}").is_empty());
        assert!(saved_roots(r#"{"prefs":{}}"#).is_empty());
        assert!(saved_roots(r#"{"prefs":{"downloadPath":""}}"#).is_empty());
    }

    /// The shape `docs/platform-shim.md` promises: three plain values,
    /// camelCased, and `isDirectory` a boolean rather than a method.
    #[test]
    fn stats_serialize_as_the_shim_documents() {
        let dir = temp_dir("stats");
        std::fs::write(dir.join("a.torrent"), b"12345").unwrap();

        let file = FileStats::from(std::fs::metadata(dir.join("a.torrent")).unwrap());
        assert_eq!(
            serde_json::to_value(file).unwrap(),
            serde_json::json!({ "size": 5, "isDirectory": false, "isFile": true })
        );

        let folder = FileStats::from(std::fs::metadata(&dir).unwrap());
        assert!(folder.is_directory);
        assert!(!folder.is_file);

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
