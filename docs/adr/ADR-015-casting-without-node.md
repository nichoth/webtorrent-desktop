# ADR-015: Move casting into the host, one protocol at a time

**Date:** 2026-08-04

## Context

`src/renderer/lib/cast.js` is the last deferred casualty of ADR-008
and the largest single item left in the port. It is 526 lines and it
does four things.

**It drives three protocols through three npm packages.**
`chromecasts` (1.10.2), `dlnacasts` (0.1.0) and `airplayer`
(a GitHub fork, `webtorrent/airplayer#fix-security`) are loaded by
`require()` inside `init()`, which is the renderer's one deliberate
exception to the ESM conversion: loading the three of them blocks the
renderer for ~3.8 seconds (measured), so they are loaded on the first
cast interaction rather than at startup. Each package is wrapped in a
player object with the same nine members -- `device`, `addDevice`,
`getDevices`, `open`, `play`, `pause`, `stop`, `status`, `seek`,
`volume` -- and the three objects are stored on `state.devices` by
protocol name. Discovery is an `update` event per package that appends
to that object; nothing ever removes a device, which the code notes as
a bug it does not fix.

**It owns cast session state.** The module-level functions the UI
calls -- `init`, `toggleMenu`, `selectDevice`, `stop`, `play`,
`pause`, `seek`, `setRate`, `setVolume` -- mutate `state.playing`
(`location`, `castName`, `isPaused`, `currentTime`, `volume`,
`jumpToTime`) and push onto `state.errors` directly, then call
`update()`. A `setInterval` polls the connected device's `status()`
once a second and folds the reply into the same fields.

**It runs an HTTP server in the renderer.** Only for subtitles:
`serveSubtitles` binds an ephemeral port, serves the selected track's
VTT (base64 in `state.playing.subtitles`, offset by 21 bytes) with
permissive CORS, and hands Chromecast the URL. The *media* URL is not
its business: `state.server.networkURL` comes from the engine's
`torrent.createServer()` (`src/engine/index.js:374`), which is a
sidecar concern and unaffected by any of this.

**It has a test double.** Under `config.IS_TEST` the three players are
replaced by no-op stubs so the deleted Spectron suite never touched a
real device.

The UI on the other side of it is small and worth keeping intact.
`player-page.js` decides whether to show each cast button from
`state.devices[type].getDevices().length` and reads
`state.playing.location` against the strings `chromecast`, `airplay`,
`dlna` and their `-pending` variants; `playback-controller.js` calls
six `Cast.*` functions, one of which -- `setRate` -- is used
**synchronously** for its boolean return
(`if (isCasting(state) && !Cast.setRate(rate))`).

None of this survives the cutover. The webview has no `require`, no
Node module registry and no `http`, which is why ADR-008 exempted the
file rather than shimming it.

### Where the code should run

Two places can host it now.

**The engine sidecar.** It is a real Node process (ADR-012), so all
three npm packages would keep working with no protocol code written at
all -- easily the cheapest option this week. It is rejected for two
reasons. The sidecar is scheduled for wholesale replacement by
librqbit, so putting device control there parks it on code that is
being deleted, which is precisely the argument ADR-008 used to defer
this file in the first place. And ADR-006 keeps engine IPC and OS IPC
apart on purpose: casting is an OS concern, and routing it over the
`wt-*` channel would put device control on the one channel the port is
trying to keep narrow enough to reimplement against librqbit.

**The Rust host.** Everything else Phase 4 moved went here, behind the
shim (ADR-005), and casting is the same shape: discovery and sockets
on the host, plain data over the boundary (ADR-007), a UI that only
knows names and ids.

The cost of choosing the host is honest and large: three working
implementations get rewritten, and two of them get rewritten by hand.

## Decision

Casting moves to the Rust host behind `src/renderer/lib/platform/cast.js`.
No protocol is dropped.

### Per protocol

