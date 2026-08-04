//! The update check.
//!
//! This is `src/main/updater.js`, whose whole visible behaviour is one
//! request and one dispatch: ask the feed whether a newer version
//! exists, and if it does, tell the renderer -- which shows the
//! update-available modal through `controllers/update-controller.js`.
//! Nothing above the shim changes, because the channel and the action
//! name are the ones that host already sends.
//!
//! **One deliberate departure.** `src/main/updater.js` has two
//! branches: Linux does the check above, and macOS and Windows hand the
//! same URL to Electron's Squirrel-backed `autoUpdater`, which
//! downloads and installs a signed build in the background and never
//! shows the modal. This host does the check on all three platforms.
//! Downloading and installing an update needs a signed build and a
//! release feed that serves one, and both are Phase 5 (US-085); until
//! then, silently doing nothing on two platforms would be a worse port
//! than telling the user a new version exists. The user-visible
//! consequence on macOS and Windows: an update is announced rather than
//! applied, and the modal's "download" button opens the download page,
//! exactly as it does on Linux today.
//!
//! The shape is [`crate::dock`]'s: what a response *means* is a pure
//! function of a status code and a body, so every outcome is asserted
//! from one `cargo test` run, and the part that touches the network is
//! [`check`] at the bottom.

use std::time::Duration;

use crate::menu::Platform;

/// `config.AUTO_UPDATE_URL`. Mirrored rather than read, for the reason
/// [`crate::paths`] mirrors the path block: the host cannot load
/// `src/config.js`, and the test below shells out to node to prove the
/// two have not drifted.
pub const AUTO_UPDATE_URL: &str = "https://webtorrent.io/desktop/update";

/// `config.APP_VERSION`, which is `package.json`'s `version`. The
/// crate's version is kept in step with it by hand (see
/// `Cargo.toml`); the test below is what notices when it is not.
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// `config.DELAYED_INIT`. `delayedInit` in `src/main/index.js` waits
/// this long before calling `updater.init()`, so that starting up is
/// not competing with a network request -- and, here, so that the
/// renderer is listening before an answer can arrive.
pub const DELAYED_INIT: Duration = Duration::from_millis(3000);

/// How long the whole request may take before it is abandoned.
///
/// `simple-get` sets no timeout, so the Electron host's Linux check can
/// sit on a half-open connection for as long as the OS allows. Here it
/// would be a thread doing that, so it gets a bound. The number is not
/// load-bearing: nothing waits on this check, and a missed one is
/// retried by the next launch.
pub const TIMEOUT: Duration = Duration::from_secs(30);

/// What came back from the feed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// A newer version exists. The string is `data.version`, which the
    /// renderer shows in the modal and remembers if the user skips it.
    Available(String),
    /// Nothing to do -- the feed's 204.
    UpToDate,
    /// The check did not happen, or did not make sense. Logged and
    /// otherwise ignored, exactly as `src/main/updater.js` logs it:
    /// there is no failure the user could act on.
    Failed(String),
}

/// `process.platform`, as the feed's query string spells it.
pub fn platform_name(platform: Platform) -> &'static str {
    match platform {
        Platform::Mac => "darwin",
        Platform::Windows => "win32",
        Platform::Linux => "linux",
    }
}

/// `config.OS_SYSARCH`, which is `arch() === 'x64' ? 'x64' : 'ia32'`.
///
/// That `arch` is the npm package, not `os.arch()`, and it answers a
/// narrower question than its name suggests: it reports whether the
/// **operating system** is 64-bit, and it only ever says `x64` or
/// `x86`. So an Apple-silicon machine asks the feed for `x64`, not for
/// anything arm-shaped -- the query says how wide the OS is, and the
/// platform beside it says which OS. That is why this reads
/// [`sysarch_for`] over a pointer width rather than over
/// `target_arch`.
pub fn sysarch() -> &'static str {
    sysarch_for(cfg!(target_pointer_width = "64"))
}

/// [`sysarch`] as a decision, so both answers are asserted from a
/// build that can only be one of them.
///
/// The one place this parts company with the `arch` package: a 32-bit
/// *build* on a 64-bit OS. `arch` detects that (the WOW64 directory on
/// Windows, `getconf LONG_BIT` on Linux) because Electron ships a
/// 32-bit Windows build that must still be told the OS is 64-bit.
/// There is no 32-bit build of this host -- Tauri's targets are
/// `x86_64` and `aarch64` -- so the process's width is the OS's, and
/// the extra probe would be answering a question nothing asks.
pub fn sysarch_for(os_is_64_bit: bool) -> &'static str {
    if os_is_64_bit {
        "x64"
    } else {
        "ia32"
    }
}

