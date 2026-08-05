//! Launching the app at login.
//!
//! This is the Rust half of `src/main/startup.js`, which is the
//! `auto-launch` package configured with `isHidden: true` and nothing
//! else. That package is three unrelated mechanisms behind one name,
//! so they are named here as [`Strategy`] and each one's content is a
//! pure function of an [`Entry`] -- the way [`crate::power`] and
//! [`crate::dock`] split what a platform *does* from the part that
//! touches the world. All three are compiled on every platform, so a
//! `cargo test` run on one of them checks the other two's spelling.
//!
//! What `auto-launch` does, and therefore what is reproduced here:
//!
//! - macOS: a `~/Library/LaunchAgents/<name>.plist` launch agent
//!   whose `ProgramArguments` are the executable and `--hidden`.
//!   `auto-launch` reaches this through its `mac.useLaunchAgent`
//!   option rather than by default, and `startup.js` does not pass it
//!   -- see the note below for why this host does.
//! - Linux: a `~/.config/autostart/<name>.desktop` file whose `Exec`
//!   line ends in `--hidden`.
//! - Windows: a value under `HKCU\...\CurrentVersion\Run` holding the
//!   quoted executable path followed by `--hidden`.
//!
//! The two guards around all of that -- install only when it is not
//! already installed, uninstall only when it is -- are
//! [`install`] and [`uninstall`], which are `startup.js` itself.
//!
//! # Why macOS is the launch agent rather than the login item
//!
//! `auto-launch`'s default on macOS is a System Events **login item**,
//! and that is what `src/main/startup.js` gets. It no longer does
//! anything. On macOS 26.5.1, `make login item at end with properties
//! {...}` reports success -- it answers `login item <name>` -- and
//! nothing is added: the item is absent from `every login item` two
//! seconds later and from a fresh `osascript` process after that.
//! Deleting it then fails with "Can't get login item" (-1728). The
//! same is true of an item made without the `name` or `hidden`
//! properties, so it is the deprecated `LSSharedFileList` machinery
//! behind the whole verb rather than anything about how it is called.
//! Porting it faithfully would have been a preference the user can
//! switch on that silently does nothing.
//!
//! The launch agent is the same package's other macOS branch, it
//! works, and it is a better fit besides: it passes `--hidden` as a
//! real argument, so [`crate::window::is_hidden`] answers correctly on
//! macOS without Electron's `wasOpenedAsHidden` -- which is Chromium
//! asking the same dead `LSSharedFileList` API which login item
//! started the process.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::menu::Platform;
use crate::window::HIDDEN_FLAG;

/// `HKEY_CURRENT_USER`'s Run key, which is where `auto-launch` puts a
/// Windows login entry.
pub const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

/// How this platform is told to launch the app at login.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Strategy {
    /// macOS and Linux: a file the session reads at login.
    File(FileKind),
    /// Windows: a value under [`RUN_KEY`].
    RunKey,
}

/// What [`platform_items`] builds on this platform.
pub fn strategy(platform: Platform) -> Strategy {
    match platform {
        Platform::Mac => Strategy::File(FileKind::LaunchAgent),
        Platform::Linux => Strategy::File(FileKind::DesktopEntry),
        Platform::Windows => Strategy::RunKey,
    }
}

/// What gets registered: which executable, under which name.
///
/// Both come from the running executable, as they do in `auto-launch`
/// -- the name is not `APP_NAME` but whatever the executable is
/// called, because `fixOpts` there overwrites the configured name with
/// the last component of the path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    pub path: PathBuf,
}

impl Entry {
    /// The entry for this build's own executable, or `None` when the
    /// OS will not say what that is -- there is nothing to register
    /// then, and a guess would register the wrong thing.
    pub fn current() -> Option<Entry> {
        let exe = std::env::current_exe().ok()?;
        Some(Entry::resolve(&exe, Platform::current()))
    }

    /// `fixOpts` in `auto-launch`: the executable to launch, and the
    /// name to file it under.
    ///
    /// The path is the executable itself on every platform, including
    /// macOS -- a launch agent runs a binary, not a bundle directory,
    /// which is why `auto-launch` only rewrites the path to the `.app`
    /// in the branch that makes a login item instead.
    pub fn resolve(exe: &Path, platform: Platform) -> Entry {
        Entry {
            name: registered_name(exe, platform),
            path: exe.to_path_buf(),
        }
    }
}

