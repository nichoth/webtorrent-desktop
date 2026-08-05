//! The system clipboard.
//!
//! This is the Rust half of `platform/clipboard.js`. Under Electron the
//! clipboard is synchronous and available in the renderer; under Tauri
//! it is two host commands over the clipboard-manager plugin's Rust
//! API, which is what keeps `capabilities/default.json` at
//! `core:default` -- granting the JS plugin's `allow-read-text` /
//! `allow-write-text` would hand them to the whole webview.
//!
//! `main.rs` holds the commands. What lives here is the one place the
//! two hosts disagree: **an empty clipboard**.
//!
//! `clipboard.readText()` in Electron is synchronous and returns a
//! string, so an empty clipboard -- or one holding an image, or a file
//! reference -- is `''`. The plugin's `read_text` is `arboard`'s
//! `get_text`, which reports the same situation as
//! `Error::ContentNotAvailable`. [`read_outcome`] turns that one error
//! back into `''` and leaves every other failure a failure, so a broken
//! clipboard still rejects in the renderer instead of looking empty.

/// The distinguishing part of `arboard`'s `ContentNotAvailable`
/// message. The plugin collapses every clipboard error to its own
/// string (`Error::Clipboard(String)`), so this is the only thing left
/// to recognise it by. Matching on a substring rather than the whole
/// message keeps it working if the wording around it changes; if
/// `arboard` drops the phrase entirely, an empty clipboard starts
/// rejecting in the renderer, which is visible rather than silent.
const CLIPBOARD_IS_EMPTY: &str = "clipboard is empty";

/// What the renderer should see for a clipboard read.
pub fn read_outcome(read: Result<String, String>) -> Result<String, String> {
    match read {
        Ok(text) => Ok(text),
        Err(message) if message.contains(CLIPBOARD_IS_EMPTY) => Ok(String::new()),
        Err(message) => Err(message),
    }
}

#[cfg(test)]
mod tests {
    use super::read_outcome;

    /// `arboard::Error::ContentNotAvailable`, verbatim, which is what
    /// the plugin's error string is when the clipboard is empty.
    const NOT_AVAILABLE: &str = "The clipboard contents were not available in the \
                                 requested format or the clipboard is empty.";

    #[test]
    fn text_reads_through() {
        assert_eq!(
            read_outcome(Ok("magnet:?xt=urn:btih:abc".into())),
            Ok("magnet:?xt=urn:btih:abc".to_string())
        );
    }

    #[test]
    fn an_empty_clipboard_reads_as_an_empty_string() {
        assert_eq!(
            read_outcome(Err(NOT_AVAILABLE.into())),
            Ok(String::new()),
            "what Electron's synchronous readText answers"
        );
    }

    #[test]
    fn any_other_failure_stays_a_failure() {
        let held = "The native clipboard is not accessible due to being held \
                    by another party.";

        assert_eq!(read_outcome(Err(held.into())), Err(held.to_string()));
    }
}