/// The URL `src/main/updater.js` builds, as a pure function of its four
/// parts.
pub fn feed_url(base: &str, version: &str, platform: &str, sysarch: &str) -> String {
    format!("{base}?version={version}&platform={platform}&sysarch={sysarch}")
}

/// What a response means -- `onResponse` in `src/main/updater.js`.
pub fn outcome(status: u16, body: &str) -> Outcome {
    match status {
        200 => version_in(body),
        204 => Outcome::UpToDate,
        other => Outcome::Failed(format!("Unexpected status code: {other}")),
    }
}

/// The version an update-available body names.
///
/// A body without a usable `version` is a failure here, where the
/// Electron host would dispatch `undefined` and draw a modal offering
/// version `undefined`. A log line the user never sees is the better of
/// the two, and neither is a state anyone can act on.
fn version_in(body: &str) -> Outcome {
    let parsed: serde_json::Value = match serde_json::from_str(body) {
        Ok(parsed) => parsed,
        Err(err) => return Outcome::Failed(format!("Invalid JSON response: {err}")),
    };

    match parsed.get("version").and_then(serde_json::Value::as_str) {
        Some(version) => Outcome::Available(version.to_string()),
        None => Outcome::Failed("Response names no version".to_string()),
    }
}

// -- the part that touches the world ---------------------------------

/// Ask the feed, and say what it answered.
///
/// Blocking, so call it from a thread of its own: it is the whole of
/// what `get.concat(AUTO_UPDATE_URL, onResponse)` does, minus the
/// callback.
pub fn check(url: &str) -> Outcome {
    let agent = ureq::AgentBuilder::new()
        .timeout(TIMEOUT)
        // The feed answers a redirect for nothing today; following one
        // is what `simple-get` does, and this keeps that true.
        .redirects(4)
        .build();

    match agent.get(url).call() {
        Ok(response) => read_body(response.status(), response),
        // A status ureq considers an error is still an answer from the
        // feed, and 204 is not among them -- only 4xx and 5xx are, both
        // of which `outcome` reports as unexpected.
        Err(ureq::Error::Status(status, response)) => read_body(status, response),
        Err(err) => Outcome::Failed(err.to_string()),
    }
}

