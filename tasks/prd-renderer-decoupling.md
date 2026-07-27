# PRD: Renderer Decoupling (Vite Build + Platform Shim)

## Introduction

WebTorrent Desktop is an Electron app whose renderer process is wired
directly into Electron and Node. The renderer calls `ipcRenderer`,
`@electron/remote`, `shell`, `clipboard`, and Node builtins (`fs`,
`path`, `crypto`, `os`, `http`) from 40 source files. Any future move
off Electron -- the eventual target being Tauri with a librqbit
torrent engine -- is blocked until those dependencies are (a)
buildable by a standard bundler and (b) funnelled through a single
replaceable module.

This PRD covers exactly two pieces of work, both of which run entirely
in JavaScript and require zero Rust:

1. **Phase 1:** Get `src/renderer/` building under Vite.
2. **Phase 2:** Collapse every Electron and Node import in the
   renderer into one platform shim, implemented against Electron so
   the app keeps working.

When both are done, swapping the shim's internals is the single edit
that migrates the entire UI to a new host. Nothing in this PRD ships
a Tauri app, writes Rust, or changes the torrent engine.

### Measured starting state

These numbers were taken from the repo at commit `6c91af3` and differ
in places from `docs/init.md`. They are the basis for the scope below.

| Fact | Value |
| --- | --- |
| Renderer JS files | 40 |
| Renderer LOC | 6,765 |
| Files using `module.exports` / `exports.` | 38 |
| Files using ESM `import` / `export` | 0 |
| `ipcRenderer` call sites | 102 |
| Node/Electron import lines | ~41 |
| Files importing `path` | 13 |
| Distinct IPC channels sent from renderer | 54 |

Build today is `babel src --out-dir build` with a single plugin,
`@babel/plugin-transform-react-jsx` (`useBuiltIns: true`). JSX lives
in `.js` files. `static/main.html` loads the renderer with a literal
`<script>require('../build/renderer/main.js')</script>`, and
`static/webtorrent.html` does the same for the hidden engine window.

Three findings drive the story breakdown:

- **The renderer is entirely CommonJS.** Rollup cannot consume
  `require()` in source modules, so an ESM conversion of all 40 files
  is unavoidable and is the bulk of Phase 1.
- **`src/renderer/main.js:8-13` monkey-patches
  `Module.prototype.require`** to stub out `inline-style-prefixer`.
  This is a perf hack that no bundler can honour. It must be deleted
  and replaced with a build-time alias.
- **`@electron/remote` is not a thin import.** It supplies
  `dialog.showOpenDialogSync`, `dialog.showSaveDialogSync`,
  `getCurrentWindow().isVisible()` / `.isMaximized()`, a full
  `Menu`/`MenuItem` context menu
  (`src/renderer/controllers/torrent-list-controller.js:258-310`), and
  `screen.getAllDisplays()`. These are *synchronous* APIs. Their
  eventual replacements are async, so the shim must define async
  signatures now even where the Electron implementation is sync.

## Goals

- `src/renderer/` builds to a working bundle via `vite build`, and the
  Electron app runs from that bundle with no functional regressions.
- Every Electron and Node import in the renderer is replaced by an
  import from a single shim directory.
- A lint rule makes it impossible to reintroduce a direct `electron`
  or Node-builtin import in the renderer without an explicit override.
- The shim's engine-facing surface (the `wt-*` channels) is a separate
  module from its OS-facing surface, so the engine can be swapped for
  librqbit independently of the UI.
- The Electron app remains launchable and functional at every commit
  on the branch.

## Non-Goals (Out of Scope)

- Any Rust, any Tauri config, any Tauri project scaffolding.
- Replacing the torrent engine. `src/renderer/webtorrent.js` stays as
  is and keeps building through the existing Babel path, not Vite
  (see FR-4). librqbit is the eventual destination and is a separate
  future PRD.
- Porting `src/main/` (2,484 LOC). Untouched.
- Vite dev server and HMR. See "Technical Considerations" for why this
  is deferred rather than dropped.
- Merging to `master`. All work lands on a dedicated branch.
- Any change to CSS, visual design, or user-facing behaviour. This is
  a pure refactor. If the UI looks or behaves differently, that is a
  bug in the work, not a feature of it.
