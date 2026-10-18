# 12: The window-bounds debounce uses one worker thread

**What to build:** The host's window-bounds `Debounce` starts a new
thread for every move or resize event, and each one sleeps out the full
delay.

After this ticket, `Debounce` runs one worker thread. Each call moves
the deadline forward, and the job runs once after the calls stop. The
behaviour seen by the window code is unchanged; only the
thread-per-event churn goes away.

**Blocked by:** None (can start immediately)

**Touches:** `src-tauri/src/window.rs` (`Debounce`, `Debounce::call`,
`BOUNDS_DEBOUNCE`), its caller in `src-tauri/src/main.rs` (signature
unchanged), in-module `#[cfg(test)]` tests (prior art
`src-tauri/src/ready.rs` and the existing tests in `window.rs`)

**Status:** ready-for-agent

- [x] After a burst of calls, the job runs exactly once
- [x] The job does not run before the delay has passed since the last
      call
