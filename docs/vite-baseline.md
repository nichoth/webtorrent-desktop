# Vite baseline failure inventory

Captured for US-001 of the renderer-decoupling PRD
(`tasks/prd-renderer-decoupling.md`). This is the measured starting
point for Phase 1: every module Vite cannot handle today, grouped by
cause, so the remaining Phase 1 stories are driven by facts rather than
guesses.

- Vite version: `8.1.5` (Rolldown-based)
- Config: `vite.config.js` at the repo root, entry
  `src/renderer/main.js`
- Command: `npx vite build`
- Result: **fails** (exit 1). A failing build with a captured
  inventory is the expected outcome of this story.

## 1. Baseline run (verbatim)

Complete stdout and stderr of `npx vite build`, ANSI colour escapes
stripped and nothing else altered:

```
--- stdout ---
vite v8.1.5 building client environment for production...
transforming...✓ 2 modules transformed.
--- stderr ---
✗ Build failed in 82ms
error during build:
Build failed with 1 error:

[PARSE_ERROR] Unexpected JSX expression
     ╭─[ src/renderer/main.js:135:5 ]
     │
 135 │     <App state={state} ref={elem => { app = elem }} />,
     │     ┬
     │     ╰──
     │
     │ Help: JSX syntax is disabled and should be enabled via the parser options
─────╯

    at aggregateBindingErrorsIntoJsError (file:///Users/nick/code/webtorrent-desktop/node_modules/rolldown/dist/shared/error-BHRSI0R7.mjs:48:18)
    at unwrapBindingResult (file:///Users/nick/code/webtorrent-desktop/node_modules/rolldown/dist/shared/error-BHRSI0R7.mjs:18:128)
    at #build (file:///Users/nick/code/webtorrent-desktop/node_modules/rolldown/dist/shared/rolldown-build-CtPvmZgJ.mjs:3276:34)
    at async buildEnvironment (file:///Users/nick/code/webtorrent-desktop/node_modules/vite/dist/node/chunks/node.js:33061:66)
    at async Object.build (file:///Users/nick/code/webtorrent-desktop/node_modules/vite/dist/node/chunks/node.js:33483:19)
    at async Object.buildApp (file:///Users/nick/code/webtorrent-desktop/node_modules/vite/dist/node/chunks/node.js:33480:153)
    at async CAC.<anonymous> (file:///Users/nick/code/webtorrent-desktop/node_modules/vite/dist/node/cli.js:776:3) {
  errors: [Getter/Setter]
}
```

### Why a second, JSX-enabled run was needed

The baseline aborts on the *first* JSX token after transforming only 2
of the ~724 modules in the graph. On its own it measures exactly one
thing and says nothing about the Node builtin or Electron categories.

So a throwaway probe config was run as well: the same config plus a
`transform` hook that pipes `src/renderer/**/*.js` through
`@babel/plugin-transform-react-jsx` (the same plugin and
`useBuiltIns: true` option already configured in the `babel` key of
`package.json`). That probe config was deleted after the run; it is not
part of the repo. Everything in sections 2-5 below marked "probe" comes
from that run, which reached **724 modules transformed** and therefore
exercised the whole renderer graph.

Probe result: `✓ built in 503ms`, **exit 0**, with 167 lines of
warnings. That exit code is the single most important finding here --
see section 5.

## 2. JSX

The only hard error in the baseline run.

| File | Line | Error |
| --- | --- | --- |
| `src/renderer/main.js` | 135 | `[PARSE_ERROR] Unexpected JSX expression` |

Vite does not apply a JSX transform to `.js` files; it only treats
`.jsx`/`.tsx` as JSX by default. Every renderer component in this repo
uses the `.js` extension with JSX inside, so this error is the first of
many identical ones -- the build just stops at the first.

Addressed by **US-004** (configure the JSX transform for `.js` files).

## 3. CommonJS

**No CommonJS failures were reported, in either run.**

This is a genuine measurement, not an omission. Vite 8 bundles with
Rolldown, which handles `require()`/`module.exports` in the module
graph natively -- there is no `@rollup/plugin-commonjs` step to fail
and no "could not resolve" diagnostic. `grep -ci 'could not resolve'`
over the probe output returns `0`.

CommonJS is therefore **not** a build-blocking category. The ESM
conversion in US-005 through US-013 is still required, but for the
reasons the PRD gives (tree-shaking, the `Module.prototype.require`
hook in US-003, and a clean shim boundary in Phase 2) -- not because
Vite rejects CJS. Future stories should not expect this section to
grow.

