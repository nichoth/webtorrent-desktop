//! The folder watcher: `src/main/folder-watcher.js`.
//!
//! Electron watches `${torrentsFolderPath}/**/*.torrent` with chokidar
//! and dispatches `addTorrent` at the renderer for every file that
//! appears. Two of chokidar's options carry the behaviour, and both are
//! reproduced below: `ignoreInitial`, so that the torrents already in
//! the folder are not re-added on every launch, and `awaitWriteFinish`,
//! so that a file still being written is not handed to the engine
//! half-downloaded.
//!
//! No crate does that here. `notify` 8 is the current line and its
//! `notify-types` needs rustc 1.85, above ADR-014's 1.77.2; `notify` 6
//! is within it but is a superseded major line, and either way
//! `awaitWriteFinish` is a size-stability poll that has to be written
//! on top. What is left once that is written is a directory walk, so
//! this module is `std` alone: no dependency to review, no MSRV to pin,
//! and -- because the part that decides anything is a pure function of
//! two directory listings -- a core that `cargo test` can drive
//! without touching a disk or a clock.
//!
//! [`Watch`] is that core. [`FolderWatcher`] is the managed state the
//! two commands in `main.rs` reach: it owns the polling thread, and
//! starting it twice replaces the first, exactly as `start()` does in
//! the Electron original.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

use serde::Deserialize;

/// How often the watched folder is re-read.
///
/// chokidar's `awaitWriteFinish` polls a growing file every 100ms; a
/// whole-folder scan is more expensive than one `stat`, so this is
/// slower. The cost of the difference is up to half a second before a
/// dropped torrent is noticed, against a folder walk twice a second
/// for as long as the preference is on.
pub const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// How many further polls a new file's size has to stay put before it
/// counts as finished being written.
///
/// Four at [`POLL_INTERVAL`] is the 2000ms `stabilityThreshold`
/// chokidar defaults to under `awaitWriteFinish: true`.
pub const STABLE_POLLS: u32 = 4;

/// One scan of the watched folder: every `.torrent` file under it,
/// with the size it had when it was read.
pub type Listing = BTreeMap<PathBuf, u64>;

/// The preferences the watcher reads out of the renderer's
/// `config.json`.
///
/// The renderer never sends them: `ipcOs.startFolderWatcher()` takes no
/// arguments, because in Electron the main process has its own view of
/// the saved state (`src/main/saved-state.js`) and reads them there.
/// The difference here is that the file is read again on every start
/// rather than once at launch, so choosing a different folder and
/// toggling the preference takes effect without a restart.
#[derive(Debug, Default, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    pub auto_add_torrents: bool,
    pub torrents_folder_path: Option<String>,
}

impl Prefs {
    /// The folder to watch, if there is one.
    ///
    /// `start()` in the Electron original bails on a falsy
    /// `torrentsFolderPath`, which an unset preference and a cleared
    /// one both are -- so a missing key and an empty string are the
    /// same answer here.
    pub fn folder(&self) -> Option<PathBuf> {
        self.torrents_folder_path
            .as_deref()
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
    }
}

#[derive(Deserialize)]
struct SavedState {
    #[serde(default)]
    prefs: Prefs,
}

/// Read the watcher's preferences out of the saved state document
/// [`crate::window::read_saved_state`] returns.
///
/// As tolerant as its neighbour there: a missing, unreadable or corrupt
/// profile is not an error, it is a watcher that has nothing to watch.
pub fn saved_prefs(document: &str) -> Prefs {
    serde_json::from_str::<SavedState>(document)
        .map(|state| state.prefs)
        .unwrap_or_default()
}

/// Read every `.torrent` file under `root`, recursively.
///
/// The glob it stands in for is `${torrentsFolderPath}/**/*.torrent`,
/// which is case-sensitive and matches the extension literally, so this
/// is too. A folder that cannot be read contributes nothing rather than
/// failing the scan: the user can point the preference anywhere,
/// including at a folder that is removed while it is being watched.
///
/// Symbolic links are not followed. `read_dir` reports one as neither a
/// file nor a directory, and leaving it that way is what stops a link
/// pointing back up the tree from walking forever.
pub fn scan(root: &Path) -> Listing {
    let mut listing = Listing::new();
    collect(root, &mut listing);
    listing
}

fn collect(dir: &Path, listing: &mut Listing) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };

        if kind.is_dir() {
            collect(&entry.path(), listing);
        } else if kind.is_file() && is_torrent(&entry.path()) {
            if let Ok(meta) = entry.metadata() {
                listing.insert(entry.path(), meta.len());
            }
        }
    }
}

