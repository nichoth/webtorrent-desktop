# Ad-hoc Signing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the packaged `WebTorrent.app` executable at all. The
release binary currently carries no code signature, and arm64 macOS
refuses to exec an unsigned Mach-O, so the bundle the bundler produces
cannot launch on any Apple Silicon Mac including the one that built it.

**Architecture:** Set `bundle.macOS.signingIdentity` to `"-"` in
`src-tauri/tauri.conf.json`. The Tauri bundler passes that string
verbatim to `codesign --force -s -`, which is an ad-hoc signature: no
certificate, no account, no cost. Signing happens inside `tauri build`
before the `.dmg` is assembled, so the disk image carries the signed
app. Nothing under `Contents/Resources` is touched.

**Tech Stack:** Tauri 2 bundler, `codesign(1)`, Node CommonJS scripts
under `bin/`, `tape` unit tests under `test/unit/`, `standard` lint.

**Scope boundary:** This plan makes the build *run*. It does not make
it run *cleanly*: an ad-hoc signature does not satisfy Gatekeeper, so a
recipient still has to clear the quarantine attribute. Developer ID
signing and notarization are a separate, credential-gated plan --
`docs/superpowers/plans/2026-08-08-developer-id-signing.md` (US-083).
These are split because that one is blocked on a paid Apple Developer
Program membership that may never arrive, and this one ships today.

## Global Constraints

- **arm64 macOS only** (ADR-017). No universal binary.
- **No new npm dependencies.** `npm test` runs `depcheck`. Shell out to
  the `codesign` macOS ships, via `child_process`.
- **Do not sign anything under `Contents/Resources`.** The staged
  `node` carries a genuine `Developer ID Application: Node.js
  Foundation (HX7739G8FX)` signature with a secure timestamp and the
  JIT entitlements V8 needs. The `utp-native` prebuild is already
  ad-hoc linker-signed. Re-signing either one is Plan 2's problem and
  would strip entitlements here for no gain.
- **`hardenedRuntime` must be `false`.** It buys nothing without
  notarization and only adds failure modes under an ad-hoc signature.
  Plan 2 turns it back on.
- Code style is `standard`: no semicolons, 2-space indent, space before
  the parameter list in a function declaration.
- Docs and comments use `--` rather than an em dash and `->` rather
  than an arrow character. No emoji in filenames or comments.

---

## Background: the observed failure

Recorded here because it is not reproducible once the plan is done.

```
$ codesign -dv .../WebTorrent.app
code object is not signed at all

$ otool -l .../Contents/MacOS/webtorrent-desktop | grep -c LC_CODE_SIGNATURE
0

$ spctl --assess --type execute -vv .../WebTorrent.app
rejected (source=no usable signature)
```

An arm64 Mach-O with no `LC_CODE_SIGNATURE` is SIGKILLed by the kernel.
Demonstrated on the target machine with a throwaway binary: unsigned
exits 137, the same binary after `codesign --force --sign -` exits
normally. So this is not only a distribution problem -- the release
bundle does not run locally either.

Why the linker's usual ad-hoc signature is absent was not established.
There is no `[profile]` section in `src-tauri/Cargo.toml`, no
`.cargo/config.toml`, and `RUSTFLAGS` is empty. It does not matter for
this plan: `codesign` adds the signature regardless of why it went
missing. If Task 1 does not produce a signed binary, that assumption is
wrong and the cause needs investigating before continuing.

## Verified mechanism

From `tauri-bundler`'s `macos/sign.rs` and `tauri-macos-sign`'s
`keychain.rs` on `dev`:

- `keychain(identity)` returns `Keychain::with_signing_identity(identity)`
  when `APPLE_CERTIFICATE` is unset and an identity is configured. No
  keychain lookup and no validation happen on that path, so `"-"`
  survives to `codesign`.
- `Keychain::sign` runs `codesign --force -s <identity> <path>`, adding
  `--options runtime` only when `hardened_runtime` is true and the
  target is an executable, and `--entitlements <path>` only when
  entitlements are configured.
- It signs an explicit list of `SignTarget`s. It never passes `--deep`
  and never walks `Contents/Resources`.
- With no identity configured at all, `keychain()` returns `None` and
  the bundler skips signing entirely. That is today's state.

---

## File Structure

**Created:**
- `bin/verify-bundle.js` -- reads a built `.app`, classifies the
  signature on every Mach-O it contains, and exits non-zero if any is
  unsigned. Pure `signatureKind` and `bundleVerdict` helpers split from
  the impure walk, following the split `bin/fetch-node.js` uses.
