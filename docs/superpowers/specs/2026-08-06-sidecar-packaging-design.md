# Ship the engine sidecar in the packaged macOS app (US-047)

**Date:** 2026-08-06

**Status:** implemented. See "Resolved during implementation" for what
building a bundle answered, and "Corrected after implementation" for
one thing the design got wrong.

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

**The dependency closure is 190 package directories, 1618 files,
8.36 MB**, not the six direct requires visible in `build/engine/`.
Three of those packages carry native N-API prebuilds: `utp-native`,
`bufferutil` and `utf-8-validate`.

**The closure is not cleanly hoisted.** `debug` appears at 12
different paths in it and `readable-stream` at 10, at differing
versions under differing parents -- `node_modules/music-metadata/`
and `node_modules/webtorrent/` each carry their own `debug`. So the
staged `node_modules` has to preserve the tree rather than flatten
it. Flattening by package name would silently pick one version of
`debug` for every consumer, which is a class of bug that surfaces
only at runtime in a packaged app.

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

A third piece is needed to make those two work together, and the
design missed it. `bundle.resources` is read by `tauri-build`'s build
script, which runs during *every* `cargo build`, debug and release
alike -- and a resource path that does not exist is a hard error
there. `build-sidecar/` is gitignored, created only by
`beforeBundleCommand` (which runs after the cargo build) and deleted
by `bin/clean.js`, so the generated directory was a prerequisite of
the build that generates it. `src-tauri/build.rs` therefore creates it
before calling `tauri_build::build()`. See "Corrected after
implementation".

A plain `cargo build` is still a debug build, so `production` is false
and the sidecar still *resolves* to `node` on `PATH` and the
repository's own `build/`. What changed is the build, not the
resolution: a debug build now creates an empty `build-sidecar/` if
there is none.

## Components

### The runtime fetch

A committed manifest, `bin/node-runtime.json`, pins the version and
its SHA-256:

```json
{
  "version": "24.19.0",
  "platforms": {
    "darwin-arm64": {
      "sha256":
        "8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d"
    }
  }
}
```

The `platforms` nesting is what the code reads
(`verifyTarball` indexes `manifest.platforms[platform]`), and it is
what keeps `version` from colliding with a platform key if a second
one is ever pinned.

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

The walker resolves the way Node does: from a package's own directory,
check `<dir>/node_modules/<name>`, then walk up a level and check
again. That is Node's own algorithm, it handles hoisted and nested
layouts alike, and unlike `require.resolve('<name>/package.json')` it
cannot be defeated by a package whose `exports` map declines to
expose its manifest -- a real hazard across 190 packages.

Each resolved package is recorded by its path relative to the
repository root, and staging copies it to the same relative path
under `build-sidecar/`. Preserving the tree rather than flattening it
is what makes resolution in the bundle identical to resolution in
development, which is the property that lets the manual verification
mean something.

Its roots are the bare specifiers the built engine requires --
`application-config`, `arch`, `music-metadata`, `network-address`,
`webtorrent` and `ws` -- and from each it follows `dependencies` and
`optionalDependencies` transitively. Two deliberate edits on the way
past:

- `bufferutil` and `utf-8-validate` are skipped, by name.
- `utp-native` is copied with `prebuilds/` pruned to `darwin-arm64`.
  The other four platform directories are dead weight in an arm64-only
  bundle.

The walker returns a file list rather than copying as it goes. It
still reads the filesystem -- resolution *is* a filesystem question --
but it writes nothing, so what decides which files ship is separable
from the copying and testable with no network and no bundle.

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

Three unit files are new, one per module rather than the single
`stage-sidecar.js` this design first sketched:

**`test/unit/sidecar-closure.js`** covers the walker, run against the
real `node_modules`: `webtorrent`, `ws` and `music-metadata` present,
`bufferutil` and `utf-8-validate` absent, `utp-native` present with
`darwin-arm64` as its only prebuild directory, and `debug` staged at
each of its own paths. It also re-derives `ROOTS` by scanning
`build/config.js`, `build/engine/` and `build/shared/` for bare
`require()` specifiers, so a new import that nobody adds to the list
fails here rather than in a bundle.

**`test/unit/fetch-node.js`** covers manifest parsing, URL
construction and checksum comparison from fixtures, plus the two cache
paths that make the pin worth having -- a cached tarball that no
longer matches is deleted, and a download that does not match is never
written. `fetchNode` takes its cache directory as a parameter so those
run against a temp directory, and `globalThis.fetch` is stubbed. No
network in the unit suite.

**`test/unit/stage-sidecar.js`** covers assembly. `stage()` takes an
output path and a runtime-install function, so the smoke test
assembles a real tree into a temp directory with the 50MB download
stubbed out, and asserts that `node`, `package.json`,
`build/engine/index.js` and `node_modules/webtorrent/package.json`
land where `Runtime::resolve` looks for them. It also pins the
platform guard: staging refuses any host that is not `darwin-arm64`,
because cross-staging produces a bundle whose failure mode is
`Engine: failed to spawn` in the shipped app.

