//! The media keys, held only while the player is open.
//!
//! This is the Rust half of `src/main/shortcuts.js`, whose whole
//! content is three `globalShortcut.register` calls and the three
//! `unregister` calls that give the keys back to the OS. A global
//! shortcut is taken from every other application on the machine for
//! as long as it is held, which is why Electron registers them on
//! `onPlayerOpen` and releases them on `onPlayerClose` rather than at
//! startup -- and why the release matters more than the registration.
//!
//! The split is [`crate::power`]'s: what the keys *are* is a table of
//! plain values ([`MEDIA_KEYS`]), the bookkeeping that keeps them from
//! being held twice or leaked is [`MediaShortcuts`] over a fake
//! [`Keys`] in the tests, and the part that touches the world -- the
//! `global-shortcut` plugin -- is at the bottom of the file.

use std::sync::Mutex;

use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// One media key: the accelerator the OS is asked for, and the
/// renderer action pressing it dispatches.
pub struct MediaKey {
    /// **Not Electron's spelling.** Electron's `MediaNextTrack` and
    /// `MediaPreviousTrack` are `MediaTrackNext` and
    /// `MediaTrackPrevious` to the parser behind this plugin, which
    /// takes the `KeyboardEvent.code` names. Unlike the application
    /// menu's accelerators (see `crate::menu`), one that does not
    /// parse is an error rather than a silent drop -- and
    /// `every_accelerator_parses` below is what proves these three do.
    pub accelerator: &'static str,
    /// `windows.main.dispatch(action)`, which is what each of the
    /// three handlers in `src/main/shortcuts.js` does.
    pub action: &'static str,
}

/// The three keys `src/main/shortcuts.js` registers, in its order.
pub const MEDIA_KEYS: [MediaKey; 3] = [
    MediaKey {
        accelerator: "MediaPlayPause",
        action: "playPause",
    },
    MediaKey {
        accelerator: "MediaTrackNext",
        action: "nextTrack",
    },
    MediaKey {
        accelerator: "MediaTrackPrevious",
        action: "previousTrack",
    },
];

/// Whatever can take a media key from the rest of the machine and give
/// it back. The real one is the `global-shortcut` plugin, below.
pub trait Keys: Send + Sync {
    fn register(&self, key: &'static MediaKey) -> Result<(), String>;
    fn unregister(&self, key: &'static MediaKey) -> Result<(), String>;
}

/// `src/main/shortcuts.js`, with the bookkeeping Electron gets for
/// free.
///
/// `globalShortcut.unregister` on a key that was never registered is a
/// no-op there, and `register` on one already held simply replaces the
/// handler; here both are errors from the OS, so what is held is
/// tracked. It is the *keys that were actually taken* rather than a
/// flag: a key another application already owns is refused, and
/// handing back a key that was never taken would report an error the
/// user cannot act on.
pub struct MediaShortcuts {
    keys: Box<dyn Keys>,
    held: Mutex<Vec<&'static MediaKey>>,
}

impl MediaShortcuts {
    /// The real thing: the keys are taken through the plugin and each
    /// press dispatches to the renderer.
    pub fn global(app: AppHandle) -> Self {
        Self::new(Box::new(Global { app }))
    }

    pub fn new(keys: Box<dyn Keys>) -> Self {
        Self {
            keys,
            held: Mutex::new(Vec::new()),
        }
    }

    /// `shortcuts.enable()`: the player is open, so the media keys
    /// drive it.
    ///
    /// A key the OS refuses is reported and not recorded, so the next
    /// player open asks for it again rather than believing it is held
    /// -- and so [`disable`](Self::disable) does not hand back a key
    /// this process never had.
    pub fn enable(&self) {
        let mut held = self.held.lock().unwrap_or_else(|err| err.into_inner());
        if !held.is_empty() {
            return;
        }

        for key in &MEDIA_KEYS {
            match self.keys.register(key) {
                Ok(()) => held.push(key),
                Err(err) => eprintln!("shortcuts.enable {}: {err}", key.accelerator),
            }
        }
    }

    /// `shortcuts.disable()`: "return the media key to the OS, so
    /// other apps can use it".
    pub fn disable(&self) {
        let mut held = self.held.lock().unwrap_or_else(|err| err.into_inner());

        for key in held.drain(..) {
            if let Err(err) = self.keys.unregister(key) {
                eprintln!("shortcuts.disable {}: {err}", key.accelerator);
            }
        }
    }

    /// Which keys are held. Nothing in the host asks -- the guard in
    /// [`enable`](Self::enable) is the only reader -- so this is here
    /// for the tests that assert on it.
    #[cfg(test)]
    fn held(&self) -> Vec<&'static str> {
        self.held
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .iter()
            .map(|key| key.accelerator)
            .collect()
    }
}

/// The media keys are global state of the *machine*, not of this
/// process: a host that exits holding them is the failure this guards
/// against, and it is the same one `disable` guards against on the way
/// out of a player.
impl Drop for MediaShortcuts {
    fn drop(&mut self) {
        self.disable();
    }
}

// -- the part that touches the world ---------------------------------

/// The `global-shortcut` plugin, reached from Rust. As with every
/// other plugin here (ADR-005), the renderer cannot call it: the
/// plugin's own commands are not in `capabilities/default.json`.
struct Global {
    app: AppHandle,
}

impl Keys for Global {
    fn register(&self, key: &'static MediaKey) -> Result<(), String> {
        self.app
            .global_shortcut()
            .on_shortcut(key.accelerator, move |app, _shortcut, event| {
                // A media key reports its press *and* its release.
                // Electron's handler runs once per press, so a
                // release is dropped rather than skipping two tracks.
                if event.state == ShortcutState::Pressed {
                    crate::dispatch(app, key.action, Vec::new());
                }
            })
            .map_err(|err| err.to_string())
    }

