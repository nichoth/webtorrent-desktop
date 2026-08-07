# Webtorrent Desktop

Rewriting it in Tauri.

## Install

### Recommended Install

Download the latest version of WebTorrent Desktop from
[the official website](https://webtorrent.io/desktop/):

### [✨ Download WebTorrent Desktop ✨](https://webtorrent.io/desktop/)

### Advanced Install

- Download specific installer files from the
  [GitHub releases](https://github.com/webtorrent/webtorrent-desktop/releases)
  page.

- Use [Homebrew-Cask](https://github.com/caskroom/homebrew-cask) to
  install from the command line:

  ```
  $ brew install --cask webtorrent
  ```

- Try the (unstable) development version by cloning the Git repository.
  See the ["How to Contribute"](#how-to-contribute) instructions.

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
$ npm run build:tauri && npx tauri build
```

On an Apple Silicon Mac this produces
`src-tauri/target/release/bundle/macos/WebTorrent.app` and a matching
`.dmg`. `npm run package` drove `electron-packager` and was deleted
along with the Electron host; Tauri's own bundler replaces it.

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
the output is **unsigned and un-notarized**, so macOS will refuse it
on another machine without a Gatekeeper override -- signing, the
hardened runtime and notarization are US-083 in `specs/prd.json`.
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
