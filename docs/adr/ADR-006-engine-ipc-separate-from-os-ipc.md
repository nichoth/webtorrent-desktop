# ADR-006: Split engine IPC from OS IPC into two modules sharing no exports

**Date:** 2026-07-28

## Context

The renderer's IPC surface has two halves that look identical at the
call site -- both are `ipcRenderer.send` and `ipcRenderer.on` -- and
have nothing else in common.

The `wt-*` channels talk to the hidden WebTorrent window: start
torrenting, progress, server running, audio metadata. Roughly 35 other
channels talk to the main process: set badge, set progress, show item
in folder, open external player, set default file handler.

The two halves are on different schedules. The OS channels leave when
the host leaves, in Phase 4. The `wt-*` channels leave when the engine
is replaced by librqbit, in Phase 3, which is earlier and independent.

If both live in one module, the librqbit swap has to reach into a file
that also holds the window and tray integration, and a reviewer cannot
tell by looking whether a given function is engine surface or host
surface.

There is also no direct renderer-to-renderer channel in Electron.
Every `wt-*` message goes renderer -> `ipcMain` -> the other renderer,
relayed by an `ipcMain.emit` override that inspects nothing but the
channel prefix and the sending window's title. That relay is transport,
not protocol, and a replacement engine is free to deliver these
messages any way it likes.

## Decision

Two modules, `ipc-os.js` and `ipc-engine.js`, sharing no exports
(FR-9). `ipc-engine.js` covers the `wt-*` channels and only those;
`ipc-os.js` covers every other renderer/main channel and exports none
of the engine ones.

`ipc-engine.js` is the seam the torrent engine is swapped at. A
librqbit implementation has to satisfy exactly this surface and
nothing more.

Because that makes it a contract, the wire protocol behind it is
documented in full at `docs/platform-shim.md` (US-033): every channel,
its payload shape, and its delivery semantics -- fire-and-forget,
one-shot, or standing subscription. The payload shapes `TorrentInfo`,
`Progress`, `ServerInfo`, `FileModtimes`, `CreateOptions` and
`AudioMetadata` are written out.

Both dynamic channel families are declared even where the UI does not
currently consume them. `wt-ready` and `wt-server-${infoHash}` are each
the unused half of their pair, and both are part of the contract: an
engine emitting only the half consumed today breaks the moment a caller
switches.

Two `wt-*` channels are deliberately outside the shim, because their
only sender is `webtorrent.js` and they have no listener anywhere in
the repo: `wt-new-torrent` and `wt-uncaught-error`. A replacement
engine should treat them as optional rather than contract.

## Consequences

The Phase 3 engine swap is scoped to one file's surface, and the
document says what a replacement has to do. That is the deliverable
this split exists to produce.

Several behaviours of the current engine are now contract whether or
not they were designed. The pre-ready message queue matters:
`main.js` sends `wt-set-global-trackers` and `wt-start-torrenting`
during startup, before the engine can possibly be listening, and
expects delivery rather than a drop. Three commands
(`wt-save-torrent-file`, `wt-generate-torrent-poster`,
`wt-get-audio-metadata`) have a reply channel but no failure reply --
they log and return, so the UI's one-shot listener never fires. A
librqbit implementation has to preserve that silence or the UI needs
new error handling.

One payload field is not plain JSON. `Progress.bitfield` is put on the
wire as a `bitfield` instance, structured clone strips the prototype,
and the single reader already compensates with
`BitField.prototype.get.call(...)`. So a replacement only has to
deliver something that borrowed method can read.

`wt-uncaught-error` currently sends into the void. It is worth reviving
as a real error path rather than reimplementing as-is.

The cost is two modules where one would compile: a reader has to know
which half a channel belongs to before knowing where to look. The
`wt-` prefix makes that mechanical.
