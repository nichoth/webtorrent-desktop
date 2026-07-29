# ADR-007: No host object crosses the shim boundary

**Date:** 2026-07-28

## Context

A shim that returns Electron and Node objects has not decoupled
anything. If `fs.stat()` resolves to a Node `Stats` instance, callers
depend on `Stats`. If `window` exposes a `BrowserWindow` handle,
callers depend on `BrowserWindow`. The imports move; the coupling does
not.

This matters more than usual here because the eventual host may put a
process boundary in the middle of these calls. Anything crossing the
boundary has to survive structured clone or an equivalent, and a
`BrowserWindow` proxy, a `Stats` instance and a `MenuItem` do not.

The context menu was the sharpest case. `torrent-list-controller.js`
built nine `remote.MenuItem` instances directly, and Electron calls
each `click` handler with `(menuItem, browserWindow, event)`.

Alternatives considered:

- **Return the real objects and convert later.** Defers the work to
  the point where it is most expensive and least testable.
- **Return objects that mimic the host types.** A fake `Stats` with a
  working `isDirectory()` method keeps call sites unchanged, but it
  reintroduces a method call that cannot cross a process boundary and
  it hides the constraint from anyone reading the shim.

## Decision

Only plain data crosses the boundary (FR-12).

- **Menus are data.** `menu.showContextMenu(items)` takes an array of
  plain descriptor objects -- `type`, `label`, `click`, `enabled` --
  and no `MenuItem` instance reaches a caller. Descriptors are
  validated before the menu is built, so a bad one rejects rather than
  producing a half-built menu. The `click` handler is wrapped inside
  the shim and called with **no arguments**, so Electron's
  `(menuItem, browserWindow, event)` never leaks out.
- **`fs.stat()` resolves to `{ size, isDirectory, isFile }`**, plain
  booleans rather than methods. `stat.isDirectory()` became
  `stat.isDirectory` at every call site.
- **`fs.readFile()` resolves to a `Uint8Array`**, not a `Buffer`.
- **There is no exported current-window handle.** `window.isVisible()`
  and `window.isMaximized()` resolve the window internally, per call,
  and return a boolean. `dialog.js` parents its dialogs the same way,
  through its own `getCurrentWindow()` rather than through
  `window.js`.
- **No `createReadStream`.** `subtitles-controller.js` reads whole
  files with `readFile`; subtitle files are small and the old code
  concatenated the stream before parsing anyway.

The surface stays at "no more than today". There is no submenu type,
because the renderer has no submenu. `screen.getAllDisplays()` is
excluded, because its only consumer was the deleted telemetry module.
`fs.js` exports exactly the nine operations the renderer performs,
re-enumerated by grep at implementation time rather than taken from
the design document on faith.

Two return-shape changes were folded in while migrating, since the
callers were being touched anyway: `showOpenDialog` resolves to a
`string[]` (empty on cancel) rather than `undefined`, so the
`Array.isArray()` guards became `length` checks, and `showSaveDialog`
resolves to `string|null`.

## Consequences

The boundary is genuinely serialisable. Every call could be put behind
a process boundary without changing a single caller's code.

The `Uint8Array` decision cost more than the others. Text callers must
decode: `JSON.parse(await fs.readFile(p))` does not work where
`JSON.parse(readFileSync(p))` did, because a `Uint8Array` stringifies
to `"1,2,3"`, so `lib/state.js` needed a `TextDecoder`. And
`parse-torrent` 9 rejects a bare `Uint8Array` with "Invalid torrent
identifier", so `state.js` wraps the same memory in a `Buffer` before
handing it over. Plain data does not mean every consumer accepts it.

The "no more than today" rule means the shim will need extending
rather than merely implementing when the UI grows. Adding a submenu is
a shim change, not just a caller change. That is the intended
trade-off: the surface stays small enough to reimplement.

Menus-as-data made the context menu testable without Electron, which
is what `test/unit/torrent-context-menu.js` exercises.