One related hazard is worth recording next to the inventory, because it
is what makes the conversion order load-bearing: Babel compiles
`export default X` to `exports.default = X`, so a still-CommonJS
consumer doing `require('./x')` gets the module namespace rather than
the default export. That is why conversion runs top-down, entry point
first. See the `esmOrder` convention in `specs/prd.json`.

## 4. Node builtins

Not hard errors. Rolldown resolves each builtin to a browser stub that
throws on use, and emits:

> `Module "<x>" has been externalized for browser compatibility,
> imported by "<importer>"`

So these fail silently at build time and blow up at runtime instead.
Twenty distinct builtins are externalized across the graph:

`assert`, `constants`, `crypto`, `dgram`, `events`, `fs`,
`fs/promises`, `http`, `https`, `module`, `net`, `os`, `path`,
`querystring`, `stream`, `timers`, `tls`, `url`, `util`,
`worker_threads`

### 4a. First-party importers (`src/`)

These are the ones Phase 1 and Phase 2 have to deal with directly:

| Builtin | Importer |
| --- | --- |
| `crypto` | `src/renderer/lib/telemetry.js` |
| `events` | `src/renderer/lib/state.js` |
| `fs` | `src/config.js` |
| `fs` | `src/renderer/main.js` |
| `fs` | `src/renderer/controllers/subtitles-controller.js` |
| `fs` | `src/renderer/controllers/torrent-list-controller.js` |
| `fs` | `src/renderer/lib/migrations.js` |
| `fs` | `src/renderer/lib/state.js` |
| `http` | `src/renderer/lib/cast.js` |
| `module` | `src/renderer/main.js` |
| `os` | `src/renderer/lib/telemetry.js` |
| `path` | `src/config.js` |
| `path` | `src/renderer/components/path-selector.js` |
| `path` | `src/renderer/controllers/playback-controller.js` |
| `path` | `src/renderer/controllers/subtitles-controller.js` |
| `path` | `src/renderer/controllers/torrent-controller.js` |
| `path` | `src/renderer/controllers/torrent-list-controller.js` |
| `path` | `src/renderer/lib/migrations.js` |
| `path` | `src/renderer/lib/sound.js` |
| `path` | `src/renderer/lib/state.js` |
| `path` | `src/renderer/lib/torrent-player.js` |
| `path` | `src/renderer/lib/torrent-summary.js` |
| `path` | `src/renderer/pages/create-torrent-page.js` |

Notes on individual entries:

- `module` in `src/renderer/main.js` is the
  `Module.prototype.require` monkey patch -- deleted by **US-003**.
- `crypto` and `os` in `lib/telemetry.js` disappear entirely with
  **US-002**, which deletes that module.
- `http` in `lib/cast.js` is a deferred casualty per the PRD; it stays
  exempt from the shim.
- `fs` is marked external and kept as such by **US-014**.
- `path` is by far the widest dependency (12 first-party files). It is
  the strongest candidate for a bundled browser-safe implementation
  rather than an external.

### 4b. Transitive importers (`node_modules/`)

Dependency-side externalizations, by builtin and count of distinct
importing files:

| Builtin | Files |
| --- | --- |
| `util` | 36 |
| `events` | 21 |
| `path` | 16 |
| `fs` | 10 |
| `os` | 8 |
| `url` | 7 |
| `stream` | 7 |
| `http` | 6 |
| `tls` | 3 |
| `querystring` | 3 |
| `https` | 3 |
| `dgram` | 2 |
| `assert` | 2 |
| `worker_threads` | 1 |
| `timers` | 1 |
| `net` | 1 |
| `fs/promises` | 1 |
| `constants` | 1 |

The heaviest offenders are the casting stack (`castv2`, `castv2-client`,
`chromecasts`, `dlnacasts`, `bonjour`, `multicast-dns`,
`upnp-device-client`, `airplay-protocol`) and the config-persistence
stack (`application-config`, `write-file-atomic`, `graceful-fs`,
`rimraf`, `path-scurry`). Both are reached from the renderer only via
`lib/cast.js` and `lib/state.js` respectively, which is consistent with
the Phase 2 plan of putting them behind the shim.

Addressed by **US-014** (resolve Node builtins and Electron externals).

## 5. Electron

**No error and no warning was emitted for `electron`, and that is the
worst result in this inventory.**

Fifteen first-party renderer files do `require('electron')`:

