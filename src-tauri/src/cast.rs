//! Casting: the Rust half of `platform/cast.js` (US-075).
//!
//! ADR-015 moves Chromecast, DLNA and AirPlay out of
//! `src/renderer/lib/cast.js` and into this host. What lands here
//! first is the *shape* of that: the plain-data types the shim's
//! payloads deserialize into, the event names the renderer listens
//! on, and a session that owns no protocol at all.
//!
//! So every device command answers [`not_implemented`] and discovery
//! reports an empty list. That is a complete answer rather than a
//! broken one: `player-page.js` shows a cast button only for a
//! protocol with devices in it, so a protocol that has not landed has
//! no control on screen. A protocol that *has* landed and whose
//! discovery fails is the other case, and it emits [`ERROR_EVENT`] --
//! which is why an empty list is silent.
//!
//! `main.rs` holds the commands, as it does for every other module
//! here. What lives here is everything that can be decided without a
//! device on the network, so `cargo test` covers it: the wire shapes,
//! the protocol names the UI matches on, and the session's own
//! bookkeeping.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// The whole device list, on every change (ADR-015). Sending the list
/// rather than a delta is what lets a receiver that goes away
/// disappear -- the bug `lib/cast.js` documents and does not fix.
pub const DEVICES_EVENT: &str = "castDevices";

/// The connected device's playback state, pushed by the host's poll
/// rather than pulled by the renderer's `setInterval`.
///
/// Nothing emits it yet, because nothing connects yet: the first
/// emitter is the Chromecast session in US-076. It is declared here
/// rather than there because the renderer already subscribes to it --
/// the name is contract with `platform/cast.js`, and the two are
/// checked against each other below.
#[allow(dead_code)]
pub const STATUS_EVENT: &str = "castStatus";

/// A cast failure, as a message for the renderer's `state.errors`.
///
/// Unemitted for the same reason, and for one more: ADR-015 has an
/// unimplemented protocol report *no devices and no error*, so the
/// first thing that can raise this is the first discovery that can
/// fail (US-076).
#[allow(dead_code)]
pub const ERROR_EVENT: &str = "castError";

/// A cast protocol.
///
/// The serialized names are the strings the UI already matches on --
/// `player-page.js` keys `state.devices` by them and compares
/// `state.playing.location` against them and their `-pending`
/// variants -- so renaming one here changes the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    Chromecast,
    Dlna,
    Airplay,
}

impl Protocol {
    /// Every protocol the port owes, in the order ADR-015 lands them.
    pub const ALL: [Protocol; 3] = [Protocol::Chromecast, Protocol::Dlna, Protocol::Airplay];

    /// The story that implements this protocol, for the message an
    /// unimplemented command answers with.
    pub fn story(self) -> &'static str {
        match self {
            Protocol::Chromecast => "US-076",
            Protocol::Dlna => "US-077",
            Protocol::Airplay => "US-078",
        }
    }
}

/// Something a device can be asked to do.
///
/// This is the array `playback-controller.js` keeps its synchronous
/// answers from: `Cast.setRate()` returns a boolean today, and under
/// the async shim that boolean is "does the connected device list
/// `rate`".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Capability {
    Play,
    Pause,
    Seek,
    Volume,
    Rate,
}

/// A receiver on the local network, as the renderer sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    /// Unique for as long as the device is on the network, and opaque
    /// to the renderer -- it hands it back to `cast_connect` and does
    /// nothing else with it.
    pub id: String,
    pub protocol: Protocol,
    /// What the user picked out of the cast menu.
    pub name: String,
    pub capabilities: Vec<Capability>,
}

/// What to play, as `cast_connect` receives it.
///
/// The media URL is the engine's own `networkURL`
/// (`torrent.createServer()`), so nothing here is the host's to
/// produce -- except the subtitles, which cross as cue text because
/// the renderer no longer has an HTTP server to publish them from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Media {
    pub url: String,
    pub title: String,
    pub content_type: String,
    /// The selected subtitle track's cue text, or `None` when the user
    /// has none selected. The shim sends `null` rather than omitting
    /// the key, so this is an explicit absence.
    pub subtitles_vtt: Option<String>,
    /// Where to start, in seconds, for a resumed torrent.
    pub start_time: Option<f64>,
}

