//! Keeping the display awake while something is playing.
//!
//! This is the Rust half of `src/main/power-save-blocker.js`, whose
//! whole content is Electron's `powerSaveBlocker` plus the two
//! `isStarted` guards that make `enable` and `disable` idempotent.
//! Tauri has no equivalent API, so the guards live in
//! [`PowerSaveBlocker`] here and each platform's way of holding the
//! display awake is a [`Wake`] behind it.
//!
//! The split is the one [`crate::dock`] uses: what a platform *does*
//! is a decision over plain values ([`strategy`]), asserted for all
//! three platforms from one `cargo test` run, and the part that
//! touches the world is at the bottom of the file. The bookkeeping
//! that Electron's two guards are -- enable once, release exactly
//! once, never leak -- is tested against a fake [`Wake`], because that
//! is the half a leak would come from.

use std::sync::Mutex;

use crate::menu::Platform;

/// Electron's `powerSaveBlocker.start('prevent-display-sleep')`, which
/// is the only type `src/main/power-save-blocker.js` asks for.
///
/// The name each platform shows the user for the assertion it is
/// holding: `pmset -g assertions` on macOS, `systemd-inhibit --list`
/// on Linux.
const WHY: &str = "WebTorrent Desktop is playing media";

/// How this platform holds the display awake.
///
/// Electron reaches one API on all three; there is no such API here,
/// so each platform is named rather than left to a fallback that
/// would quietly do nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Strategy {
    /// macOS: an IOKit power assertion of type
    /// `PreventUserIdleDisplaySleep`, which is exactly what Electron's
    /// `prevent-display-sleep` takes out. It belongs to this process
    /// and dies with it.
    Assertion,
    /// Windows: `ES_DISPLAY_REQUIRED`, which is per-thread, so the
    /// thread that sets it is held for as long as the block lasts. It
    /// dies with the process too.
    ExecutionState,
    /// Linux: a `systemd-inhibit` child holding an `idle` lock. See
    /// [`inhibit_command`] for why it is a child process rather than a
    /// D-Bus call.
    Inhibit,
}

/// What [`PowerSaveBlocker::platform`] builds on this platform.
pub fn strategy(platform: Platform) -> Strategy {
    match platform {
        Platform::Mac => Strategy::Assertion,
        Platform::Windows => Strategy::ExecutionState,
        Platform::Linux => Strategy::Inhibit,
    }
}

/// The `systemd-inhibit` invocation [`Strategy::Inhibit`] holds open.
///
/// `--what=idle` is the closest lock to `prevent-display-sleep`: it
/// stops the session going idle, which is what turns the display off.
///
/// The lock lasts as long as the child does, and the child is `cat`
/// reading a pipe this process holds the write end of. That is the
/// point of `cat` rather than `sleep`: if this process dies without
/// running its cleanup, the pipe closes, `cat` sees end-of-file and
/// exits, and the lock goes with it. An inhibitor that outlives the
/// app that took it out is the one failure mode here that a user
/// cannot see and cannot undo.
pub fn inhibit_command() -> (&'static str, Vec<String>) {
    (
        "systemd-inhibit",
        vec![
            "--what=idle".to_string(),
            "--who=WebTorrent Desktop".to_string(),
            format!("--why={WHY}"),
            "--mode=block".to_string(),
            "cat".to_string(),
        ],
    )
}

/// One held block on display sleep. Dropping it releases the block.
///
/// Release is `Drop` rather than a method so that there is no path
/// that forgets it: the app's own exit, a panic, and
/// [`PowerSaveBlocker::disable`] all go through the same code.
pub trait Inhibitor: Send {}

/// Whatever can take out an [`Inhibitor`] on this platform.
pub trait Wake: Send + Sync {
    fn inhibit(&self) -> Result<Box<dyn Inhibitor>, String>;
}

/// `src/main/power-save-blocker.js`, guards and all.
///
/// Electron keeps a `blockId` and asks `powerSaveBlocker.isStarted`
/// before doing anything; the held [`Inhibitor`] is that id, and
/// whether it is there is that question.
pub struct PowerSaveBlocker {
    wake: Box<dyn Wake>,
    held: Mutex<Option<Box<dyn Inhibitor>>>,
}

impl PowerSaveBlocker {
    /// The blocker this platform can actually hold, per [`strategy`].
    pub fn platform() -> Self {
        Self::new(platform_wake())
    }

    pub fn new(wake: Box<dyn Wake>) -> Self {
        Self {
            wake,
            held: Mutex::new(None),
        }
    }

