# ADR-001: Decouple the renderer in place before porting to Tauri

**Date:** 2026-07-26

## Context

WebTorrent Desktop is an Electron app: 2,484 LOC in `src/main/`, 6,765
in `src/renderer/`. The goal is to leave Electron for Tauri, and
eventually to replace the WebTorrent engine with librqbit.

Measuring the coupling first changed the plan. Twenty-two renderer
files touch Electron or Node, which sounds severe, but the coupling is
broad and thin: roughly sixteen import sites in total, almost entirely
`ipcRenderer` (6 files), `@electron/remote` (4), `shell` (2),
`clipboard` (2) and `fs.copyFileSync` (3). There is no deep Node
entanglement in the UI.

The IPC surface splits cleanly in two, and the halves have completely
different difficulty profiles:

- 21 `wt-*` channels talking to the hidden WebTorrent window
- roughly 35 OS channels talking to the main process

The second is mechanical. The first is the project.

The obvious alternative is to start a Tauri application and port
screens into it. That path makes every renderer change a change to
software nobody can run: there is no working build to smoke test
against until the port is substantially complete, and the parts most
likely to be wrong (the engine protocol, the OS integration) are the
last to be exercised.

A third option, rewriting the UI outright, was never seriously on the
table -- the UI is the part of this codebase that works.

## Decision

Decouple the renderer from Electron *in place*, on Electron, in
phases, keeping the app launchable and smoke-testable at every commit
(FR-2).

- **Phase 1** -- get `src/renderer/` building under Vite.
- **Phase 2** -- collapse every Electron and Node import in the
  renderer into a single replaceable platform shim, implemented
  against Electron so nothing changes behaviourally.
- **Phase 3** -- run the existing `webtorrent.js` as a Node sidecar,
  with the `wt-*` channel names as the wire protocol, before
  attempting librqbit.
- **Phase 4** -- port `src/main/` to Rust.
- **Phase 5** -- the long tail: casting, external players, codec
  fallbacks, signing and notarization.

Phases 1 and 2 require zero Rust and are the highest-leverage work in
the project: once the shim exists, swapping its internals migrates the
whole UI from one file set.

This is otherwise a pure refactor. No CSS file may be modified and
there is no change to visual design or user-facing behaviour (FR-14),
with the single exception of the telemetry removal.

## Consequences

Every commit ships. The app remains a working Electron app throughout
Phases 1 and 2, so a regression is caught by a smoke test on the same
day it is introduced rather than at the end of a long port.

The engine swap is isolated from the host swap. Phase 3 can proceed
against Electron, and Phase 4 against the real WebTorrent engine,
instead of both risks landing at once.

The `wt-*` channel names become a wire protocol by default rather than
by design. That is cheap here because the protocol is small and
already documented, but it does mean the eventual librqbit engine
inherits an interface shaped by WebTorrent's internals.

Some Electron capabilities have no Tauri equivalent and will be lost
or reimplemented rather than ported. The hidden window runs with
`nodeIntegration: true`, `contextIsolation: false`, `enableRemoteModule:
true` and `enableBlinkFeatures: 'AudioVideoTracks'`. That last one is
Chromium-only and `audio-tracks-controller.js` depends on it, so
multi-audio-track switching will not survive on WKWebView.

The work is longer in total than a direct port would be if the direct
port went well. This trades peak speed for the ability to stop at any
commit with a working application.
