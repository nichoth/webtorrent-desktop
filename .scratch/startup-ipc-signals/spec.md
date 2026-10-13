# Startup IPC signals under Tauri

**Status:** ready-for-agent

## Problem Statement

Every launch of the Tauri build shows a red error banner across the top
of the main window:

> platform/ipc-os.onLog() is not implemented yet (ADR-014). Implement it
> in src/renderer/lib/platform/ipc-os.js and in the host command it
> needs.

The app otherwise works, so the banner reads as a false alarm. Over time
that teaches the user to ignore the error banner, which is also where
real failures show up.

The cause is the renderer's startup IPC registration. It registers all
of its host and engine listeners in one `Promise.all`. The first two
are the OS-IPC log and error subscriptions, and both are still ADR-014
not-implemented stubs that throw. The `Promise.all` rejects, startup
error reporting dispatches `'error'`, and the banner appears. The other
listeners in that array still register, because they all start
synchronously before the rejection lands. That is why the app works.

The rejection also hides two more problems further down the same
function:

- The ready signal is never sent. It is also a stub, owed by US-065,
  so the host is never told the UI is listening.
- The state-saved signal is never wired up, so nothing calls that
  stub either.

Fixing only the log subscription would not clear the banner. The next
stub in line would name itself instead, and after that the state-saved
stub would throw on every state save.

## Solution

On launch the main window shows no error banner. The host and the UI
agree on the startup handshake again:

- The UI subscribes to the host's log and error channels. Anything the
  host sends on them shows up in the webview's developer console, just
  as main-process logs did under Electron.
- Once its listeners are registered, the UI tells the host it is ready.
  The host records this, and US-065's queue of file and magnet open
  events will drain on it.
- After each state save, the UI tells the host the save finished.

A genuinely unported concern still fails loudly. This spec removes
four entries from the stub register and does not soften how the
remaining stubs fail.

## User Stories

1. As a user launching the app, I want no error banner when nothing
   has gone wrong, so that I trust the banner when it does appear.
2. As a user, I want the error banner to keep appearing for real
   failures, so that I find out when something I asked for did not
   happen.
3. As a developer, I want messages the host sends on its log and error
   channels to appear in the webview's developer console, so that I
   can debug the host without a separate terminal.
4. As a developer working on US-065, I want the host to already know
   whether the UI has signalled ready, so that queuing open events
   only needs the queue, not the handshake too.
5. As a developer, I want each stub to throw only when its own
   concern is missing, so that one stub cannot hide another behind a
   single rejected `Promise.all`.

## Implementation Decisions

- **OS-IPC shim: `onLog` and `onError` become standing subscriptions**
  to the host events `log` and `error`. They follow the same pattern
  as `onDispatch`: they go through the shared `subscribe` helper,
  honour `{ once: true }`, and resolve to an unsubscribe function.
- **Both spread their payload.** A Tauri event carries a single
  payload, where Electron's `send` carried an argument list. The
  shim's convention for a multi-argument listener is that the host
  sends the whole list as an array and the shim spreads it. The
  caller's signature stays `(...args)`, and startup passes them
  straight to `console.log` / `console.error`.
- **No host producer is added for `log` or `error` in this spec.**
  Subscribing to an event nothing emits is harmless. A host-side
  emitter (for example, forwarding host log lines to the webview) can
  come later without touching the renderer.
- **OS-IPC shim: `signalReady` invokes a new host command,
  `ipc_ready`, and `signalStateSaved` invokes a new host command,
  `state_saved`.** Neither takes arguments, and both resolve to
  `undefined`. Command names use snake_case, like the existing host
  commands.
- **Host: a readiness record, registered as managed state.** It is a
  small type holding whether the UI has signalled ready. `ipc_ready`
  sets it and is idempotent: a second call (a webview reload, say) is
  not an error. It exposes a query for whether the UI is ready, which
  US-065 will consult before delivering open events or queuing them.
  It lives in its own host module, next to the other per-concern
  modules, so that its logic is testable without a running app.
- **Host: `state_saved` is an acknowledgement and does nothing else.**
  The Tauri host does not currently ask the UI to save before
  quitting. Its quit path exits at once, so there is nothing yet to
  wake. The command exists so the UI's half of the contract is real
  and stops throwing.