/// Read the body a status came with, and decide what the pair means.
fn read_body(status: u16, response: ureq::Response) -> Outcome {
    match response.into_string() {
        Ok(body) => outcome(status, &body),
        Err(err) => Outcome::Failed(err.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::{TcpListener, TcpStream};
    use std::path::Path;

    /// The query string the feed is asked for, character for character.
    /// It is a public URL with a server on the other end of it, so the
    /// spelling is not this host's to choose.
    #[test]
    fn builds_the_url_src_main_updater_js_builds() {
        assert_eq!(
            feed_url(AUTO_UPDATE_URL, "0.24.0", "darwin", "x64"),
            "https://webtorrent.io/desktop/update\
             ?version=0.24.0&platform=darwin&sysarch=x64"
        );
    }

    /// The feed knows two widths and no architectures; see
    /// [`sysarch_for`].
    #[test]
    fn a_64_bit_os_asks_for_x64_and_nothing_else_does() {
        assert_eq!(sysarch_for(true), "x64");
        assert_eq!(sysarch_for(false), "ia32");
    }

    /// `process.platform`, which is what the query string carries.
    #[test]
    fn platform_names_are_node_spellings() {
        assert_eq!(platform_name(Platform::Mac), "darwin");
        assert_eq!(platform_name(Platform::Windows), "win32");
        assert_eq!(platform_name(Platform::Linux), "linux");
    }

    /// The three constants above are copies of values in
    /// `src/config.js`, so a change made on the JS side alone fails
    /// here -- including the `package.json` version bump that the
    /// crate's own version is meant to follow by hand.
    ///
    /// Same recipe as `paths::tests::matches_src_config_js_on_this_platform`.
    #[test]
    fn matches_src_config_js() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("no repo root above src-tauri/");
        let script = "import('./src/config.js').then(m => \
             console.log(JSON.stringify([\
             m.AUTO_UPDATE_URL, m.APP_VERSION, m.OS_SYSARCH, m.DELAYED_INIT])))";

        let output = std::process::Command::new("node")
            .args(["--input-type=module", "-e", script])
            .current_dir(repo)
            .env_remove("NODE_ENV")
            .output()
            .expect("could not run node");
        assert!(
            output.status.success(),
            "node failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        let from_js: Vec<serde_json::Value> =
            serde_json::from_slice(&output.stdout).expect("config.js printed no JSON");

        assert_eq!(from_js[0], AUTO_UPDATE_URL);
        assert_eq!(from_js[1], APP_VERSION);
        // Node's `arch()` and this crate's `target_arch` are two
        // readings of the same machine.
        assert_eq!(from_js[2], sysarch());
        assert_eq!(from_js[3], DELAYED_INIT.as_millis() as u64);
    }

    /// The 200 branch: an update exists and the body names it.
    #[test]
    fn a_200_names_the_new_version() {
        assert_eq!(
            outcome(200, r#"{"version":"0.25.0","url":"https://example.test"}"#),
            Outcome::Available("0.25.0".to_string())
        );
    }

    /// The 204 branch, which is the one the feed answers almost always.
    #[test]
    fn a_204_is_up_to_date() {
        assert_eq!(outcome(204, ""), Outcome::UpToDate);
    }

    /// `JSON.parse` throwing is a log line and nothing else.
    #[test]
    fn a_200_that_is_not_json_fails() {
        assert!(matches!(
            outcome(200, "<html>gateway error</html>"),
            Outcome::Failed(_)
        ));
    }

    /// See [`version_in`]: better a log line than a modal offering
    /// version `undefined`.
    #[test]
    fn a_200_without_a_version_fails() {
        assert!(matches!(outcome(200, r#"{"url":"x"}"#), Outcome::Failed(_)));
        assert!(matches!(
            outcome(200, r#"{"version":7}"#),
            Outcome::Failed(_)
        ));
    }

    /// Anything else is the `Unexpected status code` branch.
    #[test]
    fn any_other_status_fails() {
        assert!(matches!(outcome(404, ""), Outcome::Failed(_)));
        assert!(matches!(outcome(500, "boom"), Outcome::Failed(_)));
    }

    /// A stub feed on a loopback port, answering the two outcomes that
    /// matter: an update, then no update. This is [`check`] itself --
    /// the agent, the request and the body -- rather than the pure
    /// decision the tests above cover.
    #[test]
    fn checks_a_stub_feed() {
        let (url, served) = stub_feed(vec![
            (200, r#"{"version":"9.9.9"}"#.to_string()),
            (204, String::new()),
        ]);

        assert_eq!(check(&url), Outcome::Available("9.9.9".to_string()));
        assert_eq!(check(&url), Outcome::UpToDate);

        // Both requests carried the query string the feed is asked for,
        // which is the half of `feed_url` a unit test cannot see.
        let requests = served.join().expect("the stub feed panicked");
        assert_eq!(requests.len(), 2);
        for request in requests {
            assert!(
                request.contains("?version=") && request.contains("&sysarch="),
                "asked for {request}"
            );
        }
    }

    /// Nothing listening is the ordinary failure -- no network on the
    /// machine, or the feed being down -- and it is a log line.
    #[test]
    fn a_feed_that_is_not_there_fails() {
        // Bound and dropped, so the port is one nothing answers on.
        let port = TcpListener::bind("127.0.0.1:0")
            .expect("no loopback port")
            .local_addr()
            .expect("no address")
            .port();

        assert!(matches!(
            check(&feed_url(
                &format!("http://127.0.0.1:{port}/desktop/update"),
                APP_VERSION,
                "linux",
                "x64"
            )),
            Outcome::Failed(_)
        ));
    }

    /// A feed that answers the given responses in order, one connection
    /// each, and hands back the request lines it saw.
    fn stub_feed(responses: Vec<(u16, String)>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("no loopback port");
        let port = listener.local_addr().expect("no address").port();

        let served = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for (status, body) in responses {
                let (stream, _) = listener.accept().expect("no connection");
                requests.push(serve(stream, status, &body));
            }
            requests
        });

        let url = feed_url(
            &format!("http://127.0.0.1:{port}/desktop/update"),
            APP_VERSION,
            platform_name(Platform::current()),
            sysarch(),
        );
        (url, served)
    }

    /// Read one request, answer it, and close -- so the client never
    /// waits on a connection this feed will not use again.
    fn serve(stream: TcpStream, status: u16, body: &str) -> String {
        let mut reader = BufReader::new(stream);
        let mut request = String::new();
        reader.read_line(&mut request).expect("no request line");

        // The headers are read to their blank line, so the client is
        // not answered mid-send.
        loop {
            let mut header = String::new();
            reader.read_line(&mut header).expect("no header");
            if header == "\r\n" || header.is_empty() {
                break;
            }
        }

        let response = format!(
            "HTTP/1.1 {status} \r\n\
             Content-Type: application/json\r\n\
             Content-Length: {}\r\n\
             Connection: close\r\n\r\n{body}",
            body.len()
        );
        let mut stream = reader.into_inner();
        stream.write_all(response.as_bytes()).expect("no answer");
        stream.flush().expect("no flush");

        request.trim().to_string()
    }
}