fn is_torrent(path: &Path) -> bool {
    path.extension().is_some_and(|ext| ext == "torrent")
}

/// What one file has looked like since it was first seen.
#[derive(Debug)]
struct Pending {
    size: u64,
    unchanged: u32,
}

/// The decision half of the watcher: which files in this scan are new,
/// and which of those have finished being written.
///
/// Pure, and driven a scan at a time, so the whole of chokidar's
/// `ignoreInitial` and `awaitWriteFinish` behaviour is testable without
/// a thread, a timer or a disk.
#[derive(Debug)]
pub struct Watch {
    /// Reported already, or there before watching began.
    known: HashSet<PathBuf>,
    /// Seen, but not yet reported: still being written, as far as this
    /// can tell.
    pending: HashMap<PathBuf, Pending>,
    stable_polls: u32,
}

impl Watch {
    /// Begin from a scan of the folder, ignoring everything in it.
    ///
    /// chokidar's `ignoreInitial: true`. Without it, every torrent the
    /// user has ever dropped in the folder would be re-added each time
    /// the preference was switched on.
    pub fn started(initial: &Listing, stable_polls: u32) -> Watch {
        Watch {
            known: initial.keys().cloned().collect(),
            pending: HashMap::new(),
            stable_polls,
        }
    }

    /// Take the next scan and return the files to dispatch `addTorrent`
    /// for.
    ///
    /// A file is reported once its size has been the same for
    /// `stable_polls` further scans -- a torrent copied in over a slow
    /// link is reported when the copy lands, not when it starts. A file
    /// that disappears is forgotten, so that putting one back reports
    /// it again, which is the `add` chokidar would emit for it.
    pub fn poll(&mut self, listing: &Listing) -> Vec<PathBuf> {
        self.known.retain(|path| listing.contains_key(path));
        self.pending.retain(|path, _| listing.contains_key(path));

        let mut added = Vec::new();
        for (path, &size) in listing {
            if self.known.contains(path) {
                continue;
            }

            let first_sighting = !self.pending.contains_key(path);
            let seen = self
                .pending
                .entry(path.clone())
                .or_insert(Pending { size, unchanged: 0 });

            if !first_sighting {
                if seen.size == size {
                    seen.unchanged += 1;
                } else {
                    seen.size = size;
                    seen.unchanged = 0;
                }
            }

            if seen.unchanged >= self.stable_polls {
                added.push(path.clone());
            }
        }

        for path in &added {
            self.pending.remove(path);
            self.known.insert(path.clone());
        }
        added
    }
}

/// A sleep that can be cut short.
///
/// The thread spends nearly all of its life waiting for the next poll,
/// and `stopFolderWatcher` has to be immediate -- unchecking the
/// preference and dropping a torrent in the folder a moment later must
/// not still add it. A plain `thread::sleep` would leave up to a whole
/// [`POLL_INTERVAL`] in which it would.
#[derive(Default)]
struct Stopper {
    stopped: Mutex<bool>,
    wake: Condvar,
}

impl Stopper {
    fn stop(&self) {
        let mut stopped = self.stopped.lock().unwrap_or_else(|err| err.into_inner());
        *stopped = true;
        self.wake.notify_all();
    }

    /// Wait for `how_long`, returning false if the watcher was stopped
    /// -- either during the wait or before it began.
    fn sleep(&self, how_long: Duration) -> bool {
        let stopped = self.stopped.lock().unwrap_or_else(|err| err.into_inner());
        if *stopped {
            return false;
        }

        let (stopped, _) = self
            .wake
            .wait_timeout(stopped, how_long)
            .unwrap_or_else(|err| err.into_inner());
        !*stopped
    }
}

/// The running watcher, held as Tauri managed state.
///
/// The Electron original is one object per app with `start()` and
/// `stop()` on it, kept in `ipc.setModule('folderWatcher', ...)`; this
/// is the same object reached the same way, from the two commands in
/// `main.rs`.
/// Which folder it is watching is deliberately not readable back: the
/// only thing that distinguishes one watch from another is which files
/// the callback is called with, and a getter would be a second answer
/// to that question with nothing keeping it honest.
#[derive(Default)]
pub struct FolderWatcher {
    running: Mutex<Option<Arc<Stopper>>>,
}