/// The name the entry is filed under: the last component of the path,
/// without the suffix that says what kind of thing it is.
fn registered_name(path: &Path, platform: Platform) -> String {
    // Split on the separator by hand rather than through `file_name`,
    // which knows only this build's separator: a Windows path is still
    // a Windows path when the test asserting it runs on macOS.
    let name = path
        .to_string_lossy()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .to_string();

    let suffix = match platform {
        Platform::Mac => ".app",
        Platform::Windows => ".exe",
        Platform::Linux => return name,
    };

    name.strip_suffix(suffix).unwrap_or(&name).to_string()
}

/// Whatever can register this app to launch at login.
pub trait LoginItems {
    fn is_enabled(&self, entry: &Entry) -> Result<bool, String>;
    fn enable(&self, entry: &Entry) -> Result<(), String>;
    fn disable(&self, entry: &Entry) -> Result<(), String>;
}

/// `install()` in `src/main/startup.js`, guard included.
pub fn install(items: &dyn LoginItems, entry: &Entry) -> Result<(), String> {
    if items.is_enabled(entry)? {
        return Ok(());
    }
    items.enable(entry)
}

/// `uninstall()` in `src/main/startup.js`, guard included.
///
/// The guard is not decoration on either side: removing a file that
/// is not there and deleting a registry value that was never written
/// both fail, and neither is something the user did wrong -- the
/// preference is written by the renderer on every change, so it is
/// normal for this to be asked to turn off something already off.
pub fn uninstall(items: &dyn LoginItems, entry: &Entry) -> Result<(), String> {
    if !items.is_enabled(entry)? {
        return Ok(());
    }
    items.disable(entry)
}

/// The mechanism [`strategy`] names for the platform this is built
/// for.
pub fn platform_items() -> Box<dyn LoginItems> {
    match strategy(Platform::current()) {
        Strategy::File(kind) => Box::new(FileEntries::current(kind)),
        Strategy::RunKey => Box::new(RunKey),
    }
}

// -- macOS and Linux: a file the session reads at login --------------

/// Which kind of file a platform's session reads at login.
///
/// `auto-launch` has both -- the Linux one always, the macOS one
/// behind its `mac.useLaunchAgent` option -- and they share its
/// `fileBasedUtilities`, so they share [`FileEntries`] here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    /// `~/Library/LaunchAgents/<name>.plist`.
    LaunchAgent,
    /// `~/.config/autostart/<name>.desktop`.
    DesktopEntry,
}

impl FileKind {
    /// The directory this kind of file lives in, under a home
    /// directory. Both are the literal paths `auto-launch` hardcodes;
    /// neither reads `XDG_CONFIG_HOME`, so neither does this.
    pub fn dir(self, home: &Path) -> PathBuf {
        match self {
            FileKind::LaunchAgent => home.join("Library").join("LaunchAgents"),
            FileKind::DesktopEntry => home.join(".config").join("autostart"),
        }
    }

    pub fn file_name(self, name: &str) -> String {
        match self {
            FileKind::LaunchAgent => format!("{name}.plist"),
            FileKind::DesktopEntry => format!("{name}.desktop"),
        }
    }

    /// What goes in it.
    ///
    /// The launch agent is `auto-launch`'s `mac.useLaunchAgent`
    /// template and the desktop entry is its Linux one, both with the
    /// same keys -- the executable, the `--hidden` argument, and the
    /// instruction to run it at login.
    pub fn content(self, entry: &Entry) -> String {
        let name = &entry.name;
        let path = entry.path.display();

        match self {
            FileKind::LaunchAgent => format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{name}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{path}</string>
    <string>{HIDDEN_FLAG}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
"#
            ),
            FileKind::DesktopEntry => format!(
                "[Desktop Entry]\n\
                 Type=Application\n\
                 Version=1.0\n\
                 Name={name}\n\
                 Comment={name}startup script\n\
                 Exec={path} {HIDDEN_FLAG}\n\
                 StartupNotify=false\n\
                 Terminal=false"
            ),
        }
    }
}

/// One of the two directories above, as something that can be
/// installed into.
pub struct FileEntries {
    kind: FileKind,
    dir: PathBuf,
}