- Rewriting or removing the deferred-casualty features listed below.

### Deferred casualties (tracked, not resolved here)

`docs/init.md` identifies functionality that will not survive a move
off Electron. None of it is addressed in this PRD, and none of it is
being deleted. Each needs its own decision later:

| Feature | Location | Why it is at risk |
| --- | --- | --- |
| Multi-audio-track switching | `controllers/audio-tracks-controller.js` | Depends on `enableBlinkFeatures: 'AudioVideoTracks'`, a Chromium-only flag with no WKWebView equivalent |
| Chromecast / DLNA / AirPlay | `lib/cast.js` | Runs an `http` server in the renderer; needs full reimplementation |
| Telemetry | `lib/telemetry.js` | Uses `@electron/remote` `screen` and `os`; may simply be dropped |
| Windows thumbar / user tasks | `src/main/thumbar.js`, `user-tasks.js` | Superseded by other bundlers' plugins |

These files must keep **building and working** through Phases 1-2.
They are exempt from the shim migration only where noted in FR-11.

## User Stories

Each story is sized for one focused session. Every story that changes
runtime behaviour ends with the standard smoke test defined below.

### Standard smoke test

Referenced by acceptance criteria as "smoke test passes". Run
`npm start` and verify:

1. App launches; torrent list renders with the four default torrents.
2. Adding a magnet link starts a download and progress updates.
3. Playing a video opens the player; play/pause and seek work.
4. Right-clicking a torrent row opens the context menu.
5. Preferences opens; the download-folder path selector opens a
   native dialog.
6. Quit and relaunch; torrent list state persisted.

---

## Phase 1: Vite build

### US-001: Create branch and capture the baseline failure inventory
**Description:** As a developer, I want a recorded list of every
module Vite cannot resolve, so that the remaining Phase 1 stories are
driven by measured facts rather than guesses.

**Acceptance Criteria:**
- [ ] Branch created off current `redesign` HEAD, named
      `renderer-decoupling`
- [ ] `vite` added as a dev dependency
- [ ] A minimal `vite.config.js` exists with
      `src/renderer/main.js` as the entry point
- [ ] `vite build` is run and its full output captured to
      `docs/vite-baseline.md`, including every "could not resolve"
      and "externalized" warning
- [ ] `docs/vite-baseline.md` groups failures by cause (CommonJS,
      JSX, Node builtin, Electron)
- [ ] The build is *expected to fail* at this stage; a failing build
      with a captured inventory is a passing story
- [ ] `npm test` (standard + depcheck) passes

### US-002: Remove the `Module.prototype.require` monkey patch
**Description:** As a developer, I need the require-hook removed so
that the renderer entry point can be processed by a bundler at all.

**Acceptance Criteria:**
- [ ] Lines 8-13 of `src/renderer/main.js` deleted
- [ ] `inline-style-prefixer` stubbed via `resolve.alias` in
      `vite.config.js` pointing at an empty module
- [ ] App still launches under the existing Babel build
      (`npm start`)
- [ ] No visual regression in `material-ui` components, checked on
      the torrent list and preferences pages
- [ ] `npm test` passes
- [ ] Smoke test passes

### US-003: Configure the JSX transform for `.js` files
**Description:** As a developer, I want Vite to compile JSX inside
`.js` files, because every component in this codebase uses that
combination and esbuild does not handle it by default.

**Acceptance Criteria:**
- [ ] `vite.config.js` configures esbuild with `loader: 'jsx'` for
      `src/**/*.js` (or an equivalent plugin configuration)
- [ ] The existing `useBuiltIns: true` JSX behaviour from
      `.babelrc` is preserved or its removal is justified in a
      comment
- [ ] A single component file (`components/header.js`) compiles
      without JSX syntax errors, verified by build output
- [ ] `npm test` passes

### US-004: Convert `src/renderer/lib/` to ESM
**Description:** As a developer, I need the lib layer in ESM so Rollup
can statically analyse it.

**Acceptance Criteria:**
- [ ] All files in `src/renderer/lib/` use `import` / `export`
      instead of `require` / `module.exports`
