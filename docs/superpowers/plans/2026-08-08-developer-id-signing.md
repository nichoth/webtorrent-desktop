# Developer ID Signing and Notarization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** US-083. Ship a `WebTorrent.app` and `.dmg` that open on a Mac
that has never seen them, with no Gatekeeper prompt and no `xattr`
ritual.

**Architecture:** Sign inside-out. `bin/stage-sidecar.js` gains a step
that signs the two Mach-O it stages into `Contents/Resources` -- the
`utp-native` addon first, then the Node runtime with its own
entitlements -- because the Tauri bundler provably does not walk that
directory. The bundler then signs the app and `.dmg` with the hardened
runtime on, and notarizes and staples in the same `tauri build`.

**Tech Stack:** Tauri 2 bundler, `codesign(1)`, `notarytool` and
`stapler` via Tauri, Node CommonJS under `bin/`, `tape` under
`test/unit/`, GitHub Actions.

**Depends on:**
`docs/superpowers/plans/2026-08-08-adhoc-signing.md`. That plan creates
`bundle.macOS`, `test/unit/macos-signing.js` and `bin/verify-bundle.js`,
all of which this one modifies. Execute it first.

**Blocked on, before Task 3:** a paid Apple Developer Program
membership ($99/yr), a **Developer ID Application** certificate (only
the account holder can create one), notarization credentials, and a
second Mac that has never run the app. Tasks 1 and 2 need none of
these and can land ahead of the certificate.

## Global Constraints

- **arm64 macOS only** (ADR-017).
- **No new npm dependencies.** `npm test` runs `depcheck`. Shell out to
  the `codesign` macOS ships, via `child_process`.
- **Never commit a certificate, a `.p12`, a private key, or a
  password.** Credentials come from the environment only. This is
  AC-5 of US-083.
- **Never use `codesign --deep`.** Apple deprecated it for signing, and
  here it would re-sign the staged Node with the *app's* entitlements,
  silently dropping `com.apple.security.cs.allow-jit`. The sidecar then
  dies at spawn under the hardened runtime, which surfaces only in a
  signed release build.
- **`com.apple.security.get-task-allow` must not appear in any shipped
  entitlements.** The notarization service rejects it.
- Sign leaves before containers. A signature over a directory seals the
  files under it; re-signing a nested file afterwards invalidates the
  outer seal.
- Code style is `standard`. Docs and comments use `--` not an em dash
  and `->` not an arrow character.

---

## Background: why this is not one `codesign` call

Established by inspecting this repo's own build.

The bundle holds three Mach-O:

```
Contents/MacOS/webtorrent-desktop                            the Rust host
Contents/Resources/node                                      the sidecar runtime
Contents/Resources/node_modules/utp-native/prebuilds/darwin-arm64/node.napi.node
```

The sidecar arrives through `bundle.resources` (`"../build-sidecar/":
"./"`), not `externalBin`. `tauri-bundler`'s `macos/sign.rs` signs an
explicit list of `SignTarget`s and never walks `Contents/Resources`, so
those two files are sealed as resource hashes but never code-signed by
the build. Notarization inspects every Mach-O regardless of where it
sits.

The `utp-native` prebuild reports `flags=0x20002(adhoc,linker-signed)`
and `TeamIdentifier=not set`. Ad-hoc fails notarization outright.

The Node runtime looks fine -- valid Developer ID from Node.js
Foundation, hardened runtime, secure timestamp -- but its entitlements
are:

```
com.apple.security.cs.allow-dyld-environment-variables    true
com.apple.security.cs.allow-jit                           true
com.apple.security.cs.allow-unsigned-executable-memory    true
com.apple.security.cs.disable-executable-page-protection  true
com.apple.security.cs.disable-library-validation          true
com.apple.security.get-task-allow                         true   <-- rejected
```

So the official Node binary cannot be shipped as downloaded. It has to
be re-signed to drop `get-task-allow` while keeping `allow-jit`, or V8
cannot allocate JIT pages under the hardened runtime and the engine
never starts.