impl FileEntries {
    /// This user's directory for that kind of file. `HOME` unset gives
    /// a relative path, which is what `untildify` leaves behind in the
    /// same case.
    fn current(kind: FileKind) -> Self {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default();
        Self::in_dir(kind, &kind.dir(&home))
    }

    pub fn in_dir(kind: FileKind, dir: &Path) -> Self {
        FileEntries {
            kind,
            dir: dir.to_path_buf(),
        }
    }

    pub fn file(&self, entry: &Entry) -> PathBuf {
        self.dir.join(self.kind.file_name(&entry.name))
    }
}

impl LoginItems for FileEntries {
    fn is_enabled(&self, entry: &Entry) -> Result<bool, String> {
        Ok(self.file(entry).exists())
    }

    fn enable(&self, entry: &Entry) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir)
            .map_err(|err| format!("{}: {err}", self.dir.display()))?;

        let file = self.file(entry);
        std::fs::write(&file, self.kind.content(entry))
            .map_err(|err| format!("{}: {err}", file.display()))
    }

    fn disable(&self, entry: &Entry) -> Result<(), String> {
        let file = self.file(entry);
        std::fs::remove_file(&file).map_err(|err| format!("{}: {err}", file.display()))
    }
}

// -- Windows: a value under the Run key ------------------------------

/// What a `reg.exe` invocation is being asked to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunKeyAction {
    Query,
    Add,
    Delete,
}

/// What the Run value holds: the executable, quoted because a program
/// path with a space in it is otherwise read as a path plus arguments,
/// and then the flag that keeps the window closed.
pub fn run_key_value(entry: &Entry) -> String {
    format!("\"{}\" {HIDDEN_FLAG}", entry.path.display())
}

/// The arguments `reg.exe` is given for one of the three actions. All
/// three name the same value under the same key, which is what makes
/// uninstall remove exactly what install created.
pub fn run_key_command(action: RunKeyAction, entry: &Entry) -> Vec<String> {
    let mut args = vec![
        match action {
            RunKeyAction::Query => "query",
            RunKeyAction::Add => "add",
            RunKeyAction::Delete => "delete",
        }
        .to_string(),
        RUN_KEY.to_string(),
        "/v".to_string(),
        entry.name.clone(),
    ];

    match action {
        RunKeyAction::Query => {}
        RunKeyAction::Add => args.extend([
            "/t".to_string(),
            "REG_SZ".to_string(),
            "/d".to_string(),
            run_key_value(entry),
            "/f".to_string(),
        ]),
        RunKeyAction::Delete => args.push("/f".to_string()),
    }

    args
}

/// `reg.exe` rather than a registry crate: this is three invocations
/// of a tool that ships with Windows, and the alternative is a
/// dependency whose Windows-only code could not be compiled -- let
/// alone run -- on the machine this port is being written on
/// (`rust-version`, ADR-014).
struct RunKey;

impl RunKey {
    fn run(action: RunKeyAction, entry: &Entry) -> Result<bool, String> {
        Command::new("reg")
            .args(run_key_command(action, entry))
            .output()
            .map(|output| output.status.success())
            .map_err(|err| format!("reg: {err}"))
    }
}

impl LoginItems for RunKey {
    /// A missing value is a failed `reg query`, which is not an error
    /// here any more than it is in `auto-launch`.
    fn is_enabled(&self, entry: &Entry) -> Result<bool, String> {
        Self::run(RunKeyAction::Query, entry)
    }

    fn enable(&self, entry: &Entry) -> Result<(), String> {
        match Self::run(RunKeyAction::Add, entry)? {
            true => Ok(()),
            false => Err(format!("reg add {RUN_KEY} failed")),
        }
    }