- [ ] Lazy/conditional requires (`lib/migrations.js:46,52,173`,
      `lib/state.js:121`, `lib/telemetry.js:21,86`) are converted to
      top-level imports, or the reason for keeping them dynamic is
      recorded in a code comment
- [ ] Named vs default exports match how each module is consumed at
      its call sites
- [ ] App still launches under the Babel build
- [ ] `npm test` passes
- [ ] Smoke test passes

### US-005: Convert `src/renderer/components/` to ESM
**Description:** As a developer, I need the component layer in ESM.

**Acceptance Criteria:**
- [ ] All 10 files in `src/renderer/components/` use ESM syntax
- [ ] App still launches under the Babel build
- [ ] `npm test` passes
- [ ] Smoke test passes, with specific attention to the modals
      (remove-torrent, unsupported-media, open-torrent-address,
      update-available, delete-all-torrents)

### US-006: Convert `src/renderer/controllers/` and `pages/` to ESM
**Description:** As a developer, I need the controller and page layers
in ESM.

**Acceptance Criteria:**
- [ ] All 9 controller files and all 5 page files use ESM syntax
- [ ] `lib/dispatcher.js` wiring still resolves every controller
      method by name
- [ ] App still launches under the Babel build
- [ ] `npm test` passes
- [ ] Smoke test passes

### US-007: Convert the renderer entry point and shared config to ESM
**Description:** As a developer, I need `main.js` and any shared
module it pulls from outside `src/renderer/` in ESM, completing the
conversion.

**Acceptance Criteria:**
- [ ] `src/renderer/main.js` uses ESM syntax
- [ ] `src/config.js` (and any other shared module imported by the
      renderer) is ESM-compatible without breaking `src/main/`, which
      remains CommonJS
- [ ] If `src/config.js` must serve both, the dual-consumption
      approach is documented in a comment
- [ ] Zero files under `src/renderer/` except `webtorrent.js` contain
      `module.exports` or a top-level `require(`, verified by grep
- [ ] `npm test` passes
- [ ] Smoke test passes

### US-008: Resolve Node builtins in the Vite build
**Description:** As a developer, I want each Node builtin in the
renderer given an explicit resolution strategy, so the bundle can be
produced and so Phase 2 knows what it must replace.

**Acceptance Criteria:**
- [ ] `path` (13 files) resolved by bundling `path-browserify` via
      `resolve.alias`, since it is browser-safe
- [ ] `fs` marked external and listed in `docs/vite-baseline.md` as
      Phase 2 shim work
- [ ] `crypto`, `os`, `http` marked external and annotated with which
      deferred-casualty file uses them (`webtorrent.js`,
      `telemetry.js`, `cast.js`)
- [ ] `electron` and `@electron/remote` marked external
- [ ] Build output format is set so Electron with
      `nodeIntegration: true` can consume the externals (see
      Technical Considerations)
- [ ] `vite build` completes with zero unresolved-import errors
- [ ] `npm test` passes

### US-009: Serve the renderer HTML through Vite
**Description:** As a developer, I want `main.html` to load the Vite
bundle instead of a hand-written `require()` call.

**Acceptance Criteria:**
- [ ] `static/main.html` uses a normal `<script>` tag referencing the
      Vite entry, not `require('../build/renderer/main.js')`
- [ ] `static/webtorrent.html` is left unchanged and still loads the
      Babel-built engine
- [ ] `static/main.css` is still applied
- [ ] App launches from the Vite output
- [ ] `npm test` passes
- [ ] Smoke test passes

### US-010: Wire npm scripts to the Vite build
**Description:** As a developer, I want `npm start` and `npm run
build` to produce and run the Vite bundle, so the new path is the
default and cannot silently rot.

**Acceptance Criteria:**
- [ ] `npm run build` runs Vite for the renderer and Babel for
      `src/main/` and `src/renderer/webtorrent.js`
- [ ] `npm start` launches Electron against the Vite output
- [ ] `npm run watch` still rebuilds on change
- [ ] `npm run package` still produces a working app bundle on the
      current platform
- [ ] `npm test` passes
- [ ] Smoke test passes

