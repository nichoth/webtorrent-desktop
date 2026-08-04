//! The engine sidecar's supervisor: `src/main/engine-process.js`.
//!
//! The torrent engine is a plain Node process (ADR-012), so somebody
//! has to own its lifecycle: spawn it at startup, learn the port it
//! bound, forward its output into the log, restart it when it dies,
//! and make sure a quit never leaves it running. That is this module,
//! and that is all of it -- no `wt-*` message passes through here, so
//! nothing in this file knows the protocol. The renderer talks to the
//! sidecar directly over a WebSocket, and the only thing it needs from
//! the host is where that socket is: [`Engine::wait_for_endpoint`] is
//! what answers `get_engine_endpoint`.
//!
//! Three parts of the Electron original are worth knowing before
//! changing anything here, because each is behaviour rather than
//! detail:
//!
//! - **The port arrives on one line of stdout.** [`PORT_LINE_PREFIX`]
//!   is kept in step with `src/engine/index.js`; everything else the
//!   child prints is log output.
//! - **A start that got as far as a bound port counts as healthy.**
//!   The restart allowance is reset there, so a crash days later gets
//!   the full five attempts again rather than the remains of the last
//!   bad patch.
//! - **The child is stopped by closing its stdin, not by a signal.**
//!   It is spawned with `WEBTORRENT_ENGINE_PARENT_PIPE=1`, which makes
//!   it shut down when that pipe closes -- so it destroys its client
//!   and releases the download directory on a clean quit, *and* dies
//!   on its own if the host is force quit and never gets to ask.
//!   `Child::kill` (SIGKILL, `TerminateProcess`) is the backstop after
//!   [`SHUTDOWN_GRACE`], which is what `engine-process.js` uses
//!   SIGTERM-then-SIGKILL for. Going through the pipe rather than a
//!   signal keeps this module `std`-only and identical on Windows.
//!
//! The decisions are pure functions of plain values -- [`backoff`],
//! [`parse_port_line`], [`Runtime::resolve`] -- in the same shape as
//! `paths.rs` and `window.rs`, and [`Engine`] is the managed state
//! `main.rs` reaches.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

/// The one stdout line the child promises us. Kept in step with
/// `src/engine/index.js` and `src/main/engine-process.js`.
pub const PORT_LINE_PREFIX: &str = "WEBTORRENT_ENGINE_PORT=";

const LOOPBACK: &str = "127.0.0.1";

/// How long a stopped child is given to close itself down before it is
/// killed outright. The 4s of `engine-process.js`.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(4);

/// How often a running child is checked for having exited. Nothing
/// waits on this -- the port line arrives on stdout, not here -- so it
/// only bounds how quickly a restart begins.
const REAP_INTERVAL: Duration = Duration::from_millis(50);

/// How long `get_engine_endpoint` waits before answering "not yet".
///
/// `engine-process.js` waits indefinitely; the renderer's reconnect
/// loop (`ipc-engine.js`) is happier with a `null` it can retry than
/// with a request that never settles, and a restart that has not
/// produced a port within this is a restart worth reporting.
pub const ENDPOINT_TIMEOUT: Duration = Duration::from_secs(30);

/// The restart policy.
///
/// Five attempts at 500ms doubling to 8s spans about 15 seconds, which
/// is long enough to ride out a transient port or filesystem fault and
/// short enough that a broken engine reports itself while the user is
/// still looking at the window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Policy {
    pub max_restarts: u32,
    pub backoff: Duration,
    pub max_backoff: Duration,
}

impl Default for Policy {
    fn default() -> Policy {
        Policy {
            max_restarts: 5,
            backoff: Duration::from_millis(500),
            max_backoff: Duration::from_millis(8000),
        }
    }
}

/// Where the engine is listening, and the credential it expects.
///
/// The same `{ url, token }` `ipc-os.getEngineEndpoint()` resolves to
/// under Electron: both field names are one word, so nothing here is
/// renamed on the way across.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Endpoint {
    pub url: String,
    pub token: String,
}