- `test/unit/macos-signing.js` -- covers the bundler configuration and
  `bin/verify-bundle.js`'s pure helpers. Plan 2 extends this same file.

**Modified:**
- `src-tauri/tauri.conf.json` -- add `bundle.macOS` with
  `signingIdentity` and `hardenedRuntime`.
- `package.json` -- add a `verify:bundle` script.
- `README.md:98-106` -- the "Two limits worth knowing" paragraph
  currently says the output is unsigned. Half of that stops being true.
- `docs/README.md:181` -- same claim, same fix.
- `specs/prd.json` -- US-083's `notes`, to record what ad-hoc covers
  and what it does not.

**Untouched, deliberately:**
- `bin/stage-sidecar.js` and everything it stages.
- `bin/darwin-entitlements.plist` -- Electron-era leftover. Plan 2
  deletes it; leaving it alone keeps this plan's diff to one concern.

---

## Task 1: Make the bundler sign the app

**Files:**
- Create: `test/unit/macos-signing.js`
- Modify: `src-tauri/tauri.conf.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `bundle.macOS.signingIdentity` (string) and
  `bundle.macOS.hardenedRuntime` (boolean) in `tauri.conf.json`. Task 3
  documents them; Plan 2 changes both values.

- [ ] **Step 1: Write the failing test**

Create `test/unit/macos-signing.js`:

```js
const test = require('tape')
const fs = require('fs')
const path = require('path')

// The bundler signs only when an identity is configured: with none,
// `tauri-bundler`'s `keychain()` returns None and skips signing
// entirely. That produced a release binary with no LC_CODE_SIGNATURE,
// which arm64 macOS SIGKILLs on exec -- a bundle that cannot run on
// the machine that built it. Nothing else in the repo would catch its
// removal, because no test can run a bundler.

const REPO = path.join(__dirname, '..', '..')
const CONF_PATH = path.join(REPO, 'src-tauri', 'tauri.conf.json')

function readConf () {
  return JSON.parse(fs.readFileSync(CONF_PATH, 'utf8'))
}

test('the bundler is configured to sign the app', function (t) {
  const macos = readConf().bundle.macOS || {}

  t.ok(
    typeof macos.signingIdentity === 'string' &&
      macos.signingIdentity.length > 0,
    'bundle.macOS.signingIdentity is a non-empty string'
  )
  t.end()
})

