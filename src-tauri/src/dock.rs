//! The dock badge and the Downloads stack.
//!
//! This is the Rust half of `src/main/dock.js`. It follows
//! [`crate::menu`] and [`crate::tray`]: what a badge count *means* on
//! a given platform is a pure function of plain values, asserted for
//! all three platforms from one `cargo test` run, and the part that
//! touches the world is the bottom of the file plus the commands in
//! `main.rs`.
//!
//! The third thing `src/main/dock.js` does -- the dock's right-click
//! menu, its `init` -- is not here. Tauri 2 exposes no equivalent of
//! `app.dock.setMenu`; reaching it would mean implementing
//! `applicationDockMenu:` on the AppKit delegate, which is a larger
//! piece of work than this story's acceptance criteria describe (they
//! name `setBadge`, `setProgress` and `downloadFinished`). The
//! consequence is visible only on macOS, and only to a user who
//! right-clicks the dock icon: the three "open a torrent" shortcuts
//! are missing there. Every one of them is also in the application
//! menu, which US-061 ported.
//!
//! `setProgress` is the window's own -- `set_progress` in `main.rs`
//! over [`crate::window::progress_bar`] -- because Tauri hangs the
//! progress bar off the window rather than off the app. It landed with
//! the rest of the window controls in US-057 and is unchanged here.

use crate::menu::Platform;

/// The distributed notification macOS bounces the Downloads stack for.
///
/// This is what `app.dock.downloadFinished(path)` does inside
/// Electron: it posts `com.apple.DownloadFileFinished` with the file's
/// path as the notification object, and the Dock -- which is the
/// observer -- animates the stack the path is in. There is no Tauri
/// API for it, so the notification is posted directly.
#[cfg(target_os = "macos")]
const DOWNLOAD_FINISHED_NOTIFICATION: &str = "com.apple.DownloadFileFinished";

/// What `app.badgeCount = Number(count)` amounts to on this platform.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Badge {
    /// Show this many, which is Tauri's `set_badge_count(Some(n))`.
    Show(i64),
    /// Take the badge down. Zero is how the renderer says "nothing is
    /// downloading" -- `state.dock.badge || 0` in
    /// `src/renderer/main.js` -- and Electron clears the badge for it
    /// rather than drawing a `0`.
    Clear,
    /// This platform has no badge. Windows puts a small image over the
    /// taskbar button instead (`set_overlay_icon`), which is a
    /// different feature with a different input: Electron's
    /// `app.badgeCount` is documented as macOS and Linux only, and
    /// `src/main/dock.js` guards on exactly that.
    Unsupported,
}

/// `dock.setBadge(count)` as a decision over a plain number.
///
/// Two departures from the Electron original, both deliberate.
///
/// Electron guards Linux with `app.isUnityRunning()`; there is no such
/// read in Tauri, and none is needed -- `set_badge_count` on Linux
/// talks to the Unity launcher over D-Bus and does nothing at all
/// where nothing is listening, which is the same outcome the guard
/// produces.
///
/// A count that is not a usable number -- NaN, an infinity, a negative
/// -- clears rather than being passed on. `Number(count)` would hand
/// Electron the same nonsense; a badge stuck with it would stay for
/// the rest of the session, because the renderer only ever sends the
/// count it has just computed.
pub fn badge(platform: Platform, count: f64) -> Badge {
    match platform {
        Platform::Mac | Platform::Linux => {
            if !count.is_finite() {
                return Badge::Clear;
            }
            match count.round() as i64 {
                n if n > 0 => Badge::Show(n),
                _ => Badge::Clear,
            }
        }
        Platform::Windows => Badge::Unsupported,
    }
}

/// What `dock.downloadFinished(path)` amounts to on this platform.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadNotice {
    /// Post [`DOWNLOAD_FINISHED_NOTIFICATION`] so the Dock bounces the
    /// stack the file landed in.
    Bounce,
    /// No dock, so no stack to bounce. `src/main/dock.js` returns
    /// early on `!app.dock`, which is every platform but macOS.
    Unsupported,
}