### US-011: Phase 1 verification pass
**Description:** As a developer, I want a documented confirmation that
the Vite-built app is functionally identical to the Babel-built one,
so Phase 2 starts from a known-good state.

**Acceptance Criteria:**
- [ ] Full smoke test executed and results recorded in
      `docs/vite-baseline.md`
- [ ] `npm run test-integration` passes
- [ ] Startup time measured and compared against `master`; any
      regression greater than 25% is recorded as a known issue with a
      cause identified
- [ ] Deferred-casualty features confirmed still working: audio-track
      switching on a multi-track file, and cast device discovery
- [ ] `npm test` passes

---

## Phase 2: Platform shim

### US-012: Define the shim API surface
**Description:** As a developer, I want the shim's module layout and
function signatures agreed before any call site moves, so that the
migration is mechanical rather than exploratory.

**Acceptance Criteria:**
- [ ] `src/renderer/lib/platform/` created with `index.js` plus one
      module per concern: `ipc-os.js`, `ipc-engine.js`, `shell.js`,
      `clipboard.js`, `dialog.js`, `window.js`, `menu.js`, `fs.js`
- [ ] Every exported function has a JSDoc signature, and every one
      that today wraps a synchronous Electron API is declared
      `async` anyway
- [ ] `ipc-engine.js` covers only the `wt-*` channels;
      `ipc-os.js` covers only the rest. No module exports both.
- [ ] The surface is documented in `docs/platform-shim.md`, listing
      each function against the call sites it will replace
- [ ] No call sites changed yet; this story is design only
- [ ] `npm test` passes

### US-013: Implement the IPC modules against Electron
**Description:** As a developer, I want `ipc-os.js` and
`ipc-engine.js` implemented over `ipcRenderer`, so the 102 existing
call sites have somewhere to go.

**Acceptance Criteria:**
- [ ] Both modules implemented using `ipcRenderer` internally
- [ ] `ipc-engine.js` handles the dynamic channel names
      (`wt-ready-${infoHash}`, `wt-server-${infoHash}`) without
      leaking string concatenation to callers
- [ ] Listener registration returns an unsubscribe function rather
      than requiring callers to track `removeListener`
- [ ] Unit tests cover send, receive, and unsubscribe for one channel
      of each kind
- [ ] `npm test` passes

### US-014: Implement `shell`, `clipboard`, and `fs` modules
**Description:** As a developer, I want the mechanical parts of the
shim implemented, since they map almost one to one onto Electron.

**Acceptance Criteria:**
- [ ] `shell.js` covers `openExternal` and `showItemInFolder`
- [ ] `clipboard.js` covers `readText` and `writeText`
- [ ] `fs.js` covers exactly the operations the renderer uses today:
      `copyFileSync`, `mkdirSync`, `readFileSync`, and whatever
      `main.js`, `torrent-list-controller.js` and
      `subtitles-controller.js` require
- [ ] All exports are async, even where the Electron implementation
      is synchronous
- [ ] `npm test` passes

### US-015: Implement the `@electron/remote` replacement modules
**Description:** As a developer, I want the remote surface behind
`dialog.js`, `window.js`, and `menu.js`, because this is the part of
the shim with no straightforward equivalent on other hosts and it
needs its shape decided now.

**Acceptance Criteria:**
- [ ] `dialog.js` covers `showOpenDialogSync` and
      `showSaveDialogSync` behind async functions
- [ ] `window.js` covers `isVisible()`, `isMaximized()`, and current
      window access
- [ ] `menu.js` exposes a data-driven context menu API: callers pass
      an array of `{ label, click, enabled }` descriptors instead of
      constructing `remote.MenuItem` objects
- [ ] The nine-item torrent context menu in
      `torrent-list-controller.js:258-310` is expressible through
      that API, verified by rewriting it in the following story
- [ ] `screen.getAllDisplays()` is either included or explicitly
      excluded with a note that `telemetry.js` is a deferred casualty
- [ ] `npm test` passes

### US-016: Migrate the OS-channel call sites to the shim
**Description:** As a developer, I want every non-`wt-*` Electron call
in the renderer routed through the shim.