---

## File Structure

**Created:**
- `bin/sidecar-entitlements.plist` -- Node's entitlement set minus
  `get-task-allow`. Applied only to `build-sidecar/node`.

**Modified:**
- `bin/stage-sidecar.js` -- add `sidecarSignTargets` and `signSidecar`,
  and call the latter at the end of `stage()`.
- `test/unit/stage-sidecar.js` -- cover the new helpers.
- `test/unit/macos-signing.js` -- cover the entitlements file and the
  changed bundler config.
- `src-tauri/tauri.conf.json` -- `hardenedRuntime` back to `true`,
  `signingIdentity` sourced from the environment.
- `.github/workflows/package.yml` -- signing and notarization secrets;
  publish a release instead of a workflow artifact.
- `README.md`, `docs/README.md`, `specs/prd.json`.

**Deleted:**
- `bin/darwin-entitlements.plist` -- Electron-era. It grants
  `com.apple.security.cs.debugger`, which should not ship, and nothing
  references it since US-072 removed the Electron host.

---

## Task 1: The sidecar entitlements file

**Files:**
- Create: `bin/sidecar-entitlements.plist`
- Delete: `bin/darwin-entitlements.plist`
- Modify: `test/unit/macos-signing.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `bin/sidecar-entitlements.plist`, referenced by name from
  `signSidecar` in Task 2.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/macos-signing.js`:

```js
const ENTITLEMENTS_PATH = path.join(
  REPO, 'bin', 'sidecar-entitlements.plist'
)

// The staged Node runtime is re-signed with these. Two properties
// matter and neither is cosmetic: `get-task-allow` is rejected by the
// notarization service, so shipping it fails the submission outright;
// and without `allow-jit` V8 cannot allocate executable pages under the
// hardened runtime, so the engine dies at spawn in a signed release
// build and nowhere else.

test('the sidecar entitlements are notarizable', function (t) {
  const xml = fs.readFileSync(ENTITLEMENTS_PATH, 'utf8')

  t.notOk(
    xml.includes('get-task-allow'),
    'get-task-allow is absent -- notarization rejects it'
  )
  t.ok(
    xml.includes('com.apple.security.cs.allow-jit'),
    'allow-jit is present -- V8 needs it under the hardened runtime'
  )
  t.ok(
    xml.includes('com.apple.security.cs.disable-library-validation'),
    'library validation is off so the native addon can load'
  )
  t.end()
})

test('the Electron-era entitlements are gone', function (t) {
  // bin/darwin-entitlements.plist granted cs.debugger, which lets a
  // process attach to others. Nothing has referenced it since US-072
  // removed the Electron host, and it must not be picked up by
  // mistake now that entitlements are wired up again.
  t.notOk(
    fs.existsSync(path.join(REPO, 'bin', 'darwin-entitlements.plist')),
    'bin/darwin-entitlements.plist is deleted'
  )
  t.end()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tape test/unit/macos-signing.js`

Expected: FAIL. The first test throws `ENOENT` on the missing plist;
the second fails because `bin/darwin-entitlements.plist` still exists.

- [ ] **Step 3: Create the entitlements file**

Create `bin/sidecar-entitlements.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <!--
      Node's own entitlement set, minus com.apple.security.get-task-allow
      which the notarization service rejects. Read the official binary's
      with:

        codesign -d --entitlements - build-sidecar/node

      allow-jit and allow-unsigned-executable-memory are V8's.
      disable-library-validation lets node load the utp-native addon.
      Both are re-signed with the same team here, so that last one is a
      candidate for removal once the pipeline is green -- try it, and
      confirm the engine still spawns before keeping the change.
    -->
    <key>com.apple.security.cs.allow-dyld-environment-variables</key>
    <true/>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-executable-page-protection</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
  </dict>
</plist>
```

- [ ] **Step 4: Delete the Electron-era file**

```bash
git rm bin/darwin-entitlements.plist
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tape test/unit/macos-signing.js`

