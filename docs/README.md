# WebTorrent Desktop

Developer documentation for building, running, and working on the app.
For installing a released build, see the
[project README](../README.md).

**This app is being ported from Electron to Tauri.** It still runs on
Electron today, and every command below is an Electron command -- there
is no `src-tauri/` directory and no Rust in the repo yet. The port is
being done in place, so the app stays launchable at every commit. See
[Porting to Tauri](#porting-to-tauri) for where that work stands and
which rules exist because of it.

## Requirements

- Node.js `20.19+` or `22.12+`. This is what Vite 8 requires; the
  `engines` field in `package.json` still says `^16 || ^18` and is out
  of date.
- npm 7 or later.

macOS, Windows, and Linux are all supported for development.

## Run

```sh
git clone https://github.com/nichoth/webtorrent-desktop.git
cd webtorrent-desktop
npm i
npm start
```

`npm start` runs `npm run build` and then launches Electron with
`--no-sandbox`. There is no dev server: the app always loads compiled
output from disk, so a build has to run before Electron starts.

## Build

`npm run build` runs two independent builds, and the app needs both.

| Script | Tool | Input | Output |
| --- | --- | --- | --- |
| `build:main` | Babel | `src/`, minus the four renderer UI paths | `build/` |
| `build:renderer` | Vite | `src/renderer/main.js` | `build-vite/` |

- `build:main` compiles `src/config.js`, `src/main/**`, `src/engine/**`,
  `src/shared/**` and `src/renderer/lib/**` to CommonJS in `build/`.
  `index.js` (the Electron entry point) requires `build/main`, and the
  host spawns the torrent engine as `build/engine/index.js`.
- `build:renderer` bundles the UI -- `main.js`, `components/`,
  `controllers/`, `pages/` -- into `build-vite/renderer/main.js`, which
  `static/main.html` loads with a plain `<script src>`.

Those four UI paths are passed to Babel's `--ignore` because Vite owns
them exclusively. `src/renderer/lib/**` is deliberately built both
ways, because both processes use it.

Either build can be run on its own when you know which half you
touched. `npm run build:renderer` is the fast one.

The Vite config is at `vite.config.js`. It is heavily commented,
because several settings are load-bearing in non-obvious ways -- the
JSX-in-`.js` transform, the CommonJS output format, and the list of
externalized Node builtins. Read the comments before changing it.

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
and `src/engine/`. It fails the build if renderer code imports
`electron`, `@electron/remote`, or a Node builtin directly instead of
going through the platform shim, and if engine code imports Electron or
touches a DOM global -- the sidecar is a plain Node process, so that is
the mirror-image mistake. The shim is the seam the Tauri port swaps out
and the sidecar is the seam librqbit swaps in, so both halves of the rule
are load-bearing rather than stylistic.
`test/unit/platform-boundary.js` enforces the same things for
`require()` spellings and for usage the import rule cannot see.

Integration tests are separate and slower:

```sh
npm run test-integration
```

They drive the real app with Spectron and compare screenshots, so they
are sensitive to screen resolution and to mouse movement while
running. See
["Run integration tests"](../README.md#run-integration-tests) for the
per-platform requirements.

### Where the code lives

- `src/main/` -- the Electron main process. Stays CommonJS; ported to
  Rust in Phase 4. It supervises the engine sidecar
  (`src/main/engine-process.js`) and hands the UI its endpoint.
- `src/renderer/` -- the UI, converted to ESM. All host access goes
  through the platform shim in `src/renderer/lib/platform/`, which is
  the module set a Tauri host reimplements. There is one window.
- `src/engine/` -- the torrent engine, as its own process: the sidecar
  entry point `index.js` plus the WebSocket bus it talks to the UI
  through. A plain Node process, so it has no Electron and no DOM;
  librqbit replaces it later. See `src/engine/AGENTS.md`.
- `src/shared/` -- code both processes must agree on. Just `wire.js`,
  the `{ channel, args }` codec for the `wt-*` protocol. Nothing here
  may import a host module.
- `static/` -- HTML entry points and app icons.
- `test/unit/` -- unit tests. `test/` -- integration tests.

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

```sh
npm run package
```

Builds installers for Mac, Linux, and Windows into `dist/`. Pass a
platform and options after `--`:

```sh
npm run package -- darwin --package=dmg
```

Note that `npm run package` deletes `node_modules/` and runs `npm ci`
before it builds. The full option list, plus the per-platform
prerequisites (Wine and Mono for Windows builds from other platforms,
`npm run install-system-deps` for Linux builds from a Mac), is in
["Package the app"](../README.md#package-the-app).

## Porting to Tauri

The goal is to leave Electron for Tauri, and eventually to replace the
WebTorrent engine with librqbit. Rather than starting a fresh Tauri app
and porting screens into it, the renderer is being decoupled from
Electron *in place*, so there is a working, smoke-testable app at every
commit. [ADR-001](adr/ADR-001-decouple-renderer-before-porting-to-tauri.md)
records that decision and the alternatives it rejected.

The plan is five phases:

| Phase | Work | State |
| --- | --- | --- |
| 1 | Build `src/renderer/` with Vite | done |
| 2 | Collapse host access into one platform shim | done |
| 3 | Run the torrent engine as a Node sidecar | done |
| 4 | Port `src/main/` to Rust | not started |
| 5 | Casting, external players, codecs, signing | not started |

Phases 1 to 3 require no Rust. Phase 3 kept the existing WebTorrent
engine and reused the `wt-*` channel names as its wire protocol, so the
engine swap stays independent of the host swap: the app now runs a UI
renderer, an Electron host, and an engine sidecar, and the UI reaches
the engine over a loopback WebSocket rather than through the host. The
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
and US-045 finished by deleting the relay. Phase 4 grows `src-tauri/`
alongside `src/main/` with the shim implementation chosen at build time,
so Electron stays launchable until one cutover story.

### What this means day to day

Phases 1 to 3 built the two seams the rest of the port swaps out -- the
platform shim on the host side and the sidecar on the engine side -- so
most of the rules in this document exist to protect them:

- **The platform shim is the swap point.** Every Electron and Node
  surface the UI needs is reachable through
  `src/renderer/lib/platform/`, and the UI touches nothing else.
  Reimplementing those modules against Tauri's `invoke`/`listen`
  migrates the whole UI without touching a component. That is why the
  boundary lint rule and `test/unit/platform-boundary.js` both exist:
  a new direct `electron` import is the decoupling eroding, not a
  legitimate need.
- **Every shim function is `async`**, including wrappers around
  Electron APIs that are synchronous today, because a host that has to
  cross a process boundary cannot offer a synchronous version later.
- **No host object crosses the boundary.** The shim passes plain data,
  so nothing on the UI side holds an Electron handle. The menu API is
  data-driven for the same reason.
- **The `wt-*` channels are a wire protocol**, not an implementation
  detail. Phase 3 kept the channel names unchanged and carries them over
  a WebSocket to the sidecar instead of over Electron IPC.
  `docs/platform-shim.md` documents the contract, including the
  pre-connect queue a replacement engine has to provide.
- **The sidecar is a plain Node process.** No Electron module, no DOM
  global, and no media handling -- poster generation moved to the UI
  renderer in US-043 for exactly that reason. The boundary lint rule
  polices `src/engine/` for those mistakes the way it polices
  `src/renderer/` for direct host imports.
- **One module is a deferred casualty**, exempt from the shim:
  `src/renderer/lib/cast.js`, which runs an `http` server in the
  renderer and is reimplemented outright in Phase 5. It is exempt
  because it is being thrown away, not because the rules are optional.
  The other two exemptions are gone: US-002 deleted `lib/telemetry.js`,
  and US-045 deleted `src/renderer/webtorrent.js` when the engine became
  a process of its own.

Some Electron capabilities will not survive the move. The main window
runs with `nodeIntegration: true`, `contextIsolation: false`, and
`enableBlinkFeatures: 'AudioVideoTracks'` -- that last one is
Chromium-only and `audio-tracks-controller.js` depends on it, so
multi-audio-track switching will not work on WKWebView (US-082).

### Further reading

- [ADR index](adr/INDEX.md) -- the decisions that shape the current
  build and shim. Read this first if you are changing anything
  structural.
- `docs/init.md` -- the original five-phase plan and the measurements
  behind it.
- `docs/platform-shim.md` -- the shim's API surface and the full
  `wt-*` protocol contract.
- `docs/vite-baseline.md` -- what Vite could not handle at the start of
  Phase 1, resolved item by item.
- `tasks/prd-renderer-decoupling.md` -- the numbered requirements
  (FR-*) that the ADRs and stories cite.
