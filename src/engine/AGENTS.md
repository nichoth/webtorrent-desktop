# src/engine/

The torrent engine and its transport (ADR-012). Phase 3 moves the
engine here from `src/renderer/webtorrent.js` and turns it into a Node
sidecar; US-039 landed the transport seam first and US-040 added the
sidecar entry point.

**There is exactly one engine.** US-044 moved the UI onto the sidecar
and US-045 deleted the hidden window, the engine that ran in it and the
`ipcMain` relay between them. Engine behaviour has a single home now:
`src/engine/index.js`.

`build:main` compiles the whole of `src` except the four Vite-owned
paths, so a file added here is emitted to `build/engine/` with no build
change -- that is also the path unit tests require.

## The bus contract

The engine talks to the UI through an injected bus and never names a
transport API itself. A bus is exactly two functions:

- `send(channel, ...args)` -- deliver one message to the UI.
- `on(channel, handler)` -- subscribe; resolves to an unsubscribe
  function. The handler receives the protocol's argument list only,
  never the transport's own event object. Stripping that object is the
  bus's job, not the caller's.

The bus carries no protocol. Channel names, argument lists and payload
shapes live in the command and event tables in
`docs/platform-shim.md`; the codec that turns them into bytes is
`src/shared/wire.js`. A bus implementation that knows a channel name is
a bug.

The engine constructs its bus in exactly one place and
`test/unit/engine-entry.js` asserts that, by scanning the engine source
for transport APIs, for stray `.send(` calls and for subscriptions that
bypass `bus.on`. That scan is what keeps the seam substitutable, so keep
it passing rather than relaxing it.

`bus-electron.js`, the Phase 3 transitional implementation, is gone:
US-044 pointed the UI at `bus-websocket.js` and US-045 deleted the
hidden window it depended on, along with its unit test.

This directory is outside `src/renderer/`, so the renderer's Node bans
do not apply: the sidecar is a Node process and uses `fs`, `crypto`
and friends directly. Since US-046 both boundary mechanisms cover it
for the **opposite** mistake instead. `eslint-boundary.config.js` has
an `src/engine/**` override banning `electron`, `@electron/remote` and
`original-fs` plus every DOM global, and `npm run lint:boundary` lints
this tree as well as the renderer;
`test/unit/platform-boundary.js` scans the same two things in source,
which is what catches the `require()` spellings ESLint cannot see.

## `bus-websocket.js`

The sidecar implementation, and the one that survives Phase 4. It binds
a `ws` server to `127.0.0.1` on port 0, encodes every frame with
`src/shared/wire.js`, and exposes `send`/`on` plus three lifecycle
functions the entry point needs: `listen()` (resolves to the bound
port, idempotent), `address()` and `close()`.

Three behaviours are contract, not incidental:

- **A send with nobody connected is dropped, not queued.** Commands
  always originate from the UI, so a connected client is the normal
  case; the pre-connect queue that ADR-012 requires lives on the *UI*
  side, in `ipc-engine.js`, and has since US-044.
- **A malformed frame and a throwing handler are both reported through
  `onError`, never rethrown and never fatal to the socket.** The engine
  is a long-lived process; one bad message from a buggy UI must not end
  the session. `index.js` wires `onError` to the same
  `wt-uncaught-error` path the process handlers use.
- **The token, when configured, is checked in `verifyClient`**, which
  answers a bad upgrade with HTTP 401 before any frame is read. It is
  read from `WEBTORRENT_ENGINE_TOKEN` by `index.js`. No token means an
  open server, which is only acceptable for running the sidecar by
  hand. The `Origin` check ADR-012 also asks for is still not
  implemented -- US-044 connected the UI without needing it, so it needs
  the real header the Electron and Tauri webviews send and is US-046
  territory.

## `index.js`

The sidecar entry point: `node build/engine/index.js`. It imports no
Electron module and uses no DOM.

**The stdout contract with the host.** Exactly one line matches
`WEBTORRENT_ENGINE_PORT=<port>`, printed once the server is listening.
The host end is `src-tauri/src/engine.rs`, which holds the same prefix
in `PORT_LINE_PREFIX`; keep the prefix and the `=` if you touch either
side. Every other line on stdout and stderr is pumped through to the
host's own output under an `Engine: ` prefix. `src/main/` is gone, so
the Electron reader that older plans name here
(`src/main/engine-process.js`, US-041) went with it.