    fn unregister(&self, key: &'static MediaKey) -> Result<(), String> {
        self.app
            .global_shortcut()
            .unregister(key.accelerator)
            .map_err(|err| err.to_string())
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;
    use std::sync::{Arc, Mutex};

    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

    use super::*;

    /// What a fake [`Keys`] was asked for, in order: the question
    /// every test here asks is which keys were taken and whether they
    /// were all given back.
    #[derive(Default)]
    struct Log(Mutex<Vec<String>>);

    impl Log {
        fn calls(&self) -> Vec<String> {
            self.0.lock().unwrap().clone()
        }

        fn clear(&self) {
            self.0.lock().unwrap().clear();
        }
    }

    struct Fake {
        log: Arc<Log>,
        /// The accelerator some other application already owns.
        refuses: Option<&'static str>,
    }

    impl Keys for Fake {
        fn register(&self, key: &'static MediaKey) -> Result<(), String> {
            if self.refuses == Some(key.accelerator) {
                return Err("already registered".to_string());
            }
            self.log
                .0
                .lock()
                .unwrap()
                .push(format!("register {}", key.accelerator));
            Ok(())
        }

        fn unregister(&self, key: &'static MediaKey) -> Result<(), String> {
            self.log
                .0
                .lock()
                .unwrap()
                .push(format!("unregister {}", key.accelerator));
            Ok(())
        }
    }

    fn shortcuts(refuses: Option<&'static str>) -> (MediaShortcuts, Arc<Log>) {
        let log = Arc::new(Log::default());
        let keys = Fake {
            log: Arc::clone(&log),
            refuses,
        };
        (MediaShortcuts::new(Box::new(keys)), log)
    }

    /// The player opens: the same three keys `src/main/shortcuts.js`
    /// registers, and nothing else.
    #[test]
    fn enable_registers_the_three_media_keys() {
        let (shortcuts, log) = shortcuts(None);

        shortcuts.enable();

        assert_eq!(
            log.calls(),
            [
                "register MediaPlayPause",
                "register MediaTrackNext",
                "register MediaTrackPrevious"
            ]
        );
    }

    /// The player closes: every key is given back, so another
    /// application's play/pause works again.
    #[test]
    fn disable_returns_every_key() {
        let (shortcuts, log) = shortcuts(None);

        shortcuts.enable();
        log.clear();
        shortcuts.disable();

        assert_eq!(
            log.calls(),
            [
                "unregister MediaPlayPause",
                "unregister MediaTrackNext",
                "unregister MediaTrackPrevious"
            ]
        );
        assert!(shortcuts.held().is_empty());
    }

    /// Opening a second player without closing the first asks the OS
    /// for keys this process already holds, which it refuses.
    #[test]
    fn enabling_twice_takes_each_key_once() {
        let (shortcuts, log) = shortcuts(None);

        shortcuts.enable();
        shortcuts.enable();

        assert_eq!(log.calls().len(), 3);
    }

    /// `openExternalPlayer` disables and then the player's close
    /// disables again, so the second one has to hand back nothing.
    #[test]
    fn disabling_what_was_never_enabled_does_nothing() {
        let (shortcuts, log) = shortcuts(None);

        shortcuts.disable();
        assert!(log.calls().is_empty());

        shortcuts.enable();
        shortcuts.disable();
        log.clear();
        shortcuts.disable();
        assert!(log.calls().is_empty());
    }

    /// Five players opened and closed: every key taken is given back.
    /// The counts staying equal is the whole of "the media keys are
    /// not captured outside playback".
    #[test]
    fn opening_and_closing_the_player_balances() {
        let (shortcuts, log) = shortcuts(None);

        for _ in 0..5 {
            shortcuts.enable();
            shortcuts.disable();
        }

        let calls = log.calls();
        assert_eq!(
            calls.iter().filter(|c| c.starts_with("register")).count(),
            15
        );
        assert_eq!(
            calls.iter().filter(|c| c.starts_with("unregister")).count(),
            15
        );
    }

    /// A key another application owns is refused. The other two are
    /// still taken -- and only those two are handed back, rather than
    /// the host reporting a failure to release a key it never had.
    #[test]
    fn a_refused_key_is_not_recorded() {
        let (shortcuts, log) = shortcuts(Some("MediaTrackNext"));

        shortcuts.enable();
        assert_eq!(
            shortcuts.held(),
            ["MediaPlayPause", "MediaTrackPrevious"],
            "the refused key is not held"
        );

        log.clear();
        shortcuts.disable();
        assert_eq!(
            log.calls(),
            ["unregister MediaPlayPause", "unregister MediaTrackPrevious"]
        );
    }

    /// Quitting with the player open gives the keys back. Nothing
    /// calls this -- it is `Drop` -- which is the point: a host that
    /// exits still holding play/pause leaves the machine broken in a
    /// way restarting *this* app does not fix.
    #[test]
    fn dropping_the_shortcuts_returns_the_keys() {
        let (shortcuts, log) = shortcuts(None);

        shortcuts.enable();
        log.clear();
        drop(shortcuts);

        assert_eq!(log.calls().len(), 3);
    }

    /// Each key dispatches the action `src/main/shortcuts.js`
    /// dispatches for it.
    #[test]
    fn the_actions_are_the_ones_the_renderer_knows() {
        let actions: Vec<_> = MEDIA_KEYS.iter().map(|key| key.action).collect();

        assert_eq!(actions, ["playPause", "nextTrack", "previousTrack"]);
    }

    /// An accelerator that does not parse is refused at registration
    /// and the key silently never works -- and these three are not
    /// spelled the way Electron spells them. Parsed here by the
    /// parser the plugin itself uses.
    #[test]
    fn every_accelerator_parses_to_its_media_key() {
        let expected = [
            Code::MediaPlayPause,
            Code::MediaTrackNext,
            Code::MediaTrackPrevious,
        ];

        for (key, code) in MEDIA_KEYS.iter().zip(expected) {
            let parsed = Shortcut::from_str(key.accelerator)
                .unwrap_or_else(|err| panic!("{}: {err}", key.accelerator));

            assert_eq!(parsed.key, code, "{}", key.accelerator);
            assert_eq!(
                parsed.mods,
                Modifiers::empty(),
                "{} takes a modifier",
                key.accelerator
            );
        }
    }
}