/// What to run, and from where.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Runtime {
    /// The Node binary. `node` off the `PATH` in development.
    pub program: PathBuf,
    /// The sidecar entry point, `build/engine/index.js`.
    pub entry: PathBuf,
    /// The child's working directory, which is what `src/config.js`
    /// resolves its relative paths against.
    pub cwd: PathBuf,
}

impl Runtime {
    /// Resolve the sidecar's location from the two roots the host
    /// knows about.
    ///
    /// In development the entry point is the Babel output in this
    /// repository and the runtime is whatever `node` is on the
    /// `PATH` -- which is the same Node `npm start` hands Electron
    /// through `ELECTRON_RUN_AS_NODE`.
    ///
    /// In a packaged app both live in the bundle's resource
    /// directory. **Putting them there is US-047**, which owns the
    /// packaging; this function is where that layout is stated, so
    /// that the supervisor itself does not change when it lands.
    pub fn resolve(repo_root: &Path, resource_dir: Option<&Path>, production: bool) -> Runtime {
        let root = match (production, resource_dir) {
            (true, Some(dir)) => dir.to_path_buf(),
            _ => repo_root.to_path_buf(),
        };
        let program = if production {
            root.join(if cfg!(target_os = "windows") {
                "node.exe"
            } else {
                "node"
            })
        } else {
            PathBuf::from("node")
        };
        Runtime {
            program,
            entry: root.join("build").join("engine").join("index.js"),
            cwd: root,
        }
    }
}

/// The delay before restart number `restarts` (counting from zero).
///
/// `Math.min(backoffMs * Math.pow(2, restarts), maxBackoffMs)`.
pub fn backoff(restarts: u32, policy: &Policy) -> Duration {
    let doubled = policy
        .backoff
        .checked_mul(1u32.checked_shl(restarts.min(31)).unwrap_or(u32::MAX))
        .unwrap_or(policy.max_backoff);
    doubled.min(policy.max_backoff)
}

/// The port out of one line of the child's stdout, if that is what the
/// line is.
///
/// A line that carries the prefix but not a port is a broken promise
/// rather than log output, so it is `Err` -- the caller logs it and
/// keeps reading, as `engine-process.js` does.
pub fn parse_port_line(line: &str) -> Option<Result<u16, &str>> {
    let rest = line.strip_prefix(PORT_LINE_PREFIX)?;
    Some(match rest.trim().parse::<u16>() {
        Ok(port) if port > 0 => Ok(port),
        _ => Err(rest),
    })
}

/// The URL a bound port becomes.
fn endpoint_url(port: u16) -> String {
    format!("ws://{LOOPBACK}:{port}")
}

/// A per-launch credential for the sidecar, as
/// `crypto.randomBytes(24).toString('hex')`.
fn new_token() -> String {
    let mut bytes = [0u8; 24];
    // The engine rejects a socket whose token does not match, so a
    // failure here has to be fatal rather than quietly predictable.
    getrandom::getrandom(&mut bytes).expect("no source of randomness for the engine token");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Default)]
struct State {
    endpoint: Option<Endpoint>,
    /// Consecutive restarts since the last time a port was bound.
    restarts: u32,
    /// `kill()` has been called; there will be no further child.
    stopped: bool,
    /// The restart allowance ran out. Torrenting is unavailable until
    /// the app is restarted, exactly as in `engine-process.js`.
    gave_up: bool,
    pid: Option<u32>,
}

struct Shared {
    token: String,
    policy: Policy,
    runtime: Runtime,
    state: Mutex<State>,
    /// Woken whenever `state` changes in a way a waiter cares about:
    /// an endpoint, a stop, or giving up.
    changed: Condvar,
    /// Held separately from `state` so that killing a child never
    /// blocks a reader of the endpoint. Lock order is `state` then
    /// `child`, never the other way.
    child: Mutex<Option<Child>>,
}

/// The supervisor for one engine sidecar.
///
/// Cloning it shares the same child: `main.rs` manages one and the
/// command clones it out of `tauri::State` to wait off the async
/// runtime's worker.
#[derive(Clone)]
pub struct Engine {
    shared: Arc<Shared>,
}

