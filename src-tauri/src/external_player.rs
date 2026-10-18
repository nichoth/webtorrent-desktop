//! "Play in VLC": `src/main/external-player.js` and the `vlc-command`
//! package it depends on.
//!
//! The Electron module is three exported functions -- `checkInstall`,
//! `spawn` and `kill` -- over one module-level `proc`, and everything
//! interesting about it is what the child's life dispatches back at the
//! renderer:
//!
//! - still up after a second: `exitModal`, which takes the
//!   unsupported-media modal off the screen now that something else is
//!   playing the video;
//! - a clean exit: `backToList`, because the user closed the player;
//! - any other exit, or no player to run at all:
//!   `externalPlayerNotFound`, which is the message in that same modal;
//! - killed by us: nothing, because the renderer is the one that asked.
//!
//! `vlc-command` is the other half. It is a list of places VLC lives on
//! each platform, probed with `--version`, and the registry on Windows;
//! it is not a package any more (US-053 took it out of `package.json`),
//! so the list is [`vlc_candidates`] here.
//!
//! The split follows `paths.rs` and `window.rs`: every decision is a
//! pure function of plain values -- [`configured`], [`player_program`],
//! [`vlc_args`], [`plan`] -- so all three platforms' answers are
//! asserted from a `cargo test` run on any one of them, and
//! [`ExternalPlayer`] is the only part that makes a process. What the
//! *host* does around the spawn -- disabling the Playback menu and
//! handing the media keys back -- is `main.rs`'s, because it is
//! `src/main/ipc.js`'s rather than this module's.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::menu::Platform;

/// The renderer actions a player's life dispatches. All three are
/// handled in `src/renderer/main.js` already; none is new.
pub const EXIT_MODAL: &str = "exitModal";
pub const BACK_TO_LIST: &str = "backToList";
pub const NOT_FOUND: &str = "externalPlayerNotFound";

/// How long the player has to stay up before the modal is closed. The
/// `setTimeout(..., 1000)` of `spawnExternal`, and it is a *survival*
/// test rather than a delay: a player that exits inside it never sends
/// `exitModal`, because the JS clears the timeout on close.
pub const MODAL_DELAY: Duration = Duration::from_millis(1000);

/// How often the child is checked for having exited. Nothing waits on
/// this; it only bounds how quickly an exit is reported, and how
/// closely [`MODAL_DELAY`] is honoured.
const POLL: Duration = Duration::from_millis(25);

/// How long a `--version` probe may take before the candidate is
/// treated as not answering. `vlc --version` prints and exits at once;
/// this only has to outlast a cold start on a loaded machine.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// The two registry keys `vlc-command` reads on Windows: the second is
/// where a 32-bit VLC lands on a 64-bit Windows.
pub const VLC_REGISTRY_KEYS: [&str; 2] = [
    r"HKLM\Software\VideoLAN\VLC",
    r"HKLM\Software\Wow6432Node\VideoLAN\VLC",
];

/// The value under those keys, and the executable inside it.
const INSTALL_DIR: &str = "InstallDir";
const VLC_EXE: &str = "vlc.exe";

/// Something to run: a program and the arguments that come before the
/// ones the caller adds.
///
/// The arguments are here because one `vlc-command` candidate is not a
/// program at all -- `flatpak run org.videolan.VLC` is three words --
/// and `cp.spawn` of that whole string is an `ENOENT` upstream, since
/// only the `--version` probe went through a shell. Splitting it here
/// is a deliberate deviation from `external-player.js`: it is the
/// difference between the Flatpak VLC working and being found and then
/// failing to start.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
}

impl Launch {
    /// A candidate as `vlc-command` writes it: a path, or a command
    /// line whose first word is the program.
    pub fn parse(command: &str) -> Launch {
        let mut words = command.split_whitespace().map(str::to_string);
        let program = words.next().unwrap_or_default();
        Launch {
            program: PathBuf::from(program),
            args: words.collect(),
        }
    }

    fn program(program: PathBuf) -> Launch {
        Launch {
            program,
            args: Vec::new(),
        }
    }
}

/// The player the user configured, if they configured one.
///
/// `if (!playerPath)` in both `checkInstall` and `spawn`, and the empty
/// string matters: `externalPlayerPath` defaults to `''` in
/// `lib/state.js`, so "no player" reaches the host as an empty string
/// far more often than as a missing value.
pub fn configured(player: Option<&str>) -> Option<&str> {
    player.filter(|path| !path.is_empty())
}