**Chromecast: the `rust_cast` crate (0.21) plus `mdns-sd` (0.20) for
discovery.** CASTv2 is protobuf over TLS with its own connection,
heartbeat and receiver namespaces before any media command is sent;
this is the one of the three where a reimplementation is a project
rather than a file. `rust_cast` covers exactly the media namespace
`chromecasts` uses. Its costs, measured with the `cargo metadata`
procedure in `progress.log` rather than assumed:

- Its **runtime** tree tops out at rustc 1.85 (`hashbrown`,
  `getrandom` 0.4, `indexmap`, `security-framework`), under the 1.86
  the tree already requires through Tauri's `url` -> `idna` -> `icu_*`
  chain. It raises nothing.
- Its **build** tree does: `rust_cast` regenerates its protobufs with
  `protobuf-codegen`, which pulls `which` -> `home`, MSRV 1.88. That
  is a build-machine floor, not a target floor, but US-084 has to
  satisfy it on every platform.
- It pulls `rustls` 0.23.43 with the **`aws-lc-rs`** provider, and
  `aws-lc-sys` is a C build. The tree already compiles `rustls`
  0.23.43 with **`ring`** underneath `ureq` (the updater, US-071).
  Two providers linked into one process leave rustls with no
  unambiguous default, so US-076 must install one explicitly at
  startup and prove *both* TLS users still work, or the update check
  breaks in a way nothing in the cast path would reveal.

If that combination proves too expensive when the Windows and Linux
builds are wired up, the fallback is to speak CASTv2 directly over the
`rustls`/`ring` stack already in the tree. That is a US-076 decision
with a real build to measure, not one to take here.

**DLNA: reimplement.** It is SSDP discovery (a UDP `M-SEARCH` to
239.255.255.250:1900) plus SOAP `POST`s to the AVTransport and
RenderingControl services: `SetAVTransportURI`, `Play`, `Pause`,
`Stop`, `Seek`, `GetPositionInfo`, `SetVolume`. `dlnacasts` is a few
hundred lines and the host already has both halves of what it needs --
`ureq` for the HTTP, `std::net::UdpSocket` for the search. The crates
that exist (`rupnp`, `upnp-client`, `ssdp-client`) are general UPnP
stacks that each bring an async runtime and a dependency review for
seven SOAP bodies.

**AirPlay: reimplement.** Every AirPlay crate on crates.io is a
*receiver* (`shairplay`, `rairplay`, `openairplay1/2`); there is no
sender. What `airplayer` speaks is AirPlay v1 over plain HTTP --
`POST /play`, `/rate`, `/scrub`, `/stop` and `GET /playback-info`,
whose reply is a plist -- discovered over `_airplay._tcp` by the same
`mdns-sd` instance Chromecast uses. `ureq` and `plist` (already in the
lockfile) cover it.

Two AirPlay limits are accepted rather than solved, and US-078 records
them here rather than papering over them: **volume is not supported**
(it is not supported today either -- `cast.js` sets
`state.playing.volume` and returns), and **receivers that demand
pairing** (tvOS 10.2 and later can require device authentication)
report a clear error instead of failing silently. Implementing Apple's
pairing handshake is out of scope for this port.

### The shim surface

