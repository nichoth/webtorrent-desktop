I pulled the repo and measured it, because the shape of this codebase changes the plan.

**What you're actually dealing with**

2,484 LOC in `src/main/`, 6,765 in `src/renderer/`. Twenty-two renderer files touch Electron or Node — sounds bad, but the coupling is *broad and thin*: across all of them it's only ~16 import sites, and almost entirely `ipcRenderer` (6 files), `@electron/remote` (4), `shell` (2), `clipboard` (2), `fs.copyFileSync` (3). There's no deep Node entanglement in the UI. That's the good news.

The IPC surface splits cleanly in two, which is your whole migration map:

- **21 `wt-*` channels** (`wt-start-torrenting`, `wt-progress`, `wt-server-running`, …) — the hidden engine window
- **~35 OS channels** (`setBadge`, `setProgress`, `showItemInFolder`, `openExternalPlayer`, `setDefaultFileHandler`, …) — main-process integration

Those two halves have completely different difficulty profiles. The second is mechanical. The first is the project.

And here's the hidden window's config:

```js
webPreferences: {
  nodeIntegration: true,
  contextIsolation: false,
  enableBlinkFeatures: 'AudioVideoTracks',
  enableRemoteModule: true,
  backgroundThrottling: false
}
```

That is the maximally-privileged Electron context, and every single flag is something Tauri has no equivalent for. `enableBlinkFeatures: 'AudioVideoTracks'` is a Chromium-only flag that `audio-tracks-controller.js` depends on — multi-audio-track switching in the player will not survive on WKWebView.

**Phase 1 — Vite build of the renderer** *(start here, today)*

Nothing else can be validated until this works. Create a Vite config with `src/renderer/main.js` as entry, and let it fail. Each failure is one line in your inventory.

```bash
npm i -D vite
npx vite build src/renderer 2>&1 | grep -i "not resolve\|external"
```

**Phase 2 — Collapse the 16 import sites into one shim**

Write `src/renderer/lib/platform.js` exporting `ipc`, `shell`, `clipboard`, `fs` as your own named functions. Point every one of those 22 files at it. Implement it against Electron first so the app still runs — this refactor should be a no-op you can ship on master. Then swapping its internals to `invoke`/`listen` migrates the whole UI in one file.

This is the highest-leverage step in the entire project and it requires zero Rust.

**Phase 3 — Engine: Node sidecar**

Take `src/renderer/webtorrent.js` (434 lines) nearly verbatim, run it under a bundled Node binary as a Tauri sidecar, and replace its `ipcRenderer` calls with a WebSocket. The `wt-*` channel names become your wire protocol unchanged. Do this before librqbit even if librqbit is the destination — it gets you a working app to test against, and it isolates the engine rewrite as an independent swap later.

**Phase 4 — Port `src/main/` to Rust**, roughly in this order:

`config.js` + `user-data` paths → `windows/main.js` → `menu.js`/`tray.js` → `dialog.js`/`shell.js` → `handlers.js` (magnet + file assoc) → `power-save-blocker.js` → `updater.js`.

Delete rather than port: `squirrel-win32.js`, `thumbar.js`, `user-tasks.js` (Windows-specific, all superseded by Tauri's bundler and plugins), plus `announcement.js`, `crash-reporter.js`, and `lib/telemetry.js` unless you actually want to run WebTorrent's telemetry endpoints.

**Phase 5 — the long tail:** `lib/cast.js` (Chromecast/DLNA/AirPlay, full reimplementation in Rust), `external-player.js`, codec fallbacks, signing and notarization.

Realistically: phases 1–2 are a weekend and derisk everything. Phase 3 gets you a running Tauri app that torrents. Phase 4 is steady mechanical work. Phase 5 is where the schedule actually goes.
