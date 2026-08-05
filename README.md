<h1 align="center">
  <br>
  <a href="https://webtorrent.io">
    <img src="https://webtorrent.io/img/WebTorrent.png"
         alt="WebTorrent" width="200">
  </a>
  <br>
  WebTorrent Desktop
  <br>
  <br>
</h1>

<h4 align="center">The streaming torrent app. For Mac, Windows, and Linux.</h4>

<p align="center">
  <a href=
    "https://discord.gg/cnXkm4Z">
    <img src="https://img.shields.io/discord/612575111718895616"
         alt="discord">
  </a>
  <a href=
    "https://github.com/webtorrent/webtorrent-desktop/actions/workflows/ci.yml">
    <img src=
      "https://github.com/webtorrent/webtorrent-desktop/actions/workflows/ci.yml/badge.svg"
      alt="GitHub CI action">
  </a>
  <a href=
    "https://github.com/webtorrent/webtorrent-desktop/releases">
    <img src=
      "https://img.shields.io/github/release/webtorrent/webtorrent-desktop.svg"
         alt="github release version">
  </a>
  <a href=
    "https://github.com/webtorrent/webtorrent-desktop/releases">
    <img src=
      "https://img.shields.io/github/downloads/webtorrent/webtorrent-desktop/total.svg"
         alt="github release downloads">
  </a>
  <a href="https://standardjs.com">
    <img src=
      "https://img.shields.io/badge/code_style-standard-brightgreen.svg"
         alt="Standard - JavaScript Style Guide">
  </a>
</p>

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

Packaging is not wired up yet. `npm run package` drove
`electron-packager` and was deleted along with the Electron host;
Tauri's own bundler replaces it, and the signed macOS, Windows and
Linux builds are the next stories in `specs/prd.json` (US-083 and
US-084). Until then the way to get a binary is
`npm run build:tauri && (cd src-tauri && cargo build)`.

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

## License

MIT. Copyright (c) [WebTorrent, LLC](https://webtorrent.io).