`src/renderer/lib/platform/cast.js`, every export `async`, plain JSON
in both directions (ADR-007), the host holding a single session
because the UI already forbids two ("Never cast to two devices at the
same time", `cast.js:toggleMenu`):

| Export | Argument | Resolves to |
|---|---|---|
| `startDiscovery()` | -- | -- |
| `stopDiscovery()` | -- | -- |
| `getDevices()` | -- | `[{ id, protocol, name, capabilities }]` |
| `onDevices(cb)` | callback | unlisten function |
| `onStatus(cb)` | callback | unlisten function |
| `onError(cb)` | callback | unlisten function |
| `connect(deviceId, media)` | `{ url, title, contentType, subtitlesVtt, startTime }` | -- |
| `play()` | -- | -- |
| `pause()` | -- | -- |
| `stop()` | -- | -- |
| `seek(seconds)` | seconds | -- |
| `setVolume(volume)` | 0..1 | -- |
| `setRate(rate)` | multiplier | -- |
| `getStatus()` | -- | `{ deviceId, isPaused, currentTime, volume, ended }` |

`capabilities` is the subset of `play`, `pause`, `seek`, `volume`,
`rate` a device actually answers. `onDevices` delivers the whole list
on every change, so a device that goes away can finally disappear --
the bug `cast.js` documents and does not fix.

`onStatus` replaces the renderer's one-second `setInterval`: the host
polls the device and pushes, so a poll that hangs cannot stall the UI
thread. `onError` exists because a discovery *failure* and a network
with no cast devices are indistinguishable in a device list, and only
one of them should raise anything.

### What keeps `controllers/` and the cast UI unchanged

`main.js` keeps `state.devices` in the shape the UI reads today. On
`onDevices` it rebuilds `state.devices[protocol]` as an object with a
synchronous `getDevices()` over the mirrored array, so
`player-page.js`'s button rule, `state.devices.castMenu`,
`state.playing.location` and the `-pending` strings are untouched.
`onStatus` writes the same `state.playing` fields `cast.js` writes.
The six `Cast.*` calls in `playback-controller.js` keep their
signatures; `setRate` stays synchronous by answering from the mirrored
device's `capabilities` and firing the async call behind it, which is
what its boolean return has always meant.

The mirror is the only thing that reads the cast shim. Nothing in
`controllers/` or `pages/` learns that casting became asynchronous.

### Subtitles

The host serves them. `connect()` carries the selected track's cue
text as a string, and the host publishes it from a one-route HTTP
server over `std::net::TcpListener` on the LAN address, alive for the
session. One route does not justify a server crate and the MSRV review
that comes with it, and the renderer keeps no `http` import -- which
is what closes ADR-008.

### Order, and what a protocol that has not landed shows

Chromecast first (US-076), then DLNA (US-077), then AirPlay (US-078),
which is the order of confidence: a maintained crate, a protocol
written from a spec, and a protocol written from a spec that some
devices will refuse.

Until a protocol lands, its discovery reports **no devices** and
raises nothing. The existing rule in `player-page.js` -- no devices
and not casting means no button -- then hides it with no UI change and
no dead control. A protocol that *is* implemented and whose discovery
fails is the different case: it emits `onError`, which the mirror
pushes onto `state.errors`, and the user gets the same error toast any
other cast failure produces.

US-075 lands this surface with a host that answers an empty device
list and a not-implemented error for every command, so the UI shape is
provable before any protocol exists. `lib/cast.js` stays exactly where
it is until US-079 deletes it and the three npm packages with it.

## Consequences

The renderer stops loading 3.8 seconds of casting libraries, and the
one-second status poll leaves the UI thread. `lazyLoadCast()` in
`main.js` loses its reason to exist.

ADR-008's exemption list empties: with `webtorrent.js` already a
sidecar and `cast.js` gone at US-079, no renderer file is outside the
shim, and the per-file overrides in `eslint-boundary.config.js` and
`test/unit/platform-boundary.js` go with it.

The three npm packages disappear from `package.json`, and with them
the last renderer `require()` and the last renderer `http` import.

The host gains a listening socket on the LAN, which is a firewall
prompt on macOS and Windows. The engine sidecar already binds one, so
this is a second port rather than a first prompt, but a packaged build
(US-084) has to account for it.

`config.IS_TEST` loses its test players, and with the Spectron suite
deleted there is nothing to replace them with directly. Discovery and
protocol code that only runs against real hardware is exactly what
US-086 exists to exercise; unit-testable parts (SSDP and plist
parsing, the status fold, the device mirror) stay in plain functions
so they do not need a device.

Two protocols are now the project's own code. `dlnacasts` and
`airplayer` have absorbed years of device quirks that a fresh
implementation has not, and the first report of "it worked in the
Electron build" for some particular television is a bug in this repo
rather than an upstream issue.
