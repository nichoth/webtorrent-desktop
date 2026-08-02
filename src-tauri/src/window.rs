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

/// The renderer's `config.json`, given the config directory
/// [`crate::paths`] resolved, or `""` when there is not one to read.
///
/// The document rather than the bounds, because the startup path reads
/// two different things out of it -- the window rectangle here and the
/// download folders in [`crate::fs::saved_roots`] -- and reading the
/// file once means the two cannot disagree about what was in it.
pub fn read_saved_state(config_path: &Path) -> String {
    std::fs::read_to_string(config_path.join(STATE_FILE)).unwrap_or_default()
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

/// The rectangle the renderer asks for, as `ipcOs.setBounds` sends it.
///
/// Every field is optional and `x`/`y` are explicitly nullable,
/// because the renderer's own calls are partial: the player sends
/// `{ contentBounds: true, x: null, y: null, width, height }` to say
/// "this size, centred", and `playback-controller` sends the whole
/// saved rectangle back. `null` and "absent" mean the same thing here,
/// exactly as they do in `src/main/windows/main.js`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BoundsRequest {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    /// Size the content area rather than the whole window. Electron's
    /// `setContentBounds`; see [`outer_size`].
    pub content_bounds: Option<bool>,
}

/// What the window is doing when a `setBounds` arrives. The two reads
/// `src/main/windows/main.js` makes before it decides anything.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct WindowState {
    pub fullscreen: bool,
    pub maximized: bool,
}

/// What a `setBounds` call comes to: at most one maximize state change
/// and at most one resize.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct BoundsPlan {
    /// `Some(true)` maximizes, `Some(false)` restores, `None` leaves
    /// the maximize state alone.
    pub maximize: Option<bool>,
    /// Whether the rectangle is applied at all.
    pub resize: bool,
}

/// `setBounds` in `src/main/windows/main.js`, as a decision over plain
/// values.
///
/// Three rules, in order: a fullscreen window is left alone entirely;
/// the maximize state changes only when the caller asked for a state
/// it is not already in; and the rectangle is applied only when the
/// window will not be maximized afterwards -- a maximized window
/// ignores its bounds, and setting them would fight the OS.
pub fn plan_bounds(maximize: Option<bool>, state: WindowState) -> BoundsPlan {
    if state.fullscreen {
        return BoundsPlan {
            maximize: None,
            resize: false,
        };
    }

    let change = match maximize {
        Some(true) if !state.maximized => Some(true),
        Some(false) if state.maximized => Some(false),
        _ => None,
    };

    BoundsPlan {
        maximize: change,
        resize: !maximize.unwrap_or(state.maximized),
    }
}

/// Where a window of this size sits when it is asked to be centred.
///
/// Electron centres on `screen.getDisplayMatching(win.getBounds())` --
/// the display the window is mostly on, whose Tauri equivalent is
/// `current_monitor()`. Both rectangles are logical here, so the
/// arithmetic is the same as the Electron host's.
pub fn centered_origin(size: (f64, f64), monitor: Bounds) -> (f64, f64) {
    (
        (monitor.x + (monitor.width / 2.0) - (size.0 / 2.0)).round(),
        (monitor.y + (monitor.height / 2.0) - (size.1 / 2.0)).round(),
    )
}

/// The outer size that gives a content area of `size`.
///
/// Tauri's `set_size` sizes the *content* area, so a request that is
/// already `contentBounds` needs no adjustment and one that is not has
/// to give the window chrome back its room. `chrome` is the window's
/// own outer-minus-inner difference, measured at the call.
pub fn outer_size(size: (f64, f64), chrome: (f64, f64)) -> (f64, f64) {
    (
        (size.0 - chrome.0).max(MIN_WIDTH),
        (size.1 - chrome.1).max(MIN_HEIGHT),
    )
}

/// What `setProgress` asks of the taskbar, in Electron's vocabulary:
/// a fraction sets the bar, anything above 1 makes it indeterminate,
/// and anything below 0 removes it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ProgressBar {
    Hidden,
    Indeterminate,
    /// A percentage, 0..=100, which is the unit Tauri takes.
    Normal(u64),
}

/// `win.setProgressBar(progress)` as a decision over a plain number.
///
/// A NaN is treated as "remove": it is not a fraction, and passing it
/// on would put a nonsense bar on the taskbar for the rest of the
/// session.
pub fn progress_bar(progress: f64) -> ProgressBar {
    if progress.is_nan() || progress < 0.0 {
        ProgressBar::Hidden
    } else if progress > 1.0 {
        ProgressBar::Indeterminate
    } else {
        ProgressBar::Normal((progress * 100.0).round() as u64)
    }
}

