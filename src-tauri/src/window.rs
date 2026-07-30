//! The main window: where it opens, and what it tells the renderer.
//!
//! This is the Rust half of `src/main/windows/main.js` -- the part
//! that runs before the UI exists. Electron builds the window from
//! `WINDOW_INITIAL_BOUNDS` merged with the bounds the last session
//! saved, keeps it hidden until it is ready, and then pushes every
//! later move or resize back to the renderer on the
//! `windowBoundsChanged` channel so the renderer can save them again.
//! All three are host concerns, so all three land here.
//!
//! As in [`crate::paths`], the decisions are pure functions of plain
//! values: [`WindowLayout::resolve`] reads a [`SavedBounds`] rather
//! than a file, and [`logical_bounds`] converts a physical rectangle
//! rather than reading a window. What touches the world is the thin
//! layer in `main.rs`.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// `WINDOW_INITIAL_BOUNDS.width` in `src/config.js`.
pub const INITIAL_WIDTH: f64 = 500.0;

/// `WINDOW_INITIAL_BOUNDS.height`: the header plus six torrent rows.
pub const INITIAL_HEIGHT: f64 = 638.0;

/// `WINDOW_MIN_WIDTH` in `src/config.js`.
pub const MIN_WIDTH: f64 = 425.0;

/// `WINDOW_MIN_HEIGHT`: the header plus two torrent rows.
pub const MIN_HEIGHT: f64 = 238.0;

/// The shim event `onWindowBoundsChanged` subscribes to. It is the
/// Electron channel name unchanged, because the renderer is the same
/// renderer (ADR-014) and the shim is where a host difference would
/// have to be absorbed -- not in the payload it carries.
pub const BOUNDS_CHANGED_EVENT: &str = "windowBoundsChanged";

/// How long a window has to stop moving before the renderer hears
/// about it. `src/main/windows/main.js` debounces both the `move` and
/// the `resize` handler by this much; a drag emits hundreds of events
/// and each one would otherwise be a state write.
pub const BOUNDS_DEBOUNCE: Duration = Duration::from_millis(1000);

/// The file the renderer saves its state to, inside the config
/// directory. Mirrors `STATE_FILE` in `src/main/saved-state.js`.
pub const STATE_FILE: &str = "config.json";

/// The window flag Electron reads from `process.argv` to come up
/// without showing itself, which is how it starts when it was
/// launched on login.
pub const HIDDEN_FLAG: &str = "--hidden";

/// The saved rectangle, as the renderer writes it: `bounds` in
/// `config.json`. Every field is optional because this struct is read
/// from a file the host does not own -- a partial or half-written
/// object restores what it can rather than throwing the session away.
#[derive(Debug, Clone, Copy, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct SavedBounds {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub maximized: Option<bool>,
}

/// Only the one key this module needs out of the saved state. Serde
/// ignores the rest of the file, which is the renderer's business.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct SavedState {
    bounds: Option<SavedBounds>,
}

/// What the window is opened with.
///
/// `x` and `y` stay optional rather than defaulting to a corner:
/// Electron passes `undefined` for both on a first run and lets the
/// platform place the window, and a guessed origin would put it
/// somewhere the OS would not have.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct WindowLayout {
    pub width: f64,
    pub height: f64,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub maximized: bool,
}

impl WindowLayout {
    /// `Object.assign(config.WINDOW_INITIAL_BOUNDS, state.saved.bounds)`
    /// in `src/main/windows/main.js`: the saved values win where they
    /// exist, and the defaults fill in the rest.
    pub fn resolve(saved: Option<SavedBounds>) -> WindowLayout {
        let saved = saved.unwrap_or_default();

        WindowLayout {
            width: saved.width.unwrap_or(INITIAL_WIDTH),
            height: saved.height.unwrap_or(INITIAL_HEIGHT),
            x: saved.x,
            y: saved.y,
            maximized: saved.maximized.unwrap_or(false),
        }
    }
}

/// The saved bounds inside a `config.json` document, or `None` when
/// there are none to be had.
///
/// Deliberately tolerant, exactly as `src/main/saved-state.js` is: a
/// missing, unreadable or corrupt file is not an error here. The
/// renderer owns that file and will rewrite it a moment later, and
/// refusing to open a window over a bad `bounds` key would turn a lost
/// rectangle into a lost app.
pub fn saved_bounds(document: &str) -> Option<SavedBounds> {
    serde_json::from_str::<SavedState>(document).ok()?.bounds
}

/// [`saved_bounds`] against the real file, given the config directory
/// [`crate::paths`] resolved.
pub fn read_saved_bounds(config_path: &Path) -> Option<SavedBounds> {
    let document = std::fs::read_to_string(config_path.join(STATE_FILE)).ok()?;
    saved_bounds(&document)
}

/// Whether this launch should come up without showing the window.
///
/// `src/main/index.js` reads the same flag out of `process.argv`. The
/// macOS half of that test (`wasOpenedAsHidden`) belongs to
/// launch-on-login and lands with it in US-069.
pub fn is_hidden<I>(args: I) -> bool
where
    I: IntoIterator<Item = String>,
{
    args.into_iter().any(|arg| arg == HIDDEN_FLAG)
}