/// The connected device's playback state.
///
/// The fields are exactly the ones `lib/cast.js` folds into
/// `state.playing` on each poll of its `status()`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub device_id: String,
    pub is_paused: bool,
    pub current_time: f64,
    pub volume: f64,
    pub ended: bool,
}

/// What a command answers while its protocol is unwritten.
///
/// It names the operation and the stories that owe it, because this
/// message is what a user sees in an error toast if the UI ever
/// reaches a control it should have hidden -- and what a developer
/// sees in the console if it does not.
pub fn not_implemented(operation: &str) -> String {
    let owed: Vec<String> = Protocol::ALL
        .iter()
        .map(|protocol| format!("{:?} in {}", protocol, protocol.story()))
        .collect();

    format!(
        "cast.{}() is not implemented yet (ADR-015). Casting lands one protocol at a time: {}.",
        operation,
        owed.join(", ")
    )
}

/// The host's cast session: what discovery has found.
///
/// Managed state in `main.rs`, one per app. It holds no protocol yet,
/// so [`Session::devices`] is empty for as long as US-076 through
/// US-078 are open -- but the bookkeeping around it is the real
/// thing, so a protocol implementation adds a discoverer rather than
/// a session.
#[derive(Debug, Default)]
pub struct Session {
    devices: Mutex<Vec<Device>>,
}

impl Session {
    /// The devices found so far, which is none until a protocol lands.
    ///
    /// This is what every [`DEVICES_EVENT`] carries and what
    /// `cast_get_devices` answers, so the renderer's mirror and its
    /// first read can never disagree.
    pub fn devices(&self) -> Vec<Device> {
        self.devices.lock().expect("cast device list").clone()
    }

    /// Forget every device found so far, which is what stopping
    /// discovery does: the renderer's mirror is rebuilt from the
    /// event that follows, and a receiver that has since been
    /// unplugged is worse in a menu than an empty menu.
    ///
    /// There is no matching "start": discovery starting twice is
    /// ordinary -- `main.js` starts it whenever the player opens --
    /// so a protocol's discoverer owns its own idempotence rather
    /// than a flag here owning it for all three.
    pub fn forget_devices(&self) {
        self.devices.lock().expect("cast device list").clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::{json, Value};

    #[test]
    fn a_protocol_serializes_to_the_string_the_ui_matches_on() {
        // `player-page.js` keys `state.devices` by these and compares
        // `state.playing.location` against them; they are UI contract,
        // not an internal spelling.
        assert_eq!(json!(Protocol::Chromecast), json!("chromecast"));
        assert_eq!(json!(Protocol::Dlna), json!("dlna"));
        assert_eq!(json!(Protocol::Airplay), json!("airplay"));
    }

    #[test]
    fn a_capability_serializes_to_the_operation_it_names() {
        let all = vec![
            Capability::Play,
            Capability::Pause,
            Capability::Seek,
            Capability::Volume,
            Capability::Rate,
        ];
        assert_eq!(
            json!(all),
            json!(["play", "pause", "seek", "volume", "rate"])
        );
    }

    #[test]
    fn a_device_crosses_as_the_shim_documents_it() {
        let device = Device {
            id: "chromecast:1".into(),
            protocol: Protocol::Chromecast,
            name: "Living Room".into(),
            capabilities: vec![Capability::Play, Capability::Pause],
        };

        assert_eq!(
            serde_json::to_value(&device).unwrap(),
            json!({
                "id": "chromecast:1",
                "protocol": "chromecast",
                "name": "Living Room",
                "capabilities": ["play", "pause"]
            })
        );
    }

    #[test]
    fn a_status_crosses_in_the_renderers_spelling() {
        let status = Status {
            device_id: "dlna:2".into(),
            is_paused: true,
            current_time: 42.5,
            volume: 0.5,
            ended: false,
        };

        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            json!({
                "deviceId": "dlna:2",
                "isPaused": true,
                "currentTime": 42.5,
                "volume": 0.5,
                "ended": false
            })
        );
    }