**Acceptance Criteria:**
- [ ] All `shell`, `clipboard`, `dialog`, `window`, `menu`, and `fs`
      call sites import from `lib/platform/` only
- [ ] All OS-channel `ipcRenderer` call sites use `ipc-os.js`
- [ ] The torrent context menu is rewritten against the descriptor
      API from US-015
- [ ] `src/renderer/main.js` no longer imports `electron` directly
- [ ] `npm test` passes
- [ ] Smoke test passes, with explicit checks on: context menu,
      save-file dialog, open-folder dialog, external link opening,
      copy magnet link, and window maximize state persistence

### US-017: Migrate the `wt-*` engine call sites to the shim
**Description:** As a developer, I want the engine channels routed
through `ipc-engine.js`, so the engine becomes a swappable unit.

**Acceptance Criteria:**
- [ ] Every `wt-*` call site in the renderer UI uses
      `ipc-engine.js`
- [ ] `src/renderer/webtorrent.js` is *not* migrated; it remains a
      direct `ipcRenderer` consumer, since it is the counterparty and
      is slated for replacement by librqbit
- [ ] `docs/platform-shim.md` records the complete `wt-*` protocol as
      it now exists at the shim boundary, which is the contract a
      librqbit implementation must satisfy
- [ ] `npm test` passes
- [ ] Smoke test passes, with attention to torrent add, progress
      updates, file selection, and streaming server start/stop

### US-018: Enforce the boundary with lint
**Description:** As a developer, I want a lint rule preventing new
direct Electron or Node imports in the renderer, so the decoupling
does not erode.

**Acceptance Criteria:**
- [ ] A `no-restricted-imports` rule (or equivalent) bans `electron`,
      `@electron/remote`, `fs`, `os`, `crypto`, and `http` under
      `src/renderer/`
- [ ] `src/renderer/lib/platform/` is exempt
- [ ] The deferred-casualty files (`webtorrent.js`, `cast.js`,
      `telemetry.js`) carry explicit per-file overrides with a
      comment naming them as deferred
- [ ] The rule is wired into `npm test` and fails the build when
      violated, verified by temporarily adding a bad import
- [ ] `npm test` passes

### US-019: Phase 2 verification pass
**Description:** As a developer, I want confirmation that the shim is
complete and the app is unregressed, so the branch is a valid base for
a future host swap.

**Acceptance Criteria:**
- [ ] Grep confirms zero direct `electron` / `@electron/remote`
      imports under `src/renderer/` outside the shim and the three
      documented exemptions
- [ ] Full smoke test executed and recorded
- [ ] `npm run test-integration` passes
- [ ] `npm run package` produces a working bundle
- [ ] `docs/platform-shim.md` updated with the final surface and a
      short "what a new host must implement" section
- [ ] `npm test` passes

## Functional Requirements

- **FR-1:** All work must land on a branch named
  `renderer-decoupling`, taken from the current `redesign` HEAD.
  Nothing merges to `master` within this PRD.
- **FR-2:** The Electron app must launch and pass the smoke test at
  every commit on the branch. A commit that leaves the app broken is
  not a valid commit.
- **FR-3:** All 40 renderer source files except
  `src/renderer/webtorrent.js` must be converted from CommonJS to
  ESM.
- **FR-4:** `src/renderer/webtorrent.js` must continue to be built by
  Babel and loaded by `static/webtorrent.html` unchanged. It is not
  passed through Vite, because it runs in a separate
  fully-node-integrated hidden window and is slated for replacement by
  librqbit.
- **FR-5:** The `Module.prototype.require` hook in
  `src/renderer/main.js:8-13` must be deleted and replaced with a
  build-time alias.
- **FR-6:** Vite must compile JSX contained in `.js` files.
- **FR-7:** `path` must be resolved via `path-browserify` and bundled,
  not externalized.
- **FR-8:** The system must provide a shim directory at
  `src/renderer/lib/platform/` that is the sole source of Electron and
  Node access for the renderer.
- **FR-9:** The shim must separate engine-facing (`wt-*`) from
  OS-facing IPC into two modules that share no exports.
- **FR-10:** Every shim function must be async, including wrappers
  around currently-synchronous Electron APIs, so that a future
  message-passing implementation does not force a second refactor of
  every call site.