/// The payload of [`BOUNDS_CHANGED_EVENT`], which is what
/// `win.getBounds()` gives the Electron host: a rectangle in logical
/// pixels, the same units the saved bounds are in.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Convert the physical rectangle a window reports into the logical
/// one the renderer saves.
///
/// Tauri reports physical pixels; Electron's `getBounds()` is logical.
/// Skipping this would save a rectangle twice the size it should be on
/// every retina display, and the window would grow on each restart.
pub fn logical_bounds(position: (i32, i32), size: (u32, u32), scale_factor: f64) -> Bounds {
    // A zero or negative factor is not a scale, and dividing by it
    // would put a NaN in the saved profile.
    let scale = if scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };

    Bounds {
        x: f64::from(position.0) / scale,
        y: f64::from(position.1) / scale,
        width: f64::from(size.0) / scale,
        height: f64::from(size.1) / scale,
    }
}

/// The trailing-edge debounce the Electron host gets from the
/// `debounce` package.
///
/// Each call takes a ticket and waits out the delay on its own thread;
/// only the call still holding the newest ticket runs. The window
/// events it guards arrive on the UI thread, so the work must not
/// happen there, and dropping the intermediate ones is the point --
/// see [`BOUNDS_DEBOUNCE`].
#[derive(Debug, Clone)]
pub struct Debounce {
    delay: Duration,
    latest: Arc<AtomicU64>,
}