Expected: PASS.

- [ ] **Step 6: Run the full suite and commit**

Run: `npm test`

```bash
git add bin/sidecar-entitlements.plist test/unit/macos-signing.js
git commit -m "feat: add notarizable entitlements for the Node sidecar"
```

---

## Task 2: Sign the staged sidecar binaries

**Files:**
- Modify: `bin/stage-sidecar.js`, `test/unit/stage-sidecar.js`

**Interfaces:**
- Consumes: `bin/sidecar-entitlements.plist` from Task 1.
- Produces, added to `bin/stage-sidecar.js`'s exports:
  - `sidecarSignTargets(outPath) -> string[]` -- absolute paths, leaves
    first, `<outPath>/node` last.
  - `signSidecar(outPath, identity) -> string[]` -- the paths signed;
    `[]` when `identity` is falsy. Defaults `identity` to
    `process.env.APPLE_SIGNING_IDENTITY`.

Signing during staging, rather than after bundling, means the bundler
copies binaries that are already signed. Signatures live inside the
Mach-O, so the copy preserves them, and the app's outer signature then
seals the signed files. The reverse order would invalidate the seal.

- [ ] **Step 1: Write the failing test**

`test/unit/stage-sidecar.js` already destructures this module at the
top. Extend that existing require rather than adding a second one:

```js
const {
  OUT_DIR, PLATFORM, assertHost, sidecarSignTargets, signSidecar, stage
} = require('../../bin/stage-sidecar')
```

Then append to the end of the file:

```js
function fakeStagedTree () {
  const outPath = tempDir()
  const prebuild = path.join(
    outPath, 'node_modules', 'utp-native', 'prebuilds', 'darwin-arm64'
  )
  fs.mkdirSync(prebuild, { recursive: true })
  fs.writeFileSync(path.join(prebuild, 'node.napi.node'), '')
  fs.writeFileSync(path.join(outPath, 'node'), '')
  fs.writeFileSync(path.join(outPath, 'package.json'), '{}')
  return outPath
}

test('signing targets are ordered leaves first', function (t) {
  // A signature over a directory seals what is under it. Signing the
  // runtime before the addon it loads would invalidate the runtime's
  // own seal, and the failure shows up as a notarization rejection
  // rather than anything local.
  const outPath = fakeStagedTree()

  try {
    const targets = sidecarSignTargets(outPath)

    t.equal(targets.length, 2, 'both Mach-O are targets')
    t.ok(
      targets[0].endsWith('node.napi.node'),
      'the native addon is signed first'
    )
    t.equal(
      targets[1], path.join(outPath, 'node'),
      'the runtime that loads it is signed last'
    )
    t.notOk(
      targets.some(target => target.endsWith('package.json')),
      'non-Mach-O files are not signing targets'
    )
  } finally {
    fs.rmSync(outPath, { recursive: true, force: true })
  }
  t.end()
})

test('staging does not sign without an identity', function (t) {
  // An unsigned local build has to keep working. `npm start` and every
  // developer without a certificate go through this path.
  const outPath = fakeStagedTree()

  try {
    t.deepEqual(
      signSidecar(outPath, ''), [],
      'an empty identity signs nothing and does not throw'
    )
    t.deepEqual(
      signSidecar(outPath, undefined), [],
      'an absent identity signs nothing and does not throw'
    )
  } finally {
    fs.rmSync(outPath, { recursive: true, force: true })
  }
  t.end()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tape test/unit/stage-sidecar.js`

Expected: FAIL with `sidecarSignTargets is not a function`.

- [ ] **Step 3: Write the implementation**

In `bin/stage-sidecar.js`, add to the requires at the top:

```js
const { spawnSync } = require('child_process')
```

Extend the exports line:

```js
module.exports = {
  COPY, OUT_DIR, PLATFORM, assertHost, sidecarSignTargets, signSidecar,
  stage
}
```

Add the two functions at the end of the file:

```js
/**
 * The staged Mach-O, leaves before the runtime that loads them.
 *
 * `bundle.resources` puts this tree in `Contents/Resources`, and
 * `tauri-bundler` signs an explicit target list that never walks that
 * directory. So nothing else signs these, and notarization inspects
 * every Mach-O in the bundle wherever it sits.
 *
 * @param {string} outPath the staging root
 * @returns {string[]} absolute paths
 */
function sidecarSignTargets (outPath) {
  const addons = []

  walk(outPath)
  addons.sort()
  return [...addons, path.join(outPath, 'node')]

  function walk (dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.node')) addons.push(full)
    }
  }
}

/**
 * Re-signs the staged tree with a Developer ID.
 *
 * The runtime gets `bin/sidecar-entitlements.plist`: the official Node
 * binary ships `com.apple.security.get-task-allow`, which the
 * notarization service rejects, so it cannot go out as downloaded.
 * Dropping `allow-jit` along with it would leave V8 unable to allocate
 * executable pages under the hardened runtime, so the set is Node's
 * minus the one entitlement that fails.
 *
 * A no-op without an identity, because every local build and `npm
 * start` go through here without one.
 *
 * @param {string} outPath the staging root
 * @param {string} [identity] a codesign identity
 * @returns {string[]} the paths signed
 */
function signSidecar (
  outPath, identity = process.env.APPLE_SIGNING_IDENTITY
) {
  if (!identity) return []

  const entitlements = path.join(__dirname, 'sidecar-entitlements.plist')
  const nodePath = path.join(outPath, 'node')
  const signed = []

  for (const target of sidecarSignTargets(outPath)) {
    const args = ['--force', '--timestamp', '--options', 'runtime']
    if (target === nodePath) args.push('--entitlements', entitlements)
    args.push('--sign', identity, target)

    const result = spawnSync('codesign', args, { stdio: 'inherit' })
    if (result.status !== 0) {
      throw new Error(
        `codesign failed for ${target} -- exit ${result.status}`
      )
    }
    signed.push(target)
  }

  return signed
}
```

Then call it from `stage()`. The runtime has to be on disk first, so it
goes after `installRuntime`:

```js
  writeManifest(outPath)
  copyClosure(outPath)
  await installRuntime(outPath)
  signSidecar(outPath)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tape test/unit/stage-sidecar.js`

Expected: PASS.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test`

Expected: PASS. `depcheck` stays clean -- `child_process` is built in.

```bash
git add bin/stage-sidecar.js test/unit/stage-sidecar.js
git commit -m "feat: sign the staged sidecar binaries when an identity is set"
```

---

## Task 3: Point the bundler at a real identity

**Files:**
- Modify: `src-tauri/tauri.conf.json`, `test/unit/macos-signing.js`

**Interfaces:**
- Consumes: `bundle.macOS` from the ad-hoc plan's Task 1.
- Produces: a bundler configuration that signs with the hardened
  runtime.

**Needs the certificate.** Install the Developer ID Application
certificate in the login keychain and read the identity string:

```bash
security find-identity -v -p codesigning
```

It looks like `Developer ID Application: Some Name (TEAMID1234)`.

- [ ] **Step 1: Establish which source wins**

`tauri-bundler` resolves the identity from `bundle.macOS.signingIdentity`
and from `APPLE_SIGNING_IDENTITY`. Which takes precedence is not
established here, and it decides whether the config file can keep
`"-"` as a local default. Determine it empirically before editing:

```bash
APPLE_SIGNING_IDENTITY="Developer ID Application: Some Name (TEAMID1234)" \
  npx tauri build 2>&1 | grep 'Signing with identity'