**Manual.** US-047's own criterion -- a packaged build downloads,
plays and seeds -- stays manual, and the story is already marked
`manual: true`. It carries real weight here rather than being
ceremony: the engine's dependency tree is 2022-era, Node 24 is well
ahead of what it was written against, and no automated end-to-end
torrent test exists to catch a regression. The manual pass must use a
real torrent, not merely confirm the app launches.

## Resolved during implementation

Two questions were answerable only by building a bundle. Both were,
and both went the way the design hoped -- recorded here so the next
person does not have to rebuild to find out.

**Tauri's resource copy preserves the executable bit.**
`Contents/Resources/node` comes through `-rwxr-xr-x` and reports
`v24.19.0`. The contingency -- `chmod` from the host at setup -- was
not needed, and `src-tauri/src/main.rs` is untouched by this work.

**The `bundle.resources` map form flattens.** `{"../build-sidecar/":
"./"}` puts `build/`, `node`, `node_modules/` and `package.json`
directly in `Contents/Resources` beside `WebTorrent.icns`, rather than
nesting them under a `build-sidecar/` subdirectory. The list form was
not needed.

Two things worth knowing that only surfaced from running it:

`beforeBundleCommand` runs with the repository root as its working
directory. That is a different base than `frontendDist` in the same
config block, which is relative to `src-tauri/` -- hence
`"node bin/stage-sidecar.js"` and `"../build-tauri"` sitting next to
each other and both being correct.

It also runs *after* the Rust compile rather than before it, so a
staging failure costs a full compile first. That is a slow way to
learn about a typo, which is part of why the staging script is
runnable and testable on its own.

## Corrected after implementation

**A clean checkout could not build.** Every task above passed review on
its own; nothing in that scope could see it. With `build-sidecar/`
absent -- a fresh clone, or anyone who has run `npm run clean` --
`cd src-tauri && cargo build` exited 101 with
`resource path '../build-sidecar' doesn't exist`, which broke
`npm start`, `npx tauri build` and the command README documented.

The fix is four lines in `src-tauri/build.rs`: create
`../build-sidecar` before calling `tauri_build::build()`. Three
approaches were tested rather than argued.

1. **A glob, `"../build-sidecar/*"`.** Rejected, and it does not work
   in either direction. `tauri-utils` errors with `GlobPathNotFound`
   when a glob matches nothing, so it does not fix the empty case; and
   for globbed matches it computes the destination as
   `dest.join(file_name)`, which would flatten the whole staged tree
   into one directory and drop every subdirectory. Verified by reading
   `tauri-utils-2.9.3/src/resources.rs` and by building.
2. **Staging from `beforeBuildCommand`.** Would work, but it also runs
   for `tauri dev`, so every developer would pay the ~50MB Node
   download on first run and each debug build would copy ~128MB into
   `target/debug/`.
3. **Creating the directory in `build.rs`.** Taken. `tauri-utils`
   walks a directory resource and skips it when the walk yields no
   files, so an *empty* directory is not an error -- only a missing
   one is. A debug build therefore copies nothing, `beforeBundleCommand`
   still fills the directory before the bundler collects resources, and
   the packaged Resources are unchanged.

The tradeoff: `build.rs` now knows the staging directory's name, which
is a sixth place `build-sidecar` is spelled. `test/unit/tauri-host.js`
holds all six together, and additionally pins that `bundle.resources`
maps `../build-sidecar/` to `./` in that direction and is not a glob.

**The staged platform is now checked.** `PLATFORM` was written out
twice, in `bin/stage-sidecar.js` and `bin/sidecar-closure.js`, with
nothing holding the two together -- a drift would put an x64 Node
beside an arm64 `utp-native` prebuild, which fails at require time in
the packaged app. It is now defined once in `bin/sidecar-closure.js`
and imported. `stage()` also refuses to run on a host that is not
`darwin-arm64`, which nothing checked before.

## Also in scope

`package.json`'s `engines.node` becomes `>=24.0.0`, replacing
`^16.0.0 || ^18.0.0`. It is already fiction -- neither range is
satisfied by the Node in use for development -- and shipping a pinned
Node 24 widens the gap between the declared and the actual runtime.
The range is open-ended rather than `^24.0.0` because `engines`
constrains the machine that runs the build and the test suite, not
just the sidecar, and that machine is on a newer line.

`engines.npm` has to move with it. It read
`^7.10.0 || ^8.0.0 || ^9.0.0 || ^10.0.0`, and Node 24 ships npm 11, so
raising `node` alone left a block that nothing could satisfy -- the
same defect in the other field. It becomes `>=10.0.0`, open-ended for
the same reason.

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
