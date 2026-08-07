# ADR-016: Ship a pinned Node runtime and the engine's closure in the bundle

**Date:** 2026-08-07

## Context

ADR-012 made the engine a Node sidecar and wrote down what that would
cost at packaging time: "the sidecar needs a Node runtime in the
shipped app." US-072 then deleted `bin/package.js` along with the
Electron host, and nothing replaced it.

So `npx tauri build` produced a `WebTorrent.app` that launched and
could not torrent. `Contents/Resources` held exactly one file,
`WebTorrent.icns`, and running the binary gave:

```
Engine: failed to spawn: No such file or directory (os error 2)
Engine: restarting in 500ms (attempt 1 of 5)
```

The layout was never in question. `engine::Runtime::resolve`
(`src-tauri/src/engine.rs:130`) branches on `!cfg!(debug_assertions)`:
a release build wants `<resource_dir>/node`,
`<resource_dir>/build/engine/index.js`, and `cwd = <resource_dir>`,
and `the_packaged_sidecar_is_next_to_its_runtime_in_the_resources`
already asserted it. What was missing was something to produce that
directory. This ADR records how, and the four measurements that ruled
out the obvious answers.

**Copying the build machine's `node` does not work.** Homebrew's is
dynamically linked against roughly eighteen dylibs under
`/opt/homebrew/opt/`, including `@rpath/libnode.141.dylib`,
`libicui18n.78.dylib` and `libcrypto.3.dylib`. A bundle carrying that
binary alone runs only where an identical Homebrew install exists.

**The closure is 190 package directories, 1618 files, 8.36 MB**, not
the six bare specifiers visible in `build/engine/` and
`build/config.js`.

**The closure is not cleanly hoisted.** `debug` resolves to twelve
different directories at differing versions and `readable-stream` to
ten -- `node_modules/music-metadata/` and `node_modules/webtorrent/`
each carry their own. Any scheme that flattens by package name picks
one version of `debug` for every consumer, and the failure surfaces
only at runtime in a packaged app.

**The three packages carrying native prebuilds are all optional.**
`node_modules/webtorrent/lib/utp.js` is a `try`/`catch` require that
returns `{}` and warns `WebTorrent: uTP not supported`; `ws` falls
back to JS implementations without `bufferutil` and `utf-8-validate`.

## Decision

### The runtime is a pinned official tarball, and the digest is committed

`bin/node-runtime.json` pins the version and its SHA-256.
`bin/fetch-node.js` downloads from `nodejs.org/dist`, verifies against
that manifest before writing anything to the cache, and extracts only
`bin/node`. Extraction shells out to the `tar` macOS ships, so no npm
dependency is added and `depcheck` stays quiet.

Committing the digest is the point rather than a detail. Verifying a
download against a `SHASUMS256.txt` fetched from the same host proves
the file arrived intact, not that it is the file that was intended.
The committed value makes changing the shipped runtime a reviewable
diff.

Rejected: the build machine's binary, for the dylib reason above; a
Node SEA fusion, which still has to source a Node binary and does not
carry native addons without extra work; and depending on the user
having Node installed, which for a consumer torrent client means most
downloads fail to torrent.

### Node 24 LTS

`v24.19.0`, LTS codename Krypton, maintained into 2028. Node 25 was
considered and rejected on evidence: it is an odd-numbered line that
never becomes LTS, and `nodejs.org/dist/index.json` shows its last
release was 25.9.0 in March 2026 while 24 and 26 both shipped in
August. Node 26 is live but a Current line and the furthest from what
this 2022-era dependency tree was written against. Node 18, which
`engines` declared at the time, is past end of life, and shipping an
unpatched runtime inside a client that parses untrusted data from
peers is the wrong direction.

### The closure is copied out of `node_modules`, tree preserved

`bin/sidecar-closure.js` resolves the way Node does: from a package's
own directory, check `<dir>/node_modules/<name>`, then walk up and
check again. Spelled out rather than delegated to
`require.resolve('<name>/package.json')`, which a package whose
`exports` map declines to expose its manifest defeats -- a real hazard
across 190 of them.

Each resolved package is recorded by its path relative to the
repository root and staged at that same path. Preserving the tree is
what makes resolution in the bundle identical to resolution in
development, which is the property that lets a manual verification
mean anything.