/// Where VLC might be, in the order `vlc-command` prefers.
///
/// Windows answers from the registry instead ([`VLC_REGISTRY_KEYS`]),
/// so its list is empty. `home` is `os.homedir()`; without one the
/// per-user Applications directory is simply not a candidate.
///
/// Only the Flatpak entry goes through [`Launch::parse`]. Splitting the
/// rest on whitespace would be the same answer for every path this
/// function writes itself, but not for the one it does not: a home
/// directory with a space in it would become a program and an argument.
pub fn vlc_candidates(platform: Platform, home: Option<&Path>) -> Vec<Launch> {
    let path = |command: &str| Launch::program(PathBuf::from(command));

    match platform {
        Platform::Mac => {
            let bundle = "Applications/VLC.app/Contents/MacOS/VLC";
            let mut candidates = vec![path(&format!("/{bundle}"))];
            if let Some(home) = home {
                candidates.push(Launch::program(home.join(bundle)));
            }
            candidates.extend(["/usr/bin/vlc", "/usr/local/bin/vlc", "vlc"].map(path));
            candidates
        }
        Platform::Linux => vec![
            path("/usr/bin/vlc"),
            path("/usr/local/bin/vlc"),
            path("vlc"),
            // The one candidate that is a command line rather than a
            // path.
            Launch::parse("flatpak run org.videolan.VLC"),
        ],
        Platform::Windows => Vec::new(),
    }
}

/// The `reg.exe` arguments that read `InstallDir` out of one of the
/// keys. `reg.exe` rather than a registry crate for `startup.rs`'s
/// reason: it ships with Windows, and a Windows-only dependency could
/// not be compiled -- let alone run -- on the machine this port is
/// written on.
pub fn registry_query(key: &str) -> Vec<String> {
    vec![
        "query".to_string(),
        key.to_string(),
        "/v".to_string(),
        INSTALL_DIR.to_string(),
    ]
}

/// The install directory out of what `reg query` printed, and the
/// executable inside it.
///
/// The output is a header line, then `    InstallDir    REG_SZ    C:\...`.
/// A missing value is a failed query with nothing to parse, which is
/// `vlc-command`'s "VLC not found" on that key.
pub fn parse_install_dir(output: &str) -> Option<PathBuf> {
    output
        .lines()
        .filter(|line| line.trim_start().starts_with(INSTALL_DIR))
        .find_map(|line| line.split_once("REG_SZ"))
        .map(|(_, dir)| PathBuf::from(dir.trim()).join(VLC_EXE))
}

/// The executable inside a macOS `.app`, which is what `cp.spawn` needs
/// -- the bundle directory itself is not runnable.
///
/// `spawnExternal` applies this to whatever it is about to run, so a
/// user who picked `/Applications/mpv.app` in the preferences gets
/// `/Applications/mpv.app/Contents/MacOS/mpv`. Everything else, and
/// every other platform, is left exactly as it was.
pub fn player_program(platform: Platform, player: &Path) -> PathBuf {
    if platform != Platform::Mac || player.extension().and_then(|e| e.to_str()) != Some("app") {
        return player.to_path_buf();
    }
    match player.file_stem() {
        Some(name) => player.join("Contents").join("MacOS").join(name),
        None => player.to_path_buf(),
    }
}

/// The arguments VLC is given when it is the player *we* found.
///
/// A player the user configured gets the url and nothing else: we know
/// what VLC's flags mean and we do not know what theirs would.
///
/// `--meta-title` is JSON-quoted because `external-player.js` builds it
/// with `JSON.stringify(title)`, quotes included -- VLC shows the
/// quotes, and matching that is the point of porting rather than
/// improving.
pub fn vlc_args(url: &str, title: &str) -> Vec<String> {
    let title = serde_json::to_string(title).unwrap_or_else(|_| format!("{title:?}"));
    vec![
        "--play-and-exit".to_string(),
        "--quiet".to_string(),
        format!("--meta-title={title}"),
        url.to_string(),
    ]
}

/// `spawn(playerPath, url, title)` up to the point where a process is
/// made: what to run, and with what.
///
/// `vlc` is the lookup's answer, and it is only consulted when no
/// player is configured -- which is why it is passed in rather than
/// performed here. `None` back means there is nothing to run, which is
/// the `externalPlayerNotFound` branch of the original.
pub fn plan(
    platform: Platform,
    player: Option<&str>,
    vlc: Option<Launch>,
    url: &str,
    title: &str,
) -> Option<Launch> {
    match configured(player) {
        Some(player) => Some(Launch {
            program: player_program(platform, Path::new(player)),
            args: vec![url.to_string()],
        }),
        None => {
            let found = vlc?;
            let mut args = found.args;
            args.extend(vlc_args(url, title));
            Some(Launch {
                program: player_program(platform, &found.program),
                args,
            })
        }
    }
}

/// Whatever can answer "where is VLC". The real one is [`Lookup`].
pub trait Vlc: Send + Sync {
    fn find(&self) -> Option<Launch>;
}

/// `vlc-command`: probe each candidate with `--version` and take the
/// first that answers, or read the registry on Windows.
///
/// The package probes all the candidates at once and keeps the
/// lowest-indexed one that succeeded; probing them in order and
/// stopping at the first is the same answer for fewer processes.
pub struct Lookup {
    platform: Platform,
    home: Option<PathBuf>,
}