impl Debounce {
    pub fn new(delay: Duration) -> Debounce {
        Debounce {
            delay,
            latest: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Run `job` once the calls stop, and only then.
    pub fn call<F>(&self, job: F)
    where
        F: FnOnce() + Send + 'static,
    {
        let ticket = self.latest.fetch_add(1, Ordering::SeqCst) + 1;
        let latest = Arc::clone(&self.latest);
        let delay = self.delay;

        std::thread::spawn(move || {
            std::thread::sleep(delay);
            if latest.load(Ordering::SeqCst) == ticket {
                job();
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn a_first_run_opens_at_the_initial_bounds() {
        let layout = WindowLayout::resolve(None);

        assert_eq!(layout.width, INITIAL_WIDTH);
        assert_eq!(layout.height, INITIAL_HEIGHT);
        assert_eq!(layout.x, None, "the platform places a new window");
        assert_eq!(layout.y, None);
        assert!(!layout.maximized);
    }

    #[test]
    fn saved_bounds_win_over_the_defaults() {
        let layout = WindowLayout::resolve(Some(SavedBounds {
            x: Some(12.0),
            y: Some(34.0),
            width: Some(900.0),
            height: Some(700.0),
            maximized: None,
        }));

        assert_eq!(layout.width, 900.0);
        assert_eq!(layout.height, 700.0);
        assert_eq!(layout.x, Some(12.0));
        assert_eq!(layout.y, Some(34.0));
    }

    /// `Object.assign` merges key by key, so a saved object missing a
    /// key keeps the default for that key rather than losing both.
    #[test]
    fn a_partial_rectangle_merges_key_by_key() {
        let layout = WindowLayout::resolve(Some(SavedBounds {
            width: Some(900.0),
            ..SavedBounds::default()
        }));

        assert_eq!(layout.width, 900.0);
        assert_eq!(layout.height, INITIAL_HEIGHT, "the default height");
        assert_eq!(layout.x, None);
    }

    #[test]
    fn the_maximized_flag_is_restored_when_one_was_saved() {
        let maximized = WindowLayout::resolve(Some(SavedBounds {
            maximized: Some(true),
            ..SavedBounds::default()
        }));
        assert!(maximized.maximized);

        let restored = WindowLayout::resolve(Some(SavedBounds {
            maximized: Some(false),
            ..SavedBounds::default()
        }));
        assert!(!restored.maximized);
    }

    #[test]
    fn bounds_come_out_of_the_saved_state_document() {
        let document = r#"{
            "bounds": { "x": 1, "y": 2, "width": 3, "height": 4 },
            "prefs": { "downloadPath": "/tmp" }
        }"#;

        assert_eq!(
            saved_bounds(document),
            Some(SavedBounds {
                x: Some(1.0),
                y: Some(2.0),
                width: Some(3.0),
                height: Some(4.0),
                maximized: None,
            })
        );
    }

    /// The renderer owns `config.json` and rewrites it moments after
    /// startup, so nothing readable here is worth failing a launch
    /// over -- the same tolerance `src/main/saved-state.js` has.
    #[test]
    fn an_unusable_document_restores_nothing_rather_than_failing() {
        assert_eq!(saved_bounds("not json at all"), None);
        assert_eq!(saved_bounds("{}"), None);
        assert_eq!(saved_bounds(r#"{ "bounds": null }"#), None);
        assert_eq!(saved_bounds(r#"{ "bounds": { "width": "wide" } }"#), None);

        // And a launch over any of them opens the default window.
        assert_eq!(
            WindowLayout::resolve(saved_bounds("not json at all")).width,
            INITIAL_WIDTH
        );
    }

    #[test]
    fn a_missing_state_file_restores_nothing() {
        let nowhere = Path::new("/no/such/webtorrent/profile");
        assert_eq!(read_saved_bounds(nowhere), None);
    }

    #[test]
    fn the_state_file_is_read_from_the_config_dir() {
        let dir = std::env::temp_dir().join("wt-window-bounds-test");
        std::fs::create_dir_all(&dir).expect("could not make a temp profile");
        std::fs::write(dir.join(STATE_FILE), r#"{"bounds":{"width":640}}"#)
            .expect("could not write a temp profile");

        let bounds = read_saved_bounds(&dir).expect("no bounds were read");
        assert_eq!(bounds.width, Some(640.0));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_hidden_flag_is_read_from_the_command_line() {
        let args = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();

        assert!(is_hidden(args(&["webtorrent", "--hidden"])));
        assert!(!is_hidden(args(&["webtorrent"])));
        assert!(
            !is_hidden(args(&["webtorrent", "--hidden-extra"])),
            "a longer flag is a different flag"
        );
        assert!(
            is_hidden(args(&["webtorrent", "magnet:?xt=1", "--hidden"])),
            "the flag is found wherever it sits"
        );
    }

    #[test]
    fn a_physical_rectangle_becomes_a_logical_one() {
        assert_eq!(
            logical_bounds((100, 200), (1000, 1276), 2.0),
            Bounds {
                x: 50.0,
                y: 100.0,
                width: 500.0,
                height: 638.0
            }
        );

        assert_eq!(
            logical_bounds((10, 20), (500, 638), 1.0),
            Bounds {
                x: 10.0,
                y: 20.0,
                width: 500.0,
                height: 638.0
            }
        );
    }

    /// A rectangle that never parses back into the saved state is
    /// worse than a stale one, so a nonsense scale is ignored rather
    /// than divided by.
    #[test]
    fn a_nonsense_scale_factor_is_not_divided_by() {
        let bounds = logical_bounds((10, 20), (500, 638), 0.0);
        assert_eq!(bounds.width, 500.0);
        assert!(bounds.x.is_finite() && bounds.width.is_finite());
    }

    /// The payload the renderer receives is the shape `setBounds` and
    /// the saved state both use: four plain numbers, no host object
    /// (ADR-007).
    #[test]
    fn the_payload_serializes_as_four_numbers() {
        let json = serde_json::to_value(logical_bounds((0, 0), (500, 638), 1.0))
            .expect("bounds do not serialize");
        let fields = json.as_object().expect("not a JSON object");

        assert_eq!(fields.len(), 4);
        for key in ["x", "y", "width", "height"] {
            assert!(fields[key].is_number(), "{key} is not a number");
        }
    }

    #[test]
    fn a_burst_of_calls_runs_the_job_once() {
        let runs = Arc::new(AtomicUsize::new(0));
        let debounce = Debounce::new(Duration::from_millis(40));

        for _ in 0..5 {
            let runs = Arc::clone(&runs);
            debounce.call(move || {
                runs.fetch_add(1, Ordering::SeqCst);
            });
            std::thread::sleep(Duration::from_millis(5));
        }

        assert_eq!(runs.load(Ordering::SeqCst), 0, "nothing runs early");
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(runs.load(Ordering::SeqCst), 1, "only the last call ran");
    }

    #[test]
    fn a_later_burst_is_debounced_on_its_own() {
        let runs = Arc::new(AtomicUsize::new(0));
        let debounce = Debounce::new(Duration::from_millis(40));

        for _ in 0..2 {
            let runs = Arc::clone(&runs);
            debounce.call(move || {
                runs.fetch_add(1, Ordering::SeqCst);
            });
            std::thread::sleep(Duration::from_millis(150));
        }

        assert_eq!(
            runs.load(Ordering::SeqCst),
            2,
            "a call after the delay is a new burst, not a swallowed one"
        );
    }

    /// The window geometry the host opens with is stated in
    /// `src/config.js`, which the Electron host reads directly. The
    /// same differential check `paths.rs` makes: hard-coded numbers
    /// above say what the layout is, this says it is still Electron's.
    #[test]
    fn matches_src_config_js() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("no repo root above src-tauri/");
        let script = "import('./src/config.js').then(m => \
             console.log(JSON.stringify([\
             m.WINDOW_INITIAL_BOUNDS.width, m.WINDOW_INITIAL_BOUNDS.height, \
             m.WINDOW_MIN_WIDTH, m.WINDOW_MIN_HEIGHT])))";

        let output = std::process::Command::new("node")
            .args(["--input-type=module", "-e", script])
            .current_dir(repo)
            .output()
            .expect("could not run node");
        assert!(
            output.status.success(),
            "node failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        let from_js: Vec<f64> =
            serde_json::from_slice(&output.stdout).expect("config.js printed no JSON");

        assert_eq!(
            from_js,
            vec![INITIAL_WIDTH, INITIAL_HEIGHT, MIN_WIDTH, MIN_HEIGHT]
        );
    }
}
