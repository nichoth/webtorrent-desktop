//! Where the app keeps its data.
//!
//! This is the Rust half of the path block in `src/config.js`:
//! `CONFIG_PATH`, `TORRENT_PATH`, `POSTER_PATH`, the temp directory and
//! `DEFAULT_DOWNLOAD_PATH`, plus the portable-app relocation that
//! `src/main/index.js` performs on top of them. Every later Phase 4
//! module needs these, so they are resolved once at startup and handed
//! to the renderer as plain data.
//!
//! Resolution is a pure function of an [`Env`] value rather than of
//! process state, so the layout can be asserted for a platform the
//! test is not running on. [`Env::current`] is the only part that reads
//! the real environment.

use std::path::PathBuf;

use serde::Serialize;

/// Matches `APP_NAME` in `src/config.js`. It is the directory name the
/// per-user config path is built from, so it is not cosmetic.
pub const APP_NAME: &str = "WebTorrent";

/// The folder a portable Windows install keeps everything in, beside
/// the executable.
const PORTABLE_DIR_NAME: &str = "Portable Settings";

/// The three platforms `application-config-path` supports, which is
/// the set `src/config.js` inherits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Darwin,
    Linux,
    Windows,
}

impl Platform {
    /// `None` on a platform `src/config.js` would have thrown on.
    pub fn current() -> Option<Platform> {
        match std::env::consts::OS {
            "macos" => Some(Platform::Darwin),
            "linux" => Some(Platform::Linux),
            "windows" => Some(Platform::Windows),
            _ => None,
        }
    }
}

/// Everything the resolution reads, gathered in one place.
#[derive(Debug, Clone)]
pub struct Env {
    pub platform: Platform,
    pub home: Option<PathBuf>,
    pub xdg_config_home: Option<PathBuf>,
    pub local_app_data: Option<PathBuf>,
    pub user_profile: Option<PathBuf>,
    pub system_temp: PathBuf,
    pub downloads: Option<PathBuf>,
    pub exe_dir: PathBuf,
    pub is_test: bool,
    pub is_production: bool,
    pub portable_settings_present: bool,
}

impl Env {
    /// `downloads` comes from the caller because Tauri's own resolver
    /// reads the XDG user-dirs config on Linux, which this module has
    /// no business reimplementing. `None` means "unknown", and matches
    /// what `src/config.js` produces outside an Electron process.
    pub fn current(downloads: Option<PathBuf>) -> Option<Env> {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(PathBuf::from))
            .unwrap_or_else(|| PathBuf::from("."));

        Some(Env {
            platform: Platform::current()?,
            home: var_path("HOME"),
            xdg_config_home: var_path("XDG_CONFIG_HOME"),
            local_app_data: var_path("LOCALAPPDATA"),
            user_profile: var_path("USERPROFILE"),
            system_temp: std::env::temp_dir(),
            downloads,
            // The check `src/config.js` does with `fs.accessSync`. It
            // is read here rather than inside the resolution so that
            // the resolution stays a pure function of this value.
            portable_settings_present: exe_dir.join(PORTABLE_DIR_NAME).is_dir(),
            exe_dir,
            is_test: std::env::var("NODE_ENV").as_deref() == Ok("test"),
            // The Electron `IS_PRODUCTION` test is "am I running from a
            // packaged binary rather than from the dev `electron`
            // binary". A debug build is this host's dev binary.
            is_production: !cfg!(debug_assertions),
        })
    }
}

fn var_path(key: &str) -> Option<PathBuf> {
    match std::env::var(key) {
        Ok(value) if !value.is_empty() => Some(PathBuf::from(value)),
        _ => None,
    }
}

/// The resolved layout, as the renderer receives it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPaths {
    pub config_path: PathBuf,
    pub torrent_path: PathBuf,
    pub poster_path: PathBuf,
    pub temp_path: PathBuf,
    pub default_download_path: PathBuf,
    pub is_portable: bool,
}

impl AppPaths {
    pub fn resolve(env: &Env) -> AppPaths {
        let is_portable = is_portable(env);
        let config_path = if is_portable {
            portable_path(env)
        } else {
            application_config_dir(env)
        };

        // The portable branch is the relocation `src/main/index.js`
        // performs with `app.setPath('userData')` and
        // `app.setPath('temp')`: nothing is written outside the
        // "Portable Settings" folder, so the install stays silent.
        let (temp_path, default_download_path) = if is_portable {
            (config_path.join("Temp"), config_path.join("Downloads"))
        } else {
            (
                env.system_temp.clone(),
                env.downloads.clone().unwrap_or_default(),
            )
        };

        AppPaths {
            torrent_path: config_path.join("Torrents"),
            poster_path: config_path.join("Posters"),
            config_path,
            temp_path,
            default_download_path,
            is_portable,
        }
    }
}

