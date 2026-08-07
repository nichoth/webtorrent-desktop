# Ship the engine sidecar in the packaged macOS app (US-047)

**Date:** 2026-08-06

**Status:** design, approved -- not yet implemented

## Why this exists

`npm run build:tauri && npx tauri build` already produces a real
`WebTorrent.app` and a `.dmg`. The app launches. It cannot torrent.

`engine::Runtime::resolve` (`src-tauri/src/engine.rs:130`) branches on
`!cfg!(debug_assertions)`, so a release build looks for its Node
runtime and its entry point inside the bundle's resource directory.
`src-tauri/tauri.conf.json` has no `bundle.resources` key at all, so
`WebTorrent.app/Contents/Resources/` contains exactly one file,
`WebTorrent.icns`. Running the built binary shows the result:

```
Engine: failed to spawn: No such file or directory (os error 2)
Engine: restarting in 500ms (attempt 1 of 5)
Engine: failed to spawn: No such file or directory (os error 2)
Engine: restarting in 1000ms (attempt 2 of 5)
...
```

This is US-047 in `specs/prd.json`. That story's acceptance criteria
still describe `bin/package.js`, which was deleted with the Electron
host in US-072, so the criteria are stale even though the gap is real.

## What the exploration established

Four facts shaped the design, and two of them contradict the obvious
first guess.

**Copying the build machine's `node` does not work.** Homebrew's Node
is dynamically linked against roughly eighteen Homebrew dylibs,
including `@rpath/libnode.141.dylib`, `libicui18n.78.dylib` and
`libcrypto.3.dylib` under `/opt/homebrew/opt/`. A bundle carrying that
binary alone runs only on a machine with an identical Homebrew
install.

**The dependency closure is 174 packages, about 8.5 MB**, not the six
direct requires visible in `build/engine/`. Three of those packages
carry native N-API prebuilds: `utp-native`, `bufferutil` and
`utf-8-validate`.

**All three native packages are optional.**
`node_modules/webtorrent/lib/utp.js` is a `try`/`catch` require that
returns `{}` and warns `WebTorrent: uTP not supported`; `ws` falls
back to JS implementations without its two. `utp-native` ships
prebuilds for `darwin-arm64` and `darwin-x64` among others.

**The host already specifies the layout this work has to produce.**
`Runtime::resolve` wants `<resource_dir>/node`,
`<resource_dir>/build/engine/index.js`, and `cwd = <resource_dir>`,
and `the_packaged_sidecar_is_next_to_its_runtime_in_the_resources`
already asserts it. So no Rust changes are needed. The work is
producing a directory that satisfies a contract the host states.

## Decisions

1. **The Node runtime comes from a pinned official tarball.** Not the
   build machine's binary (see above), not a Node SEA fusion, and not
   a dependency on the user having Node installed.
2. **Node 24 LTS.** `v24.19.0`, released 2026-08-03, LTS codename
   Krypton, maintained into 2028. `package.json` declares
   `engines: ^16.0.0 || ^18.0.0`, both long past end-of-life and
   neither satisfied by the Node in use for development.
3. **The dependency closure is copied out of the existing
   `node_modules`.** Not an `npm install` into a staging directory,
   and not an esbuild single-file bundle -- ADR-003 deliberately
   settled this repo on two build tools, and webtorrent's tree uses
   dynamic require patterns that bundlers handle badly.
4. **`utp-native` ships; `bufferutil` and `utf-8-validate` do not.**
   uTP is peer transport and its loss is a real connectivity
   regression against the Electron app. The other two accelerate
   WebSocket masking, which here is a localhost control channel
   carrying small JSON envelopes.
5. **arm64 only.** `aarch64-apple-darwin`, one architecture, no
   universal binary.

## Architecture

`bin/stage-sidecar.js` assembles `build-sidecar/` at the repository
root. That directory becomes `Contents/Resources`:

```
build-sidecar/
  node                     official Node 24 arm64, executable
  package.json             generated; carries `version` only
  build/config.js
  build/engine/
  build/shared/
  node_modules/            resolved closure, minus excluded optionals
```

The generated `package.json` is not optional. `build/config.js:12`
requires `../package.json` and reads `version` from it as
`APP_VERSION` (`build/config.js:77`), which the engine folds into its
Azureus-style peer ID. Staged without it, the sidecar dies on load:

```
Error: Cannot find module '../package.json'
Require stack:
- .../build/config.js
- .../build/engine/index.js
```

Verified by staging the layout by hand and running the engine under
it, first failing exactly as above and then, with a root
`package.json` present, printing `WEBTORRENT_ENGINE_PORT=57269` and
its init timing. It is generated rather than copied so that the
bundle does not carry the repository's dependency and script maps,
which describe a tree the packaged app does not have.

`node_modules` sits at the root because Node resolves `require` by
walking up from the requiring file. From
`Resources/build/engine/index.js` the walk reaches
`Resources/node_modules` on its third hop, so `require('webtorrent')`
resolves with no path configuration anywhere.

Two keys in `src-tauri/tauri.conf.json` wire it up. Both were verified
against `tauri-utils-2.9.3/src/config.rs` -- `before_bundle_command`
at line 3436, `resources` at line 1629, the latter accepting either a
list or a source-to-target map.

1. `build.beforeBundleCommand` runs the staging script, so it fires
   after the Rust build and before bundling.
2. `bundle.resources` maps `../build-sidecar/` into the Resources
   root.

A plain `cargo build` remains a debug build, so `production` is false
and the sidecar still resolves to `node` on `PATH` and the
repository's own `build/`. The development path README documents is
untouched.

## Components

### The runtime fetch

A committed manifest, `bin/node-runtime.json`, pins the version and
its SHA-256:

```json
{
  "version": "24.19.0",
  "darwin-arm64": {
    "sha256":
      "8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d"
  }
}
```

Committing the hash is the security-relevant part. Verifying a
download against a `SHASUMS256.txt` fetched from the same host proves
the file arrived intact, not that it is the file that was intended.
The committed value is the actual pin, and changing the runtime
becomes a reviewable diff.

The script downloads
`https://nodejs.org/dist/v24.19.0/node-v24.19.0-darwin-arm64.tar.gz`,
checks it against the manifest, and extracts only `bin/node`. The
tarball is cached at `~/.cache/webtorrent-desktop/node/`, outside the
repository, so rebuilds do not re-fetch and `bin/clean.js` does not
delete it. Extraction shells out to `tar`, which macOS ships, so no
npm dependency is added and `depcheck` in `npm test` stays quiet.

### The closure walker

The walker resolves the way Node does, using `createRequire` from each
package's own directory, so hoisted and nested `node_modules` layouts
both come out right. Reading `dependencies` out of each `package.json`
and constructing paths by hand would guess at a layout npm owns.

Its roots are the bare specifiers the built engine requires --
`application-config`, `arch`, `music-metadata`, `network-address`,
`webtorrent` and `ws` -- and from each it follows `dependencies` and
`optionalDependencies` transitively. Two deliberate edits on the way
past:

- `bufferutil` and `utf-8-validate` are skipped, by name.
- `utp-native` is copied with `prebuilds/` pruned to `darwin-arm64`.
  The other four platform directories are dead weight in an arm64-only
  bundle.

The walker returns a file list rather than copying as it goes. The
interesting logic is then a pure function, and the filesystem work is
a thin shell around it -- which is what makes it testable with no
network and no bundle.

## Error handling

The script fails loudly and early rather than producing a bundle that
looks correct and cannot torrent, which is precisely the current
failure.

A missing `build/` throws with the instruction to run `npm run build`
first, matching what `bin/build-tauri.js:43-46` already does for
`build-vite/`.

A checksum mismatch throws and deletes the cached download, so a retry
re-fetches rather than re-validating a bad file indefinitely.

