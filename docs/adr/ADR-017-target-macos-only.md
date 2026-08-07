# ADR-017: Target macOS only

**Date:** 2026-08-07

## Context

WebTorrent Desktop shipped Mac, Windows and Linux builds. `npm run
package` drove `electron-packager` and `.github/workflows/package.yml`
had a job per platform. US-072 deleted that script with the Electron
host, and nothing replaced it until US-047, which shipped packaging
for macOS on arm64 and nothing else (ADR-016).

Nobody wrote down that the target had narrowed, so the repository
kept asserting the old one in places a reader would reasonably trust:

- `package.json`'s description read "For Mac, Windows, and Linux."
- `scripts.install-system-deps` was `brew install fakeroot dpkg rpm`
  -- Debian and RPM packaging tools, needed only to build Linux
  artifacts.
- `src-tauri/tauri.conf.json` set `bundle.targets` to `"all"`.
- `.github/workflows/package.yml` had `package_linux`, `package_macos`
  and `package_windows` jobs, all invoking the `npm run package` that
  US-072 deleted. The workflow had been dead for as long as the script
  had been gone, in a way that also encoded the wrong scope.
- `.github/workflows/ci.yml` ran the suite on `ubuntu-latest` under
  Node 16, which is neither the target platform nor a Node the
  `engines` field admits.
- `docs/README.md` said "macOS, Windows, and Linux are all supported
  for development."
- `static/linux/` carried a `.ejs` desktop entry and a `share/` tree,
  referenced by nothing in the repository.

ADR-015 is the clearest cost of leaving this unrecorded. It reasons
carefully about a `protobuf-codegen` build-machine floor "on every
platform" and about a firewall prompt on macOS and Windows, and
assigns both to a US-084 that does not exist in `specs/prd.json` and
was never going to.

## Decision

**This project targets macOS, on arm64 (ADR-016).** Windows and Linux
are not supported targets and are not in the backlog.

That is a decision about **what ships, what CI runs, and what the
documentation claims** -- not a mandate to strip every platform
conditional out of the host. `src-tauri/src/tray.rs` selects an icon
per platform and `src-tauri/src/paths.rs` has a Windows portable-mode
branch; both are ported code that already works, costs nothing to
keep, and would be a regression risk to remove for no benefit. They
stay. What changes is anything that either claims a platform we do not
ship or would break if someone believed it:

- `bundle.targets` narrows from `"all"` to `["app", "dmg"]`, so the
  bundler emits the two artifacts that are actually wanted rather than
  whatever else it decides `"all"` means on a given release.
- `package.yml` becomes one macOS job running the real build
  (`npm run build:tauri && npx tauri build`) instead of three jobs
  running a script that does not exist.
- `ci.yml` runs on `macos-latest` under Node 24, matching both the
  target platform and the declared `engines` floor.
- `install-system-deps` is removed. It installed Linux packaging tools
  through Homebrew, which was always odd and is now pointless.
- The `package.json` description and `docs/README.md` say macOS.
- `static/linux/` is deleted. Nothing references it.

## Consequences

The obligations ADR-015 assigned to a cross-platform packaging story
collapse to one platform. The rustc floor has to hold on an arm64 Mac;
the firewall prompt is the macOS one. Its per-platform crate analysis
stays accurate and is simply broader than the target.

CI exercises the packaging path for the first time. `package.yml` was
dead from US-072 until now, which is why nothing caught US-047's
clean-checkout build failure before a whole-branch review did -- a
`cargo build` on a fresh clone is exactly what CI does and what no
developer machine does. That gap closes.

The artifacts CI produces are **unsigned**, so they will not pass
Gatekeeper on a machine that did not build them. That is US-083, and
the workflow is `workflow_dispatch` rather than release automation
until it lands.

Moving CI from Ubuntu to macOS costs runner minutes -- GitHub bills
macOS runners at a multiple of Linux. The suite is fast and the
workflow is push/PR-triggered, so this is a real but small cost, and
running the tests on a platform the app does not target was buying
correspondingly little.

The `.ico` files stay, because `tray.rs` embeds `WebTorrent.ico` for
its Windows branch and `src/config.js` derives `APP_FILE_ICON` from a
base path without an extension. Deleting them means editing the host
and dropping the `image-ico` feature from `src-tauri/Cargo.toml`. That
is a coherent follow-up if the platform conditionals ever do come out;
it is not worth doing on its own.

Reversing this decision is cheap for the code and expensive for the
verification. Nothing here forecloses a Windows or Linux build --
Tauri bundles for all three and the host is largely portable -- but
`bin/stage-sidecar.js` stages one runtime for one triple and refuses
other hosts outright, so a second target means a second pinned Node,
a second closure prune, and a machine to verify each on.
