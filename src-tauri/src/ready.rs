//! Whether the UI is listening yet.
//!
//! The renderer registers its host and engine listeners at startup and
//! then calls `ipcOs.signalReady`, which is the `ipc_ready` command.
//! Under Electron that was the `ipcReady` message `src/main/ipc.js`
//! waited on before sending the file and magnet open events the app
//! was launched with. Those events are US-065's; this is the record
//! they will consult, so that one sent before the UI can hear it is
//! queued rather than lost.
//!
//! A webview reload runs startup again and signals again. That is not
//! an error: the UI is ready either way.

use std::sync::atomic::{AtomicBool, Ordering};

/// Whether the UI has signalled ready. It starts not ready, and once
/// ready it stays ready.
#[derive(Debug, Default)]
pub struct Readiness(AtomicBool);

impl Readiness {
    /// The UI's listeners are registered.
    pub fn signal(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    /// Has the UI signalled ready? Nothing reads it until US-065
    /// delivers the open events, which is why it is allowed to be dead
    /// code until then.
    #[allow(dead_code)]
    pub fn is_ready(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_not_ready() {
        assert!(!Readiness::default().is_ready());
    }

    #[test]
    fn is_ready_after_the_signal() {
        let ready = Readiness::default();
        ready.signal();
        assert!(ready.is_ready());
    }

    #[test]
    fn a_repeated_signal_leaves_it_ready() {
        let ready = Readiness::default();
        ready.signal();
        ready.signal();
        assert!(ready.is_ready());
    }
}