/// `IS_PORTABLE` in `src/config.js`. Only a packaged Windows build can
/// be portable, and only when the folder is there beside the
/// executable; the test suite is portable everywhere.
pub fn is_portable(env: &Env) -> bool {
    env.is_test
        || (env.platform == Platform::Windows && env.is_production && env.portable_settings_present)
}

/// `PORTABLE_PATH` in `src/config.js`.
pub fn portable_path(env: &Env) -> PathBuf {
    if env.is_test {
        let temp = if env.platform == Platform::Windows {
            "C:\\Windows\\Temp"
        } else {
            "/tmp"
        };
        return PathBuf::from(temp).join("WebTorrentTest");
    }

    env.exe_dir.join(PORTABLE_DIR_NAME)
}

/// `application-config-path`, which `src/config.js` reaches through
/// `application-config`. A missing `HOME` or `USERPROFILE` yields a
/// relative path rather than a panic, which is the same shape of
/// nonsense the JS produces from an undefined env var -- neither host
/// can do anything useful without one.
pub fn application_config_dir(env: &Env) -> PathBuf {
    let base = match env.platform {
        Platform::Darwin => home(env).join("Library").join("Application Support"),
        Platform::Linux => match &env.xdg_config_home {
            Some(xdg) => xdg.clone(),
            None => home(env).join(".config"),
        },
        Platform::Windows => match &env.local_app_data {
            Some(local) => local.clone(),
            None => env
                .user_profile
                .clone()
                .unwrap_or_default()
                .join("Local Settings")
                .join("Application Data"),
        },
    };

    base.join(APP_NAME)
}