    #[test]
    fn a_media_description_arrives_in_the_shims_spelling() {
        let media: Media = serde_json::from_value(json!({
            "url": "http://192.168.1.5:8080/0",
            "title": "Sintel",
            "contentType": "video/mp4",
            "subtitlesVtt": "WEBVTT\n",
            "startTime": 12.5
        }))
        .expect("the shim's payload deserializes");

        assert_eq!(media.content_type, "video/mp4");
        assert_eq!(media.subtitles_vtt.as_deref(), Some("WEBVTT\n"));
        assert_eq!(media.start_time, Some(12.5));
    }

    #[test]
    fn an_omitted_track_and_start_time_arrive_as_null() {
        // The shim sends `null` rather than dropping the key, because
        // a dropped key and "no subtitle track selected" are not the
        // same thing. Both spellings read the same here, which is what
        // keeps that a shim decision rather than a protocol one.
        let explicit: Media = serde_json::from_value(json!({
            "url": "http://192.168.1.5:8080/0",
            "title": "Sintel",
            "contentType": "video/mp4",
            "subtitlesVtt": Value::Null,
            "startTime": Value::Null
        }))
        .expect("an explicit null deserializes");

        assert_eq!(explicit.subtitles_vtt, None);
        assert_eq!(explicit.start_time, None);
    }

    #[test]
    fn discovery_finds_nothing_and_says_so_quietly() {
        let session = Session::default();

        assert_eq!(
            session.devices(),
            Vec::new(),
            "no protocol is implemented, so there is nothing to report"
        );

        session.forget_devices();
        assert_eq!(session.devices(), Vec::new(), "and stopping keeps it empty");
    }

    /// The repository root, for the two cross-checks below.
    fn repo() -> std::path::PathBuf {
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        manifest
            .parent()
            .expect("src-tauri has a parent")
            .to_path_buf()
    }

    fn shim_source() -> String {
        std::fs::read_to_string(repo().join("src/renderer/lib/platform/cast.js"))
            .expect("the cast shim is where it was")
    }

    /// The three event names are contract with `platform/cast.js`,
    /// which subscribes to them by string. Nothing else checks the two
    /// ends against each other -- the renderer's suite stubs the host
    /// and this crate never loads the renderer -- so the file is read.
    /// The same shape as `paths.rs`'s cross-check of `src/config.js`.
    #[test]
    fn the_renderer_listens_on_the_names_the_host_emits() {
        let source = shim_source();

        for event in [DEVICES_EVENT, STATUS_EVENT, ERROR_EVENT] {
            assert!(
                source.contains(&format!("'{event}'")),
                "the shim subscribes to {event}"
            );
        }
    }

    /// Every command the shim invokes exists in `main.rs`.
    ///
    /// `generate_handler!` catches a name that is registered and
    /// undefined; nothing catches a name the *renderer* invokes and
    /// the host never defined, because that failure is a rejected
    /// promise in a webview at runtime. This is the check for it, and
    /// it is here rather than in the renderer's suite because that
    /// suite stubs `invoke` and so cannot see the host at all.
    #[test]
    fn every_command_the_shim_invokes_is_defined_in_the_host() {
        let shim = shim_source();
        let host = std::fs::read_to_string(repo().join("src-tauri/src/main.rs"))
            .expect("main.rs is where it was");

        let mut found = 0;
        for piece in shim.split("invoke('").skip(1) {
            let command = piece.split('\'').next().expect("a closed string literal");
            assert!(
                host.contains(&format!("fn {command}(")),
                "main.rs defines the {command} command"
            );
            assert!(
                host.contains(&format!("            {command},"))
                    || host.contains(&format!("            {command}\n")),
                "main.rs registers the {command} command"
            );
            found += 1;
        }
        assert_eq!(found, 11, "every command in the shim was checked");
    }

    #[test]
    fn an_unimplemented_command_says_what_is_missing() {
        let message = not_implemented("connect");

        assert!(message.contains("cast.connect()"), "{message}");
        assert!(message.contains("ADR-015"), "{message}");
        for protocol in Protocol::ALL {
            assert!(message.contains(protocol.story()), "{message}");
        }
    }
}