```
src/config.js
src/renderer/main.js
src/renderer/components/open-torrent-address-modal.js
src/renderer/components/path-selector.js
src/renderer/components/unsupported-media-modal.js
src/renderer/components/update-available-modal.js
src/renderer/controllers/folder-watcher-controller.js
src/renderer/controllers/media-controller.js
src/renderer/controllers/playback-controller.js
src/renderer/controllers/prefs-controller.js
src/renderer/controllers/subtitles-controller.js
src/renderer/controllers/torrent-controller.js
src/renderer/controllers/torrent-list-controller.js
src/renderer/lib/migrations.js
src/renderer/lib/telemetry.js
```

(`src/renderer/webtorrent.js` also does, but per FR-4 it never goes
through Vite.)

Vite resolves every one of them to `node_modules/electron/index.js`.
That file is the **npm CLI helper**, not the Electron runtime API -- it
reads `path.txt` and exports a string path to the Electron binary. So
`electron.ipcRenderer` is `undefined`, and the build reports success.
The probe run confirms this: exit 0, a 1.46 MB bundle, no diagnostic
mentioning `electron` anywhere in the 167 warning lines. The only
`electron`-adjacent output is second-order -- `fs` and `path`
externalized *by* `node_modules/electron/index.js`.

This is the category that most needs an explicit guard rather than a
fix-until-the-build-passes loop. A green Vite build is not evidence
that Electron resolution is correct.

Addressed by **US-014** (mark `electron` external so it resolves to the
real runtime API at load time) and, structurally, by the whole of Phase
2, which removes these fifteen imports in favour of the platform shim.

## Summary

| Category | Hard errors | Silent problems | Story |
| --- | --- | --- | --- |
| JSX | 1 (blocks the build) | -- | US-004 |
| CommonJS | 0 | 0 (Rolldown handles CJS natively) | US-005..US-013 |
| Node builtin | 0 | 20 builtins externalized to throwing stubs; 23 first-party import sites | US-014 |
| Electron | 0 | 15 first-party import sites silently resolve to the CLI helper | US-014, Phase 2 |

Only the JSX category actually fails the build. The other three are
build-time-silent and runtime-fatal, which is the main thing this
baseline establishes.

## Resolved by deletion (US-002)

`src/renderer/lib/telemetry.js` was **deleted**, not ported. Every
entry in this inventory attributed to that file is therefore resolved
by removal, and no shim, stub, or externalization has to be designed
for it:

- Section 4a: `crypto` in `lib/telemetry.js` -- gone.
- Section 4a: `os` in `lib/telemetry.js` -- gone. This was the
  renderer's only importer of `os`, so `os` drops out of the
  first-party builtin list entirely.
- Section 5: `src/renderer/lib/telemetry.js` -- gone. The Electron
  first-party import count drops from 15 to 14.
- `@electron/remote`'s `screen` API had exactly one renderer consumer,
  telemetry's `getScreenInfo()`. That API now has no renderer caller
  and needs no shim.

Revised first-party counts after US-002: 21 Node-builtin import sites
(was 23), 14 `electron` import sites (was 15). The tables above are
left as measured on 2026-07-27 so the baseline stays a faithful record
of the starting state; this section is the delta.

## End of the ESM conversion (US-013)

`src/renderer/lib/cast.js` was the last renderer module on
`module.exports`. With it converted, the conversion that US-005 through
US-013 carried out is complete, verified by grep over
`src/renderer/**/*.js` on 2026-07-27:

| Pattern | Matches |
| --- | --- |
| `module.exports` | 0 |
| top-level `require(` (column 0) | `src/renderer/webtorrent.js` only |
| any `require(` | `src/renderer/webtorrent.js`, plus `cast.js:47-49` (below) and comments |

`webtorrent.js` is exempt by FR-4 -- Vite never builds it, so it stays
CommonJS.

### The one deliberate `require()` exception

`lib/cast.js` keeps three lazy `require()` calls inside `init()`:

```js
airplayer = require('airplayer')()
chromecasts = require('chromecasts')()
dlnacasts = require('dlnacasts')()
```

They are not top-level, so they do not affect the grep criterion above,
and they are confined to the module the PRD already designates a
deferred casualty and exempts from the Vite bundle.

Both ESM-native alternatives were implemented and measured against the
Babel build in a real Electron 27 renderer, and both fail:

1. **Static imports.** Loading the casting stack (`chromecasts`,
   `dlnacasts`, `airplayer` and their `castv2`/`bonjour`/`upnp`
   dependency trees) blocks the renderer for **3.85 seconds**
   -- timestamped either side of the `require` at
   `build/renderer/main.js`: `t-before-cast 231ms`,
   `t-after-cast 4080ms`. Startup went from `init: 665ms` to
   `init: 4.5s`. That is the "~300ms improvement in startup time" the
   original comment claimed, except an order of magnitude larger.
2. **Dynamic `import()`.** `await Promise.all([import('airplayer'),
   ...])` inside an `async init()` works in plain Node (resolves in
   119ms, correct `.default` interop) but **never settles at all in the
   Electron renderer** -- no resolve, no reject, no console error, and
   control never returns to the caller, observed over a 60-second
   launch. The renderer loads `build/renderer/main.js` from a classic
   `<script>` in a `file://` document, so `import()` is Chromium's, not
   Node's.

The lazy `require()` keeps startup at `init: 739ms`, within noise of
the 665ms baseline.

This matters beyond `cast.js`: **dynamic `import()` is not a usable
deferral mechanism anywhere in this renderer** as long as it is loaded
as a classic script. Phase 2 should not reach for it.

### Pre-existing bug found while verifying (not fixed here)

`delayedInit()` never runs in the current build. `main.js` does
`electron.remote.getCurrentWindow().isVisible()` (the `sound.play('STARTUP')`
guard), and `electron.remote` was removed in Electron 14 in favour of
`@electron/remote`, so it throws `TypeError: Cannot read properties of
undefined (reading 'getCurrentWindow')` and aborts the rest of
`onState` -- including the `window.setTimeout(delayedInit, ...)` two
lines below it. Consequences: `checkDownloadPath()`, the
`webkitvisibilitychange` listener and `lazyLoadCast()` are all dead
code at startup today, so **cast device discovery never starts on its
own**, and `console.timeEnd('init')` never fires in the main window
(the `init:` line seen in the renderer console comes from
`webtorrent.js`, the hidden window).

This predates the ESM conversion and is out of scope for US-013. It was
worked around for verification by patching the built artifact only. The
casting code itself is fine: with that one line bypassed, `Cast.init()`
completes in the real renderer and installs all three device players.

## Node builtin and Electron resolution (US-014)

Every builtin the renderer graph reaches now has an explicit strategy,
and the externalization-to-browser-stub warning count is **0** (it was
113). Section 4's "20 builtins externalized to throwing stubs" is
resolved; the tables above are left as measured on 2026-07-27.

Two mechanisms, both in `vite.config.js`:

1. **Bundled** -- `path`, aliased to `path-browserify` 1.0.1 (a new
   devDependency). Superseded by ADR-011: the alias now points at
   `src/renderer/lib/path.js` and the package is gone.
2. **Externalized** -- everything else, plus `electron` and
   `@electron/remote`, listed in `rollupOptions.external` in both the
   bare and `node:`-prefixed spellings.

Externals only work because `build.rollupOptions.output.format` is now
`'cjs'`. The bundle is loaded by an Electron renderer with
`nodeIntegration: true`, so the emitted `require()` calls resolve
against the real Node/Electron module registry at load time. Verified
in the output bundle: no `import`/`export` statements, 19 distinct
`require("...")` specifiers, and no `require("path")`.

### `path` -- bundled, not externalized

13 first-party renderer files import it:

```
src/config.js                                      src/renderer/lib/sound.js
src/renderer/components/path-selector.js           src/renderer/lib/state.js
src/renderer/controllers/playback-controller.js    src/renderer/lib/torrent-player.js
src/renderer/controllers/subtitles-controller.js   src/renderer/lib/torrent-poster.js
src/renderer/controllers/torrent-controller.js     src/renderer/lib/torrent-summary.js
src/renderer/controllers/torrent-list-controller.js
src/renderer/lib/migrations.js
src/renderer/pages/create-torrent-page.js
```

(`src/renderer/webtorrent.js` also imports it and `src/main/` has five
more importers, but neither goes through Vite.)

Bundling per FR-7 means none of those 13 call sites changes and none of
them needs a Phase 2 shim -- every use is pure string manipulation
(`join`, `basename`, `extname`, `parse`), which the bundled
implementation performs identically. Confirmed present in the output by
grepping the minified bundle for `Path must be a string`, the type-check
message the implementation raises.

