# `src/renderer/lib/platform/`

The platform shim: the sole source of Electron and Node access for
`src/renderer/` (FR-8). `docs/platform-shim.md` is the contract --
read it before changing anything here, and update it in the same
commit when the surface changes.

## Rules every module follows

- **Every export is `async`** (FR-10), including wrappers around
  Electron APIs that are synchronous today. A future host has to cross
  a process boundary; callers must not need a second refactor.
- **No channel string reaches a caller.** One named function per
  channel. The dynamic engine channels take the info hash as an
  argument.
- **Listener registration resolves to an unsubscribe function** and
  takes an optional `{ once: true }`. Nothing outside this directory
  calls `removeListener`.
- **`ipc-os.js` and `ipc-engine.js` share no exports** (FR-9).
  `ipc-engine.js` is `wt-*` and only `wt-*`; `ipc-os.js` is everything
  else. Adding a `wt-` channel to `ipc-os.js` breaks the seam the
  engine is swapped at.
- **`shell.js` owns `showItemInFolder`, `openPath` and
  `moveItemToTrash`**, even though they are IPC channels, because they
  are one concern. Do not move them to `ipc-os.js`. Those three stay
  on `ipcRenderer.send` rather than calling `shell` directly:
  `moveItemToTrash` is main-process-only in Electron, and the main
  handlers already exist. Only `openExternal` runs in the renderer.
- **Nothing here returns a Node object.** `fs.stat` resolves to a
  plain `{ size, isDirectory, isFile }`, not a `Stats` instance; menus
  are descriptor objects, not `MenuItem` instances (FR-12). Anything
  crossing the boundary has to be serialisable. `fs.readFile` resolves
  to a plain `Uint8Array` view for the same reason -- never a `Buffer`,
  so text callers have to decode.
- **`fs.js` is backed by `fs/promises`, not `fs`.** Callback and
  `*Sync` variants stay out of this directory; every operation is
  already a promise there. `fs/promises` is externalized as a
  first-party builtin in `vite.config.js` for this module's sake.

## Implementation pattern (set by `ipc-os.js`, US-020)

`ipc-engine.js` (US-021) follows it exactly, including a private
`listen()` helper of its own -- the two modules deliberately do not
share code, so the engine seam can be reimplemented without touching
`ipc-os.js`.

- Import the Electron surface at module top level with a named
  import: `import { ipcRenderer } from 'electron'`. Babel compiles
  that to a lazy `_electron.ipcRenderer` property read at each call
  site, which is what makes the module unit-testable (see
  `test/AGENTS.md`). A destructured `const { ipcRenderer } =
  require('electron')` would bind eagerly and defeat that.
- Each listener export is a one-liner over a private `listen(channel,
  listener, options)` helper that wraps the caller's function to drop
  the Electron event object, honours `{ once: true }`, and returns the
  `removeListener` closure.
- Request/response over `send` + `once` collapses into a single
  promise (`ipc-os.checkForExternalPlayer`). Register the reply
  listener *before* sending.
- `@electron/remote` is imported by name too --
  `import { dialog, getCurrentWindow } from '@electron/remote'`
  (`dialog.js`, `window.js`, US-024). Its renderer entry sets
  `__esModule` and defines every builtin (`dialog`, `clipboard`, ...)
  as a lazy getter on `exports` with **no `default`**, so named
  imports match its real shape and give the same per-call property
  read Babel needs for the unit-test stub. The `import remote from
  '@electron/remote'` form used by the not-yet-migrated call sites
  survives only because Rolldown's CJS-external interop supplies a
  default; do not copy it into this directory.

## Gotchas

- `index.js` uses `import * as x` plus `export { x }`, not
  `export * as x from`. Keep it that way: three toolchains
  (`standard`, Babel, Rolldown) have to agree on the syntax.
- This directory is compiled by **both** Babel (`build/`, because
  `src/main/index.js` requires `../renderer/lib/state`) and Vite
  (`build-vite/`). Both must keep building.
- The lint rule from US-034 exempts this directory. It is the only
  place a direct `electron`, `@electron/remote`, `fs`, `os`, `crypto`
  or `http` import is allowed, alongside the two deferred casualties
  `webtorrent.js` and `lib/cast.js`.