/// The event the renderer's `onFullscreenChanged` subscribes to. As
/// with [`BOUNDS_CHANGED_EVENT`], it is the Electron channel name
/// unchanged.
pub const FULLSCREEN_CHANGED_EVENT: &str = "fullscreenChanged";

/// Edge detection for the fullscreen state.
///
/// Electron has `enter-full-screen` and `leave-full-screen` events;
/// Tauri's `WindowEvent` has neither, and entering fullscreen arrives
/// as an ordinary `Resized`. So the state is read on every resize and
/// this decides whether it is news -- which also means a fullscreen
/// entered from the OS window chrome is reported, not just one the
/// renderer asked for.
#[derive(Debug)]
pub struct FullscreenWatch {
    last: std::sync::atomic::AtomicBool,
}

impl FullscreenWatch {
    /// Starts from the state the window was opened in, which is never
    /// fullscreen -- [`WindowLayout`] has no such field.
    pub fn new() -> FullscreenWatch {
        FullscreenWatch {
            last: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Whether `fullscreen` differs from the last state seen. Records
    /// it either way.
    pub fn changed(&self, fullscreen: bool) -> bool {
        self.last.swap(fullscreen, Ordering::SeqCst) != fullscreen
    }
}

impl Default for FullscreenWatch {
    fn default() -> FullscreenWatch {
        FullscreenWatch::new()
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
        assert_eq!(read_saved_state(nowhere), "");
        assert_eq!(saved_bounds(&read_saved_state(nowhere)), None);
    }

    #[test]
    fn the_state_file_is_read_from_the_config_dir() {
        let dir = std::env::temp_dir().join("wt-window-bounds-test");
        std::fs::create_dir_all(&dir).expect("could not make a temp profile");
        std::fs::write(dir.join(STATE_FILE), r#"{"bounds":{"width":640}}"#)
            .expect("could not write a temp profile");

        let bounds = saved_bounds(&read_saved_state(&dir)).expect("no bounds were read");
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

    // -- setBounds ---------------------------------------------------

    /// The Electron host returns early on a fullscreen window: the
    /// player asks for a video-shaped rectangle whenever the track
    /// changes, and applying it would drop the window out of
    /// fullscreen mid-playback.
    #[test]
    fn a_fullscreen_window_is_left_alone() {
        let plan = plan_bounds(
            Some(true),
            WindowState {
                fullscreen: true,
                maximized: false,
            },
        );

        assert_eq!(plan.maximize, None);
        assert!(!plan.resize);
    }

    #[test]
    fn a_plain_request_resizes_and_touches_nothing_else() {
        let plan = plan_bounds(None, WindowState::default());

        assert_eq!(plan.maximize, None, "no maximize state was asked for");
        assert!(plan.resize);
    }

    #[test]
    fn the_maximize_state_changes_only_when_it_is_not_already_there() {
        let restored = WindowState {
            fullscreen: false,
            maximized: false,
        };
        let maximized = WindowState {
            fullscreen: false,
            maximized: true,
        };

        assert_eq!(plan_bounds(Some(true), restored).maximize, Some(true));
        assert_eq!(
            plan_bounds(Some(true), maximized).maximize,
            None,
            "already maximized"
        );
        assert_eq!(plan_bounds(Some(false), maximized).maximize, Some(false));
        assert_eq!(
            plan_bounds(Some(false), restored).maximize,
            None,
            "already restored"
        );
    }

    /// A maximized window ignores its bounds, so setting them is at
    /// best wasted and at worst a fight with the window manager.
    #[test]
    fn a_window_that_will_be_maximized_is_not_resized() {
        assert!(!plan_bounds(Some(true), WindowState::default()).resize);
        assert!(
            !plan_bounds(
                None,
                WindowState {
                    fullscreen: false,
                    maximized: true
                }
            )
            .resize,
            "no flag means the state it is already in"
        );
        assert!(
            plan_bounds(
                Some(false),
                WindowState {
                    fullscreen: false,
                    maximized: true
                }
            )
            .resize,
            "unmaximizing to a rectangle applies the rectangle"
        );
    }

    #[test]
    fn a_centred_window_sits_in_the_middle_of_its_monitor() {
        let monitor = Bounds {
            x: 0.0,
            y: 0.0,
            width: 1440.0,
            height: 900.0,
        };

        assert_eq!(centered_origin((500.0, 638.0), monitor), (470.0, 131.0));
    }

    /// `screen.getDisplayMatching` returns the monitor's own origin in
    /// the desktop's coordinate space, which is not `(0, 0)` for a
    /// second display -- centring without it throws the window onto
    /// the primary monitor.
    #[test]
    fn a_centred_window_stays_on_its_own_monitor() {
        let second = Bounds {
            x: 1440.0,
            y: -200.0,
            width: 1000.0,
            height: 800.0,
        };
        let (x, y) = centered_origin((500.0, 400.0), second);

        assert_eq!(x, 1690.0);
        assert_eq!(y, 0.0);
    }

    /// Tauri sizes the content area, Electron's plain `setBounds`
    /// sizes the whole window -- so the chrome has to come off a
    /// request that was not `contentBounds`, or the window grows by a
    /// title bar every time the saved rectangle is restored.
    #[test]
    fn the_chrome_comes_off_a_whole_window_rectangle() {
        assert_eq!(outer_size((500.0, 638.0), (0.0, 28.0)), (500.0, 610.0));
        assert_eq!(
            outer_size((500.0, 638.0), (0.0, 0.0)),
            (500.0, 638.0),
            "an undecorated window is its own content area"
        );
    }

    #[test]
    fn a_rectangle_smaller_than_the_chrome_clamps_to_the_minimum() {
        let (width, height) = outer_size((MIN_WIDTH, MIN_HEIGHT), (0.0, 28.0));

        assert_eq!(width, MIN_WIDTH);
        assert_eq!(height, MIN_HEIGHT, "never below the minimum size");
    }

    // -- setProgress -------------------------------------------------

    #[test]
    fn a_fraction_becomes_a_percentage() {
        assert_eq!(progress_bar(0.0), ProgressBar::Normal(0));
        assert_eq!(progress_bar(0.5), ProgressBar::Normal(50));
        assert_eq!(progress_bar(1.0), ProgressBar::Normal(100));
        assert_eq!(progress_bar(0.336), ProgressBar::Normal(34));
    }

    /// `src/renderer/main.js` sends `-1` to clear the bar and the
    /// Electron docs give `> 1` as indeterminate; both have to survive
    /// the crossing or the taskbar keeps a stale bar forever.
    #[test]
    fn the_out_of_range_values_keep_their_electron_meaning() {
        assert_eq!(progress_bar(-1.0), ProgressBar::Hidden);
        assert_eq!(progress_bar(2.0), ProgressBar::Indeterminate);
        assert_eq!(progress_bar(f64::NAN), ProgressBar::Hidden);
    }

    // -- fullscreenChanged -------------------------------------------

    /// Tauri has no enter/leave-fullscreen event, so the state is read
    /// on every resize. Without edge detection the renderer would get
    /// a `fullscreenChanged` for every pixel of a window drag.
    #[test]
    fn only_a_change_of_fullscreen_state_is_news() {
        let watch = FullscreenWatch::new();

        assert!(!watch.changed(false), "a window opens un-fullscreen");
        assert!(watch.changed(true), "entering is news");
        assert!(!watch.changed(true), "a resize while fullscreen is not");
        assert!(watch.changed(false), "leaving is news");
        assert!(!watch.changed(false));
    }

    /// The renderer subscribes to these names because the Electron
    /// main process sends them; the shim absorbs host differences,
    /// never the channel name (ADR-014).
    #[test]
    fn the_event_names_are_the_electron_channel_names() {
        assert_eq!(BOUNDS_CHANGED_EVENT, "windowBoundsChanged");
        assert_eq!(FULLSCREEN_CHANGED_EVENT, "fullscreenChanged");
    }

    /// The renderer sends partial rectangles with explicit nulls; both
    /// spellings have to arrive as `None` rather than failing the
    /// command.
    #[test]
    fn a_partial_bounds_request_deserializes() {
        let request: BoundsRequest = serde_json::from_str(
            r#"{ "contentBounds": true, "x": null, "y": null,
                 "width": 640, "height": 480 }"#,
        )
        .expect("the player's own request does not parse");

        assert_eq!(request.x, None);
        assert_eq!(request.width, Some(640.0));
        assert_eq!(request.content_bounds, Some(true));

        let empty: BoundsRequest = serde_json::from_str("{}").expect("an empty request");
        assert_eq!(empty, BoundsRequest::default());
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