impl FolderWatcher {
    /// Watch `root`, calling `on_add` with every `.torrent` file that
    /// appears in it.
    ///
    /// Starting an already-running watcher stops it first, which is how
    /// `start()` handles a folder that has changed since last time.
    ///
    /// The scan that decides what is "already there" is taken here
    /// rather than on the new thread: what the preference was switched
    /// on over is what was in the folder at that moment, and a torrent
    /// dropped in a millisecond later is an addition. Leaving it to the
    /// thread would make which of the two it is a scheduling accident.
    pub fn start<F>(&self, root: PathBuf, interval: Duration, stable_polls: u32, on_add: F)
    where
        F: Fn(&Path) + Send + 'static,
    {
        self.stop();

        let stop = Arc::new(Stopper::default());
        let signal = Arc::clone(&stop);
        let folder = root;
        let mut watch = Watch::started(&scan(&folder), stable_polls);
        thread::spawn(move || {
            while signal.sleep(interval) {
                for path in watch.poll(&scan(&folder)) {
                    on_add(&path);
                }
            }
        });

        let mut running = self.running.lock().unwrap_or_else(|err| err.into_inner());
        *running = Some(stop);
    }

    /// Stop watching. Doing so twice, or without having started, is a
    /// no-op -- the same `if (!this.watching) return`.
    pub fn stop(&self) {
        let mut running = self.running.lock().unwrap_or_else(|err| err.into_inner());
        if let Some(stop) = running.take() {
            stop.stop();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn listing(files: &[(&str, u64)]) -> Listing {
        files
            .iter()
            .map(|(path, size)| (PathBuf::from(path), *size))
            .collect()
    }

    /// A test directory of its own, emptied first so that a previous
    /// run cannot make this one pass.
    fn temp_dir(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("wt-watcher-test-{name}"));
        std::fs::remove_dir_all(&path).ok();
        std::fs::create_dir_all(&path).expect("could not make a test directory");
        path
    }

    #[test]
    fn the_prefs_are_read_out_of_the_saved_state() {
        let prefs = saved_prefs(
            r#"{"prefs":{"autoAddTorrents":true,
                         "torrentsFolderPath":"/Users/me/Torrents"},
                "bounds":{"width":640}}"#,
        );