An unresolvable dependency throws, naming the package that required
it. The two excluded optionals are skipped by name and by name only,
so a *new* unresolvable optional is an error rather than a silent
omission.

`utp-native` missing its `darwin-arm64` prebuild throws, rather than
shipping a package that will warn its way to TCP-only at runtime where
nobody is reading the log.

The runtime half already exists: the supervisor logs
`Engine: failed to spawn` and backs off five times.

## Testing

`test/AGENTS.md` establishes the conventions. Unit tests are CommonJS,
require the Babel output under `build/` rather than the ESM sources,
and are globbed from `test/unit/*.js` with no registration.

**`test/unit/tauri-host.js`** already holds the launch wiring as
manifest assertions -- that `build` includes `build:node`, that
nodemon ignores the document root, that host and sidecar agree on the
port-line prefix. Two additions belong there:

1. `tauri.conf.json` declares the `beforeBundleCommand` and the
   `bundle.resources` mapping.
2. `build-sidecar` is registered in all four places the
   `bin/build-tauri.js:24-26` comment enumerates for `build-tauri`:
   `.gitignore`, nodemon's `--ignore` list, depcheck's
   `--ignore-dirs`, and `bin/clean.js`. There is already a test for
   exactly this on the other output directory, so this is a mirror of
   an existing pattern rather than a new idea.

**`test/unit/stage-sidecar.js`** is new and covers the walker. Run it
against the real `node_modules` and assert that `webtorrent`, `ws` and
`music-metadata` are present, that `bufferutil` and `utf-8-validate`
are absent, and that `utp-native` is present with `darwin-arm64` as
its only prebuild directory. Manifest parsing, URL construction and
checksum comparison get fixture-based tests. No network in the unit
suite.

**Manual.** US-047's own criterion -- a packaged build downloads,
plays and seeds -- stays manual, and the story is already marked
`manual: true`. It carries real weight here rather than being
ceremony: the engine's dependency tree is 2022-era, Node 24 is well
ahead of what it was written against, and no automated end-to-end
torrent test exists to catch a regression. The manual pass must use a
real torrent, not merely confirm the app launches.

## To resolve during implementation

Two questions are answerable only by building a bundle, and are
deliberately not settled here.

**Does Tauri's resource copy preserve the executable bit on `node`?**
If it does not, the fix is small but it changes the design: either
`chmod` during host setup, or stage the binary differently. This is
the most likely thing to bite.

**What are the exact `bundle.resources` map semantics** for copying a
directory's contents into the Resources root rather than into a
subdirectory of it?

## Also in scope

`package.json`'s `engines.node` becomes `>=24.0.0`, replacing
`^16.0.0 || ^18.0.0`. It is already fiction -- neither range is
satisfied by the Node in use for development -- and shipping a pinned
Node 24 widens the gap between the declared and the actual runtime.
The range is open-ended rather than `^24.0.0` because `engines`
constrains the machine that runs the build and the test suite, not
just the sidecar, and that machine is on a newer line.

`src-tauri/Cargo.toml` notes that its `version` is kept in sync with
`package.json` by hand and that "the packaging stories are where this
stops being cosmetic". Packaging now stamps a version into a
distributable artifact, so this design assumes the drift check lands
with it.

## Out of scope

Signing, the hardened runtime, notarization and stapling are US-083.
This work makes that harder in one specific way worth recording: the
bundle gains a nested Mach-O binary (`Resources/node`) and a nested
`.node` addon (`utp-native`'s prebuild), and macOS notarization
requires every Mach-O in the bundle to be signed. US-083 has to sign
those explicitly rather than relying on the app signature alone.

Windows and Linux packaging are not in scope, and are not in
`specs/prd.json` either. README cites "US-083 and US-084" for signed
macOS, Windows and Linux builds, but there is no US-084 -- the
sequence runs US-083, US-085, US-086. That README paragraph needs
correcting; the correction is not part of this design.

Replacing the deleted Spectron suite is not in scope. See
`test/AGENTS.md`, which records that `tauri-driver` does not support
macOS.