impl Engine {
    /// Create a supervisor. Nothing is spawned until [`Engine::start`].
    ///
    /// One token per launch, not per spawn: it is the app's credential
    /// for this engine and the renderer holds a copy. The port changes
    /// across a restart, so the renderer re-reads the endpoint anyway.
    pub fn new(runtime: Runtime, policy: Policy) -> Engine {
        Engine {
            shared: Arc::new(Shared {
                token: new_token(),
                policy,
                runtime,
                state: Mutex::new(State::default()),
                changed: Condvar::new(),
                child: Mutex::new(None),
            }),
        }
    }

    /// Spawn the sidecar and keep it running.
    ///
    /// Returns as soon as the supervising thread is up -- the port
    /// arrives later, and is waited for by
    /// [`Engine::wait_for_endpoint`].
    pub fn start(&self) {
        let shared = Arc::clone(&self.shared);
        thread::spawn(move || supervise(shared));
    }

    /// The endpoint if there is one right now, without waiting.
    ///
    /// `getEndpoint()` in `engine-process.js`, which the Electron main
    /// process does not call either -- every real caller wants the
    /// waiting form below, and this is how the tests read the state
    /// between the events they are asserting on.
    #[cfg(test)]
    pub fn endpoint(&self) -> Option<Endpoint> {
        self.shared.state.lock().unwrap().endpoint.clone()
    }

    /// The running child's pid, if there is one. `getPid()`, and the
    /// same story as [`Engine::endpoint`] above.
    #[cfg(test)]
    pub fn pid(&self) -> Option<u32> {
        self.shared.state.lock().unwrap().pid
    }

    /// The endpoint, waiting up to `timeout` for a sidecar that has
    /// not bound a port yet.
    ///
    /// This is what answers the renderer's `getEngineEndpoint`: the UI
    /// may ask before the first spawn has finished, or during the gap
    /// while a restart is in flight. `None` means there is no engine
    /// to offer -- stopped, given up, or still not listening -- which
    /// the renderer retries rather than treats as an error.
    pub fn wait_for_endpoint(&self, timeout: Duration) -> Option<Endpoint> {
        let deadline = Instant::now() + timeout;
        let mut state = self.shared.state.lock().unwrap();
        loop {
            if let Some(endpoint) = &state.endpoint {
                return Some(endpoint.clone());
            }
            if state.stopped || state.gave_up {
                return None;
            }
            let left = deadline.checked_duration_since(Instant::now())?;
            let (next, _) = self.shared.changed.wait_timeout(state, left).unwrap();
            state = next;
        }
    }

    /// Stop the sidecar and stop supervising it.
    ///
    /// Safe to call twice, and safe to call when nothing was ever
    /// spawned -- both happen on the way out of `RunEvent::Exit`.
    pub fn stop(&self) {
        {
            let mut state = self.shared.state.lock().unwrap();
            state.stopped = true;
            state.endpoint = None;
            self.shared.changed.notify_all();
        }
        self.shared.kill_child();
    }
}

impl Shared {
    fn stopped(&self) -> bool {
        self.state.lock().unwrap().stopped
    }