impl Lookup {
    /// The lookup for the machine this is running on.
    pub fn current() -> Lookup {
        Lookup {
            platform: Platform::current(),
            home: std::env::var_os("HOME").map(PathBuf::from),
        }
    }
}

impl Vlc for Lookup {
    fn find(&self) -> Option<Launch> {
        if self.platform == Platform::Windows {
            return VLC_REGISTRY_KEYS
                .iter()
                .find_map(|key| registry_install_dir(key))
                .map(Launch::program);
        }
        vlc_candidates(self.platform, self.home.as_deref())
            .into_iter()
            .find(answers_version)
    }
}

/// Whether a candidate is really there: `cp.exec(cmd + ' --version')`.
fn answers_version(candidate: &Launch) -> bool {
    answers_version_within(candidate, PROBE_TIMEOUT)
}

/// [`answers_version`] with its deadline as a parameter. A candidate
/// still running at the deadline is killed, reaped and counted as not
/// answering, so a hung one never strands the lookup's thread.
fn answers_version_within(candidate: &Launch, timeout: Duration) -> bool {
    let spawned = Command::new(&candidate.program)
        .args(&candidate.args)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = spawned else {
        return false;
    };

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if Instant::now() < deadline => thread::sleep(POLL),
            Ok(None) | Err(_) => {
                end(child);
                return false;
            }
        }
    }
}

/// One `reg query`, parsed.
fn registry_install_dir(key: &str) -> Option<PathBuf> {
    let output = Command::new("reg")
        .args(registry_query(key))
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_install_dir(&String::from_utf8_lossy(&output.stdout))
}

/// The running player, if there is one, and which spawn it belongs to.
///
/// Together the two are `proc = null` in the original: a watching
/// thread reports on the child *it* started and on nothing else. The
/// child alone is enough for a kill -- it is taken out, and a thread
/// that finds nothing there goes quiet -- but not for a replacement,
/// where there is a different child in the slot and the old thread
/// would otherwise watch it and speak for it twice. That is what the
/// generation is for, and it is why only [`ExternalPlayer::spawn`]
/// advances it.
#[derive(Default)]
struct Slot {
    generation: u64,
    child: Option<Child>,
}

struct Shared {
    platform: Platform,
    vlc: Box<dyn Vlc>,
    modal_delay: Duration,
    state: Mutex<Slot>,
}

/// `src/main/external-player.js`, as managed state.
///
/// Cloning shares the one child, so a command can take a copy out of
/// `tauri::State` and do the waiting off the main thread -- the same
/// arrangement as [`crate::engine::Engine`].
#[derive(Clone)]
pub struct ExternalPlayer {
    shared: Arc<Shared>,
}

impl ExternalPlayer {
    /// The real one: VLC found the way `vlc-command` finds it.
    pub fn system() -> ExternalPlayer {
        ExternalPlayer::new(
            Box::new(Lookup::current()),
            Platform::current(),
            MODAL_DELAY,
        )
    }

    pub fn new(vlc: Box<dyn Vlc>, platform: Platform, modal_delay: Duration) -> ExternalPlayer {
        ExternalPlayer {
            shared: Arc::new(Shared {
                platform,
                vlc,
                modal_delay,
                state: Mutex::new(Slot::default()),
            }),
        }
    }

    /// `checkInstall`: is there a player to hand the stream to?
    ///
    /// A configured one is taken on trust and the lookup is not run --
    /// which is the whole of `if (!playerPath) return vlcCommand(cb)`,
    /// and the reason this answers instantly for anyone who set one.
    pub fn installed(&self, player: Option<&str>) -> bool {
        match configured(player) {
            Some(_) => true,
            None => self.shared.vlc.find().is_some(),
        }
    }