```

Expected if the environment wins: the Developer ID string. If it logs
`"-"` instead, the config value wins and `signingIdentity` must be
removed from `tauri.conf.json` rather than left as a default.

Record the answer in a comment in the commit message. Steps 2 and 3
assume the environment wins; if it does not, delete the
`signingIdentity` key instead of changing its value, and change the
Step 2 test to assert the key is absent.

- [ ] **Step 2: Write the failing test**

Replace the two tests the ad-hoc plan added to
`test/unit/macos-signing.js` -- `the bundler is configured to sign the
app` and `the hardened runtime is off while the signature is ad-hoc` --
with:

```js
test('the bundler signs with the hardened runtime', function (t) {
  // US-083 AC-1. `--options runtime` is what Tauri adds when this is
  // true, and notarization refuses a bundle without it.
  const macos = readConf().bundle.macOS || {}

  t.notEqual(
    macos.hardenedRuntime, false,
    'bundle.macOS.hardenedRuntime is not disabled (it defaults true)'
  )
  t.end()
})

test('no signing identity is committed', function (t) {
  // US-083 AC-5. A Developer ID string in the repo is not a secret on
  // its own, but the config must not become the place credentials
  // accrete. The identity comes from APPLE_SIGNING_IDENTITY.
  const macos = readConf().bundle.macOS || {}

  t.notOk(
    macos.signingIdentity &&
      macos.signingIdentity.includes('Developer ID'),
    'bundle.macOS.signingIdentity does not name a certificate'
  )
  t.end()
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx tape test/unit/macos-signing.js`

Expected: FAIL on the hardened runtime assertion --
`bundle.macOS.hardenedRuntime` is still `false` from the ad-hoc plan.

- [ ] **Step 4: Update the configuration**

In `src-tauri/tauri.conf.json`, change the `macOS` object to:

```json
    "macOS": {
      "signingIdentity": "-",
      "hardenedRuntime": true
    },
```

`"-"` stays as the no-credentials default so an unsigned local build
still produces a launchable app, and `APPLE_SIGNING_IDENTITY` overrides
it for a real build. If Step 1 showed the config wins, remove the
`signingIdentity` line entirely instead.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tape test/unit/macos-signing.js`

Expected: PASS.

- [ ] **Step 6: Run the full suite and commit**

Run: `npm test`

```bash
git add src-tauri/tauri.conf.json test/unit/macos-signing.js
git commit -m "feat: sign the app with the hardened runtime"
```

---

## Task 4: Notarize and staple

**Files:** none. This task is credentials and verification.

**Interfaces:**
- Consumes: Tasks 1 through 3.
- Produces: a stapled bundle, and the credential names Task 5 needs as
  CI secrets.

Get notarization credentials. Prefer the App Store Connect API key over
an Apple ID, because it is not tied to one person's 2FA and survives
into CI unchanged:

- `APPLE_API_ISSUER` -- issuer ID from App Store Connect
- `APPLE_API_KEY` -- the key ID
- `APPLE_API_KEY_PATH` -- path to the downloaded `.p8`, never committed

The Apple ID alternative is `APPLE_ID`, `APPLE_PASSWORD` (an
app-specific password, not the account password) and `APPLE_TEAM_ID`.

- [ ] **Step 1: Build signed and notarized**

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Some Name (TEAMID1234)"
export APPLE_API_ISSUER=...
export APPLE_API_KEY=...
export APPLE_API_KEY_PATH=...

npm run build:tauri && npx tauri build
```

Expected: the bundler logs signing for the app, then a notarization
submission, then stapling. Notarization takes minutes.

If the submission is rejected, read the log rather than guessing:

```bash
xcrun notarytool log <submission-id> \
  --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" \
  --issuer "$APPLE_API_ISSUER"
```

The two rejections this bundle is set up to hit are `get-task-allow`
on `Contents/Resources/node` (Task 1 did not take effect) and an
unsigned or ad-hoc `node.napi.node` (Task 2 did not run, most likely
because `APPLE_SIGNING_IDENTITY` was not exported when
`beforeBundleCommand` ran).

- [ ] **Step 2: Verify every Mach-O is properly signed**

```bash
npm run verify:bundle
```

Expected: three Mach-O, all `signed`. None `adhoc` -- that is the
difference from the ad-hoc plan, and an `adhoc` line here means Task 2
skipped that file.

- [ ] **Step 3: Verify the bundle and its notarization**

```bash
codesign --verify --deep --strict --verbose=2 \
  src-tauri/target/release/bundle/macos/WebTorrent.app
spctl --assess --type execute -vv \
  src-tauri/target/release/bundle/macos/WebTorrent.app
xcrun stapler validate \
  src-tauri/target/release/bundle/macos/WebTorrent.app
```

Expected: `codesign` reports `valid on disk` and `satisfies its
Designated Requirement`. `spctl` reports `accepted` with `source=Notarized
Developer ID` -- this is US-083 AC-3, and it currently reports
`rejected (source=no usable signature)`. `stapler` reports
`The validate action worked!`.

- [ ] **Step 4: Confirm the engine still runs**

Open the built `.app`, add a torrent, confirm it downloads.

This is the step that catches a stripped `allow-jit`. The window opens
either way; the sidecar is what fails. If it does not download, check
the entitlements actually on the shipped runtime:

```bash
codesign -d --entitlements - \
  src-tauri/target/release/bundle/macos/WebTorrent.app/Contents/Resources/node
```

- [ ] **Step 5: Verify on a machine that has never run it (AC-4)**

Upload the `.dmg` somewhere and **download it** on a second arm64 Mac.
Do not copy it over the network by other means and do not use a locally
built copy: macOS treats downloaded files differently, and quarantine is
exactly what is being tested.

Expected: it opens with no Gatekeeper prompt and no `xattr`.

This is the only step that proves the plan worked. Everything before it
can pass on a bundle that still fails for a user.

---

## Task 5: Sign and notarize in CI

**Files:**
- Modify: `.github/workflows/package.yml`

**Interfaces:**
- Consumes: the credentials proven in Task 4.
- Produces: a tagged release build that is signed and notarized.

- [ ] **Step 1: Export the certificate**

From Keychain Access, export the Developer ID Application certificate
*and its private key* as a `.p12` with a password, then:

```bash
base64 -i certificate.p12 | pbcopy
```

Delete the `.p12` afterwards. It never touches the repository.

- [ ] **Step 2: Add repository secrets**

In Settings, Secrets and variables, Actions, add: `APPLE_CERTIFICATE`
(the base64 blob), `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY`, `APPLE_API_ISSUER`, `APPLE_API_KEY`, and
`APPLE_API_KEY_PATH` handling per Step 3.

When `APPLE_CERTIFICATE` and `APPLE_CERTIFICATE_PASSWORD` are both set,
`tauri-bundler` imports the certificate into a keychain itself, so the
workflow needs no `security` commands.

- [ ] **Step 3: Wire the build step**

In `.github/workflows/package.yml`, replace the `npx tauri build` step
with:

```yaml
    - run: |
        echo "$APPLE_API_KEY_CONTENT" > "$RUNNER_TEMP/asc.p8"
        echo "APPLE_API_KEY_PATH=$RUNNER_TEMP/asc.p8" >> "$GITHUB_ENV"
      env:
        APPLE_API_KEY_CONTENT: ${{ secrets.APPLE_API_KEY_CONTENT }}
    - run: npx tauri build
      env:
        APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
        APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
        APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
        APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
        APPLE_API_KEY: ${{ secrets.APPLE_API_KEY }}
```

`APPLE_SIGNING_IDENTITY` must also be set on the `npm run build:tauri`
step above it, because that is what runs `bin/stage-sidecar.js` and
therefore `signSidecar`:

```yaml
    - run: npm run build:tauri
      env:
        APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
```

Note that `beforeBundleCommand` in `tauri.conf.json` also runs
`bin/stage-sidecar.js` during `npx tauri build`, so the identity has to
be present on both steps.

- [ ] **Step 4: Replace the artifact with a release**

The job comment currently explains that the `.dmg` goes to a workflow
artifact rather than a release because an unsigned build would offer
the public a download macOS refuses. That reasoning expires here.
Replace the `actions/upload-artifact@v7` step with:

```yaml
    - uses: softprops/action-gh-release@v2
      if: startsWith(github.ref, 'refs/tags/')
      with:
        files: src-tauri/target/release/bundle/dmg/*.dmg
        fail_on_unmatched_files: true
```

and add to the job:

```yaml
    permissions:
      contents: write
```

Rewrite the job comment so it no longer says the artifacts are
unsigned.

- [ ] **Step 5: Verify with a prerelease tag**

```bash
git tag v0.24.1-rc.1 && git push --tags
```

Expected: the workflow signs, notarizes and publishes. Download the
`.dmg` from the release page on a clean Mac and confirm it opens.
Delete the tag and the release afterwards.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/package.yml
git commit -m "ci: sign and notarize the tagged macOS build"
```

---

## Task 6: Documentation and story state

**Files:**
- Modify: `README.md`, `docs/README.md`, `specs/prd.json`,
  `RELEASE_PROCESS.md`

**Interfaces:** consumes everything above.

- [ ] **Step 1: Rewrite the README limits paragraph**

The ad-hoc plan left it saying the signature is ad-hoc and a recipient
must clear quarantine. Both stop being true. It should now say the
build is arm64-only, that a build without `APPLE_SIGNING_IDENTITY` is
ad-hoc signed and needs the quarantine step, and that a credentialed
build is signed and notarized and needs nothing. Document the
environment variables Task 4 uses. This satisfies US-083 AC-6.

- [ ] **Step 2: Fix docs/README.md**

Replace the line saying signing, the hardened runtime, notarization and
stapling are US-083 with what actually shipped, including the
`get-task-allow` finding, since it is the non-obvious part someone will
otherwise rediscover.

- [ ] **Step 3: Update RELEASE_PROCESS.md**

It is stale beyond this plan -- it still instructs `npm run package --
darwin --sign` and covers Windows and Linux, both gone with US-072 and
ADR-017. Replace section 2 with the tag push that triggers
`package.yml`, and drop the non-macOS steps.

- [ ] **Step 4: Flip US-083**

In `specs/prd.json`, set US-083's `passes` to `true` and replace
`notes` with what was actually done, naming the `get-task-allow`
rejection and the inside-out signing order.

- [ ] **Step 5: Verify and commit**

Run: `node -e "JSON.parse(require('fs').readFileSync('specs/prd.json'))"`
then `npm test`.

```bash
git add README.md docs/README.md RELEASE_PROCESS.md specs/prd.json
git commit -m "docs: record the signing and notarization pipeline"
```

---

## Consider an ADR

ADR-016 already anticipated this ("another nested Mach-O for US-083 to
sign"). Two decisions here are load-bearing and not obvious from the
code: signing during staging rather than after bundling, and re-signing
the official Node binary rather than shipping it as downloaded. If the
`adr` skill's criteria are met, record them. Otherwise the comments in
`bin/stage-sidecar.js` carry it.

---

## Self-review notes

- **AC coverage:** AC-1 Task 3, AC-2 Task 4, AC-3 Task 4 Step 3, AC-4
  Task 4 Step 5, AC-5 Global Constraints plus Task 3 Step 2's test,
  AC-6 Task 6 Step 1, AC-7 every task's `npm test`.
- **Assumptions to falsify early:** that `APPLE_SIGNING_IDENTITY`
  overrides the config value (Task 3 Step 1 measures it rather than
  assuming); and that Node's Developer ID signature would otherwise
  have been acceptable, which is moot since it gets re-signed anyway.
- **Names used consistently:** `sidecarSignTargets` and `signSidecar`
  in `bin/stage-sidecar.js`; `signatureKind`, `bundleVerdict` and
  `machoPaths` in `bin/verify-bundle.js` from the ad-hoc plan;
  `bundle.macOS.signingIdentity` and `bundle.macOS.hardenedRuntime`.
- **Known gap:** nothing verifies the `.dmg` itself is signed and
  stapled, only the `.app`. Task 4 Step 5 covers it in practice by
  downloading the disk image.