- **Startup IPC registration is not restructured.** The `Promise.all`
  stays. Once its stubs are gone it resolves, and the ready signal and
  the state-saved hook run as written. Switching to
  `Promise.allSettled`, or filtering out not-implemented errors at
  startup, was rejected: either one would silence the next unported
  stub that appears there, which goes against ADR-014's rule that an
  unported concern stays loud.
- **The stub register shrinks by four:** `onLog`, `onError`,
  `signalReady` and `signalStateSaved`. The register's US-065 comment
  should then list only what US-065 still owes, which is the two open
  dialogs. Its comment that names a host log module should be
  corrected, because no such module exists.
- **US-065 keeps its open-event work.** The parts of its acceptance
  criteria about queuing until ready and delivering on the existing
  shim event are unchanged. This spec only delivers the ready
  handshake those criteria build on.

## Testing Decisions

- Tests check external behaviour at the shim and host boundaries:
  which host command or event crosses, with what payload, and what the
  caller receives. They do not check internal helper calls or message
  text.
- **Boot seam (the regression test for the banner).** This is the
  existing test that evaluates the built renderer bundle in a webview
  sandbox. The sandbox's `invoke` answers enough for startup to get
  past `app_paths` and the state load, then the test asserts two
  things. First, the bundle invokes `ipc_ready`. Second, it does so
  after the engine and OS listeners are registered, which shows up as
  `ipc_ready` arriving after the `plugin:event|listen` calls for
  `log`, `error` and `dispatch`. That ordering is the contract that
  matters, so the test asserts it. Asserting "no banner text" would be
  brittle and is ruled out. This seam fails today, because startup
  never reaches `ipc_ready`.
- **OS-IPC shim seam.** The existing OS-IPC shim test records `listen`
  / `once` / `invoke` against a stubbed Tauri core. The prior art is
  its three `onDispatch` tests: subscribes once on the right event
  name, spreads the array payload, and honours `{ once: true }`. Mirror
  those for `onLog` and `onError`. Add one test each that
  `signalReady` and `signalStateSaved` invoke `ipc_ready` and
  `state_saved` with no arguments.
- **Stub register.** The existing stub-register test already sweeps in
  both directions. Once the four names leave the register, it fails if
  any of them still throws and if any other export starts throwing.
  This needs no new test, only the register edit.
- **Host unit tests.** These cover the readiness type: it starts not
  ready, is ready after the signal, and a repeated signal leaves it
  ready. They follow the pure-decision tests already in the dock and
  tray host modules, which assert per-concern logic without a running
  app.
- The full gate still has to pass: `npm test` (standard, depcheck,
  unit), plus `cargo fmt --check`, `cargo clippy -- -D warnings` and
  `cargo test` in the Tauri crate.

## Out of Scope

- Queuing and delivering file and magnet open events, and the
  second-instance argv (US-065).
- The open-torrent and open-files dialogs, and registering as the
  default `.torrent`/magnet handler. These stay stubs (US-065, US-064).
- Any host-side producer for the `log` and `error` events.
- Making the host's quit path ask the UI to save state and wait for
  `state_saved` before exiting. See Further Notes.
- Delaying when the window is shown until the UI is ready. The host
  currently shows the window after restoring its bounds, and that does
  not change here.

## Further Notes

- **A gap this investigation turned up but does not fix: quit does not
  wait for a state save.** Under Electron, quitting dispatched a save
  to the UI and waited for `stateSaved` before exiting. The Tauri
  host's quit sets the quitting flag and exits immediately. A change
  made within the state module's save debounce window just before quit
  could therefore be lost. `state_saved` from this spec is the
  acknowledgement such a flow would wait on. It needs its own spec or
  ticket.
- ADR-014 is marked as spent as of US-072. This spec follows its
  surviving principle, that stubs throw loudly, which the stub
  register still enforces. It does not reopen the ADR.
- An alternative was considered and set aside: leave `signalReady`
  and `signalStateSaved` as stubs until US-065. That would only move
  the banner from `onLog` to `signalReady`, so it does not solve the
  user-visible problem.