/// `dock.downloadFinished(path)` as a decision.
pub fn download_notice(platform: Platform) -> DownloadNotice {
    match platform {
        Platform::Mac => DownloadNotice::Bounce,
        Platform::Windows | Platform::Linux => DownloadNotice::Unsupported,
    }
}

// -- the part that touches the world ---------------------------------

/// Tell the Dock a file finished downloading, so it bounces the stack
/// that file is in.
///
/// Call from the main thread: this is AppKit, and the Electron code it
/// replaces runs in the main process's main thread.
#[cfg(target_os = "macos")]
pub fn bounce_downloads_stack(path: &str) {
    use objc2_foundation::{NSDistributedNotificationCenter, NSString};

    let center = NSDistributedNotificationCenter::defaultCenter();
    let name = NSString::from_str(DOWNLOAD_FINISHED_NOTIFICATION);
    let object = NSString::from_str(path);

    // SAFETY: the selector takes an NSString name and an optional
    // NSString object, which is what both of these are. It has no
    // other requirements -- there is no user info dictionary whose
    // generics could be wrong.
    unsafe { center.postNotificationName_object(&name, Some(&object)) };
}

/// Nowhere else has a Downloads stack; [`download_notice`] is what
/// stops this being reached, and this is what keeps the caller free of
/// `cfg`.
#[cfg(not(target_os = "macos"))]
pub fn bounce_downloads_stack(_path: &str) {}

#[cfg(test)]
mod tests {
    use super::*;

    /// The renderer sends `state.dock.badge || 0`: a count while
    /// torrents are downloading, and `0` the moment the last one
    /// stops.
    #[test]
    fn a_count_shows_and_zero_clears() {
        assert_eq!(badge(Platform::Mac, 3.0), Badge::Show(3));
        assert_eq!(badge(Platform::Mac, 1.0), Badge::Show(1));
        assert_eq!(badge(Platform::Mac, 0.0), Badge::Clear);
    }

    /// Linux is not guarded on Unity the way `src/main/dock.js` guards
    /// it -- see [`badge`]. It therefore takes the same path as macOS.
    #[test]
    fn linux_badges_like_mac() {
        assert_eq!(badge(Platform::Linux, 3.0), Badge::Show(3));
        assert_eq!(badge(Platform::Linux, 0.0), Badge::Clear);
    }

    /// Windows has no badge. `src/main/dock.js` does nothing there and
    /// neither does this -- in particular it does not fall through to
    /// the taskbar overlay icon, which is a different feature.
    #[test]
    fn windows_has_no_badge() {
        assert_eq!(badge(Platform::Windows, 3.0), Badge::Unsupported);
        assert_eq!(badge(Platform::Windows, 0.0), Badge::Unsupported);
    }

    /// A badge that cannot be drawn is a badge that would never come
    /// down again, because nothing re-sends a count that has not
    /// changed.
    #[test]
    fn an_unusable_count_clears_rather_than_sticking() {
        assert_eq!(badge(Platform::Mac, f64::NAN), Badge::Clear);
        assert_eq!(badge(Platform::Mac, f64::INFINITY), Badge::Clear);
        assert_eq!(badge(Platform::Mac, -1.0), Badge::Clear);
    }

    /// Only macOS has a Downloads stack, which is the whole of
    /// `dock.downloadFinished`'s `if (!app.dock) return`.
    #[test]
    fn only_mac_bounces_the_downloads_stack() {
        assert_eq!(download_notice(Platform::Mac), DownloadNotice::Bounce);
        assert_eq!(
            download_notice(Platform::Windows),
            DownloadNotice::Unsupported
        );
        assert_eq!(
            download_notice(Platform::Linux),
            DownloadNotice::Unsupported
        );
    }
}