    /// Spawn one child and hand back its output streams.
    ///
    /// The stopped check is made while the child is being stored, not
    /// before it is spawned: a `stop()` that lands in between would
    /// otherwise leave a process nobody holds.
    fn spawn_child(&self) -> std::io::Result<(ChildStdout, ChildStderr)> {
        let mut child = Command::new(&self.runtime.program)
            .arg(&self.runtime.entry)
            .current_dir(&self.runtime.cwd)
            .env("WEBTORRENT_ENGINE_TOKEN", &self.token)
            // Tells the child to shut down when this pipe closes, which
            // is what stops an orphan when the host dies without
            // quitting.
            .env("WEBTORRENT_ENGINE_PARENT_PIPE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        let stdout = child.stdout.take().expect("stdout was piped");
        let stderr = child.stderr.take().expect("stderr was piped");
        let pid = child.id();

        let mut state = self.state.lock().unwrap();
        if state.stopped {
            drop(state);
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "the app quit while the engine was starting",
            ));
        }
        state.pid = Some(pid);
        *self.child.lock().unwrap() = Some(child);
        Ok((stdout, stderr))
    }

    /// Read the child's output until it closes both streams, noting
    /// the port line on the way past.
    fn pump(&self, stdout: ChildStdout, stderr: ChildStderr) {
        let errors = thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("Engine: {line}");
            }
        });

        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            match parse_port_line(&line) {
                Some(Ok(port)) => self.on_port(port),
                Some(Err(_)) => eprintln!("Engine: unparseable port line, ignoring"),
                None => {}
            }
            println!("Engine: {line}");
        }

        let _ = errors.join();
    }

    /// A port was bound.
    fn on_port(&self, port: u16) {
        let mut state = self.state.lock().unwrap();
        // A start that got as far as a bound port counts as healthy,
        // so a crash days later gets the full restart allowance again.
        state.restarts = 0;
        state.endpoint = Some(Endpoint {
            url: endpoint_url(port),
            token: self.token.clone(),
        });
        self.changed.notify_all();
    }

    /// Wait for the child to exit, and forget it.
    fn reap(&self) {
        loop {
            {
                let mut held = self.child.lock().unwrap();
                match held.as_mut() {
                    None => break,
                    Some(child) => match child.try_wait() {
                        Ok(Some(status)) => {
                            if !self.stopped() {
                                eprintln!("Engine: exited with {status}");
                            }
                            *held = None;
                            break;
                        }
                        Ok(None) => {}
                        Err(err) => {
                            eprintln!("Engine: could not wait for the child: {err}");
                            *held = None;
                            break;
                        }
                    },
                }
            }
            thread::sleep(REAP_INTERVAL);
        }

        let mut state = self.state.lock().unwrap();
        state.endpoint = None;
        state.pid = None;
    }

    /// Close the child down: its own pipe first, the kernel's way
    /// second.
    fn kill_child(&self) {
        let mut dying = match self.child.lock().unwrap().take() {
            Some(child) => child,
            None => return,
        };

        // Closing stdin is what `WEBTORRENT_ENGINE_PARENT_PIPE` makes
        // a shutdown request, and it is the only one that lets the
        // engine destroy its client first.
        drop(dying.stdin.take());

        let deadline = Instant::now() + SHUTDOWN_GRACE;
        loop {
            match dying.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => {}
                Err(_) => return,
            }
            if Instant::now() >= deadline {
                break;
            }
            thread::sleep(REAP_INTERVAL);
        }

        let _ = dying.kill();
        let _ = dying.wait();
    }

    /// Sleep, unless a stop arrives first. `true` means stop.
    fn sleep_or_stop(&self, delay: Duration) -> bool {
        let state = self.state.lock().unwrap();
        if state.stopped {
            return true;
        }
        let (state, _) = self.changed.wait_timeout(state, delay).unwrap();
        state.stopped
    }

    /// Decide what happens after an exit. `true` means try again.
    fn schedule_restart(&self) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.restarts >= self.policy.max_restarts {
            state.gave_up = true;
            eprintln!(
                "Engine: giving up after {} restarts. Torrenting is \
                 unavailable until the app is restarted.",
                state.restarts
            );
            // A waiting renderer has to hear about it too, or it hangs
            // on a request that can no longer be answered.
            self.changed.notify_all();
            return false;
        }
        let delay = backoff(state.restarts, &self.policy);
        state.restarts += 1;
        eprintln!(
            "Engine: restarting in {}ms (attempt {} of {})",
            delay.as_millis(),
            state.restarts,
            self.policy.max_restarts
        );
        drop(state);
        !self.sleep_or_stop(delay)
    }
}

