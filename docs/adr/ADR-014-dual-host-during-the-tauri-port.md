# ADR-014: Run two hosts side by side, and select the shim at build time

**Date:** 2026-07-29

**Spent as of US-072 (2026-08-04).** This ADR was written with an
expiry in it -- "US-072 is the single cutover" -- and that story ran.
Both mechanisms it decided are now removed rather than superseded:
there is one host, so `src/main/`, `index.js` and the Electron shim
tree are deleted and `src/renderer/lib/platform/tauri/` is promoted to
`src/renderer/lib/platform/`; and there is one shim tree, so the
`WT_HOST` variable, `bin/shim-resolver.js` and the `resolveId` plugin
that read it are gone with nothing to select between.
`test/unit/electron-removed.js` asserts both, so this record is now
history rather than a rule. **Two sections outlive it and are still
live:** "Target versions" is the current toolchain baseline, and
"Capabilities known not to survive" is the open work US-081 and US-082
own. Everything else below describes an arrangement that no longer
exists.

## Context

Phases 1 through 3 emptied the renderer of host knowledge. Every
Electron and Node surface the UI touches now goes through
`src/renderer/lib/platform/` (ADR-005), no host object crosses that
boundary (ADR-007), and the engine is a separate Node process the UI
reaches over a socket (ADR-012). What is left of Electron is
`src/main/` -- window creation, menus, tray, dialogs, the paths in
`src/config.js` -- plus the nine shim modules that call
`electron`/`@electron/remote` on the renderer side.

Phase 4 replaces that. It is ~20 stories: paths, app state, window
creation, seven shim modules, menu, tray, dock progress, protocol
handlers, power save blocker, media keys, folder watcher,
launch-on-login, sidecar supervision, and the updater. Every one of
them needs somewhere to put Rust and something to run.

FR-2 has held for the whole port: the app launches at every commit.
Twenty stories is far too long a stretch to break it for, and a
long-lived broken branch is how a port dies -- nothing is verifiable,
so nothing is known. The question this ADR answers is what "launchable"
means while two hosts exist, and how one build picks which host the
renderer talks to.

Three facts about the current build constrain the answer:

- The renderer bundle is **CommonJS with host modules externalized**
  (ADR-004). `require('electron')` survives into `build-vite/renderer/main.js`
  and resolves at load time only because the window runs with
  `nodeIntegration: true` (`src/main/windows/main.js:44`). A Tauri
  webview has no `require` and no Node module registry: the same bundle
  cannot load there at all.
- `static/main.html` references the entry with a plain `<script src>`
  at a **stable, unhashed path** (`vite.config.js`, `entryFileNames`).
  Both hosts can load the same file without either one knowing how it
  was built.
- The shim's barrel imports its siblings **relatively** --
  `import * as clipboard from './clipboard'` in
  `src/renderer/lib/platform/index.js:18`. Any selection mechanism has
  to intercept resolutions, not import specifiers.

## Decision

### `src-tauri/` grows alongside `src/main/` until one cutover story

Both hosts stay buildable and launchable for the whole of Phase 4.
Neither is a branch; they are two directories in the same tree.

- `src/main/` keeps working exactly as it does today. `npm start`
  stays `npm run build && electron --no-sandbox .` and stays the
  default. Every Phase 4 story that touches the Electron side does so
  to keep it working, never to hollow it out early.
- `src-tauri/` is created empty-but-launchable in US-051 and filled in
  one concern at a time. `npm run start:tauri` builds the renderer and
  launches it.
- **Both load the same Vite output** and the same `static/main.html`.
  There is no second HTML file and no second entry point. This is the
  property that makes the overlap cheap: the UI is host-agnostic
  already, so there is nothing to fork.
- The Tauri window is expected to be **partly broken for most of
  Phase 4**, and that is the plan rather than a defect. US-052's stubs
  throw a named not-implemented error, and each later story turns one
  set of throws into working calls. A story is done when its concern
  works under Tauri *and* still works under Electron.