Differences from the hidden-window engine, all deliberate:

- No `ipcReadyWebTorrent`. Readiness is the port line plus an accepted
  socket.
- No `wt-generate-torrent-poster` and no `wt-poster`. Both needed a DOM;
  US-043 deleted them from the wire and poster generation now runs in the
  UI renderer (`src/renderer/lib/torrent-poster.js`, ADR-013). The engine
  handles no media at all -- do not add a media dependency back to it.
- No `window.client` and no `window.testOfflineMode`.
- Uncaught errors come from `process.on('uncaughtException')` and
  `process.on('unhandledRejection')` rather than a `window` error
  listener, and still go out on `wt-uncaught-error`.
- `SIGTERM` and `SIGINT` destroy the client and close every streaming
  server, so a quit does not leave the download directory held open.
- With `WEBTORRENT_ENGINE_PARENT_PIPE` set, stdin ending shuts the
  process down the same way. That is the orphan backstop for a host
  that dies without running its `before-quit`, and it is gated behind
  the flag because a hand-run `node build/engine/index.js` gets
  `/dev/null` on stdin, which ends immediately.
- `getTorrent()` throws a plain `Error` with the same message
  `TorrentKeyNotFoundError` produced. The class lives in
  `src/renderer/lib/errors.js`, only its message ever crossed the wire,
  and the sidecar does not import renderer code.

The streaming servers are a `Map` keyed by info hash, and each entry
counts its holders (US-043): `wt-start-server` is idempotent per torrent
and always replies, `wt-stop-server` takes the info hash to release, and
the server dies with its last holder. Poster generation and playback can
hold servers for different torrents at once, so a single module-level
`server` is not enough any more.

A hold is counted the moment `wt-start-server` arrives, not on
`ready`: the entry (`{ torrent, holders, server, info }`) exists from
the first request, `server` stays null until the torrent is ready and
`info` until it is listening. Only the first early request parks a
ready handler, and that handler (and the `listen` callback) does
nothing once `servers.get(infoHash)` is no longer its entry. So a
`wt-stop-server` is honoured in any state and the last one always
wins. `forgetServer` is the one way an entry goes: the last release,
`stopAllServers` and the torrent's `close` all call it, and
`destroyServer` also splices the server out of WebTorrent's private
`torrent._servers`, which otherwise only empties on destroy.

`test/unit/engine-entry.js` checks this on the real sidecar by probing
the reported port with `net.connect`. Its `withEngine` helper spawns
and connects; reuse it for new sidecar cases. A `.torrent` path is
parsed asynchronously, so a `wt-start-server` in the same burst as
`wt-start-torrenting` finds no torrent -- wait for `wt-parsed` first.
Missing files verify in milliseconds, so a test that needs to act
before `ready` writes full-length sparse files of zeros into the
download directory to widen the window.

`config.TORRENT_PATH` and `config.POSTER_PATH` resolve under plain
`node` because US-040 made `src/config.js` require `electron` lazily,
inside the main-process branch of `getPath()`. Do not hoist that back
to a top-level import: the packaged sidecar has no
`node_modules/electron` to resolve.

The host runs the sidecar as **Electron in Node mode**
(`ELECTRON_RUN_AS_NODE=1`), not as a separate `node` binary, so that the
packaged app needs no second runtime. In that mode
`process.versions.electron` is set but `process.type` is not and
`require('electron')` has no `app`, which is why `getPath()` in
`src/config.js` branches on `process.type` and treats anything that is
neither `'renderer'` nor `'browser'` as a plain Node process. A check
for "is Electron present" there breaks the sidecar at load, and only
outside `NODE_ENV=test` (portable config skips the branch).

## Per-torrent state and the torrent's `close`

State the engine keys by info hash (`lastAnnounceAt`,
`corruptPeerStats`, the stall tracker, `appliedSelections`) is forgotten in one place:
`torrentClose`, the `close` handler `addTorrentEvents` installs.
WebTorrent emits `close` from `destroy()` whatever the cause --
`wt-stop-torrenting`, removal, a fatal error -- so `stopTorrenting`
only destroys and does not repeat the cleanup. Add new per-torrent
cleanup to that handler, not to `stopTorrenting`.

