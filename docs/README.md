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

- `build:main` compiles `src/config.js`, `src/main/**`,
  `src/renderer/lib/**`, and `src/renderer/webtorrent.js` to CommonJS
  in `build/`. `index.js` (the Electron entry point) requires
  `build/main`, and the hidden engine window loads
  `build/renderer/webtorrent.js` from `static/webtorrent.html`.
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
separate ESLint pass (`eslint-boundary.config.js`) over
`src/renderer/`, which fails the build if renderer code imports
`electron`, `@electron/remote`, or a Node builtin directly instead of
going through the platform shim. That shim is the seam the Tauri port
swaps out, so the rule is load-bearing rather than stylistic --
`test/unit/platform-boundary.js` enforces the same thing for
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
  Rust in Phase 4.
- `src/renderer/` -- the UI, converted to ESM. All host access goes
  through the platform shim in `src/renderer/lib/platform/`, which is
  the module set a Tauri host reimplements.
- `src/renderer/webtorrent.js` -- the hidden engine window. Exempt from
  the Vite build and from the shim; still CommonJS. Becomes a sidecar
  in Phase 3.
- `static/` -- HTML entry points and app icons.
- `test/unit/` -- unit tests. `test/` -- integration tests.

`src/AGENTS.md` covers the module-system rules in detail: which files
are ESM, why the conversion order matters, and why dynamic `import()`
does not work in the renderer.

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
| 3 | Run `webtorrent.js` as a Node sidecar | not started |
| 4 | Port `src/main/` to Rust | not started |
| 5 | Casting, external players, codecs, signing | not started |

Phases 1 and 2 require no Rust. Phase 3 keeps the existing engine and
reuses the `wt-*` IPC channel names as its wire protocol, so the engine
swap stays independent of the host swap.

`specs/prd.json` is the authoritative task list -- each story carries a
`passes` flag. It covers all five phases: US-001 to US-035 for Phases 1
and 2, which are complete apart from US-017's verification pass, then
US-036 to US-049 (Phase 3), US-050 to US-073 (Phase 4), and US-074 to
US-086 (Phase 5). Stories marked `"manual": true` need an attended
session -- a real app window, a packaged build, a signing certificate,
or cast hardware -- and are skipped by the headless loop.

Two Phase 3 decisions are already made and recorded in the PRD's
`conventions`: the renderer connects to the sidecar directly over a
localhost WebSocket rather than relaying `wt-*` through the host, and
Phase 4 grows `src-tauri/` alongside `src/main/` with the shim
implementation chosen at build time, so Electron stays launchable until
one cutover story.

### What this means day to day

Phases 1 and 2 built the seam that the rest of the port swaps out, so
most of the rules in this document exist to protect it:

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
- **The `wt-*` IPC channels are a wire protocol**, not an
  implementation detail. Phase 3 reuses the channel names unchanged
  over a WebSocket to a sidecar. `docs/platform-shim.md` documents the
  contract.
- **Two modules are deferred casualties**, exempt from the shim:
  `src/renderer/webtorrent.js` (also exempt from the Vite build;
  becomes a sidecar in Phase 3, then librqbit) and
  `src/renderer/lib/cast.js` (bundled by Vite, but reimplemented
  outright in Phase 5). They are exempt because they are being thrown
  away, not because the rules are optional.

Some Electron capabilities will not survive the move. The hidden
window runs with `nodeIntegration: true`, `contextIsolation: false`,
and `enableBlinkFeatures: 'AudioVideoTracks'` -- that last one is
Chromium-only and `audio-tracks-controller.js` depends on it, so
multi-audio-track switching will not work on WKWebView.

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