- **US-072 is the single cutover.** It flips the default, and only
  then does `src/main/` get deleted. Nothing before it removes an
  Electron capability that Tauri does not yet have. Phase 4's
  verification pass (US-073) runs after it.

The cost is paid knowingly: for the length of Phase 4 every host
concern exists twice, and a change to a shim contract means changing
two implementations and running two smoke tests. That is the price of
FR-2, and it is bounded by US-072.

### The shim implementation is selected at build time

`src/renderer/lib/platform/*.js` stays the Electron implementation.
US-052 adds `src/renderer/lib/platform/tauri/*.js` with one module per
sibling and identical export names. **Exactly one of the two trees is
in a given bundle.**

The mechanism is a **Vite resolver plugin keyed on an environment
variable**, `WT_HOST`, defaulting to `electron`:

- With `WT_HOST=tauri`, the plugin rewrites any resolution that lands
  on `src/renderer/lib/platform/<mod>.js` to
  `src/renderer/lib/platform/tauri/<mod>.js`. Resolutions already
  inside `tauri/` are left alone, so the rewrite cannot recurse.
- It is a `resolveId` plugin rather than a `resolve.alias` entry
  because alias `find` patterns are matched against the import
  specifier as written, and the specifiers that matter are relative
  (`'./clipboard'` from the barrel). An alias list would silently miss
  them and ship a mixed bundle -- the worst possible outcome, because
  it builds.
- Under `WT_HOST=tauri` the bundle is also **ESM with no host
  externals**. `electron` and `@electron/remote` must leave the
  external list, because there is no `require` to resolve them; the
  Node builtins in `vite.config.js`'s two external lists go with them
  as the Rust side takes over each concern. ADR-004's CJS-plus-externals
  decision is scoped to the Electron host and expires at US-072.
- The **Babel build (`build/`) always compiles the Electron tree**.
  Babel has no alias step and none is being added: nothing in
  `build/` is loaded by Tauri. That path shrinks anyway -- US-055
  removes the main process's `require` of `src/renderer/lib/state.js`,
  which is the only reason `src/renderer/lib/` is compiled twice
  today (ADR-010, ADR-003).

Build time, not runtime, for four reasons:

1. **A runtime branch cannot be built.** Both trees would be in the
   bundle, so `require('electron')` would have to survive into the
   Tauri build, where it throws on load. Selecting at build time is not
   an optimisation here; it is the only form that produces a loadable
   artifact for both hosts.
2. **It keeps the boundary enforceable.** ADR-009's two mechanisms --
   the ESLint config and the source scan in
   `test/unit/platform-boundary.js` -- assert what the UI may reach.
   With one tree per bundle, "which host does this build talk to" is a
   fact about the build, and US-052's same-exports test is what keeps
   the trees from drifting. With a runtime branch, the shipped answer
   is unknowable from the source.
3. **It does not double the shim's surface.** A runtime branch makes
   every one of the nine modules a dispatcher with two backends plus
   the branch itself, and each Phase 4 story then has three things to
   keep working rather than two.
4. **It lets `nodeIntegration` die by construction.** The Tauri build
   has no Node in the renderer at all, which is the end state Phase 4
   is for. A runtime branch would keep a `require`-shaped dependency
   alive in the shipped bundle until the last story.

The escape hatch, if one is ever needed: nothing prevents a *single*
module from branching internally on a host capability -- but the
default is build-time selection, and a runtime branch needs its own
reason recorded.

### Target versions

- **Tauri 2** -- the `2` semver line, `tauri = "2"` in
  `src-tauri/Cargo.toml` and `@tauri-apps/api` `^2` in the renderer.
  Phase 4's plugin-shaped stories target the v2 plugin set
  (`dialog`, `opener`, `clipboard-manager`, `fs`, `single-instance`,
  `global-shortcut`, `updater`), which is where capabilities and
  permissions live in v2 rather than in an allowlist.
- **Rust:** no lower than **1.77.2**, Tauri 2's stated minimum. This
  machine has 1.97.1; that is the version Phase 4 is developed on, and
  `cargo fmt --check` plus `cargo clippy -- -D warnings` are gates
  from US-051 onward.