The handler returns early when `client.get(infoHash)` still finds a
torrent. WebTorrent removes a closing torrent from the client before
emitting `close`, so a hit means a duplicate add is being destroyed
under the live torrent's hash, and that state is not its to forget.

The streaming server entry is forgotten there too (`forgetServer`).

`test/unit/engine-torrent-close-wiring.js` pins this by source scan.

## `announce.js`

`announceNow(torrent, dht)` is the discovery half of "destroy and
re-add": a tracker `update()` plus a DHT `lookup()`, with no re-verify
of pieces on disk and no dropped peer connections. It exists because
the natural cadence is slow -- 30 minutes per tracker, 15 minutes plus
jitter for the DHT -- so a torrent whose last peer drops can sit at
zero peers for half an hour.

The sweep automates it. Once a minute `index.js` calls
`runAnnounceSweep`, which re-announces every torrent that has zero
peers, is not finished and is not paused. Three guards keep it from
being worse than the bug it fixes, and they are the reason the logic
lives here rather than inline in `index.js`, where it could not be
tested: a five minute per-torrent cooldown, comfortably above any
tracker's `min interval`; a cap of five torrents per sweep, served
least-recently-announced first so a long list goes round robin; and one
summary line per sweep that did anything, carrying the deferred count,
because a silent truncation reads as "nothing else needed it".

Be precise about that last one, because the obvious reading is too
narrow. The line is not reserved for capped sweeps: a sweep that
announces one torrent and defers nothing still logs. What is silent is
a sweep with nothing to do -- `runAnnounceSweep` returns early only
when it selected nothing *and* deferred nothing, so an idle engine
says nothing at all.

`index.js` owns only the timer and the `lastAnnounceAt` map. The map
is seeded when a torrent's info hash arrives -- `client.add()` has just
announced `started` and a second announce a minute later would be waste
-- and cleared when the torrent closes (see above).

The three tunables are exported from here, not from `index.js`:
`SWEEP_INTERVAL_MS`, `COOLDOWN_MS` and `MAX_PER_SWEEP`. `index.js`
imports the interval rather than repeating `60 * 1000`, so the cadence
has one home. `selectStalled` is exported next to `runAnnounceSweep`
because the guards are worth testing without announcing anything.

`test/unit/engine-sweep-wiring.js` pins that wiring by scanning the
`index.js` source: both imports, `setInterval(runSweep,
SWEEP_INTERVAL_MS)`, and the seed and the delete on `lastAnnounceAt`.
An interval that fires once a minute is too slow to drive from a
spawned sidecar, and a test-only override of it would be production
code that exists for a test -- so renaming `runSweep` or inlining the
constant fails that scan instead of going unnoticed.

## `audio-metadata.js`

`readAudioMetadata(file, torrentPath, options, parser)` is the only
place the engine hands `music-metadata` a file. An unfinished file is
parsed from `file.createReadStream()`, and that stream holds a piece
buffer and a high-priority selection until it is destroyed -- the
library stops reading once it has what it needs but never destroys the
stream it was given. So the module owns the stream and destroys it once
the parse settles, either way. Finished files go through `parseFile`,
which closes its own file. Do not call `mm.parseStream` from `index.js`
again: `test/unit/engine-audio-metadata-wiring.js` scans for exactly
that. `parser` defaults to `music-metadata` and is a parameter so
`test/unit/engine-audio-metadata.js` can drive a real `Readable`
without audio.

## `selections.js`

`diffSelections(applied, requested)` decides which file selections
reach webtorrent. In webtorrent 1.9.7 each `file.select()` pushes a new
entry onto the torrent's selection list and `file.deselect()` removes
only one, so re-applying the whole list on every checkbox toggle grows
the list and leaves a twice-selected file downloading after a
deselect. `selectFiles` in `index.js` diffs against
`appliedSelections` (info hash -> last applied list) and applies only
the changes. `applied` undefined means the first application, which is
also when webtorrent's default whole-torrent selection is removed.
`test/unit/engine-selections.js` tests the diff with plain values;
`test/unit/engine-torrent-close-wiring.js` scans that `selectFiles`
uses it and that `torrentClose` forgets the applied list.