- **FR-11:** A lint rule must ban direct `electron`,
  `@electron/remote`, `fs`, `os`, `crypto`, and `http` imports under
  `src/renderer/`, exempting `lib/platform/` and carrying documented
  per-file overrides for `webtorrent.js`, `cast.js`, and
  `telemetry.js`.
- **FR-12:** The context menu API must be data-driven -- callers
  supply descriptor objects, not `MenuItem` instances.
- **FR-13:** `npm run build`, `npm start`, `npm run watch`, and
  `npm run package` must all work at the end of Phase 1.
- **FR-14:** No CSS file may be modified.

## Technical Considerations

**Vite dev server is deferred, not dropped.** Vite's dev server serves
native ESM over HTTP, where externalized Node builtins like `fs`
cannot resolve. Phase 1 therefore targets `vite build` only, producing
a bundle Electron loads from disk. Once Phase 2 removes Node builtins
from the renderer entirely, the dev server becomes viable. Attempting
both at once will stall Phase 1.

**Output format.** With `nodeIntegration: true` still enabled on the
main window, externalized `electron` and `fs` imports need an output
format Electron can resolve at runtime. A CommonJS output target is
the low-friction choice for Phase 1 even though sources are ESM. This
is a build-output decision only and does not affect source style. If
it proves troublesome, the alternative is to bring the `fs` shim
forward from Phase 2 and drop the externals entirely.

**Sync-to-async is the real risk in Phase 2.** `showOpenDialogSync`,
`showSaveDialogSync`, `isMaximized()`, and `getAllDisplays()` are
called synchronously today, and some sit in code paths that assume an
immediate return value -- `main.js:443-455` reads maximize state while
saving window bounds. Making these async will surface ordering bugs
that the smoke test may not catch. Budget time for it and check
window-state persistence carefully.

**`src/config.js` is shared** between `src/main/` (CommonJS, staying
that way) and `src/renderer/` (becoming ESM). US-007 must solve this
without breaking the main process.

**Branch strategy tradeoff.** `docs/init.md` argues the shim refactor
should ship on `master` as a no-op, which would keep the diff small
and continuously validated. Doing it on a branch instead means a
long-lived divergence and a larger eventual merge. To limit the
damage: rebase on `master` regularly, and keep the app runnable at
every commit per FR-2.

**Testing.** This repo has no TypeScript, so "typecheck" in the
acceptance criteria means `npm test`, which runs `standard` and
`depcheck`. Integration tests are `npm run test-integration`. Because
this is an Electron desktop app rather than a web page, UI
verification is the manual smoke test defined above, not browser
automation.

## Success Metrics

- `vite build` produces a working renderer bundle with zero
  unresolved imports.
- Zero direct `electron` or `@electron/remote` imports remain under
  `src/renderer/` outside the shim and its three documented
  exemptions.
- The count of files a future host swap must touch drops from 22 to 1
  directory.
- App startup time regresses by less than 25% against `master`.
- Full smoke test and `npm run test-integration` pass at the end of
  each phase.

## Open Questions

1. **Does `useBuiltIns: true` on the JSX transform matter?** It
   affects how props are spread. Worth confirming no component relies
   on the difference before switching to esbuild's transform.
2. **Should `telemetry.js` just be deleted now?** It is a deferred
   casualty, it pulls in `@electron/remote` `screen` and `os`, and it
   reports to WebTorrent's endpoints. Deleting it in Phase 1 would
   remove two shim surfaces and one lint exemption. This is a product
   decision, not a technical one.
3. **How should `lib/cast.js` be handled during Phase 1?** It runs an
   `http` server inside the renderer. Externalizing `http` should let
   the build pass, but this needs verifying early -- it is the most
   likely single point of Phase 1 failure.
4. **Does `npm run package` need to keep working throughout?** FR-13
   requires it at the end of Phase 1. Keeping it green at every commit
   is more expensive; confirm whether that is wanted.
5. **What is the target for the `wt-*` protocol documentation in
   US-017?** If librqbit's API is already known, the protocol doc
   could be written against that shape rather than transcribing
   WebTorrent's, which would save a translation layer later.