    /// `powerSaveBlocker.enable()`: block display sleep, unless it is
    /// already blocked.
    ///
    /// A platform that cannot take the block out says so and nothing
    /// is held, so the next call tries again -- rather than recording
    /// a block that was never taken and then refusing to try.
    pub fn enable(&self) {
        let mut held = self.held.lock().unwrap_or_else(|err| err.into_inner());
        if held.is_some() {
            return;
        }

        match self.wake.inhibit() {
            Ok(inhibitor) => *held = Some(inhibitor),
            Err(err) => eprintln!("powerSaveBlocker.enable: {err}"),
        }
    }

    /// `powerSaveBlocker.disable()`: release the block if one is held.
    pub fn disable(&self) {
        let mut held = self.held.lock().unwrap_or_else(|err| err.into_inner());
        // The `Drop` of what was in there is the release.
        held.take();
    }

    /// Whether a block is held, which is Electron's
    /// `powerSaveBlocker.isStarted(blockId)`. Nothing in the host asks
    /// -- the guards above are the only readers of that state -- so it
    /// is here for the tests that assert on it.
    #[cfg(test)]
    pub fn is_enabled(&self) -> bool {
        self.held
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .is_some()
    }
}

// -- the part that touches the world ---------------------------------

/// macOS: `IOPMAssertionCreateWithName`, which is the call Electron's
/// own `prevent-display-sleep` makes.
#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::c_void;

    use objc2_core_foundation::CFString;

    use super::{Inhibitor, Wake, WHY};

    /// `kIOPMAssertionTypePreventUserIdleDisplaySleep`. The constant is
    /// a `CFStringRef` exported by IOKit, but its value is this string
    /// and the API takes it by value, so it is spelled out rather than
    /// linked to.
    const PREVENT_USER_IDLE_DISPLAY_SLEEP: &str = "PreventUserIdleDisplaySleep";

    /// `kIOPMAssertionLevelOn`.
    const LEVEL_ON: u32 = 255;

    /// `kIOReturnSuccess`.
    const SUCCESS: i32 = 0;

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: *const c_void,
            assertion_level: u32,
            assertion_name: *const c_void,
            assertion_id: *mut u32,
        ) -> i32;

        fn IOPMAssertionRelease(assertion_id: u32) -> i32;
    }

    pub struct IoKit;

    impl Wake for IoKit {
        fn inhibit(&self) -> Result<Box<dyn Inhibitor>, String> {
            let kind = CFString::from_str(PREVENT_USER_IDLE_DISPLAY_SLEEP);
            let name = CFString::from_str(WHY);
            let mut id: u32 = 0;

            // SAFETY: both strings outlive the call -- the assertion
            // copies what it keeps -- and `id` is written only on
            // success, which is the one path that reads it back.
            let result = unsafe {
                IOPMAssertionCreateWithName(
                    &*kind as *const CFString as *const c_void,
                    LEVEL_ON,
                    &*name as *const CFString as *const c_void,
                    &mut id,
                )
            };

            if result == SUCCESS {
                Ok(Box::new(Assertion(id)))
            } else {
                Err(format!("IOPMAssertionCreateWithName: {result}"))
            }
        }
    }

    /// A held `IOPMAssertionID`.
    struct Assertion(u32);

    impl Inhibitor for Assertion {}

    impl Drop for Assertion {
        fn drop(&mut self) {
            // SAFETY: the id was handed out by a successful
            // `IOPMAssertionCreateWithName` above, and nothing else
            // holds a copy of it -- this type is the only owner and it
            // is being dropped.
            let result = unsafe { IOPMAssertionRelease(self.0) };
            if result != SUCCESS {
                eprintln!("IOPMAssertionRelease: {result}");
            }
        }
    }
}

/// Windows: `ES_DISPLAY_REQUIRED`, which applies to the thread that
/// sets it and lasts until that thread clears it or exits. A Tauri
/// command does not run on a thread this code chooses, so the state is
/// set on a thread of its own that exists for exactly as long as the
/// block does.
#[cfg(target_os = "windows")]
mod platform {
    use std::sync::mpsc::{channel, Sender};
    use std::thread::JoinHandle;

    use super::{Inhibitor, Wake};

    const ES_CONTINUOUS: u32 = 0x8000_0000;
    const ES_DISPLAY_REQUIRED: u32 = 0x0000_0002;
    const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;

    #[link(name = "kernel32")]
    extern "system" {
        fn SetThreadExecutionState(flags: u32) -> u32;
    }