test('the hardened runtime is off while the signature is ad-hoc',
  function (t) {
    // `--options runtime` without notarization buys nothing and only
    // adds ways for an ad-hoc signed process to be refused at launch.
    // The Developer ID plan turns this back on, together with the
    // entitlements that make it survivable.
    const macos = readConf().bundle.macOS || {}

    t.equal(
      macos.hardenedRuntime, false,
      'bundle.macOS.hardenedRuntime is explicitly false'
    )
    t.end()
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tape test/unit/macos-signing.js`

Expected: FAIL. `tauri.conf.json` has no `bundle.macOS` key at all, so
both assertions fail -- `signingIdentity` is `undefined` and
`hardenedRuntime` is `undefined`, not `false`.

- [ ] **Step 3: Add the configuration**

In `src-tauri/tauri.conf.json`, add a `macOS` object inside `bundle`,
after `"targets"` and before `"resources"`:

```json
    "macOS": {
      "signingIdentity": "-",
      "hardenedRuntime": false
    },
```

The surrounding `bundle` object then reads:

```json
  "bundle": {
    "active": true,
    "targets": ["app", "dmg"],
    "macOS": {
      "signingIdentity": "-",
      "hardenedRuntime": false
    },
    "resources": {
      "../build-sidecar/": "./"
    },
    "icon": [
      "../static/WebTorrent.icns",
      "../static/WebTorrent.png"
    ]
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tape test/unit/macos-signing.js`

Expected: PASS, 2 assertions.

- [ ] **Step 5: Run the full suite**

Run: `npm test`

Expected: PASS. `standard` and `depcheck` clean, all `tape` assertions
pass. The new file adds no dependency.

- [ ] **Step 6: Commit**

```bash
git add test/unit/macos-signing.js src-tauri/tauri.conf.json
git commit -m "fix: ad-hoc sign the macOS bundle so it can launch"
```

---

## Task 2: A script that proves the bundle is signed

**Files:**
- Create: `bin/verify-bundle.js`
- Modify: `test/unit/macos-signing.js`, `package.json`

**Interfaces:**
- Consumes: `bundle.macOS.signingIdentity` from Task 1, indirectly --
  it verifies the result.
- Produces: `bin/verify-bundle.js` exporting
  `signatureKind(codesignOutput) -> 'unsigned'|'adhoc'|'signed'`,
  `bundleVerdict(entries) -> {ok: boolean, unsigned: string[]}` where
  `entries` is `Array<{path: string, kind: string}>`, and
  `machoPaths(appPath) -> string[]`. Plan 2 reuses `signatureKind` and
  extends `bundleVerdict`.

Why a script and not a test: nothing in `tape` can run a bundler, so
the invariant "the thing we shipped is signed" has no unit-test home.
The pure decision functions are unit-tested here; the walk is a thin
impure shell, matching how `bin/fetch-node.js` splits `verifyTarball`
from `fetchNode`.

- [ ] **Step 1: Write the failing test**

Add this require to the top of `test/unit/macos-signing.js`, below the
existing ones:

```js
const {
  bundleVerdict, signatureKind
} = require('../../bin/verify-bundle')
```

Then append the fixtures and tests to the end of the file:

```js
// Captured verbatim from `codesign -dv` on this repo's own build, so
// the classifier is matched against real output rather than a guess at
// its shape.
const UNSIGNED_OUT =
  'MacOS/webtorrent-desktop: code object is not signed at all'

const ADHOC_OUT = [
  'Identifier=t',
  'CodeDirectory v=20400 size=259 flags=0x2(adhoc) hashes=2+2',
  'Signature=adhoc'
].join('\n')

const LINKER_ADHOC_OUT = [
  'Identifier=utp_native.node',
  'CodeDirectory v=20400 size=1032 flags=0x20002(adhoc,linker-signed)',
  'TeamIdentifier=not set'
].join('\n')

const DEVELOPER_ID_OUT = [
  'Identifier=node',
  'CodeDirectory v=20500 size=940560 flags=0x10000(runtime)',
  'Authority=Developer ID Application: Node.js Foundation (HX7739G8FX)',
  'Timestamp=Aug 3, 2026 at 12:57:06 AM',
  'TeamIdentifier=HX7739G8FX'
].join('\n')

test('signatureKind classifies real codesign output', function (t) {
  t.equal(
    signatureKind(UNSIGNED_OUT), 'unsigned',
    'a missing signature is the failure this plan exists to fix'
  )
  t.equal(
    signatureKind(ADHOC_OUT), 'adhoc', 'an ad-hoc signature is ad-hoc'
  )
  t.equal(
    signatureKind(LINKER_ADHOC_OUT), 'adhoc',
    'the linker-signed variant is still ad-hoc'
  )
  t.equal(
    signatureKind(DEVELOPER_ID_OUT), 'signed',
    'the staged Node runtime keeps a real Developer ID signature'
  )
  t.end()
})

test('bundleVerdict fails on any unsigned Mach-O', function (t) {
  const good = bundleVerdict([
    { path: 'Contents/MacOS/webtorrent-desktop', kind: 'adhoc' },
    { path: 'Contents/Resources/node', kind: 'signed' }
  ])
  t.ok(good.ok, 'every binary carrying a signature passes')
  t.deepEqual(good.unsigned, [], 'nothing is reported unsigned')

  const bad = bundleVerdict([
    { path: 'Contents/MacOS/webtorrent-desktop', kind: 'unsigned' },
    { path: 'Contents/Resources/node', kind: 'signed' }
  ])
  t.notOk(bad.ok, 'one unsigned binary fails the whole bundle')
  t.deepEqual(
    bad.unsigned, ['Contents/MacOS/webtorrent-desktop'],
    'the failing path is named so the report is actionable'
  )
  t.end()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tape test/unit/macos-signing.js`

Expected: FAIL with `Cannot find module '../../bin/verify-bundle'`.

- [ ] **Step 3: Write the implementation**

Create `bin/verify-bundle.js`:

```js
#!/usr/bin/env node

/**
 * Reports the code signature on every Mach-O in a built `.app`.
 *
 * The bundler signs the app and the binaries it knows about; it does
 * not walk `Contents/Resources`, where the Node sidecar and its native
 * addon live. So "did the build come out signed" is a question about
 * several files, and this answers it in one command rather than four
 * `codesign` invocations typed from memory.
 *
 * Ad-hoc counts as signed here. An ad-hoc signature is what makes the
 * binary runnable on arm64; whether it satisfies Gatekeeper is a
 * different question, and `spctl --assess` is the tool that answers it.
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const APP_PATH = path.join(
  __dirname, '..', 'src-tauri', 'target', 'release', 'bundle', 'macos',
  'WebTorrent.app'
)

module.exports = { bundleVerdict, machoPaths, signatureKind }

if (require.main === module) main()

/**
 * @param {string} out combined `codesign -dv` output for one file
 * @returns {'unsigned'|'adhoc'|'signed'}
 */
function signatureKind (out) {
  if (/not signed at all/.test(out)) return 'unsigned'
  if (/flags=0x[0-9a-f]+\([^)]*\badhoc\b/.test(out)) return 'adhoc'
  return 'signed'
}

/**
 * @param {Array<{path: string, kind: string}>} entries
 * @returns {{ok: boolean, unsigned: string[]}}
 */
function bundleVerdict (entries) {
  const unsigned = entries
    .filter(entry => entry.kind === 'unsigned')
    .map(entry => entry.path)

  return { ok: unsigned.length === 0, unsigned }
}

/** Every Mach-O under `appPath`, as paths relative to it. */
function machoPaths (appPath) {
  const found = []

  walk(appPath)
  return found.sort()

  function walk (dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        walk(full)
      } else if (isMacho(full)) {
        found.push(path.relative(appPath, full))
      }
    }
  }
}

function isMacho (filePath) {
  const out = spawnSync('file', ['-b', filePath], { encoding: 'utf8' })
  return /Mach-O/.test(out.stdout || '')
}

function main () {
  if (!fs.existsSync(APP_PATH)) {
    console.error(
      `${APP_PATH} does not exist -- run ` +
      "'npm run build:tauri && npx tauri build' first"
    )
    process.exit(1)
  }

  const entries = machoPaths(APP_PATH).map(relative => {
    const out = spawnSync(
      'codesign', ['-dv', '--verbose=2', path.join(APP_PATH, relative)],
      { encoding: 'utf8' }
    )
    // codesign writes its report to stderr, and exits non-zero on an
    // unsigned file, which is a result here rather than an error.
    return {
      path: relative,
      kind: signatureKind(`${out.stdout || ''}${out.stderr || ''}`)
    }
  })

  for (const entry of entries) {
    console.log(`${entry.kind.padEnd(8)} ${entry.path}`)
  }

  const verdict = bundleVerdict(entries)
  if (!verdict.ok) {
    console.error(
      `\n${verdict.unsigned.length} unsigned Mach-O in the bundle -- ` +
      'arm64 macOS will refuse to exec these'
    )
    process.exit(1)
  }
  console.log(`\n${entries.length} Mach-O, all signed`)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tape test/unit/macos-signing.js`

Expected: PASS, 10 assertions across the four tests in the file.

- [ ] **Step 5: Add the npm script**

In `package.json`, add to `scripts`, between `update-authors` and
`watch` (the existing map is not alphabetical -- `tauri:build` follows
`build:tauri` and `lint` follows `test-unit` -- so this is placement by
convention, not by sort order):

```json
    "verify:bundle": "node ./bin/verify-bundle.js",
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`

Expected: PASS. `depcheck` stays clean -- `verify-bundle.js` requires
only Node built-ins.

- [ ] **Step 7: Commit**

```bash
git add bin/verify-bundle.js test/unit/macos-signing.js package.json
git commit -m "feat: add a bundle signature verifier"
```

---

## Task 3: Correct the docs that say the output is unsigned

**Files:**
- Modify: `README.md:98-106`, `docs/README.md:181`, `specs/prd.json`

**Interfaces:**
- Consumes: the behaviour Tasks 1 and 2 establish.
- Produces: nothing code depends on.

No test. Per the repo's standing rule, docs do not get tests.

- [ ] **Step 1: Rewrite the README limits paragraph**

`README.md` currently claims the output is "unsigned and un-notarized,
so macOS will refuse it on another machine without a Gatekeeper
override". Replace that second limit with:

```markdown
Two limits worth knowing. The build is **arm64 macOS only**: the
staged Node runtime and the `utp-native` prebuild are both
`darwin-arm64`, and the staging script refuses to run on any other
host rather than producing a bundle that cannot spawn its engine. And
the signature is **ad-hoc**: `bundle.macOS.signingIdentity` is `"-"`,
which is what makes the binary runnable at all -- arm64 macOS
SIGKILLs a Mach-O with no signature -- but it is not a Developer ID
and it does not satisfy Gatekeeper. Copying the `.dmg` to another Mac
still needs the quarantine attribute cleared:

    xattr -dr com.apple.quarantine /Applications/WebTorrent.app

Signing with a Developer ID, the hardened runtime, notarization and
stapling are US-083 in `specs/prd.json`. Windows and Linux are not
targets at all -- see
[ADR-017](docs/adr/ADR-017-target-macos-only.md).

`npm run verify:bundle` reports the signature on every Mach-O in a
built `.app`.
```

- [ ] **Step 2: Fix the same claim in docs/README.md**

`docs/README.md:181` says signing, the hardened runtime, notarization
and stapling are US-083. That stays true, but the sentence around it
implies the bundle is wholly unsigned. Add after it:

```markdown
The bundle is ad-hoc signed (`bundle.macOS.signingIdentity` is `"-"`)
so that it can execute -- arm64 macOS refuses an unsigned Mach-O. That
is not a Developer ID and does not satisfy Gatekeeper.
```

- [ ] **Step 3: Record what changed in US-083**

In `specs/prd.json`, US-083 keeps `"passes": false`. Append to its
`notes`:

```
Ad-hoc signing landed separately (bundle.macOS.signingIdentity "-",
hardenedRuntime false), which fixes only that the release binary had no
LC_CODE_SIGNATURE and was SIGKILLed on arm64. It satisfies none of this
story's criteria: no Developer ID, no hardened runtime, no
notarization. Note for whoever picks this up -- the staged
Contents/Resources/node carries com.apple.security.get-task-allow,
which the notarization service rejects, so that binary has to be
re-signed rather than shipped as downloaded.
```

- [ ] **Step 4: Verify the JSON still parses**

Run: `node -e "JSON.parse(require('fs').readFileSync('specs/prd.json'))"`

Expected: no output, exit 0.

- [ ] **Step 5: Run the full suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/README.md specs/prd.json
git commit -m "docs: the bundle is ad-hoc signed, not unsigned"
```

---

## Manual verification

Not automatable -- it needs a real bundler run on an arm64 Mac. Do this
before calling the plan done.

- [ ] **Build**

```bash
npm run build:tauri && npx tauri build
```

Expected: the bundler logs `Signing with identity "-"` and
`Signing .../WebTorrent.app`.

- [ ] **Confirm the signature exists**

```bash
npm run verify:bundle
```

Expected: three Mach-O listed, none `unsigned`.
`Contents/MacOS/webtorrent-desktop` reports `adhoc`,
`Contents/Resources/node` reports `signed`, and the `utp-native`
prebuild reports `adhoc`. Exit 0.

Confirm directly too, since this is the assertion the whole plan rests
on:

```bash
otool -l src-tauri/target/release/bundle/macos/WebTorrent.app/Contents/MacOS/webtorrent-desktop \
  | grep -c LC_CODE_SIGNATURE
```

Expected: `1`. It was `0` before this plan.

- [ ] **Confirm Node kept its real signature**

```bash
codesign -dv --verbose=2 \
  src-tauri/target/release/bundle/macos/WebTorrent.app/Contents/Resources/node 2>&1 \
  | grep Authority
```

Expected: still
`Authority=Developer ID Application: Node.js Foundation (HX7739G8FX)`.
If this now reports ad-hoc, something re-signed the resources and the
sidecar will lose its JIT entitlements under any future hardened
runtime.

- [ ] **Launch it**

Open `src-tauri/target/release/bundle/macos/WebTorrent.app`.

Expected: the window opens. Before this plan the process was SIGKILLed
on exec. Add a torrent and confirm it downloads, which proves the
sidecar still spawns -- signing the app seals `Contents/Resources` as
part of the bundle, and a mistake there breaks the engine rather than
the window.

- [ ] **Confirm what this does not fix**

```bash
spctl --assess --type execute -vv \
  src-tauri/target/release/bundle/macos/WebTorrent.app
```

Expected: still `rejected`. That is correct and expected -- an ad-hoc
signature is not a Developer ID. If it says `accepted`, someone has a
certificate configured and this is no longer the ad-hoc path.

- [ ] **Confirm the recipient story on a second Mac**

Copy the `.dmg` to another arm64 Mac, ideally by download so it picks
up quarantine. Confirm it is blocked, then that
`xattr -dr com.apple.quarantine /Applications/WebTorrent.app` makes it
launch. This is the step that tells you whether the README instruction
is correct.

---

## Self-review notes

- **Coverage:** Task 1 fixes the SIGKILL. Task 2 makes the fix
  checkable. Task 3 stops the docs from asserting something false.
  Manual verification covers what no test can reach.
- **Assumption to falsify early:** that `codesign -s -` on the app
  bundle is enough, i.e. that the missing signature was only ever the
  bundler declining to sign. If Task 1's build still shows
  `LC_CODE_SIGNATURE` count 0, stop -- something is stripping the
  signature after `codesign` runs, and that needs finding first.
- **Names used consistently:** `signatureKind`, `bundleVerdict`,
  `machoPaths` in `bin/verify-bundle.js`; `signingIdentity` and
  `hardenedRuntime` under `bundle.macOS`. Plan 2 reuses all five.
