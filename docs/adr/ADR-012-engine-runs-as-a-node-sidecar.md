# ADR-012: Run the engine as a Node sidecar the renderer connects to

**Date:** 2026-07-29

## Context

Phase 2 finished with `ipc-engine.js` as a documented seam
(ADR-006) and the full `wt-*` wire contract written down in
`docs/platform-shim.md`. On the other side of that seam is
`src/renderer/webtorrent.js`: 434 lines of WebTorrent client code
running in a second, invisible `BrowserWindow`.

That window exists only to give the engine a Node runtime. It is 150
by 150 pixels, never shown, and created with
`nodeIntegration: true`, `contextIsolation: false`,
`enableRemoteModule: true` and `backgroundThrottling: false`
(`src/main/windows/webtorrent.js:26-33`). It is the single reason the
app still ships a renderer with full Node and remote-module access,
and it is also the one piece of the architecture with no analogue
under Tauri: a Tauri webview has no Node, so there is nothing for a
hidden window to host.

The transport it uses is equally Electron-shaped. There is no direct
renderer-to-renderer channel, so every `wt-*` message travels
renderer -> `ipcMain` -> the other renderer through the `ipcMain.emit`
override at `src/main/ipc.js:220-247`, which routes on nothing but the
channel prefix and the sending window's title, and queues messages
for the hidden window until it reports ready.

Phase 3 has to decide two things before any code moves: what process
the engine runs in, and how the UI reaches it.

Alternatives considered for the process:

- **Keep the hidden window until librqbit lands.** Zero work now.
  But it defers the Node-runtime problem into Phase 4, where it
  collides with the host rewrite, and it means Phase 4 cannot delete
  `nodeIntegration` from the app at all. The two hardest changes then
  land in the same commit.
- **Rewrite the engine in Rust against librqbit now.** The eventual
  destination, but it makes the engine rewrite and the host rewrite
  one indivisible task with nothing runnable in between. `docs/init.md`
  argues for the sidecar first precisely because it yields a working
  app to test the librqbit swap against later.

Alternatives considered for the transport:

- **Relay `wt-*` through the host process**, main process in the
  middle, as it is today: renderer -> host -> sidecar. The renderer
  keeps using the shim's existing IPC path and nothing about
  `ipc-engine.js` changes in Phase 3.
- **stdio to the sidecar, with the host relaying.** Same relay
  objection, plus stdout is already the port and log channel.

## Decision

`src/renderer/webtorrent.js` becomes a standalone Node process --
a sidecar, started by the host as a child process -- not a hidden
Electron window. It moves to `src/engine/index.js` and imports no
Electron module. The hidden window, the `ipcMain.emit` relay, the
`messageQueueMainToWebTorrent` queue and the `ipcReadyWebTorrent`
handshake are all deleted once the cutover is done.

**The renderer connects to the sidecar directly, over a localhost
WebSocket.** The sidecar binds a WebSocket server to `127.0.0.1` on
port 0 and prints the assigned port on stdout as one parseable line.
The host's only jobs are to spawn the process, supervise it, and
report where it is: `ipc-os.getEngineEndpoint()` returns
`{ url, token }` as plain data (ADR-007), and no `wt-*` message
passes through the host at all. `ipc-engine.js` becomes a WebSocket
client and stops using `ipcRenderer`.

**The relay is rejected.** It works, and it is less renderer churn in
Phase 3, but the host is the thing being replaced next. Every
`wt-*` channel routed through the main process in Phase 3 is a channel
that has to be reimplemented in Rust in Phase 4, for no purpose beyond
forwarding bytes between two processes that can already address each
other. Choosing the WebSocket now means the Rust host inherits one
responsibility -- spawn a child, read a port -- instead of the whole
protocol. The transport was always transport rather than protocol
(ADR-006), so this is the moment to pick the one that survives.

**The protocol does not change.** The `wt-*` channel names, argument
lists, payload shapes and delivery semantics are exactly the contract
in `docs/platform-shim.md`: the same ten commands, the same twelve
events, the same two dynamic channel families, `torrentKey` still an
opaque number, `Progress.bitfield` still readable through
`BitField.prototype.get`, and the same silence on failure for
`wt-save-torrent-file`, `wt-generate-torrent-poster` and
`wt-get-audio-metadata`. A `{ channel, args }` JSON envelope
(`src/shared/wire.js`) carries them. Only the pipe is new.

The pre-ready queue survives as a pre-connect queue. `main.js` sends
`wt-set-global-trackers` and `wt-start-torrenting` during startup,
before any socket can be open, and expects delivery rather than a
drop; that queue moves from the main process into the WebSocket
client, and it is protocol, not an implementation detail.

### Access control

A localhost WebSocket server is reachable by every process on the
machine, and this one can start torrents, write files under
`config.TORRENT_PATH` and `config.POSTER_PATH`, and stream their
contents. Two checks, both required:

- **Bind to `127.0.0.1`, never `0.0.0.0`.** Nothing off-box can
  reach it, and no firewall prompt appears.
- **A per-launch token, plus an origin check, on every upgrade
  request.** The host generates a random token when it spawns the
  sidecar, passes it to the child, and hands the same value to the
  renderer through `getEngineEndpoint()`. The sidecar rejects any
  upgrade whose token does not match, and rejects any upgrade
  carrying an `Origin` header that is not the app's own -- a browser
  on the same machine cannot suppress that header, so the pair
  together shut out both other local processes and any web page the
  user happens to have open. The token lives only in the host's
  memory and the sidecar's, never on disk, and is regenerated every
  launch.

## Consequences

The engine gets a real Node runtime and the app loses its last
`nodeIntegration` renderer. After the cutover, `src/main/` contains
no window created with Node or remote access, which is a prerequisite
for Phase 4 rather than a nicety: there is no Tauri equivalent to
port.

The engine also stops being a renderer, which costs it the DOM. That
is fine for everything except poster generation:
`lib/torrent-poster.js` calls `document.createElement('video')` and
`capture-frame`, neither of which exists in Node. That casualty is
real and is decided separately in ADR-013 rather than hidden inside
this one.

The host gains process supervision it did not have. A crashed sidecar
must be detected, restarted with capped backoff, and logged; a quit
must not leave an orphan. Those are new failure modes, and the UI now
has a connection that can drop, so `ipc-engine.js` has to reconnect
and re-register its listeners rather than assume a channel that is
always there. Under `ipcMain` a dead engine looked like silence; now
it looks like a closed socket, which is at least detectable.

Two processes talking over a socket are easier to test than two
renderers talking through a private Electron override. The sidecar can
be started with `node build/engine/index.js` and driven from a test
client, and the codec can be round-tripped in isolation, neither of
which was possible while the transport was `ipcMain`.

The cost is a serialization boundary where there was structured clone.
`Uint8Array` and `Buffer` values nested in payloads now need explicit
encoding, and a malformed frame is a new class of bug. `wire.js`
throws on malformed input rather than returning a partial object, and
its round-trip test covers one sample payload per channel, so the
contract is checked rather than assumed.

Packaging gains a requirement: the sidecar needs a Node runtime in
the shipped app, and the engine entry point has to resolve
`config.TORRENT_PATH` and `config.POSTER_PATH` when it is started
outside Electron. Both are Phase 3 stories, not surprises.

ADR-006's split is what makes this a contained change. Because
`ipc-engine.js` shares no exports with `ipc-os.js`, replacing the
engine transport touches one file's implementation and no call site in
`controllers/` or `main.js`.