/// The supervising thread: spawn, read, reap, restart.
fn supervise(shared: Arc<Shared>) {
    loop {
        if shared.stopped() {
            return;
        }
        match shared.spawn_child() {
            Ok((stdout, stderr)) => {
                shared.pump(stdout, stderr);
                shared.reap();
            }
            Err(err) => {
                if shared.stopped() {
                    return;
                }
                eprintln!("Engine: failed to spawn: {err}");
            }
        }
        if shared.stopped() || !shared.schedule_restart() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};

    // -- the pure parts ------------------------------------------------

    #[test]
    fn a_port_line_is_the_only_line_that_carries_a_port() {
        assert_eq!(
            parse_port_line("WEBTORRENT_ENGINE_PORT=51423"),
            Some(Ok(51423))
        );
        assert_eq!(parse_port_line("init: 412ms"), None);
        // The engine prints the prefix at the start of a line and
        // nowhere else, so this is log output rather than a port.
        assert_eq!(parse_port_line("saw WEBTORRENT_ENGINE_PORT=1"), None);
    }

    #[test]
    fn a_broken_port_line_is_reported_rather_than_believed() {
        assert!(matches!(
            parse_port_line("WEBTORRENT_ENGINE_PORT=banana"),
            Some(Err(_))
        ));
        assert!(matches!(
            parse_port_line("WEBTORRENT_ENGINE_PORT=0"),
            Some(Err(_))
        ));
        assert!(matches!(
            parse_port_line("WEBTORRENT_ENGINE_PORT="),
            Some(Err(_))
        ));
    }

    #[test]
    fn the_backoff_doubles_to_a_cap() {
        let policy = Policy::default();
        let delays: Vec<u128> = (0..7).map(|n| backoff(n, &policy).as_millis()).collect();
        assert_eq!(delays, vec![500, 1000, 2000, 4000, 8000, 8000, 8000]);
    }

    #[test]
    fn the_development_sidecar_is_the_babel_output_and_the_path_node() {
        let runtime = Runtime::resolve(Path::new("/repo"), Some(Path::new("/bundle")), false);
        assert_eq!(runtime.program, PathBuf::from("node"));
        assert_eq!(runtime.entry, PathBuf::from("/repo/build/engine/index.js"));
        assert_eq!(runtime.cwd, PathBuf::from("/repo"));
    }

    #[test]
    fn the_packaged_sidecar_is_next_to_its_runtime_in_the_resources() {
        let runtime = Runtime::resolve(Path::new("/repo"), Some(Path::new("/bundle")), true);
        assert_eq!(
            runtime.entry,
            PathBuf::from("/bundle/build/engine/index.js")
        );
        assert_eq!(runtime.cwd, PathBuf::from("/bundle"));
        assert!(runtime.program.starts_with("/bundle"));
    }

    // -- supervision, against a fake sidecar ---------------------------
    //
    // The real engine needs a WebTorrent client and a free port; what
    // is being asserted here is the supervisor, and the whole of its
    // contract with the child is three things -- one line on stdout,
    // an exit status, and a stdin that closing means quit. A few lines
    // of Node say all three, and `node` is already what `paths.rs`
    // shells out to.

    static SEQ: AtomicU32 = AtomicU32::new(0);

    /// A directory of this test's own, and the paths inside it.
    struct Sandbox {
        dir: PathBuf,
    }

    impl Sandbox {
        fn new(name: &str) -> Sandbox {
            let n = SEQ.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir().join(format!(
                "wt-engine-{}-{}-{}",
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

        /// Write a fake sidecar and return the runtime that runs it.
        fn sidecar(&self, source: &str) -> Runtime {
            let entry = self.path("sidecar.js");
            fs::write(&entry, source).unwrap();
            Runtime {
                program: PathBuf::from("node"),
                entry,
                cwd: self.dir.clone(),
            }
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    /// A sidecar that binds, stays up, and honours the parent pipe --
    /// leaving `farewell` behind so the graceful path is observable.
    fn healthy(port: u16, farewell: &Path) -> String {
        format!(
            r#"
            const fs = require('fs')
            process.stdin.on('end', () => {{
              fs.writeFileSync({farewell:?}, 'closed the client')
              process.exit(0)
            }})
            process.stdin.resume()
            console.log('some other line')
            console.log('WEBTORRENT_ENGINE_PORT={port}')
            setInterval(() => {{}}, 1000)
            "#
        )
    }

    fn brisk() -> Policy {
        Policy {
            max_restarts: 3,
            backoff: Duration::from_millis(10),
            max_backoff: Duration::from_millis(20),
        }
    }

    #[test]
    fn the_endpoint_is_the_port_the_child_printed_and_the_launch_token() {
        let sandbox = Sandbox::new("endpoint");
        let farewell = sandbox.path("farewell");
        let engine = Engine::new(sandbox.sidecar(&healthy(51423, &farewell)), brisk());
        engine.start();

        let endpoint = engine
            .wait_for_endpoint(Duration::from_secs(20))
            .expect("the sidecar bound a port");
        assert_eq!(endpoint.url, "ws://127.0.0.1:51423");
        assert_eq!(endpoint.token.len(), 48, "24 random bytes as hex");
        assert!(endpoint.token.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(engine.pid().is_some(), "the child is running");

        engine.stop();
    }

    #[test]
    fn stopping_closes_the_pipe_and_leaves_no_child_behind() {
        let sandbox = Sandbox::new("stop");
        let farewell = sandbox.path("farewell");
        let engine = Engine::new(sandbox.sidecar(&healthy(51424, &farewell)), brisk());
        engine.start();

        let pid = {
            let _ = engine.wait_for_endpoint(Duration::from_secs(20)).unwrap();
            engine.pid().expect("a running child")
        };
        engine.stop();

        assert!(
            farewell.exists(),
            "the child shut itself down through the parent pipe rather \
             than being killed"
        );
        assert_eq!(engine.endpoint(), None, "there is nothing left to offer");
        assert!(!is_alive(pid), "no orphan survives the stop");
    }

    #[test]
    fn a_crash_is_restarted_and_the_new_port_is_what_callers_get() {
        let sandbox = Sandbox::new("restart");
        let farewell = sandbox.path("farewell");
        let counter = sandbox.path("attempts");
        // Exits at once the first two times, then behaves. The second
        // port is a different one, which is what a caller holding the
        // first would have got wrong.
        let source = format!(
            r#"
            const attempts = require('fs')
            const seen = attempts.existsSync({counter:?})
              ? Number(attempts.readFileSync({counter:?}, 'utf8'))
              : 0
            attempts.writeFileSync({counter:?}, String(seen + 1))
            if (seen < 2) {{
              console.error('engine failed to listen')
              process.exit(1)
            }}
            {healthy}
            "#,
            healthy = healthy(51425, &farewell)
        );

        let engine = Engine::new(sandbox.sidecar(&source), brisk());
        engine.start();

        let endpoint = engine
            .wait_for_endpoint(Duration::from_secs(30))
            .expect("the third attempt bound a port");
        assert_eq!(endpoint.url, "ws://127.0.0.1:51425");
        assert_eq!(fs::read_to_string(&counter).unwrap(), "3");

        engine.stop();
    }

    #[test]
    fn a_sidecar_that_never_starts_is_given_up_on_rather_than_waited_for() {
        let sandbox = Sandbox::new("giveup");
        let engine = Engine::new(sandbox.sidecar("process.exit(1)"), brisk());
        engine.start();

        // The wait is far longer than three attempts at 10ms take, so
        // an answer inside it is the supervisor having given up rather
        // than the timeout expiring.
        let started = Instant::now();
        assert_eq!(engine.wait_for_endpoint(Duration::from_secs(30)), None);
        assert!(started.elapsed() < Duration::from_secs(25));

        // And it stays given up: a later ask is answered at once.
        let again = Instant::now();
        assert_eq!(engine.wait_for_endpoint(Duration::from_secs(30)), None);
        assert!(again.elapsed() < Duration::from_secs(1));

        engine.stop();
    }

    #[test]
    fn stopping_something_that_never_spawned_is_not_an_error() {
        let sandbox = Sandbox::new("never");
        let engine = Engine::new(sandbox.sidecar("process.exit(0)"), brisk());
        engine.stop();
        engine.stop();
        assert_eq!(engine.wait_for_endpoint(Duration::from_millis(50)), None);
    }

    /// Whether a pid is still a live process, without a signal crate:
    /// `kill -0` is the portable-enough answer on the platforms this
    /// test runs on.
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
}