    pub struct ExecutionState;

    impl Wake for ExecutionState {
        fn inhibit(&self) -> Result<Box<dyn Inhibitor>, String> {
            let (release, released) = channel::<()>();
            let (set, was_set) = channel::<bool>();

            let thread = std::thread::spawn(move || {
                // SAFETY: the call takes a flag word and returns the
                // previous one. Zero means it was refused.
                let ok = unsafe {
                    SetThreadExecutionState(
                        ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED,
                    ) != 0
                };
                let _ = set.send(ok);
                if !ok {
                    return;
                }

                // Hold the thread -- and with it the state -- until the
                // `Held` below is dropped or the process exits.
                let _ = released.recv();

                // SAFETY: same call, clearing what this thread set.
                unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
            });

            match was_set.recv() {
                Ok(true) => Ok(Box::new(Held {
                    release: Some(release),
                    thread: Some(thread),
                })),
                _ => Err("SetThreadExecutionState refused".to_string()),
            }
        }
    }

    /// The thread holding `ES_DISPLAY_REQUIRED`.
    struct Held {
        release: Option<Sender<()>>,
        thread: Option<JoinHandle<()>>,
    }

    impl Inhibitor for Held {}

    impl Drop for Held {
        fn drop(&mut self) {
            drop(self.release.take());
            // Joined rather than left to finish on its own, so that the
            // state is provably cleared before this returns.
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }
}

/// Linux: a `systemd-inhibit` child, per [`inhibit_command`].
///
/// This module is compiled on every platform even though only Linux
/// selects it: it is `std::process` and nothing else, so building it
/// everywhere is what makes it checkable from a macOS `cargo clippy`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod child {
    use std::process::{Child, Command, Stdio};

    use super::{inhibit_command, Inhibitor, Wake};

    pub struct SystemdInhibit;

    impl Wake for SystemdInhibit {
        fn inhibit(&self) -> Result<Box<dyn Inhibitor>, String> {
            let (program, args) = inhibit_command();

            Command::new(program)
                .args(args)
                // The write end of this pipe is what the child waits
                // on; see [`inhibit_command`].
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map(|child| Box::new(Inhibit(child)) as Box<dyn Inhibitor>)
                .map_err(|err| format!("{program}: {err}"))
        }
    }

    /// A running `systemd-inhibit`.
    struct Inhibit(Child);

    impl Inhibitor for Inhibit {}

    impl Drop for Inhibit {
        fn drop(&mut self) {
            let _ = self.0.kill();
            // Reaped rather than left a zombie: the app can take this
            // block out and release it many times in one session.
            let _ = self.0.wait();
        }
    }
}

/// [`strategy`] decides and this builds what it decided, so that the
/// per-platform choice is made in one place and asserted in another
/// rather than being spread through `cfg` attributes.
fn platform_wake() -> Box<dyn Wake> {
    match strategy(Platform::current()) {
        Strategy::Assertion => assertion_wake(),
        Strategy::ExecutionState => execution_state_wake(),
        Strategy::Inhibit => Box::new(child::SystemdInhibit),
    }
}

#[cfg(target_os = "macos")]
fn assertion_wake() -> Box<dyn Wake> {
    Box::new(platform::IoKit)
}

#[cfg(target_os = "windows")]
fn execution_state_wake() -> Box<dyn Wake> {
    Box::new(platform::ExecutionState)
}

/// There is no IOKit here and no `SetThreadExecutionState` here.
/// [`strategy`] is what stops these being reached; they exist so that
/// the match above is one expression on every platform, and they
/// refuse rather than panicking if that decision is ever wrong -- a
/// display that sleeps during playback is a smaller failure than a
/// host that dies when the player opens.
#[cfg(not(target_os = "macos"))]
fn assertion_wake() -> Box<dyn Wake> {
    Box::new(Unsupported("IOKit power assertions"))
}

#[cfg(not(target_os = "windows"))]
fn execution_state_wake() -> Box<dyn Wake> {
    Box::new(Unsupported("SetThreadExecutionState"))
}

