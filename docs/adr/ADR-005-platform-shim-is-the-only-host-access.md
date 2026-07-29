# ADR-005: Route all renderer host access through an all-async platform shim

**Date:** 2026-07-28

## Context

Phase 1 established what the renderer reaches for. Phase 2 has to make
those reaches replaceable. The coupling is thin (roughly sixteen import
sites) but spread across twenty-two files, so the question is where to
put the boundary and what shape to give it.

A boundary is only useful if a replacement host can sit behind it. Two
properties of a non-Electron host drive the design:

- Some operations that are synchronous in Electron are not synchronous
  anywhere else. `clipboard.readText()`, `dialog.showOpenDialogSync()`,
  `getCurrentWindow().isMaximized()` and the `fs` sync calls all return
  immediately today because the renderer shares a process with the
  APIs. A host that has to cross a process boundary cannot.
- Channel names are an Electron detail. If callers build channel
  strings, the strings are part of the interface.

Alternatives considered:

- **One `platform.js` file**, as the original plan sketched. Workable
  at sixteen import sites, but it puts unrelated concerns (engine
  protocol, clipboard, file system) in one module, and the engine
  protocol is the piece most likely to be swapped independently.
- **Match Electron's signatures exactly, sync where Electron is sync.**
  Cheapest migration, but it guarantees a second refactor of every call
  site the day the host changes -- which is the entire point of the
  exercise.

## Decision

Create `src/renderer/lib/platform/` as the sole source of Electron and
Node access for the renderer (FR-8). Nine modules: `index.js` as a
namespace barrel, plus `ipc-os.js`, `ipc-engine.js`, `shell.js`,
`clipboard.js`, `fs.js`, `dialog.js`, `window.js` and `menu.js`.

**Every exported function is `async`** (FR-10), including wrappers
around APIs that are synchronous in Electron today. The migration pays
the async cost once, now, rather than a second time later.

**Channel names never reach a caller.** Each IPC channel gets a named
function. The two dynamic engine channels take an info hash as an
argument and do the concatenation inside the shim.

**Listener registration resolves to an unsubscribe function**, so no
caller touches `removeListener`. Registrations take an optional
`{ once: true }` for the existing `ipcRenderer.once` call sites.

Modules are grouped by **concern, not by Electron module**. Three
operations that are IPC channels today -- `openPath`,
`showItemInFolder`, `moveItemToTrash` -- live in `shell.js` alongside
`openExternal`, because a non-Electron host implements all four the
same way and `openExternal` is the only one Electron happens to expose
renderer-side.

The shim is implemented against Electron first, so Phase 2 is a
behaviour-preserving refactor that ships on the existing app.

The surface was designed up front and written down
(`docs/platform-shim.md`, US-018) mapping every export onto the call
sites it would replace, so the nine migration stories that followed
were mechanical rather than exploratory.

## Consequences

Swapping the host becomes a change to one directory. That is the
highest-leverage property in the whole plan and it required no Rust.

Async-everywhere is the expensive half of this decision. It propagated
further than expected in two places. `lib/state.js` and
`lib/migrations.js` were synchronous and are loaded by `src/main/` as
well as the renderer, so `migrations.run()` and `setupStateSaved()`
became async and `State.load(cb)` had to await both -- the spread
stopped there only because nothing outside `state.js` calls them.

`setDimensions()` in `main.js` was the genuinely risky conversion:
maximize state was read while window bounds were being saved, in one
synchronous turn describing one instant. It was split into a
synchronous geometry read followed by an async `applyDimensions()`, so
the saved bounds cannot belong to a different window size than the
check guarding them.

Two latent bugs surfaced during the migration, which is an argument for
the approach. `main.js:149` used the `electron.remote` spelling, which
had been throwing since Electron 14 and silently aborting the rest of
`onState()`, so `delayedInit()` had never run -- `checkDownloadPath()`,
the visibility listener and `Cast.init()` all execute again now.
`main.js:422` assigned `.isMaximized` without calling it, storing a
function in `state.window.wasMaximized`.

Designing the surface before migrating meant one story's output was a
document rather than code, which looks like overhead and was not.
