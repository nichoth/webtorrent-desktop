# ADR-008: Name two deferred casualties and exempt them from the shim

**Date:** 2026-07-27

## Context

Two renderer files cannot be migrated behind the platform shim in any
useful sense, for opposite reasons.

`src/renderer/webtorrent.js` (434 lines) is the WebTorrent engine
running in the hidden window. It is the shim's *counterparty*, not a
consumer of it: it is the thing on the other end of every `wt-*`
channel. It is also scheduled for wholesale replacement by librqbit,
so any effort spent decoupling it is spent on code that is being
deleted. Its window runs with `nodeIntegration: true`,
`contextIsolation: false` and `enableRemoteModule: true` by design.

`src/renderer/lib/cast.js` runs an `http` server inside the renderer
to serve media to Chromecast, DLNA and AirPlay devices. There is no
shim shape that makes an in-renderer HTTP server portable; it needs a
full reimplementation on the host side, which is Phase 5 work.

The alternative is to migrate them anyway, which for `webtorrent.js`
means shimming the engine against itself and for `cast.js` means
inventing an HTTP-server abstraction with one caller and no second
implementation to validate it against.

A third file, `lib/telemetry.js`, was in this category at the start of
Phase 1. It was deleted outright in US-002 instead, along with its
call sites, because the alternative was porting telemetry endpoints
nobody intends to run.

## Decision

Name exactly two deferred casualties -- `src/renderer/webtorrent.js`
(FR-4) and `src/renderer/lib/cast.js` -- and exempt both from the
shim, from the Vite build in `webtorrent.js`'s case, and from the
boundary enforcement in ADR-009.

`webtorrent.js` is never converted to ESM, never passed through Vite,
and never migrated to the shim. It keeps building through Babel and
loading via `static/webtorrent.html` unchanged.

`cast.js` was converted to ESM with the rest of `lib/` in US-013, so
it is inside the Vite bundle, but it keeps its direct `http` import.

The exemption list is closed. Both files appear as the only two
per-file overrides in `eslint-boundary.config.js`, and
`test/unit/lint-boundary.js` asserts that stays true, so adding a
third is a deliberate act that fails a test first.

## Consequences

Phase 2 could finish. Without these exemptions the shim would have to
grow an HTTP-server abstraction and an engine-inside-the-engine, both
of which are unfalsifiable until Phase 3 or 5 gives them a second
implementation.

The renderer is not fully decoupled, and the record says exactly where
and why. Two files, both with a scheduled replacement, rather than a
vague sense that some things were left.

`webtorrent.js` staying outside the Vite build means the renderer has
two entry points built two different ways, which is one more thing the
build split (ADR-003) has to accommodate.

Because `crypto` is used only by `webtorrent.js` and `http` only by
`cast.js`, both are absent from the Vite first-party externals list
and both are banned outright by the lint rule with these two files
overridden. An audit of renderer imports has to account for the
exemptions to read correctly.

Deleting telemetry rather than exempting it removed the renderer's only
`os` and `screen.getAllDisplays()` consumers, which is why neither
appears anywhere in the shim.
