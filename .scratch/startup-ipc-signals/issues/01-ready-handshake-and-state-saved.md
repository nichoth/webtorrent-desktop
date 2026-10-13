# 01: Ready handshake and state-saved acknowledgement

**What to build:** the UI's two outbound startup signals reach real host
commands instead of throwing. Once its listeners are registered, the UI
tells the host it is ready, and the host records that in a readiness
record that US-065 can later consult before delivering or queuing open
events. After each state save, the UI tells the host the save finished,
and the host acknowledges it and does nothing else. `signalReady` and
`signalStateSaved` leave the stub register.

See `.scratch/startup-ipc-signals/spec.md` for the full decisions.

**Blocked by:** None (can start immediately)

**Touches:** `src-tauri/src/ready.rs` (new per-concern module holding
the readiness record and its pure logic and unit tests),
`src-tauri/src/main.rs` (`mod ready`, `app.manage(...)` for the record,
new `ipc_ready` and `state_saved` commands in `generate_handler!`),
`src/renderer/lib/platform/ipc-os.js` (`signalReady`,
`signalStateSaved`), `test/unit/platform-ipc-os.js`,
`test/unit/platform-stubs.js` (`UNIMPLEMENTED` register)

**Status:** done

- [x] The readiness record starts not ready
- [x] The readiness record reports ready after the ready signal
- [x] A repeated ready signal (a webview reload) is not an error and
      leaves the record ready
- [x] `signalReady()` invokes the host command `ipc_ready` with no
      arguments and resolves to `undefined`
- [x] `signalStateSaved()` invokes the host command `state_saved` with
      no arguments and resolves to `undefined`
- [x] `signalReady` and `signalStateSaved` are removed from the stub
      register, and the existing two-way stub sweep passes
- [x] `npm test`, `cargo fmt --check`, `cargo clippy -- -D warnings`
      and `cargo test` in `src-tauri` all pass
