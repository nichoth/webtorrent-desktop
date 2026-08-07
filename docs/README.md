# WebTorrent Desktop

Developer documentation for building, running, and working on the app.
For installing a released build, see the
[project README](../README.md).

**This app runs on Tauri.** US-072 cut it over: the Electron main
process, the Electron entry point and the second shim tree are all
gone, and the host is `src-tauri/`. Every command below is a Tauri
command. See [Porting to Tauri](#porting-to-tauri) for what is left of
the port and which rules exist because of it.

## Requirements

- Node.js 24 or later, which is what `engines` in `package.json`
  declares. Vite 8 itself would take `20.19+` or `22.12+`, but US-047
  ships a pinned Node 24 runtime inside the packaged app, and building
  on an older line than the one you ship is not worth the ambiguity.
- npm 10 or later. Node 24 ships npm 11.
- macOS on Apple Silicon, if you intend to produce a packaged build.
  Development works on all three platforms; `npx tauri build` does
  not, because the staged engine runtime is `darwin-arm64` only. See
  [Package the app](../README.md#package-the-app).
- The Rust toolchain, and Tauri 2's per-platform system dependencies:
  the Xcode command line tools on macOS, MSVC build tools plus the
  WebView2 runtime on Windows, `webkit2gtk-4.1` and `libsoup3` on
  Linux. See
  [ADR-014](adr/ADR-014-dual-host-during-the-tauri-port.md) for the
  versions.

macOS, Windows, and Linux are all supported for development.

## Run

```sh
git clone https://github.com/nichoth/webtorrent-desktop.git
cd webtorrent-desktop
npm i
npm start
```

`npm start` runs `npm run build:tauri` and then `tauri dev`. There is
no dev server for the UI: the webview always loads compiled output from
disk, so a build has to run before the host starts.

## Build

`npm run build` runs two independent builds, and the app needs both.
`npm run build:tauri` runs both and then stages the engine sidecar into
`build-tauri/` for the Rust side to spawn.

| Script | Tool | Input | Output |
| --- | --- | --- | --- |
| `build:node` | Babel | `src/`, minus the four renderer UI paths | `build/` |
| `build:renderer` | Vite | `src/renderer/main.js` | `build-vite/` |

- `build:node` compiles `src/config.js`, `src/engine/**`,
  `src/shared/**` and `src/renderer/lib/**` to CommonJS in `build/`.
  What still needs it is the engine sidecar the host spawns
  (`build/engine/index.js`), the config module the sidecar shares with
  the renderer, the wire protocol, and the unit suite, which requires
  Babel output rather than `src/` (ADR-010). It no longer builds a main
  process; there is not one.
- `build:renderer` bundles the UI -- `main.js`, `components/`,
  `controllers/`, `pages/` -- into `build-vite/renderer/main.js`, which
  `static/main.html` loads with a plain `<script src>`.

Those four UI paths are passed to Babel's `--ignore` because Vite owns
them exclusively. `src/renderer/lib/**` is deliberately built both
ways, because the unit suite loads the CommonJS copy.

Either build can be run on its own when you know which half you
touched. `npm run build:renderer` is the fast one.

The Vite config is at `vite.config.js`. It is heavily commented,
because several settings are load-bearing in non-obvious ways -- the
JSX-in-`.js` transform, the IIFE output format, and the fact that there
are no externals at all: a webview has no `require`, so every module
the bundle names is bundled into it. Read the comments before changing
it.

## Develop

### Watch mode

```sh
npm run watch
```

Rebuilds and restarts the app on every change to a `.js` or `.css`
file under the repo, ignoring `build/`, `build-vite/`, and `dist/`.
This is a full restart, not hot reload.

### Tests

```sh
npm test              # lint, dependency check, and unit tests
npm run test-unit     # unit tests only
npm run lint          # standard + the renderer boundary rules
```

`npm run test-unit` builds `build/` first, because the unit tests run
against Babel output rather than `src/` (see
[ADR-010](adr/ADR-010-unit-tests-run-against-babel-output.md)).

`npm run lint` runs two things: `standard` over the whole repo, and a
separate ESLint pass (`eslint-boundary.config.js`) over `src/renderer/`
and `src/engine/`. It fails the build if renderer code reaches a Node
builtin directly instead of going through the platform shim, or names
`@tauri-apps/api` anywhere but inside the shim, and if engine code
touches a DOM global -- the sidecar is a plain Node process, so that is
the mirror-image mistake. The shim is the seam the host sits behind and
the sidecar is the seam librqbit swaps in, so both halves of the rule
are load-bearing rather than stylistic.
`test/unit/platform-boundary.js` enforces the same things for
`require()` spellings and for usage the import rule cannot see.

There is no integration suite. Spectron drove the Electron app and has
no Tauri counterpart, so US-072 deleted it along with the host;
`test/AGENTS.md` records what replaces it and why a `tauri-driver`
harness is not scoped to a story yet.

### Where the code lives

- `src-tauri/` -- the host, in Rust. Window creation, menus, tray,
  dialogs, paths, the updater, and supervision of the engine sidecar.
  See `src-tauri/AGENTS.md`.
- `src/renderer/` -- the UI, in ESM. All host access goes through the
  platform shim in `src/renderer/lib/platform/`, which is the one
  module set that calls `@tauri-apps/api`. There is one window.
- `src/engine/` -- the torrent engine, as its own process: the sidecar
  entry point `index.js` plus the WebSocket bus it talks to the UI
  through. A plain Node process, so it has no Electron and no DOM;
  librqbit replaces it later. See `src/engine/AGENTS.md`.
- `src/shared/` -- code both processes must agree on. Just `wire.js`,
  the `{ channel, args }` codec for the `wt-*` protocol. Nothing here
  may import a host module.
- `static/` -- HTML entry points and app icons.
- `test/unit/` -- the whole test suite.

`src/AGENTS.md` covers the module-system rules in detail: which files
are ESM, why the conversion order matters, and why dynamic `import()`
does not work in the renderer. It also has the map of which process
loads what.

### Useful scripts

```sh
npm run clean         # delete build output, config, temp files, handlers
npm run open-config   # open the app's config directory
```

`npm run clean` removes state from your system, not just the repo: it
deletes `build/`, `build-vite/`, `dist/`, the saved app config, the
temp download directory, and the installed `.torrent` and magnet link
handlers.

## Package

There is no packaging script yet. `bin/package.js` drove
`electron-packager` and left with the Electron host; Tauri's bundler
replaces it, and US-083 and US-084 own the signed macOS, Windows and
Linux builds.

## Porting to Tauri

The goal was to leave Electron for Tauri, and eventually to replace the
WebTorrent engine with librqbit. Rather than starting a fresh Tauri app
and porting screens into it, the renderer was decoupled from Electron
*in place*, so there was a working, smoke-testable app at every commit.
[ADR-001](adr/ADR-001-decouple-renderer-before-porting-to-tauri.md)
records that decision and the alternatives it rejected.

The plan is five phases:

| Phase | Work | State |
| --- | --- | --- |
| 1 | Build `src/renderer/` with Vite | done |
| 2 | Collapse host access into one platform shim | done |
| 3 | Run the torrent engine as a Node sidecar | done |
| 4 | Port the main process to Rust | done, pending verification |
| 5 | Casting, external players, codecs, signing | not started |

Phases 1 to 3 required no Rust. Phase 3 kept the existing WebTorrent
engine and reused the `wt-*` channel names as its wire protocol, so the
engine swap stays independent of the host swap: the app runs a UI
renderer, a Rust host, and an engine sidecar, and the UI reaches the
engine over a loopback WebSocket rather than through the host. The
topology is in `docs/platform-shim.md`.

`specs/prd.json` is the authoritative task list -- each story carries a
`passes` flag. It covers all five phases: US-001 to US-035 for Phases 1
and 2, which are complete apart from US-017's verification pass, then
US-036 to US-049 (Phase 3), US-050 to US-073 (Phase 4), and US-074 to
US-086 (Phase 5). Stories marked `"manual": true` need an attended
session -- a real app window, a packaged build, a signing certificate,
or cast hardware -- and are skipped by the headless loop. Phase 3's two
remaining stories are both attended: US-047 ships the sidecar inside the
packaged build, and US-049 is the verification pass.

Both Phase 3 decisions recorded in the PRD's `conventions` held. The
renderer connects to the sidecar directly over a localhost WebSocket
rather than relaying `wt-*` through the host, which is what US-044 built
and US-045 finished by deleting the relay.

Phase 4 grew `src-tauri/` alongside `src/main/` with the shim
implementation chosen at build time, so Electron stayed launchable
until one cutover story. That story was US-072, and it removed both
halves of the arrangement: `src/main/`, `index.js` and the Electron
shim tree are deleted, `src/renderer/lib/platform/tauri/` is promoted
to `src/renderer/lib/platform/`, and the `WT_HOST` build flag is gone
because there is nothing left to select.
`test/unit/electron-removed.js` is what keeps it that way.

### What this means day to day

Phases 1 to 3 built the two seams the rest of the port swaps out -- the
platform shim on the host side and the sidecar on the engine side -- so
most of the rules in this document exist to protect them:

- **The platform shim is the swap point.** Every host and Node surface
  the UI needs is reachable through `src/renderer/lib/platform/`, and
  the UI touches nothing else. Reimplementing those modules against
  Tauri's `invoke`/`listen` is what migrated the whole UI without
  touching a component. That is why the boundary lint rule and
  `test/unit/platform-boundary.js` both exist: an `@tauri-apps/api`
  import outside the shim is the decoupling eroding, not a legitimate
  need.
- **Every shim function is `async`.** It was already true of the
  wrappers around Electron APIs that were synchronous, and it is what
  made them portable: `invoke` crosses a process boundary and has no
  synchronous form.
- **No host object crosses the boundary.** The shim passes plain data,
  so nothing on the UI side holds a host handle. The menu API is
  data-driven for the same reason.
- **The `wt-*` channels are a wire protocol**, not an implementation
  detail. Phase 3 kept the channel names unchanged and carries them over
  a WebSocket to the sidecar instead of over host IPC.
  `docs/platform-shim.md` documents the contract, including the
  pre-connect queue a replacement engine has to provide.
- **The sidecar is a plain Node process.** No host module, no DOM
  global, and no media handling -- poster generation moved to the UI
  renderer in US-043 for exactly that reason. The boundary lint rule
  polices `src/engine/` for those mistakes the way it polices
  `src/renderer/` for direct host imports.
- **No module is a deferred casualty any more.** All three exemptions
  are spent: US-002 deleted `lib/telemetry.js`, US-045 deleted
  `src/renderer/webtorrent.js` when the engine became a process of its
  own, and US-079 deleted `src/renderer/lib/cast.js` -- the one that
  ran an `http` server in the renderer -- when casting was
  reimplemented on the host behind `lib/platform/cast.js` (ADR-015).
  They were exempt because they were being thrown away, not because
  the rules are optional, which is why the exemption list is now empty
  and `test/unit/lint-boundary.js` asserts it stays that way.

Some Electron capabilities did not survive the move. The main window
ran with `nodeIntegration: true`, `contextIsolation: false`, and
`enableBlinkFeatures: 'AudioVideoTracks'`. The first two are gone by
construction -- a webview has no Node -- and were wanted gone.

The third was expected to cost the multi-audio-track menu, and did
not. That flag turned on `videoTracks` and `audioTracks`, which
`audio-tracks-controller.js` is built on and which Tauri has no way to
set -- but it was gating a *WebKit* API that Chromium had copied and
left off by default. WKWebView and WebKitGTK implement it outright, so
the menu works there; on WebView2 the lists are absent, the menu has
nothing to list and its control renders disabled. Nothing was removed.
Two things did change, both measured in the app's own window
(US-081, US-082):

- **The lists arrive late.** On WKWebView both are present and *empty*
  at `loadedmetadata` and fill from `addtrack` before `loadeddata`, so
  everything that reads them waits for `loadeddata`. Read a beat
  earlier and the codec check finds no tracks on every file and opens
  the unsupported-media modal over a video that plays perfectly.
- **The element decides which track starts, not the app.** The player
  reads back whichever track the webview enabled instead of forcing
  the first one on, so a file whose default is not track 1 keeps it.

An absent list means "this webview has no opinion", never "no tracks":
reading `.length` off the missing one threw from inside the load
handler and took the whole of playback startup with it. The rules and
the measurements are [docs/codec-support.md](codec-support.md); the
code is `lib/audio-tracks.js` and `lib/media-playability.js`.

### Further reading

- [ADR index](adr/INDEX.md) -- the decisions that shape the current
  build and shim. Read this first if you are changing anything
  structural.
- `docs/init.md` -- the original five-phase plan and the measurements
  behind it.
- `docs/platform-shim.md` -- the shim's API surface and the full
  `wt-*` protocol contract.
- `docs/codec-support.md` -- what each webview was measured as able to
  decode, and what the player does with a file it cannot.
- `docs/vite-baseline.md` -- what Vite could not handle at the start of
  Phase 1, resolved item by item.
- `tasks/prd-renderer-decoupling.md` -- the numbered requirements
  (FR-*) that the ADRs and stories cite.