The implementation was `path-browserify` 1.0.1 as measured here, and is
`src/renderer/lib/path.js` since ADR-011. The alias is not limited to
first-party code: eleven bundled dependencies import `path` too
(`application-config`, `application-config-path`, `write-file-atomic`,
`write-json-file`, `load-json-file`, `make-dir`, `rimraf`,
`path-scurry`, `mime`, `parse-torrent`, `create-torrent`), and they use
a wider surface than the UI does -- `resolve`, `normalize`, `format`,
and in `path-scurry`'s case `import { posix, win32 } from 'path'`.

### `fs` -- external, Phase 2 shim work

Six first-party renderer importers:

| File |
| --- |
| `src/config.js` |
| `src/renderer/main.js` |
| `src/renderer/controllers/subtitles-controller.js` |
| `src/renderer/controllers/torrent-list-controller.js` |
| `src/renderer/lib/migrations.js` |
| `src/renderer/lib/state.js` |

These are **Phase 2 shim work** -- US-023 (`implement fs.js`) and
US-028 (`migrate the fs call sites`). Externalizing is the holding
position that keeps them working until then; it is not the destination.

### `http` -- external, deferred casualty

One importer: `src/renderer/lib/cast.js:4`. The PRD designates
`lib/cast.js` a deferred casualty and exempts it from the shim, so this
external is permanent for as long as that exemption holds. No Phase 2
story owns it.

### `events` -- external

One importer: `src/renderer/lib/state.js`, for `EventEmitter`. Not
named in the US-014 acceptance criteria, but it is a first-party
builtin import and a stub here would throw on the first state event, so
it gets the same treatment as `fs`.

### `crypto` -- no external entry needed

Grep over `src/` for `require('crypto')`/`from 'crypto'` returns
exactly one hit:

```
src/renderer/webtorrent.js:5:const crypto = require('crypto')
```

`webtorrent.js` is exempt from the Vite build by FR-4 -- it is the
hidden window and stays CommonJS -- so `crypto` never enters this
module graph. Confirmed by its absence from the build's externalization
warnings even before US-014's changes. **No external entry, no alias,
no shim.**

### `os` -- no renderer usage remains

Grep over `src/` for `require('os')`/`from 'os'` returns **zero** hits.
The renderer's only importer was `src/renderer/lib/telemetry.js`, and
US-002 deleted that file. `os` still appears in the external list, but
purely for dependencies -- `application-config-path`, `multicast-dns`,
`rimraf`, `upnp-device-client` -- and **not for any renderer file**, so
it needs nothing from the Phase 2 shim.

### `electron` and `@electron/remote` -- external

This is the fix for section 5, the worst finding in the baseline. Both
are now in `rollupOptions.external`, so `require("electron")` survives
into the output instead of being resolved to
`node_modules/electron/index.js` (the npm CLI helper that exports a
path string).

Verified empirically rather than by build exit code, since the whole
point of section 5 is that a green build proves nothing here. A
temporary `web-contents-created` hook in `build/main/index.js` ran
`require('electron')` inside both live renderers:

```
US014-PROBE: main.html       {"typeofExport":"object","hasIpcRenderer":"object","hasRemote":"object","fsExists":"function"}
US014-PROBE: webtorrent.html {"typeofExport":"object","hasIpcRenderer":"object","hasRemote":"object","fsExists":"function"}
```

`ipcRenderer` is a real object, `@electron/remote`'s `app` resolves,
and the externalized `fs` gives a real `existsSync`. The probe patched
build artifacts only and was removed by the following `npm run build`.

### Dependency-only externals

Reached through `node_modules`, with no first-party importer, and
therefore outside the shim's scope. Kept in a separate list in
`vite.config.js` so the first-party inventory above stays an accurate
statement of what Phase 2 must cover:

`assert`, `constants`, `dgram`, `fs/promises`, `https`, `net`, `os`,
`querystring`, `stream`, `timers`, `tls`, `url`, `util`,
`worker_threads`

They come from two subtrees: the config-persistence stack under
`lib/state.js` (`application-config`, `write-file-atomic`,
`graceful-fs`, `rimraf`) and the casting stack under `lib/cast.js`. The
list is enumerated from measured warnings rather than taken from
`module.builtinModules`, so a dependency reaching for a *new* builtin
still surfaces as a warning instead of being silently absorbed.

### Remaining build warnings

Two, both pre-existing and neither a resolution failure:

- `[EVAL]` direct `eval` in `node_modules/@protobufjs/inquire` (a
  `castv2` dependency).
- Chunk size over 500 kB -- the bundle is 1.45 MB / 431 kB gzipped.