        assert!(prefs.auto_add_torrents);
        assert_eq!(prefs.folder(), Some(PathBuf::from("/Users/me/Torrents")));
    }

    #[test]
    fn a_profile_with_nothing_to_say_is_not_an_error() {
        for document in ["", "{}", r#"{"prefs":{}}"#, "not json at all"] {
            let prefs = saved_prefs(document);
            assert_eq!(prefs, Prefs::default(), "{document:?}");
            assert_eq!(prefs.folder(), None, "{document:?}");
        }
    }

    /// `start()` bails on a falsy `torrentsFolderPath`, and a cleared
    /// preference is an empty string rather than a missing key.
    #[test]
    fn an_empty_folder_preference_is_no_folder() {
        let prefs = saved_prefs(
            r#"{"prefs":{"autoAddTorrents":true,
                                             "torrentsFolderPath":""}}"#,
        );

        assert!(prefs.auto_add_torrents);
        assert_eq!(prefs.folder(), None);
    }

    /// `ignoreInitial: true`: what is already there is not an addition.
    #[test]
    fn the_torrents_already_in_the_folder_are_not_reported() {
        let initial = listing(&[("/f/a.torrent", 10), ("/f/b.torrent", 20)]);
        let mut watch = Watch::started(&initial, 0);

        assert!(watch.poll(&initial).is_empty());
    }

    #[test]
    fn a_new_torrent_is_reported_once_its_size_settles() {
        let mut watch = Watch::started(&listing(&[]), 2);

        assert!(
            watch.poll(&listing(&[("/f/new.torrent", 100)])).is_empty(),
            "the first sighting only starts the clock"
        );
        assert!(
            watch.poll(&listing(&[("/f/new.torrent", 400)])).is_empty(),
            "still growing"
        );
        assert!(
            watch.poll(&listing(&[("/f/new.torrent", 400)])).is_empty(),
            "settled for one poll, which is not yet two"
        );

        let added = watch.poll(&listing(&[("/f/new.torrent", 400)]));
        assert_eq!(added, vec![PathBuf::from("/f/new.torrent")]);

        assert!(
            watch.poll(&listing(&[("/f/new.torrent", 400)])).is_empty(),
            "and it is not reported again afterwards"
        );
    }

    #[test]
    fn a_file_that_goes_away_and_comes_back_is_reported_again() {
        let mut watch = Watch::started(&listing(&[]), 0);
        let there = listing(&[("/f/x.torrent", 1)]);

        assert_eq!(watch.poll(&there), vec![PathBuf::from("/f/x.torrent")]);
        assert!(watch.poll(&listing(&[])).is_empty(), "deleted");
        assert_eq!(
            watch.poll(&there),
            vec![PathBuf::from("/f/x.torrent")],
            "putting it back is another add"
        );
    }

    /// A file removed while it was still growing leaves nothing behind
    /// that a same-named file later could be measured against.
    #[test]
    fn a_half_written_file_that_disappears_is_forgotten() {
        let mut watch = Watch::started(&listing(&[]), 1);

        assert!(watch.poll(&listing(&[("/f/x.torrent", 50)])).is_empty());
        assert!(watch.poll(&listing(&[])).is_empty());
        assert!(
            watch.poll(&listing(&[("/f/x.torrent", 50)])).is_empty(),
            "the second file starts its own wait rather than inheriting one"
        );
        assert_eq!(watch.poll(&listing(&[("/f/x.torrent", 50)])).len(), 1);
    }

    #[test]
    fn only_torrent_files_anywhere_under_the_folder_are_scanned() {
        let dir = temp_dir("scan");
        let nested = dir.join("nested").join("deeper");
        std::fs::create_dir_all(&nested).expect("could not make a subfolder");

        std::fs::write(dir.join("one.torrent"), "aa").expect("write failed");
        std::fs::write(dir.join("notes.txt"), "ignored").expect("write failed");
        std::fs::write(dir.join("no-extension"), "ignored").expect("write failed");
        std::fs::write(nested.join("two.torrent"), "bbbb").expect("write failed");

        let found = scan(&dir);
        assert_eq!(
            found.keys().cloned().collect::<Vec<_>>(),
            vec![nested.join("two.torrent"), dir.join("one.torrent")],
            "the glob is `**/*.torrent`, so the walk is recursive"
        );
        assert_eq!(found[&dir.join("one.torrent")], 2, "the size is read too");
        assert_eq!(found[&nested.join("two.torrent")], 4);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_folder_that_is_not_there_scans_to_nothing() {
        let missing = std::env::temp_dir().join("wt-watcher-test-never-created");
        assert!(scan(&missing).is_empty());
    }

    /// The end of the module: a real folder, the real thread, and the
    /// callback the host turns into `dispatch('addTorrent', path)`.
    #[test]
    fn the_running_watcher_reports_a_dropped_torrent() {
        let dir = temp_dir("running");
        std::fs::write(dir.join("old.torrent"), "already here").expect("write failed");

        let (sender, added) = mpsc::channel();
        let watcher = FolderWatcher::default();
        watcher.start(dir.clone(), Duration::from_millis(20), 1, move |path| {
            sender.send(path.to_path_buf()).ok();
        });
        std::fs::write(dir.join("new.torrent"), "dropped in").expect("write failed");
        let first = added
            .recv_timeout(Duration::from_secs(5))
            .expect("the new torrent was never reported");
        assert_eq!(first, dir.join("new.torrent"));

        watcher.stop();

        // Nothing that lands afterwards is reported: the preference is
        // off, and the thread is gone rather than merely ignored.
        std::fs::write(dir.join("later.torrent"), "too late").expect("write failed");
        assert!(added.recv_timeout(Duration::from_millis(300)).is_err());

        std::fs::remove_dir_all(&dir).ok();
    }

    /// `start()` stops the previous watch before beginning a new one,
    /// so that changing the folder does not leave two threads running.
    #[test]
    fn starting_again_replaces_the_previous_folder() {
        let first = temp_dir("replaced-first");
        let second = temp_dir("replaced-second");

        let (sender, added) = mpsc::channel();
        let watcher = FolderWatcher::default();
        let to_first = sender.clone();
        watcher.start(first.clone(), Duration::from_millis(20), 1, move |path| {
            to_first.send(path.to_path_buf()).ok();
        });
        watcher.start(second.clone(), Duration::from_millis(20), 1, move |path| {
            sender.send(path.to_path_buf()).ok();
        });
        std::fs::write(first.join("a.torrent"), "in the old folder").expect("write failed");
        std::fs::write(second.join("b.torrent"), "in the new one").expect("write failed");

        let reported = added
            .recv_timeout(Duration::from_secs(5))
            .expect("the new folder was never scanned");
        assert_eq!(reported, second.join("b.torrent"));
        assert!(
            added.recv_timeout(Duration::from_millis(300)).is_err(),
            "the abandoned folder is no longer watched"
        );

        watcher.stop();
        std::fs::remove_dir_all(&first).ok();
        std::fs::remove_dir_all(&second).ok();
    }

    #[test]
    fn stopping_an_idle_watcher_is_harmless() {
        let watcher = FolderWatcher::default();
        watcher.stop();
        watcher.stop();
    }
}
