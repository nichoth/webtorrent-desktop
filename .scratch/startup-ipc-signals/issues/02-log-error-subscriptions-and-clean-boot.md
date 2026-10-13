# 02: Host log and error subscriptions, and the clean-boot regression test

**What to build:** on launch the main window shows no error banner.
The UI subscribes to the host's `log` and `error` channels, so anything
the host sends on them appears in the webview's developer console.
With the last startup stubs gone, the startup `Promise.all` resolves
and the UI signals ready after all its listeners are registered. The
`Promise.all` stays as written: no `allSettled`, no filtering of
not-implemented errors. `onLog` and `onError` leave the stub register,
which should then list only what is still owed.

No host-side producer for `log` or `error` is added here.

See `.scratch/startup-ipc-signals/spec.md` for the full decisions.

**Blocked by:** 01

**Touches:** `src/renderer/lib/platform/ipc-os.js` (`onLog`, `onError`,
via the shared `subscribe` helper, like `onDispatch`),
`test/unit/platform-ipc-os.js`, `test/unit/platform-stubs.js`
(`UNIMPLEMENTED` register and its comments),
`test/unit/renderer-boots.js` (webview sandbox boot test),
`src/renderer/main.js` (read only; startup IPC registration is not
restructured)

**Status:** ready-for-agent

- [ ] `onLog` subscribes once to the host event `log`, spreads an array
      payload into the listener's arguments, honours `{ once: true }`,
      and resolves to an unsubscribe function
- [ ] `onError` does the same for the host event `error`
- [ ] `onLog` and `onError` are removed from the stub register, and the
      existing two-way stub sweep passes
- [ ] The register's US-065 comment lists only the two open dialogs,
      and its reference to a host log module that does not exist is
      corrected
- [ ] In the boot seam test, with `invoke` answering enough to get past
      `app_paths` and the state load, the built renderer invokes
      `ipc_ready`
- [ ] In the same test, `ipc_ready` arrives after the
      `plugin:event|listen` calls for `log`, `error` and `dispatch`
      (assert the ordering, not any banner text)
- [ ] `npm test`, `cargo fmt --check`, `cargo clippy -- -D warnings`
      and `cargo test` in `src-tauri` all pass