Rejected: an esbuild single-file bundle, because ADR-003 deliberately
settled this repo on two build tools and webtorrent's tree uses
dynamic require patterns that bundlers handle badly; and an
`npm install` into a staging directory, which puts a network install
inside the packaging step and can drift from the root lockfile.

### `utp-native` ships; `bufferutil` and `utf-8-validate` do not

uTP is peer transport, and losing it is a real connectivity regression
against the Electron app, so `utp-native` is staged with `prebuilds/`
pruned to `darwin-arm64` alone. The other two accelerate WebSocket
frame masking and UTF-8 validation, which here is a localhost control
channel carrying small JSON envelopes -- no benefit, and each would be
another nested Mach-O for US-083 to sign.

### arm64 only

`aarch64-apple-darwin`, one architecture, no universal binary.
`bin/stage-sidecar.js` refuses to run on any other host rather than
staging a runtime that cannot execute in the artifact being built.

### `src-tauri/build.rs` creates the staging directory

This one the design missed and building found. `bundle.resources` is
read by `tauri-build`'s **build script**, which runs during every
`cargo build`, debug and release alike, and a resource path that does
not exist is a hard error there. `build-sidecar/` is gitignored,
created only by `beforeBundleCommand` -- which the CLI runs *after*
the cargo build -- and deleted by `bin/clean.js`. So the generated
directory was a prerequisite of the build that generates it, and a
clean checkout could not build at all:

```
$ cd src-tauri && cargo build
resource path `../build-sidecar` doesn't exist
CARGO EXIT: 101
```

`src-tauri/build.rs` therefore creates it before calling
`tauri_build::build()`. A directory resource that walks to no files is
skipped; only a missing path errors. Debug builds consequently copy
nothing.

The glob form (`["../build-sidecar/*"]`) was tested and rejected twice
over: it still raises `GlobPathNotFound` on an empty match, so it
fixes nothing, and globbed matches are placed with
`dest.join(file_name)`, which would have flattened the staged tree and
dropped every subdirectory -- a bundle that looks correct and cannot
torrent, which is the worst available outcome because it builds.

## Consequences

The bundle grows by about 128 MB, of which 116 MB is the Node binary.
That is worth reading against ADR-013, which rejected shelling out to
`ffmpeg` partly on the cost of "a 40 to 80 MB binary per platform
inside the app bundle" and the signing surface it would add. Both
costs are now paid regardless of that decision, so the size and
signing halves of that rejection no longer distinguish the options;
the argument that still does is that ffmpeg duplicates a decoder the
webview already ships.

US-083 gets harder in a specific way. The bundle now carries two
nested Mach-O files -- `Resources/node` and `utp-native`'s prebuild --
and macOS notarization requires every Mach-O in a bundle to be signed.
They have to be signed explicitly rather than covered by the app
signature.

Development is unchanged in *resolution* and changed in *build*. A
debug build still resolves the engine to `node` on the `PATH` and the
repository's own `build/`, so `npm start` behaves exactly as before.
But every `cargo build` now creates `build-sidecar/` when it is
absent, and copies its contents into `target/` when it is populated.

`npm start` therefore exercises none of this at runtime. It runs the
engine on a different Node, from a different working directory,
against a different `node_modules`, and it came up green for the whole
time the packaged app was broken. Verification of anything decided
here has to be done against the `.app`.

The pin is trust-on-first-use. The committed digest protects every
build after the first against a compromised mirror, and it makes a
runtime change reviewable. It does not establish that the initial
value was the intended file: it was taken from the same
`SHASUMS256.txt` it now guards against, and Node's GPG signature on
that file was not checked. Verifying `SHASUMS256.txt.sig` against
Node's release keys is the obvious thing to do the next time the pin
moves.

`ROOTS` in `bin/sidecar-closure.js` is a hand-maintained seed, and a
new bare import in `src/engine/` would otherwise drop a package from
the bundle silently. `test/unit/sidecar-closure.js` scans the built
output for bare `require()` specifiers and asserts each one appears in
the closure, so that regression fails a test rather than a download.

The `engines.node` field moves to `>=24.0.0`, open-ended rather than
`^24.0.0` because it constrains the machine running the build and the
test suite as well as the sidecar. See ADR-014's "Target versions",
which now names three independent Node floors: Vite's, the declared
one, and the runtime pinned here.
