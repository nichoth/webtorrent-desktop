# Webtorrent Desktop

Rewriting it in Tauri.

## Install

Download the arm64 macOS `.dmg` from this fork's
[releases](https://github.com/nichoth/webtorrent-desktop/releases).
Builds are ad-hoc signed rather than notarized, so macOS asks you to
approve the app once before it opens -- see
[First launch](RELEASE_PROCESS.md#first-launch). Apple Silicon Macs
only.

To build one yourself, see [Package the app](#package-the-app), or
the ["How to Contribute"](#how-to-contribute) instructions to run the
development version.

The [official website](https://webtorrent.io/desktop/), the
[GitHub releases](https://github.com/webtorrent/webtorrent-desktop/releases)
page and `brew install --cask webtorrent` all install the upstream
Electron app, not this one.

## Screenshots

<p align="center">
  <img src="https://webtorrent.io/img/screenshot-player3.png"
       alt="screenshot" align="center">
  <img src="https://webtorrent.io/img/screenshot-main.png" width="612"
       height="749" alt="screenshot" align="center">
</p>

## How to Contribute

### Get the code

```
$ git clone https://github.com/webtorrent/webtorrent-desktop.git
$ cd webtorrent-desktop
$ npm install
```

### Run the app

```
$ npm start
```

### Watch the code

Restart the app automatically every time code changes. Useful during
development.

```
$ npm run watch
```

### Run linters

```
$ npm test
```

### Run integration tests

There are none right now. The old suite drove the Electron app with
Spectron and compared screenshots; the app runs on Tauri now, Spectron
has no Tauri counterpart, and the suite was deleted with the host it
drove. `test/AGENTS.md` records what covers the same ground in the
meantime and what a replacement harness would take.

### Package the app

```
$ npm run package
```

On an Apple Silicon Mac this produces
`src-tauri/target/release/bundle/macos/WebTorrent.app` and a matching
`.dmg` in `bundle/dmg/`. The script is `npm run build:tauri` followed
by `tauri build`, and it is what CI runs too -- see
[RELEASE_PROCESS.md](RELEASE_PROCESS.md) for cutting a release and
downloading the build from GitHub Actions.

The app is self-contained. Before bundling, `bin/stage-sidecar.js`
assembles `build-sidecar/` -- a pinned Node 24 runtime, the Babel
output of `src/engine/`, and the engine's dependency closure -- and
the bundler copies that into `Contents/Resources`, which is where the
Rust host looks for the sidecar in a release build. The first run
downloads the Node tarball (~50MB) and caches it in
`~/.cache/webtorrent-desktop/node/`, so later builds do not re-fetch
it.

Two limits worth knowing. The build is **arm64 macOS only**: the
staged Node runtime and the `utp-native` prebuild are both
`darwin-arm64`, and the staging script refuses to run on any other
host rather than producing a bundle that cannot spawn its engine. And
the output is **ad-hoc signed** (`bundle.macOS.signingIdentity` is
`"-"` in `src-tauri/tauri.conf.json`): signed without a certificate,
so it costs nothing, but it is not notarized and does not pass
Gatekeeper. On another Mac it opens only after the one-time approval
in [First launch](RELEASE_PROCESS.md#first-launch). A Developer ID
signature, the hardened runtime and notarization are US-083 in
`specs/prd.json`.
Windows and Linux are not targets at all -- see
[ADR-017](docs/adr/ADR-017-target-macos-only.md).

For a development binary rather than a bundle, `npm start` is the
usual path; `cd src-tauri && cargo build` also works and produces a
debug build, which resolves the engine from `node` on your `PATH` and
the repository's own `build/` instead of from the bundle.

#### Recommended readings to start working in the app

Tauri (Framework to make native apps with a Rust host and a system
webview): https://v2.tauri.app/start/

React.js (Framework to work with Frontend UI):
https://reactjs.org/docs/getting-started.html

Material UI (React components that implement Google's Material Design.):
https://material-ui.com/getting-started/installation

### Privacy

WebTorrent Desktop collects some basic usage stats to help us make the
app better. For example, we track how well the play button works. How
often does it succeed? Time out? Show a missing codec error?

The app never sends any personally identifying information, nor does it
track which torrents you add.

```
```