/// A [`Wake`] for a platform API that is not on this platform. See
/// [`assertion_wake`].
struct Unsupported(&'static str);

impl Wake for Unsupported {
    fn inhibit(&self) -> Result<Box<dyn Inhibitor>, String> {
        Err(format!("{} is not available here", self.0))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use super::*;

    /// What a fake [`Wake`] did, counted rather than described: the
    /// question every test here asks is how many blocks were taken out
    /// and how many were given back.
    #[derive(Default)]
    struct Log {
        started: AtomicUsize,
        released: AtomicUsize,
    }

    impl Log {
        fn started(&self) -> usize {
            self.started.load(Ordering::SeqCst)
        }

        fn released(&self) -> usize {
            self.released.load(Ordering::SeqCst)
        }
    }

    struct Fake {
        log: Arc<Log>,
        fails: bool,
    }

    impl Wake for Fake {
        fn inhibit(&self) -> Result<Box<dyn Inhibitor>, String> {
            if self.fails {
                return Err("no such thing here".to_string());
            }
            self.log.started.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(Token {
                log: Arc::clone(&self.log),
            }))
        }
    }

    struct Token {
        log: Arc<Log>,
    }

    impl Inhibitor for Token {}

    impl Drop for Token {
        fn drop(&mut self) {
            self.log.released.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn blocker(fails: bool) -> (PowerSaveBlocker, Arc<Log>) {
        let log = Arc::new(Log::default());
        let wake = Fake {
            log: Arc::clone(&log),
            fails,
        };
        (PowerSaveBlocker::new(Box::new(wake)), log)
    }

    /// The player opens, then closes: one block, given back.
    #[test]
    fn enable_blocks_and_disable_releases() {
        let (blocker, log) = blocker(false);

        blocker.enable();
        assert!(blocker.is_enabled());
        assert_eq!((log.started(), log.released()), (1, 0));

        blocker.disable();
        assert!(!blocker.is_enabled());
        assert_eq!((log.started(), log.released()), (1, 1));
    }

    /// `if (powerSaveBlocker.isStarted(blockId)) return`: the player
    /// opening and then playing is two `enable`s and one block.
    #[test]
    fn enabling_twice_takes_out_one_block() {
        let (blocker, log) = blocker(false);

        blocker.enable();
        blocker.enable();
        blocker.enable();

        assert_eq!((log.started(), log.released()), (1, 0));
    }

    /// The other guard: a pause before anything played, or a close
    /// after a pause, releases nothing rather than releasing an id it
    /// does not have.
    #[test]
    fn disabling_what_was_never_enabled_does_nothing() {
        let (blocker, log) = blocker(false);

        blocker.disable();
        assert_eq!((log.started(), log.released()), (0, 0));

        blocker.enable();
        blocker.disable();
        blocker.disable();
        assert_eq!((log.started(), log.released()), (1, 1));
    }

    /// Pause, play, pause, play: each play takes out a fresh block and
    /// each pause gives it back. The counts stay equal, which is the
    /// whole of "no leaked inhibitor".
    #[test]
    fn play_and_pause_balance() {
        let (blocker, log) = blocker(false);

        for _ in 0..5 {
            blocker.enable();
            blocker.disable();
        }

        assert_eq!((log.started(), log.released()), (5, 5));
        assert!(!blocker.is_enabled());
    }

    /// Quitting with a block held releases it. Nothing calls this --
    /// it is `Drop` -- which is the point: the host's exit path cannot
    /// forget to.
    #[test]
    fn dropping_the_blocker_releases_the_block() {
        let (blocker, log) = blocker(false);

        blocker.enable();
        drop(blocker);

        assert_eq!((log.started(), log.released()), (1, 1));
    }

    /// A platform that refuses records nothing, so the next play tries
    /// again instead of believing the display is already awake.
    #[test]
    fn a_refused_block_is_not_recorded() {
        let (blocker, log) = blocker(true);

        blocker.enable();

        assert!(!blocker.is_enabled());
        assert_eq!((log.started(), log.released()), (0, 0));
    }

    /// Every platform holds the display awake somehow: there is no
    /// fallback that quietly does nothing.
    #[test]
    fn every_platform_has_a_strategy() {
        assert_eq!(strategy(Platform::Mac), Strategy::Assertion);
        assert_eq!(strategy(Platform::Windows), Strategy::ExecutionState);
        assert_eq!(strategy(Platform::Linux), Strategy::Inhibit);
    }

    /// The Linux child, whose shape is the difference between a lock
    /// that is released when the app dies and one that is not.
    #[test]
    fn the_inhibit_command_holds_a_pipe_open() {
        let (program, args) = inhibit_command();

        assert_eq!(program, "systemd-inhibit");
        assert_eq!(args.first().map(String::as_str), Some("--what=idle"));
        assert!(args.iter().any(|arg| arg == "--mode=block"));
        assert_eq!(
            args.last().map(String::as_str),
            Some("cat"),
            "reads the pipe this process holds, so it exits with the app"
        );
    }
}