    /// `spawn(playerPath, url, title)`.
    ///
    /// Returns once the child exists; everything the renderer hears
    /// about it afterwards comes from the watching thread through
    /// `dispatch`.
    pub fn spawn<F>(&self, player: Option<&str>, url: &str, title: &str, dispatch: F)
    where
        F: Fn(&'static str) + Send + 'static,
    {
        let vlc = match configured(player) {
            Some(_) => None,
            None => self.shared.vlc.find(),
        };
        let Some(launch) = plan(self.shared.platform, player, vlc, url, title) else {
            eprintln!("external player: no VLC on this machine");
            dispatch(NOT_FOUND);
            return;
        };

        eprintln!(
            "external player: {} {}",
            launch.program.display(),
            launch.args.join(" ")
        );

        let child = Command::new(&launch.program)
            .args(&launch.args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();

        let child = match child {
            Ok(child) => child,
            // `cp.spawn` reports this asynchronously and
            // `external-player.js` only logs it, leaving the modal to
            // the `close` that follows. Saying so directly is the same
            // outcome for the user -- the modal reports that the
            // player could not be started -- from one event instead of
            // two.
            Err(err) => {
                eprintln!("external player: could not start it: {err}");
                dispatch(NOT_FOUND);
                return;
            }
        };

        // Replacing a running player kills it first. The original
        // overwrites `proc` and leaves the old process playing with
        // nothing able to stop it; that is a leak rather than a
        // behaviour worth keeping.
        let generation = {
            let mut state = self.lock();
            state.generation += 1;
            if let Some(previous) = state.child.replace(child) {
                end(previous);
            }
            state.generation
        };

        let shared = Arc::clone(&self.shared);
        thread::spawn(move || watch(shared, generation, dispatch));
    }

    /// `kill()`: the renderer is done with the player.
    ///
    /// Silent by design -- the watching thread sees that the child it
    /// was reporting on is no longer the current one and dispatches
    /// nothing, which is what `if (!proc) return // Killed` does.
    /// Killing nothing is a no-op, as it is there.
    pub fn kill(&self) {
        let mut state = self.lock();
        if let Some(child) = state.child.take() {
            eprintln!("external player: killing pid {}", child.id());
            end(child);
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Slot> {
        self.shared
            .state
            .lock()
            .unwrap_or_else(|err| err.into_inner())
    }
}

/// `proc.kill('SIGKILL')`, and then the reaping Node does for us.
fn end(mut child: Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// Watch one child: close the modal if it survives, report how it ended
/// if it was still ours when it did.
fn watch<F>(shared: Arc<Shared>, generation: u64, dispatch: F)
where
    F: Fn(&'static str),
{
    let deadline = Instant::now() + shared.modal_delay;
    let mut announced = false;

    loop {
        let exited = {
            let mut state = shared.state.lock().unwrap_or_else(|err| err.into_inner());
            if state.generation != generation {
                return;
            }
            match state.child.as_mut() {
                // Killed between the two locks.
                None => return,
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => {
                        let _ = child.wait();
                        state.child = None;
                        Some(status.success())
                    }
                    Ok(None) => None,
                    // Dropping a `Child` neither kills nor reaps it, so
                    // a player we cannot wait on is ended rather than
                    // left behind as a zombie.
                    Err(err) => {
                        eprintln!("external player: could not wait for it: {err}");
                        if let Some(child) = state.child.take() {
                            end(child);
                        }
                        Some(false)
                    }
                },
            }
        };

        // The exit is checked before the deadline, so a player that
        // fails inside the first second reports the failure and never
        // takes the modal down -- `clearTimeout(closeModalTimeout)`.
        if let Some(clean) = exited {
            dispatch(if clean { BACK_TO_LIST } else { NOT_FOUND });
            return;
        }

        if !announced && Instant::now() >= deadline {
            dispatch(EXIT_MODAL);
            announced = true;
        }
        thread::sleep(POLL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};

    // -- the decisions ------------------------------------------------

    #[test]
    fn no_configured_player_is_an_empty_string_as_often_as_a_missing_one() {
        // `externalPlayerPath` defaults to `''`, so this is the common
        // case rather than the edge one.
        assert_eq!(configured(Some("")), None);
        assert_eq!(configured(None), None);
        assert_eq!(
            configured(Some("/Applications/mpv.app")),
            Some("/Applications/mpv.app")
        );
    }

    #[test]
    fn the_mac_candidates_are_vlc_commands() {
        let home = PathBuf::from("/Users/someone");
        let found: Vec<String> = vlc_candidates(Platform::Mac, Some(&home))
            .iter()
            .map(|c| c.program.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            found,
            vec![
                "/Applications/VLC.app/Contents/MacOS/VLC",
                "/Users/someone/Applications/VLC.app/Contents/MacOS/VLC",
                "/usr/bin/vlc",
                "/usr/local/bin/vlc",
                "vlc",
            ]
        );
    }

    #[test]
    fn without_a_home_the_per_user_bundle_is_simply_not_a_candidate() {
        let found = vlc_candidates(Platform::Mac, None);
        assert_eq!(found.len(), 4);
        assert!(found
            .iter()
            .all(|c| !c.program.to_string_lossy().contains("Users")));
    }

    /// A home directory with a space in it is one path, not two words.
    /// Only the Flatpak candidate is a command line; everything else on
    /// the list is a path, and the user's home is the one part of one
    /// that this code did not write.
    #[test]
    fn a_home_with_a_space_in_it_stays_one_candidate() {
        let home = PathBuf::from("/Users/ada lovelace");
        let found = vlc_candidates(Platform::Mac, Some(&home));
        let per_user = &found[1];

        assert_eq!(
            per_user.program,
            home.join("Applications/VLC.app/Contents/MacOS/VLC")
        );
        assert!(
            per_user.args.is_empty(),
            "nothing after the path was mistaken for an argument"
        );
    }

    #[test]
    fn the_linux_candidates_are_vlc_commands() {
        let found: Vec<String> = vlc_candidates(Platform::Linux, None)
            .iter()
            .map(|c| {
                let mut line = c.program.to_string_lossy().into_owned();
                for arg in &c.args {
                    line.push(' ');
                    line.push_str(arg);
                }
                line
            })
            .collect();
        assert_eq!(
            found,
            vec![
                "/usr/bin/vlc",
                "/usr/local/bin/vlc",
                "vlc",
                "flatpak run org.videolan.VLC",
            ]
        );
    }

    /// The candidate that is a command line rather than a path. Running
    /// the whole string as a program is the upstream `ENOENT`.
    #[test]
    fn the_flatpak_candidate_is_a_program_and_its_arguments() {
        let flatpak = Launch::parse("flatpak run org.videolan.VLC");
        assert_eq!(flatpak.program, PathBuf::from("flatpak"));
        assert_eq!(flatpak.args, vec!["run", "org.videolan.VLC"]);
    }

    #[test]
    fn windows_asks_the_registry_rather_than_a_list() {
        assert!(vlc_candidates(Platform::Windows, None).is_empty());
        assert_eq!(
            registry_query(VLC_REGISTRY_KEYS[0]),
            vec!["query", r"HKLM\Software\VideoLAN\VLC", "/v", "InstallDir"]
        );
        // The 32-bit-on-64-bit key, which is the second thing
        // `vlc-command` tries.
        assert!(VLC_REGISTRY_KEYS[1].contains("Wow6432Node"));
    }

    #[test]
    fn the_install_directory_is_read_out_of_what_reg_printed() {
        let output = "\r\nHKEY_LOCAL_MACHINE\\Software\\VideoLAN\\VLC\r\n    \
                      InstallDir    REG_SZ    C:\\Program Files\\VideoLAN\\VLC\r\n\r\n";
        assert_eq!(
            parse_install_dir(output),
            Some(PathBuf::from("C:\\Program Files\\VideoLAN\\VLC").join("vlc.exe"))
        );
        assert_eq!(
            parse_install_dir("ERROR: The system was unable to find the specified registry key"),
            None
        );
    }

    #[test]
    fn a_mac_bundle_is_run_through_the_executable_inside_it() {
        assert_eq!(
            player_program(Platform::Mac, Path::new("/Applications/mpv.app")),
            PathBuf::from("/Applications/mpv.app/Contents/MacOS/mpv")
        );
        // Already an executable, or not a bundle at all: untouched.
        assert_eq!(
            player_program(Platform::Mac, Path::new("/usr/local/bin/mpv")),
            PathBuf::from("/usr/local/bin/mpv")
        );
        // The rewrite is macOS's alone -- a directory called `x.app`
        // on Windows is whatever the user meant by it.
        assert_eq!(
            player_program(Platform::Windows, Path::new("C:\\mpv.app")),
            PathBuf::from("C:\\mpv.app")
        );
    }

    #[test]
    fn vlc_is_told_to_quit_at_the_end_and_what_to_call_the_video() {
        assert_eq!(
            vlc_args("http://127.0.0.1:5000/0", "Big Buck Bunny"),
            vec![
                "--play-and-exit",
                "--quiet",
                // Quoted, because `external-player.js` builds it with
                // `JSON.stringify`.
                "--meta-title=\"Big Buck Bunny\"",
                "http://127.0.0.1:5000/0",
            ]
        );
    }

    #[test]
    fn a_title_with_a_quote_in_it_is_escaped_rather_than_ending_the_argument() {
        let args = vlc_args("http://x/0", "Bob's \"Big\" Night");
        assert_eq!(args[2], "--meta-title=\"Bob's \\\"Big\\\" Night\"");
    }

    #[test]
    fn a_configured_player_gets_the_url_and_nothing_else() {
        let plan = plan(
            Platform::Linux,
            Some("/usr/bin/mpv"),
            None,
            "http://127.0.0.1:5000/0",
            "Sintel",
        )
        .expect("a configured player is always something to run");

        assert_eq!(plan.program, PathBuf::from("/usr/bin/mpv"));
        assert_eq!(plan.args, vec!["http://127.0.0.1:5000/0"]);
    }

    #[test]
    fn the_vlc_we_found_gets_its_own_arguments_after_the_candidates() {
        let plan = plan(
            Platform::Linux,
            None,
            Some(Launch::parse("flatpak run org.videolan.VLC")),
            "http://127.0.0.1:5000/0",
            "Sintel",
        )
        .expect("the lookup found something");

        assert_eq!(plan.program, PathBuf::from("flatpak"));
        assert_eq!(
            plan.args,
            vec![
                "run",
                "org.videolan.VLC",
                "--play-and-exit",
                "--quiet",
                "--meta-title=\"Sintel\"",
                "http://127.0.0.1:5000/0",
            ]
        );
    }

    #[test]
    fn nothing_to_run_is_the_not_found_branch() {
        assert_eq!(plan(Platform::Mac, None, None, "http://x/0", "x"), None);
        // And an empty configured path takes the lookup's branch, not
        // the "run the empty string" one.
        assert_eq!(plan(Platform::Mac, Some(""), None, "http://x/0", "x"), None);
    }

    // -- the lifecycle, against a fake player --------------------------
    //
    // The contract with a real player is three things: it is spawned
    // with the arguments above, it stays up or it does not, and its
    // exit status says which. A few lines of Node cover all three, and
    // `node` is already what `engine.rs`'s tests and `paths.rs` shell
    // out to.

    static SEQ: AtomicU32 = AtomicU32::new(0);

    struct Sandbox {
        dir: PathBuf,
    }

    impl Sandbox {
        fn new(name: &str) -> Sandbox {
            let n = SEQ.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir().join(format!(
                "wt-player-{}-{}-{}",
                std::process::id(),
                n,
                name
            ));
            fs::create_dir_all(&dir).unwrap();
            Sandbox { dir }
        }

        fn path(&self, name: &str) -> PathBuf {
            self.dir.join(name)
        }

        /// A fake player: it records the arguments it was given, then
        /// does whatever `body` says.
        fn player(&self, body: &str) -> PathBuf {
            let argv = self.path("argv.json");
            let script = self.path("player.js");
            let source = format!(
                r#"
                require('fs').writeFileSync({argv:?}, JSON.stringify(process.argv.slice(2)))
                {body}
                "#
            );
            fs::write(&script, source).unwrap();
            script
        }

        fn argv(&self) -> Vec<String> {
            let raw = fs::read_to_string(self.path("argv.json")).unwrap_or_default();
            serde_json::from_str(&raw).unwrap_or_default()
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    /// A player that never exits on its own.
    const STAYS_UP: &str = "setInterval(() => {}, 1000)";

    /// A lookup that answers with a script under `node`, so that the
    /// whole VLC branch -- arguments included -- runs against a process
    /// this test can read.
    struct Fake(Option<Launch>);

    impl Vlc for Fake {
        fn find(&self) -> Option<Launch> {
            self.0.clone()
        }
    }

    fn found(script: &Path) -> Box<dyn Vlc> {
        Box::new(Fake(Some(Launch {
            program: PathBuf::from("node"),
            args: vec![script.to_string_lossy().into_owned()],
        })))
    }

    fn missing() -> Box<dyn Vlc> {
        Box::new(Fake(None))
    }

    fn player(vlc: Box<dyn Vlc>) -> ExternalPlayer {
        // Short enough that a test can wait for it, long enough that a
        // player which exits at once loses the race on purpose -- Node
        // takes tens of milliseconds to start, so the margin has to
        // survive a loaded machine.
        ExternalPlayer::new(vlc, Platform::current(), Duration::from_millis(400))
    }

    /// What the renderer heard.
    #[derive(Clone, Default)]
    struct Dispatched(Arc<Mutex<Vec<&'static str>>>);

    impl Dispatched {
        fn sink(&self) -> impl Fn(&'static str) + Send + 'static {
            let seen = Arc::clone(&self.0);
            move |action| seen.lock().unwrap().push(action)
        }

        fn seen(&self) -> Vec<&'static str> {
            self.0.lock().unwrap().clone()
        }

        /// Wait for `action`, or give up. Returns everything heard.
        fn wait_for(&self, action: &str, timeout: Duration) -> Vec<&'static str> {
            let deadline = Instant::now() + timeout;
            loop {
                let seen = self.seen();
                if seen.contains(&action) || Instant::now() >= deadline {
                    return seen;
                }
                thread::sleep(Duration::from_millis(10));
            }
        }
    }

    #[test]
    fn a_player_that_stays_up_takes_the_modal_down() {
        let sandbox = Sandbox::new("stays-up");
        let player = player(found(&sandbox.player(STAYS_UP)));
        let heard = Dispatched::default();

        player.spawn(None, "http://127.0.0.1:5000/0", "Sintel", heard.sink());
        assert_eq!(
            heard.wait_for(EXIT_MODAL, Duration::from_secs(10)),
            vec![EXIT_MODAL],
            "the modal is closed and nothing else is said"
        );

        // And the url and the title reached the process, which is the
        // half `plan` cannot prove on its own.
        assert_eq!(
            sandbox.argv(),
            vec![
                "--play-and-exit",
                "--quiet",
                "--meta-title=\"Sintel\"",
                "http://127.0.0.1:5000/0",
            ]
        );

        player.kill();
    }

    #[test]
    fn killing_the_player_dispatches_nothing_and_leaves_nothing_running() {
        let sandbox = Sandbox::new("kill");
        let player = player(found(&sandbox.player(STAYS_UP)));
        let heard = Dispatched::default();

        player.spawn(None, "http://127.0.0.1:5000/0", "Sintel", heard.sink());
        heard.wait_for(EXIT_MODAL, Duration::from_secs(10));
        let pid = player.lock().child.as_ref().map(|c| c.id());

        player.kill();
        // Long enough for a watching thread that was going to say
        // `backToList` to have said it.
        thread::sleep(Duration::from_millis(400));

        assert_eq!(
            heard.seen(),
            vec![EXIT_MODAL],
            "the renderer asked for this one, so it hears nothing back"
        );
        assert!(player.lock().child.is_none(), "nothing is held any more");
        assert!(
            !is_alive(pid.expect("the player was running")),
            "no player is left behind"
        );
    }

    #[test]
    fn a_player_the_user_closed_goes_back_to_the_list() {
        let sandbox = Sandbox::new("clean-exit");
        // Up for long enough to close the modal, then a clean exit --
        // which is what quitting VLC looks like.
        let script = sandbox.player("setTimeout(() => process.exit(0), 900)");
        let heard = Dispatched::default();

        player(found(&script)).spawn(None, "http://x/0", "Sintel", heard.sink());

        assert_eq!(
            heard.wait_for(BACK_TO_LIST, Duration::from_secs(10)),
            vec![EXIT_MODAL, BACK_TO_LIST]
        );
    }

    #[test]
    fn a_player_that_fails_at_once_reports_itself_and_leaves_the_modal_up() {
        let sandbox = Sandbox::new("bad-exit");
        let heard = Dispatched::default();

        player(found(&sandbox.player("process.exit(1)"))).spawn(
            None,
            "http://x/0",
            "Sintel",
            heard.sink(),
        );

        assert_eq!(
            heard.wait_for(NOT_FOUND, Duration::from_secs(10)),
            vec![NOT_FOUND],
            "no exitModal: it never survived the first second"
        );
    }

    #[test]
    fn a_player_that_cannot_be_started_is_reported_as_not_found() {
        let heard = Dispatched::default();
        let player = player(missing());

        player.spawn(
            Some("/no/such/player"),
            "http://x/0",
            "Sintel",
            heard.sink(),
        );

        assert_eq!(
            heard.wait_for(NOT_FOUND, Duration::from_secs(5)),
            vec![NOT_FOUND]
        );
        assert!(player.lock().child.is_none());
    }

    #[test]
    fn no_vlc_on_the_machine_is_reported_before_anything_is_spawned() {
        let heard = Dispatched::default();
        let player = player(missing());

        player.spawn(None, "http://x/0", "Sintel", heard.sink());

        assert_eq!(
            heard.seen(),
            vec![NOT_FOUND],
            "said at once, not by a thread"
        );
        assert!(player.lock().child.is_none());
    }

    #[test]
    fn a_configured_player_is_given_the_url_alone_and_the_lookup_is_not_run() {
        let sandbox = Sandbox::new("configured");
        // `node <script>` with the script as the url: the point is that
        // the argument list is exactly `[url]`, with none of VLC's
        // flags -- we do not know what they would mean to this player.
        let script = sandbox.player("process.exit(0)");
        let heard = Dispatched::default();
        // A lookup that would answer, so that using it would be visible.
        let player = player(found(Path::new("/no/such/script.js")));

        player.spawn(
            Some("node"),
            &script.to_string_lossy(),
            "Sintel",
            heard.sink(),
        );

        assert_eq!(
            heard.wait_for(BACK_TO_LIST, Duration::from_secs(10)),
            vec![BACK_TO_LIST]
        );
        assert_eq!(sandbox.argv(), Vec::<String>::new());
    }

    #[test]
    fn a_configured_player_is_installed_without_looking_for_vlc() {
        let player = player(missing());
        assert!(player.installed(Some("/Applications/mpv.app")));
        // No player configured, and no VLC: the modal offers nothing.
        assert!(!player.installed(None));
        assert!(
            !player.installed(Some("")),
            "the empty default is no player"
        );
    }

    #[test]
    fn vlc_being_there_is_what_the_modal_offers() {
        let sandbox = Sandbox::new("installed");
        assert!(player(found(&sandbox.player("process.exit(0)"))).installed(None));
    }

    /// A candidate that hangs on `--version` must not strand the
    /// lookup's thread: past the deadline it is killed, reaped and
    /// treated as not answering.
    #[test]
    fn a_candidate_that_never_answers_is_not_vlc_once_the_deadline_passes() {
        let sandbox = Sandbox::new("probe-hangs");
        let pid = sandbox.path("pid");
        let script = sandbox.player(&format!(
            "require('fs').writeFileSync({pid:?}, String(process.pid))\n{STAYS_UP}"
        ));
        let candidate = Launch {
            program: PathBuf::from("node"),
            args: vec![script.to_string_lossy().into_owned()],
        };

        // Long enough for Node to start and write its pid.
        let deadline = Duration::from_millis(1500);
        let started = Instant::now();
        let answered = answers_version_within(&candidate, deadline);
        let took = started.elapsed();

        assert!(!answered);
        assert!(
            took < deadline + Duration::from_secs(2),
            "probe took {took:?}"
        );
        let pid: u32 = fs::read_to_string(&pid).unwrap().parse().unwrap();
        assert!(!is_alive(pid), "the hung candidate was left running");
    }

    #[test]
    fn a_candidate_that_answers_in_time_is_vlc() {
        let sandbox = Sandbox::new("probe-answers");
        let candidate = Launch {
            program: PathBuf::from("node"),
            args: vec![sandbox
                .player("process.exit(0)")
                .to_string_lossy()
                .into_owned()],
        };
        assert!(answers_version_within(&candidate, Duration::from_secs(5)));
    }

    #[test]
    fn killing_nothing_is_not_an_error() {
        let player = player(missing());
        player.kill();
        player.kill();
        assert!(player.lock().child.is_none());
    }

    /// The generation's whole job. Without it the first player's
    /// watching thread finds the *second* child in the slot, waits on
    /// that, and reports its exit as though it were the first
    /// player's -- one process ending, two `backToList`es.
    #[test]
    fn a_replaced_players_watcher_never_speaks_for_the_one_that_replaced_it() {
        let sandbox = Sandbox::new("generation");
        let player = player(found(&sandbox.player(STAYS_UP)));
        let first = Dispatched::default();
        let second = Dispatched::default();

        player.spawn(None, "http://x/0", "Sintel", first.sink());
        first.wait_for(EXIT_MODAL, Duration::from_secs(10));

        // A configured player this time, so that it is a different
        // script -- one that ends on its own while the first player's
        // thread is still polling.
        let ends = Sandbox::new("generation-second");
        let script = ends.player("setTimeout(() => process.exit(0), 700)");
        player.spawn(
            Some("node"),
            &script.to_string_lossy(),
            "Sintel",
            second.sink(),
        );

        assert_eq!(
            second.wait_for(BACK_TO_LIST, Duration::from_secs(10)),
            vec![EXIT_MODAL, BACK_TO_LIST],
            "the second player's own thread is the one that reports it"
        );
        // Long enough for a thread that was going to say it to have
        // said it.
        thread::sleep(Duration::from_millis(300));
        assert_eq!(
            first.seen(),
            vec![EXIT_MODAL],
            "and the first player's thread went quiet when it was replaced"
        );
    }

    #[test]
    fn opening_a_second_player_stops_the_first() {
        let sandbox = Sandbox::new("replace");
        let player = player(found(&sandbox.player(STAYS_UP)));
        let heard = Dispatched::default();

        player.spawn(None, "http://x/0", "Sintel", heard.sink());
        heard.wait_for(EXIT_MODAL, Duration::from_secs(10));
        let first = player.lock().child.as_ref().map(|c| c.id()).unwrap();

        player.spawn(None, "http://x/1", "Sintel", heard.sink());
        let second = player.lock().child.as_ref().map(|c| c.id()).unwrap();

        assert_ne!(first, second);
        assert!(!is_alive(first), "the player nothing could have stopped");
        player.kill();
    }

    /// Whether a pid is still a live process, without a signal crate --
    /// `engine.rs`'s test helper, for the same reason.
    #[cfg(unix)]
    fn is_alive(pid: u32) -> bool {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    #[cfg(not(unix))]
    fn is_alive(_pid: u32) -> bool {
        false
    }

    // -- the shim's half ------------------------------------------------

    fn repo() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri has a parent")
            .to_path_buf()
    }

    /// Every command the external-player half of the shim invokes is
    /// one `main.rs` defines and registers. The same cross-check
    /// `cast.rs` makes, and for the same reason: a command that is
    /// defined but never added to `generate_handler!` is a runtime
    /// error in a webview with no visible console.
    #[test]
    fn every_command_the_shim_invokes_is_defined_in_the_host() {
        let shim = fs::read_to_string(repo().join("src/renderer/lib/platform/ipc-os.js"))
            .expect("the OS shim is where it was");
        let host = fs::read_to_string(repo().join("src-tauri/src/main.rs"))
            .expect("main.rs is where it was");

        let commands = [
            "check_for_external_player",
            "open_external_player",
            "quit_external_player",
        ];
        for command in commands {
            assert!(
                shim.contains(&format!("invoke('{command}'")),
                "the shim invokes {command}"
            );
            assert!(
                host.contains(&format!("fn {command}(")),
                "main.rs defines the {command} command"
            );
            assert!(
                host.contains(&format!("            {command},")),
                "main.rs registers the {command} command"
            );
        }
    }
}
