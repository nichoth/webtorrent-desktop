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