fn home(env: &Env) -> PathBuf {
    env.home.clone().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn env(platform: Platform) -> Env {
        Env {
            platform,
            home: Some(PathBuf::from("/home/tester")),
            xdg_config_home: None,
            local_app_data: Some(PathBuf::from("C:\\Users\\tester\\AppData\\Local")),
            user_profile: Some(PathBuf::from("C:\\Users\\tester")),
            system_temp: PathBuf::from("/system/temp"),
            downloads: Some(PathBuf::from("/home/tester/Downloads")),
            exe_dir: PathBuf::from("/apps/WebTorrent"),
            is_test: false,
            is_production: true,
            portable_settings_present: false,
        }
    }

    #[test]
    fn config_dir_per_platform() {
        assert_eq!(
            application_config_dir(&env(Platform::Darwin)),
            Path::new("/home/tester/Library/Application Support/WebTorrent")
        );
        assert_eq!(
            application_config_dir(&env(Platform::Linux)),
            Path::new("/home/tester/.config/WebTorrent")
        );
        assert_eq!(
            application_config_dir(&env(Platform::Windows)),
            Path::new("C:\\Users\\tester\\AppData\\Local").join(APP_NAME)
        );
    }

    #[test]
    fn config_dir_honours_the_documented_overrides() {
        let mut linux = env(Platform::Linux);
        linux.xdg_config_home = Some(PathBuf::from("/xdg"));
        assert_eq!(application_config_dir(&linux), Path::new("/xdg/WebTorrent"));

        let mut windows = env(Platform::Windows);
        windows.local_app_data = None;
        assert_eq!(
            application_config_dir(&windows),
            Path::new("C:\\Users\\tester")
                .join("Local Settings")
                .join("Application Data")
                .join(APP_NAME)
        );
    }

    #[test]
    fn subdirectories_hang_off_the_config_dir() {
        let paths = AppPaths::resolve(&env(Platform::Darwin));
        let config = Path::new("/home/tester/Library/Application Support/WebTorrent");

        assert_eq!(paths.config_path, config);
        assert_eq!(paths.torrent_path, config.join("Torrents"));
        assert_eq!(paths.poster_path, config.join("Posters"));
        assert!(!paths.is_portable);
    }

    #[test]
    fn a_normal_install_uses_the_system_temp_and_downloads_dirs() {
        let paths = AppPaths::resolve(&env(Platform::Linux));

        assert_eq!(paths.temp_path, Path::new("/system/temp"));
        assert_eq!(
            paths.default_download_path,
            Path::new("/home/tester/Downloads")
        );
    }

    #[test]
    fn an_unknown_downloads_dir_is_empty_rather_than_a_guess() {
        let mut plain = env(Platform::Linux);
        plain.downloads = None;

        assert_eq!(
            AppPaths::resolve(&plain).default_download_path,
            Path::new("")
        );
    }

    /// The relocation `src/main/index.js` does with `app.setPath`:
    /// user data and temp both move under the config directory so a
    /// portable install writes nothing outside its own folder.
    #[test]
    fn the_portable_app_relocates_everything_under_its_config_dir() {
        let mut portable = env(Platform::Windows);
        portable.portable_settings_present = true;

        let paths = AppPaths::resolve(&portable);
        let config = Path::new("/apps/WebTorrent").join("Portable Settings");

        assert!(paths.is_portable);
        assert_eq!(paths.config_path, config);
        assert_eq!(paths.torrent_path, config.join("Torrents"));
        assert_eq!(paths.poster_path, config.join("Posters"));
        assert_eq!(paths.temp_path, config.join("Temp"));
        assert_eq!(paths.default_download_path, config.join("Downloads"));
    }

    #[test]
    fn only_a_windows_production_install_can_be_portable() {
        let mut present = env(Platform::Windows);
        present.portable_settings_present = true;
        assert!(is_portable(&present));

        let mut absent = env(Platform::Windows);
        absent.portable_settings_present = false;
        assert!(!is_portable(&absent));

        let mut dev = env(Platform::Windows);
        dev.portable_settings_present = true;
        dev.is_production = false;
        assert!(!is_portable(&dev));

        let mut mac = env(Platform::Darwin);
        mac.portable_settings_present = true;
        assert!(!is_portable(&mac));
    }

    /// `NODE_ENV=test` is portable on every platform, under a fixed
    /// path, so the integration suite never touches a real profile.
    #[test]
    fn test_mode_is_portable_under_a_fixed_path() {
        let mut testing = env(Platform::Darwin);
        testing.is_test = true;

        assert!(is_portable(&testing));
        assert_eq!(portable_path(&testing), Path::new("/tmp/WebTorrentTest"));

        let mut on_windows = env(Platform::Windows);
        on_windows.is_test = true;
        assert_eq!(
            portable_path(&on_windows),
            Path::new("C:\\Windows\\Temp").join("WebTorrentTest")
        );
    }

    /// The command hands the renderer JSON, so every field has to
    /// survive serialization as a string or a boolean -- no host
    /// objects (ADR-007).
    #[test]
    fn serializes_as_plain_data() {
        let json = serde_json::to_value(AppPaths::resolve(&env(Platform::Darwin)))
            .expect("paths do not serialize");
        let fields = json.as_object().expect("not a JSON object");

        assert_eq!(fields.len(), 6);
        for key in [
            "configPath",
            "torrentPath",
            "posterPath",
            "tempPath",
            "defaultDownloadPath",
        ] {
            assert!(fields[key].is_string(), "{key} is not a string");
        }
        assert!(fields["isPortable"].is_boolean());
    }

    /// Differential check against the source of truth: `src/config.js`
    /// itself, loaded by Node as ESM the way the `bin/` scripts load
    /// it. Hard-coded expectations above state the layout; this states
    /// that the layout is still the one Electron uses (ADR-011 uses
    /// the same tactic for `path`).
    #[test]
    fn matches_src_config_js_on_this_platform() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("no repo root above src-tauri/");
        let script = "import('./src/config.js').then(m => \
             console.log(JSON.stringify([\
             m.CONFIG_PATH, m.TORRENT_PATH, m.POSTER_PATH, m.IS_PORTABLE])))";

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
        // Node is not a production build, so it takes the same
        // non-portable branch a `cargo test` run does.
        let from_rust =
            AppPaths::resolve(&Env::current(None).expect("this platform is unsupported"));

        assert_eq!(
            from_js[0].as_str().unwrap(),
            from_rust.config_path.to_str().unwrap()
        );
        assert_eq!(
            from_js[1].as_str().unwrap(),
            from_rust.torrent_path.to_str().unwrap()
        );
        assert_eq!(
            from_js[2].as_str().unwrap(),
            from_rust.poster_path.to_str().unwrap()
        );
        assert_eq!(from_js[3], serde_json::Value::Bool(from_rust.is_portable));
    }
}