    fn disable(&self, entry: &Entry) -> Result<(), String> {
        match Self::run(RunKeyAction::Delete, entry)? {
            true => Ok(()),
            false => Err(format!("reg delete {RUN_KEY} failed")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    use crate::menu::Platform;

    fn temp_dir(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("wt-startup-test-{name}"));
        let _ = std::fs::remove_dir_all(&path);
        path
    }

    /// A [`LoginItems`] that records what it was asked to do, so that
    /// the two guards `src/main/startup.js` is made of can be asserted
    /// without a login item on the machine running the tests.
    #[derive(Default)]
    struct Fake {
        enabled: Mutex<bool>,
        calls: Mutex<Vec<String>>,
    }

    impl Fake {
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }

        fn enabled(&self) -> bool {
            *self.enabled.lock().unwrap()
        }
    }

    impl LoginItems for Fake {
        fn is_enabled(&self, _entry: &Entry) -> Result<bool, String> {
            self.calls.lock().unwrap().push("is_enabled".to_string());
            Ok(self.enabled())
        }

        fn enable(&self, _entry: &Entry) -> Result<(), String> {
            self.calls.lock().unwrap().push("enable".to_string());
            *self.enabled.lock().unwrap() = true;
            Ok(())
        }

        fn disable(&self, _entry: &Entry) -> Result<(), String> {
            self.calls.lock().unwrap().push("disable".to_string());
            *self.enabled.lock().unwrap() = false;
            Ok(())
        }
    }

    fn entry() -> Entry {
        Entry {
            name: "WebTorrent".to_string(),
            path: PathBuf::from("/Applications/WebTorrent.app/Contents/MacOS/WebTorrent"),
        }
    }

    #[test]
    fn each_platform_registers_the_way_auto_launch_does() {
        assert_eq!(
            strategy(Platform::Mac),
            Strategy::File(FileKind::LaunchAgent)
        );
        assert_eq!(
            strategy(Platform::Linux),
            Strategy::File(FileKind::DesktopEntry)
        );
        assert_eq!(strategy(Platform::Windows), Strategy::RunKey);
    }

    #[test]
    fn a_macos_entry_launches_the_binary_inside_the_bundle() {
        let exe = Path::new("/Applications/WebTorrent.app/Contents/MacOS/WebTorrent");
        let entry = Entry::resolve(exe, Platform::Mac);

        assert_eq!(
            entry.path, exe,
            "a launch agent runs an executable, not a bundle directory"
        );
        assert_eq!(entry.name, "WebTorrent");
    }

    #[test]
    fn a_windows_entry_drops_the_exe_suffix() {
        let exe = Path::new(r"C:\Program Files\WebTorrent\WebTorrent.exe");
        let entry = Entry::resolve(exe, Platform::Windows);

        assert_eq!(entry.path, exe);
        assert_eq!(entry.name, "WebTorrent");
    }

    #[test]
    fn a_linux_entry_is_the_executables_own_name() {
        let exe = Path::new("/usr/lib/webtorrent-desktop/WebTorrent");
        let entry = Entry::resolve(exe, Platform::Linux);

        assert_eq!(entry.path, exe);
        assert_eq!(entry.name, "WebTorrent");
    }

    #[test]
    fn both_login_files_ask_for_a_hidden_launch() {
        let entry = Entry {
            name: "WebTorrent".to_string(),
            path: PathBuf::from("/usr/lib/webtorrent-desktop/WebTorrent"),
        };

        let desktop = FileKind::DesktopEntry.content(&entry);
        assert!(desktop.starts_with("[Desktop Entry]\n"));
        assert!(desktop.contains("\nType=Application\n"));
        assert!(desktop.contains("\nName=WebTorrent\n"));
        assert!(
            desktop.contains("\nExec=/usr/lib/webtorrent-desktop/WebTorrent --hidden\n"),
            "the login launch is the hidden one: {desktop}"
        );
        assert!(desktop.contains("\nTerminal=false"));

        let agent = FileKind::LaunchAgent.content(&entry);
        assert!(agent.starts_with("<?xml "));
        assert!(agent.contains("<key>Label</key>\n  <string>WebTorrent</string>"));
        assert!(
            agent.contains(concat!(
                "<array>\n",
                "    <string>/usr/lib/webtorrent-desktop/WebTorrent</string>\n",
                "    <string>--hidden</string>\n",
                "  </array>"
            )),
            "the executable and the flag, in that order: {agent}"
        );
        assert!(
            agent.contains("<key>RunAtLoad</key>\n  <true/>"),
            "without this it is a launch agent that never launches"
        );
    }

    #[test]
    fn a_login_file_is_removed_exactly_where_it_was_written() {
        for (kind, name) in [
            (FileKind::LaunchAgent, "WebTorrent.plist"),
            (FileKind::DesktopEntry, "WebTorrent.desktop"),
        ] {
            let dir = temp_dir(name);
            let entries = FileEntries::in_dir(kind, &dir);
            let entry = entry();

            // Something else's login file, which must survive.
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("someone.else"), "not ours").unwrap();

            assert!(!entries.is_enabled(&entry).unwrap());

            install(&entries, &entry).unwrap();
            assert!(entries.is_enabled(&entry).unwrap());
            assert_eq!(
                std::fs::read_to_string(dir.join(name)).unwrap(),
                kind.content(&entry)
            );

            uninstall(&entries, &entry).unwrap();
            assert!(!entries.is_enabled(&entry).unwrap());
            assert!(!dir.join(name).exists());
            assert!(
                dir.join("someone.else").exists(),
                "uninstall removes what install created and nothing else"
            );

            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn a_login_file_is_written_into_a_directory_that_does_not_exist_yet() {
        let dir = temp_dir("missing-dir");
        let entries = FileEntries::in_dir(FileKind::LaunchAgent, &dir);
        let entry = entry();

        assert!(
            !entries.is_enabled(&entry).unwrap(),
            "no directory is not enabled"
        );
        install(&entries, &entry).unwrap();
        assert!(entries.is_enabled(&entry).unwrap());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_login_directories_are_the_ones_auto_launch_uses() {
        let home = Path::new("/home/someone");

        assert_eq!(
            FileKind::DesktopEntry.dir(home),
            PathBuf::from("/home/someone/.config/autostart"),
            "`~/.config/autostart`, which auto-launch hardcodes"
        );
        assert_eq!(
            FileKind::LaunchAgent.dir(home),
            PathBuf::from("/home/someone/Library/LaunchAgents"),
        );
    }

    #[test]
    fn the_run_key_value_quotes_the_path_and_asks_to_be_hidden() {
        let entry = Entry {
            name: "WebTorrent".to_string(),
            path: PathBuf::from(r"C:\Program Files\WebTorrent\WebTorrent.exe"),
        };

        assert_eq!(
            run_key_value(&entry),
            "\"C:\\Program Files\\WebTorrent\\WebTorrent.exe\" --hidden",
            "a path with a space in it has to survive the registry"
        );
    }

    #[test]
    fn the_run_key_commands_all_name_the_same_value() {
        let entry = entry();

        for (action, verb) in [
            (RunKeyAction::Query, "query"),
            (RunKeyAction::Add, "add"),
            (RunKeyAction::Delete, "delete"),
        ] {
            let args = run_key_command(action, &entry);

            assert_eq!(args[0], verb);
            assert_eq!(args[1], RUN_KEY);
            assert_eq!(args[2], "/v");
            assert_eq!(
                args[3], "WebTorrent",
                "one value name for all three, so uninstall removes what \
                 install created"
            );
        }

        let add = run_key_command(RunKeyAction::Add, &entry);
        assert!(add.contains(&"REG_SZ".to_string()));
        assert!(add.contains(&run_key_value(&entry)));
        assert!(
            add.contains(&"/f".to_string()),
            "no prompt, and an existing value is replaced rather than refused"
        );
        assert!(run_key_command(RunKeyAction::Delete, &entry).contains(&"/f".to_string()));
    }

    #[test]
    fn install_does_nothing_when_it_is_already_installed() {
        let fake = Fake::default();
        let entry = entry();

        install(&fake, &entry).unwrap();
        install(&fake, &entry).unwrap();

        assert_eq!(
            fake.calls(),
            vec!["is_enabled", "enable", "is_enabled"],
            "the second install asks and stops, as `startup.js` does"
        );
        assert!(fake.enabled());
    }

    #[test]
    fn uninstall_does_nothing_when_it_was_never_installed() {
        let fake = Fake::default();
        let entry = entry();

        uninstall(&fake, &entry).unwrap();
        assert_eq!(fake.calls(), vec!["is_enabled"]);

        install(&fake, &entry).unwrap();
        uninstall(&fake, &entry).unwrap();
        assert!(!fake.enabled(), "installing then uninstalling leaves none");
        assert_eq!(
            fake.calls(),
            vec![
                "is_enabled",
                "is_enabled",
                "enable",
                "is_enabled",
                "disable"
            ]
        );
    }
}