- **Node:** the Vite 8 build needs **20.19+**. The `engines` field in
  `package.json` still says `^16.0.0 || ^18.0.0`, which has been stale
  since Vite 8 landed; a Phase 4 story should correct it, and this ADR
  changes no code.
- **Per-platform system toolchain**, all of it Tauri 2's baseline:
  macOS needs the Xcode command line tools and gives WKWebView
  (26.5 here); Windows needs MSVC build tools plus the WebView2
  runtime; Linux needs `webkit2gtk-4.1` and `libsoup3` -- the 4.1/soup3
  pairing is v2's, not v1's.

### Capabilities known not to survive

One flag is already known to be lost, and it costs more than the story
it is named for.

`enableBlinkFeatures: 'AudioVideoTracks'` is set on both visible
windows (`src/main/windows/main.js:46`,
`src/main/windows/about.js:30`). It is a Chromium-internal feature
flag that turns on `HTMLMediaElement.audioTracks` and
`.videoTracks`. There is no equivalent on WKWebView or WebKitGTK,
where the API is unimplemented rather than gated, so no Tauri
configuration can restore it on macOS or Linux. Windows is the only
platform with even a plausible route, via extra WebView2 browser
arguments, and a capability that exists on one of three platforms is
not a capability the UI can be written against.

What depends on it, precisely:

- **Multi-audio-track switching.** `player-page.js:204-214` builds
  `state.playing.audioTracks.tracks` by iterating
  `mediaElement.audioTracks`, and `player-page.js:125-129` applies the
  selection by setting `.enabled` on each track. Without the flag the
  list is always empty, so `renderAudioTrackOptions`
  (`player-page.js:577`) renders nothing and the control at
  `player-page.js:606` is permanently `disabled`.
  `audio-tracks-controller.js` keeps working on state that is never
  populated. **US-082 owns the resolution.**
- **Codec detection, which is a bigger problem than the tracks.**
  `player-page.js:185-191` reads `mediaElement.videoTracks.length` and
  `mediaElement.audioTracks.length` to decide whether to dispatch
  `mediaError('Video codec unsupported')`. Those are unguarded
  dereferences -- unlike line 125, there is no `|| []` -- so on a
  webview without the flag they throw a `TypeError` inside
  `onLoadedMetadata` and take out playback startup entirely, not just
  the track menu. Whatever replaces this check is **US-081**'s
  business, and it must land before or with the cutover.

Two more flags on the same windows are lost by construction rather
than by regression, and are wanted gone: `nodeIntegration: true` and
`contextIsolation: false`. The Tauri renderer has no Node, which is
the point of the build-time selection above. `enableRemoteModule` was
already removed in US-045.

The codec bet ADR-013 named is the other half of this: WebKitGTK ships
without the proprietary codecs Chromium bundles, so on Linux a file
that will not play is also a file whose poster cannot be generated.
US-081 measures it.

## Consequences

FR-2 survives Phase 4 unchanged. Every commit has a launchable app,
and for most of the phase it has two, one of which is honestly
incomplete. The verification burden is the real cost: a shim contract
change is two implementations and two smoke tests, until US-072.

Any story that finds itself wanting to delete Electron code to make
Tauri work has found a sequencing error, not a necessity. The cutover
is one story with one job, and keeping the deletions inside it is what
makes a bisect meaningful if the Tauri host turns out to be wrong
about something.

`WT_HOST` becomes a third thing a build can vary, after mode and
target. It is deliberately one variable with two values and a default
that matches today's behaviour, so every existing command is
unaffected and a forgotten flag produces the Electron build rather
than a broken one.

The audio-tracks loss is the first capability this port gives up
outright rather than reimplements. It is worth being clear that the
flag was always a liability: it is a Chromium internal, off by
default, that the app opted into to get an API no other browser
engine implements. The multi-track menu is a small feature. The codec
check built on the same API is not, and US-081 has to replace it with
something that works on a webview that answers no questions about its
own decoders.
