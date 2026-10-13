<!-- nightralph:entry ticket=startup-ipc-signals:1 attempt=1 outcome=tests -->
## 2026-10-12 22:25 -- startup-ipc-signals/01 attempt 1 -- failed (tests)

Effort: medium. Agent exit: 0. Subagents: 0. Cost: $1.14. Checked items: none.

Test gate failed.
Last 40 lines of `01-ready-handshake-and-state-saved.test.log`:
```
npm notice run webtorrent-desktop@0.25.1 test
npm notice run npm run lint && depcheck --ignores=standard,eslint,@babel/eslint-parser,madr,buffer --ignore-dirs=build,build-vite,build-tauri,build-sidecar,dist && npm run test-unit
npm notice run webtorrent-desktop@0.25.1 lint
npm notice run standard && npm run lint:boundary
npm notice run webtorrent-desktop@0.25.1 lint:boundary
npm notice run eslint --no-eslintrc -c eslint-boundary.config.js src/renderer src/engine
Unused devDependencies
* nightralph
```

### Agent notes
# Notes: 01 ready handshake and state-saved

## Host (items 1-3)
- New `src-tauri/src/ready.rs`: `Readiness` (AtomicBool, Default),
  `signal()` and `is_ready()`. `is_ready` has `#[allow(dead_code)]`
  until US-065 reads it (clippy -D warnings would fail otherwise).
- `main.rs`: `mod ready`, `app.manage(ready::Readiness::default())`,
  commands `ipc_ready` (sets the record) and `state_saved` (no-op ack),
  both in `generate_handler!`.
- Commands themselves are not unit-tested (need a running app); the
  pure record is, per the spec's host test seam.
- `cargo test`/clippy need `build-tauri/`: ran `npm run build:tauri` first.

## Shim + register (items 4-6)
- `signalReady` -> `invoke('ipc_ready')`, `signalStateSaved` ->
  `invoke('state_saved')`; both `await` and return nothing, so the
  host's unit `null` resolves to `undefined` (tests set `answer = null`
  to prove that).
- Tests added in `test/unit/platform-ipc-os.js` after the onDispatch block.
- Register: removed the two names; US-065 comment now lists only the
  dialogs. Left `onLog`/`onError` and their log.rs comment alone --
  that is the other ticket in this spec (onLog/onError subscription).
- Items 4-6 committed together: committing the shim without the
  register edit would have left the stub sweep red.
- Boot-seam test (ipc_ready after listen calls) not done here: it can
  only pass once onLog/onError stop throwing, i.e. the other ticket.

## Gate (item 7) -- NOT ticked
- `npm test` exits 255: depcheck reports `nightralph` as an unused
  devDependency. It was added to package.json by the orchestrator's
  `nightralph init` commit (b7d017b), not by this ticket, so I did not
  touch package.json (out of scope).
- Every other stage passes: standard + lint:boundary (ran before
  depcheck), depcheck with `nightralph` added to --ignores ("No depcheck
  issue"), `npm run test-unit` 4205/4205, `cargo fmt --check`,
  `cargo clippy -- -D warnings`, `cargo test` 209/209.
- Fix for whoever owns it: add `nightralph` to depcheck's --ignores in
  the `test` script, or drop it from devDependencies.

## AGENTS.md
- Added a gotcha to `src/renderer/lib/platform/AGENTS.md`: a `()` Rust
  command resolves to `null`, so "resolves to nothing" exports should
  await and return nothing.

---
<!-- nightralph:entry ticket=startup-ipc-signals:1 attempt=2 outcome=done -->
## 2026-10-12 22:29 -- startup-ipc-signals/01 attempt 2 -- done

Effort: high. Agent exit: 0. Subagents: 0. Cost: $1.20. Checked items: "`npm`` test`, `cargo fmt --check`, `cargo clippy -- -D warnings` and `cargo test` in `src-tauri` all pass".

### Agent notes
# Notes: 01 ready handshake and state-saved (attempt 2)

## Host (items 1-3) -- done
- New `src-tauri/src/ready.rs`: `Readiness(AtomicBool)`, `Default`,
  `signal()` and `is_ready()`. `is_ready` is `#[allow(dead_code)]`
  until US-065 reads it (clippy -D warnings).
- Red seen: with `signal` stubbed, the two "after signal" tests failed.
- `main.rs`: `mod ready`, `app.manage(Readiness::default())`, commands
  `ipc_ready` (sets record) and `state_saved` (no-op ack), both in
  `generate_handler!`. The commands themselves need a running app, so
  only the pure record is unit-tested (spec's host seam).
- cargo needs `build-tauri/`: ran `npm run build:tauri` first.
- fmt, clippy -D warnings, cargo test (209) pass.

## Shim + register (items 4-6) -- done
- `signalReady` -> `await invoke('ipc_ready')`, `signalStateSaved` ->
  `await invoke('state_saved')`; neither returns, so the host's `null`
  for a `()` command reaches the caller as `undefined`. Tests set
  `answer = null` to prove it. Red seen (NotImplementedError) first.
- Tests in `test/unit/platform-ipc-os.js` after the onDispatch block.
- Register: removed the two; US-065 comment now names only the dialogs.
  `onLog`/`onError` and their wrong `log.rs` comment are left for the
  other ticket in this spec.
- Committed 4-6 together: the shim without the register edit leaves
  the stub sweep red.
- Boot-seam test (ipc_ready after the listen calls) is not here: it can
  only pass once onLog/onError stop throwing (the other ticket).

## Gate (item 7) -- done
- Attempt 1 failed only on depcheck: `nightralph` (added by the
  orchestrator's init commit) is an unused devDependency. Fixed by
  adding `nightralph` to depcheck `--ignores` in the `test` script. It
  is a CLI that is never imported, the same reason `madr` is there.
  Separate commit (ce38b66).
- `npm test` exit 0 (4207/4207, "No depcheck issue"); `cargo fmt
  --check`, `cargo clippy -- -D warnings`, `cargo test` (209) pass.

## AGENTS.md
- `src/renderer/lib/platform/AGENTS.md` Gotchas: a `()` command
  answers `null`; "resolves to nothing" exports should await and
  return nothing, with the test stub answering `null`.

---
