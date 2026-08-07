# Sidecar Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the packaged macOS app torrent, by staging a pinned Node
runtime and the engine's dependency closure into
`WebTorrent.app/Contents/Resources`.

**Architecture:** A new `bin/stage-sidecar.js` assembles
`build-sidecar/` -- a Node binary, a generated `package.json`, the
Babel output under `build/`, and the engine's resolved `node_modules`
tree. `src-tauri/tauri.conf.json` runs it as `beforeBundleCommand` and
maps it into the bundle through `bundle.resources`. No Rust changes:
`engine::Runtime::resolve` already specifies this layout and a Rust
test already asserts it.

**Tech Stack:** Node CommonJS scripts under `bin/`, `tape` unit tests
under `test/unit/`, Tauri 2 bundler, `standard` for lint.

**Design doc:**
`docs/superpowers/specs/2026-08-06-sidecar-packaging-design.md`

## Global Constraints

- Node runtime pinned to **24.19.0**, `darwin-arm64`, SHA-256
  `8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d`.
- **arm64 only.** No universal binary, no x86_64 staging.
- `bufferutil` and `utf-8-validate` are **excluded** from the closure.
  `utp-native` is **included**, pruned to its `darwin-arm64` prebuild.
- The staged `node_modules` **preserves the tree**. `debug` resolves to
  12 different directories at differing versions and `readable-stream`
  to 10; flattening by name would silently pick one for every consumer.
- No new npm dependencies. `npm test` runs `depcheck`, and extraction
  shells out to the `tar` macOS ships.
- Code style is `standard` (no semicolons, 2-space indent, space before
  the parameter list in a function declaration). `npm test` runs it.
- Docs and comments use `--` rather than an em dash and `->` rather
  than an arrow character.

---

## File Structure

**Created:**
- `bin/node-runtime.json` -- the version and SHA-256 pin. Data only.
- `bin/fetch-node.js` -- downloads, verifies and extracts the pinned
  Node binary. Pure helpers (`tarballName`, `tarballUrl`,
  `verifyTarball`) split from the impure `fetchNode`.
- `bin/sidecar-closure.js` -- resolves the engine's dependency closure
  to a list of package directories and their files. Reads the
  filesystem, writes nothing.
- `bin/stage-sidecar.js` -- orchestrates the two above into
  `build-sidecar/`. Exports `OUT_DIR` the way `bin/build-tauri.js`
  does, so tests can name it without duplicating the string.
- `test/unit/sidecar-closure.js`
- `test/unit/fetch-node.js`

**Modified:**
- `test/unit/tauri-host.js` -- the config wiring and the four-place
  registration. One **existing** assertion has to change; see Task 3.
- `src-tauri/tauri.conf.json` -- `beforeBundleCommand`, `resources`.
- `package.json` -- `engines`, depcheck `--ignore-dirs`, nodemon
  `--ignore`.
- `.gitignore`, `bin/clean.js` -- the staging output.

---

## Task 1: The dependency closure walker

**Files:**
- Create: `bin/sidecar-closure.js`
- Test: `test/unit/sidecar-closure.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `resolveClosure(repoRoot?: string) -> Entry[]` where `Entry` is
    `{ name: string, dir: string, relative: string, files: string[] }`.
    `dir` is absolute, `relative` is relative to `repoRoot`, and
    `files` are relative to `dir`.
  - `packageDir(name: string, fromDir: string) -> string | null`

`ROOTS`, `EXCLUDED` and `PREBUILD` stay module-private. Nothing outside
reads them, and `bin/build-tauri.js` sets the precedent of exporting
only what another file names.

- [ ] **Step 1: Write the failing test**

Create `test/unit/sidecar-closure.js`:

```js
const test = require('tape')
const path = require('path')

const {
  resolveClosure, packageDir
} = require('../../bin/sidecar-closure')

const REPO = path.join(__dirname, '..', '..')

test('the closure reaches the engine\'s own dependencies',
  function (t) {
    const names = new Set(resolveClosure().map(entry => entry.name))
    for (const name of [
      'webtorrent', 'ws', 'music-metadata', 'bittorrent-dht'
    ]) {
      t.ok(names.has(name), `${name} is staged`)
    }
    t.end()
  })

test('the ws performance addons are left out', function (t) {
  const names = new Set(resolveClosure().map(entry => entry.name))

  // Both only accelerate frame masking and UTF-8 validation, ws falls
  // back to JS without them, and each is a nested Mach-O that US-083
  // would have to sign.
  t.notOk(names.has('bufferutil'), 'bufferutil is not staged')
  t.notOk(names.has('utf-8-validate'), 'utf-8-validate is not staged')
  t.end()
})

test('utp-native ships exactly one prebuild', function (t) {
  const utp = resolveClosure().filter(e => e.name === 'utp-native')
  t.equal(utp.length, 1, 'utp-native is staged once')

  const platforms = utp[0].files
    .filter(file => file.startsWith(`prebuilds${path.sep}`))
    .map(file => file.split(path.sep)[1])

  t.deepEqual(
    [...new Set(platforms)], ['darwin-arm64'],
    'only the arm64 prebuild is staged'
  )
  t.end()
})

test('every copy of a duplicated package is kept', function (t) {
  // `debug` resolves to a dozen directories at differing versions.
  // Flattening by name would pick one for every consumer, and the
  // failure would only show up at runtime in a bundle.
  const debugs = resolveClosure().filter(e => e.name === 'debug')
  t.ok(debugs.length > 1, 'more than one debug is staged')

  const paths = new Set(debugs.map(entry => entry.relative))
  t.equal(paths.size, debugs.length, 'each is at its own path')
  t.end()
})

test('resolution walks up the way Node does', function (t) {
  const nested = packageDir(
    'debug', path.join(REPO, 'node_modules', 'music-metadata')
  )
  t.equal(
    nested,
    path.join(
      REPO, 'node_modules', 'music-metadata', 'node_modules', 'debug'
    ),
    'a nested copy wins over the hoisted one'
  )

  t.equal(
    packageDir('no-such-package-anywhere', REPO), null,
    'an unresolvable name answers null rather than throwing'
  )
  t.end()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tape test/unit/sidecar-closure.js`

Expected: FAIL with `Cannot find module '../../bin/sidecar-closure'`.

- [ ] **Step 3: Write the implementation**

Create `bin/sidecar-closure.js`:

```js
#!/usr/bin/env node

/**
 * The engine sidecar's dependency closure, as the list of package
 * directories a bundle has to carry (US-047).
 *
 * The closure is 190 package directories rather than the six bare
 * specifiers visible in `build/engine/`, and it is not cleanly
 * hoisted: `debug` resolves to twelve different directories at
 * differing versions and `readable-stream` to ten. So each package is
 * recorded by its path relative to the repository root and staged at
 * that same path, which makes resolution in the bundle identical to
 * resolution here. Flattening by name would silently pick one `debug`
 * for every consumer.
 *
 * This module reads the filesystem and writes nothing. The copying is
 * `bin/stage-sidecar.js`, so that what decides *which* files ship is
 * testable without producing a bundle.
 */

const fs = require('fs')
const path = require('path')

const ROOT_PATH = path.join(__dirname, '..')

// The bare specifiers the Babel output under `build/` requires.
const ROOTS = [
  'application-config',
  'arch',
  'music-metadata',
  'network-address',
  'webtorrent',
  'ws'
]

// Optional native addons that only accelerate ws's frame masking and
// UTF-8 validation. ws falls back to its JS implementations without
// them, and the engine's only WebSocket is a localhost control channel
// carrying small JSON envelopes -- so they buy nothing here, and each
// is a nested Mach-O that notarization would have to sign (US-083).
const EXCLUDED = new Set(['bufferutil', 'utf-8-validate'])

// `utp-native` ships a prebuild per platform. An arm64-only bundle
// needs exactly one; the other four are dead weight.
const PREBUILD = 'darwin-arm64'

module.exports = { packageDir, resolveClosure }

/**
 * Where `require(name)` from `fromDir` would find its package.
 *
 * Node's own algorithm: look in `<dir>/node_modules/<name>`, then walk
 * up a level and look again. Spelled out rather than delegated to
 * `require.resolve(`${name}/package.json`)`, which a package whose
 * `exports` map declines to expose its manifest defeats -- a real
 * hazard across 190 of them.
 *
 * @returns {string|null} null when nothing resolves.
 */
function packageDir (name, fromDir) {
  let dir = fromDir
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name)
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return candidate
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Every package directory the sidecar needs, and the files to take
 * from each.
 */
function resolveClosure (repoRoot = ROOT_PATH) {
  const found = new Map()
  const queue = ROOTS.map(name => ({ name, from: repoRoot }))

  while (queue.length > 0) {
    const { name, from } = queue.shift()
    if (EXCLUDED.has(name)) continue

    const dir = packageDir(name, from)
    if (dir === null) {
      throw new Error(
        `Cannot resolve ${name} from ` +
        `${path.relative(repoRoot, from) || '.'} -- run npm install`
      )
    }
    if (found.has(dir)) continue

    found.set(dir, {
      name,
      dir,
      relative: path.relative(repoRoot, dir),
      files: filesFor(name, dir)
    })

    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, 'package.json'), 'utf8')
    )
    const deps = Object.keys(manifest.dependencies || {})
      .concat(Object.keys(manifest.optionalDependencies || {}))
    for (const dep of deps) queue.push({ name: dep, from: dir })
  }

  return [...found.values()]
}

/** One package's files, relative to its own directory. */
function filesFor (name, dir) {
  const files = []

  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)

      if (entry.isDirectory()) {
        // A nested dependency is its own entry in the closure, at its
        // own path, so that the staged tree matches this one.
        if (entry.name === 'node_modules') continue
        walk(full)
        continue
      }

      const relative = path.relative(dir, full)
      if (name === 'utp-native' && !keepPrebuild(relative)) continue
      files.push(relative)
    }
  }

  walk(dir)

  if (name === 'utp-native') {
    const wanted = `prebuilds${path.sep}${PREBUILD}${path.sep}`
    if (!files.some(file => file.startsWith(wanted))) {
      throw new Error(
        `utp-native carries no ${PREBUILD} prebuild -- staging it ` +
        'would drop the sidecar to TCP-only peers with nothing but a ' +
        'console warning to say so'
      )
    }
  }

  return files
}

function keepPrebuild (relative) {
  const parts = relative.split(path.sep)
  if (parts[0] !== 'prebuilds') return true
  return parts[1] === PREBUILD
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tape test/unit/sidecar-closure.js`

Expected: PASS, 12 assertions.

- [ ] **Step 5: Check lint**

Run: `npx standard bin/sidecar-closure.js test/unit/sidecar-closure.js`

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add bin/sidecar-closure.js test/unit/sidecar-closure.js
git commit -m "feat(packaging): resolve the sidecar's dependency closure

US-047. 190 package directories, tree preserved rather than
flattened -- debug resolves to twelve of them at differing versions.
utp-native is pruned to its darwin-arm64 prebuild; bufferutil and
utf-8-validate are dropped."
```

---

## Task 2: The pinned Node runtime

**Files:**
- Create: `bin/node-runtime.json`
- Create: `bin/fetch-node.js`
- Test: `test/unit/fetch-node.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `tarballName(manifest, platform) -> string`
  - `tarballUrl(manifest, platform) -> string`
  - `verifyTarball(manifest, platform, bytes: Buffer) -> string`
    (returns the hex digest; throws on mismatch)
  - `fetchNode(platform, manifest?) -> Promise<string>` (path to the
    verified tarball in the cache)
  - `extractNodeBinary(tarball: string, destPath: string) -> void`
  - `MANIFEST: object` (the committed pin, read by its test)

`CACHE_PATH` stays module-private -- nothing outside names it.

- [ ] **Step 1: Write the failing test**

Create `test/unit/fetch-node.js`:

```js
const test = require('tape')
const crypto = require('crypto')

const {
  MANIFEST, tarballName, tarballUrl, verifyTarball
} = require('../../bin/fetch-node')

const PLATFORM = 'darwin-arm64'

function manifestFor (bytes) {
  return {
    version: '24.19.0',
    platforms: {
      [PLATFORM]: {
        sha256: crypto.createHash('sha256').update(bytes).digest('hex')
      }
    }
  }
}

test('the tarball name and URL follow the pinned version',
  function (t) {
    const manifest = { version: '24.19.0', platforms: {} }

    t.equal(
      tarballName(manifest, PLATFORM),
      'node-v24.19.0-darwin-arm64.tar.gz'
    )
    t.equal(
      tarballUrl(manifest, PLATFORM),
      'https://nodejs.org/dist/v24.19.0/' +
      'node-v24.19.0-darwin-arm64.tar.gz'
    )
    t.end()
  })

test('a tarball matching the pin verifies', function (t) {
  const bytes = Buffer.from('pretend this is a tarball')
  t.doesNotThrow(
    () => verifyTarball(manifestFor(bytes), PLATFORM, bytes)
  )
  t.end()
})

test('a tarball not matching the pin throws', function (t) {
  const bytes = Buffer.from('pretend this is a tarball')
  t.throws(
    () => verifyTarball(
      manifestFor(bytes), PLATFORM, Buffer.from('something else')
    ),
    /checksum mismatch/,
    'the mismatch is named rather than swallowed'
  )
  t.end()
})

test('an unpinned platform throws', function (t) {
  const manifest = { version: '24.19.0', platforms: {} }
  t.throws(
    () => verifyTarball(manifest, 'linux-x64', Buffer.from('x')),
    /pins no linux-x64/
  )
  t.end()
})

test('the committed manifest pins an exact build', function (t) {
  // A range or a missing digest would make the "pin" decorative: the
  // point is that changing the shipped runtime is a reviewable diff.
  t.match(
    MANIFEST.version, /^\d+\.\d+\.\d+$/,
    'the version is exact rather than a range'
  )
  t.match(
    MANIFEST.platforms[PLATFORM].sha256, /^[0-9a-f]{64}$/,
    'the arm64 build is pinned by sha256'
  )
  t.end()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tape test/unit/fetch-node.js`

Expected: FAIL with `Cannot find module '../../bin/fetch-node'`.

- [ ] **Step 3: Write the manifest**

Create `bin/node-runtime.json`. The digest is the published one for
`node-v24.19.0-darwin-arm64.tar.gz`, taken from
`https://nodejs.org/dist/v24.19.0/SHASUMS256.txt`:

```json
{
  "version": "24.19.0",
  "platforms": {
    "darwin-arm64": {
      "sha256": "8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d"
    }
  }
}
```

- [ ] **Step 4: Write the implementation**

Create `bin/fetch-node.js`:

```js
#!/usr/bin/env node

/**
 * The Node runtime the packaged sidecar runs on (US-047).
 *
 * Not the build machine's `node`: Homebrew's is dynamically linked
 * against some eighteen dylibs under `/opt/homebrew/opt/`, including
 * `@rpath/libnode.141.dylib`, so a bundle carrying it runs only where
 * an identical Homebrew install exists. The official tarballs are
 * self-contained.
 *
 * The version and its digest are pinned in `bin/node-runtime.json`.
 * The digest is committed rather than read from the `SHASUMS256.txt`
 * beside the download, because a checksum fetched from the host that
 * served the file proves the file arrived intact, not that it is the
 * file that was intended. Committing it makes changing the shipped
 * runtime a reviewable diff.
 */

const { execFileSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const MANIFEST = require('./node-runtime.json')

// Outside the repository, so `bin/clean.js` does not delete it and a
// rebuild does not re-download 50MB.
const CACHE_PATH = path.join(
  os.homedir(), '.cache', 'webtorrent-desktop', 'node'
)

module.exports = {
  MANIFEST,
  extractNodeBinary,
  fetchNode,
  tarballName,
  tarballUrl,
  verifyTarball
}

function tarballName (manifest, platform) {
  return `node-v${manifest.version}-${platform}.tar.gz`
}

function tarballUrl (manifest, platform) {
  return `https://nodejs.org/dist/v${manifest.version}/` +
    tarballName(manifest, platform)
}

/**
 * @returns {string} the hex digest, when it matches the pin.
 * @throws when the platform is unpinned or the bytes do not match.
 */
function verifyTarball (manifest, platform, bytes) {
  const pinned = (manifest.platforms[platform] || {}).sha256
  if (!pinned) {
    throw new Error(`bin/node-runtime.json pins no ${platform} build`)
  }

  const actual = crypto.createHash('sha256').update(bytes).digest('hex')
  if (actual !== pinned) {
    throw new Error(
      `${tarballName(manifest, platform)} checksum mismatch\n` +
      `  pinned ${pinned}\n` +
      `  actual ${actual}`
    )
  }
  return actual
}

/**
 * The verified tarball's path, downloading it if the cache is cold.
 */
async function fetchNode (platform, manifest = MANIFEST) {
  const cached = path.join(CACHE_PATH, tarballName(manifest, platform))

  if (fs.existsSync(cached)) {
    try {
      verifyTarball(manifest, platform, fs.readFileSync(cached))
      return cached
    } catch (err) {
      // A cached copy that no longer matches is either a corrupted
      // download or a bumped pin. Either way it must not be trusted,
      // and leaving it would fail the same way on every future run.
      fs.rmSync(cached)
      throw new Error(
        `${err.message}\n\nRemoved the cached copy -- run again.`
      )
    }
  }

  const url = tarballUrl(manifest, platform)
  console.log(`Fetching ${url}`)

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())

  // Verified before it is written, so a bad download is never
  // something a later run can pick up and trust.
  verifyTarball(manifest, platform, bytes)

  fs.mkdirSync(CACHE_PATH, { recursive: true })
  fs.writeFileSync(cached, bytes)
  return cached
}

/**
 * Extract just `bin/node` from the tarball to `destPath`.
 *
 * Shells out to the `tar` macOS ships rather than adding an npm
 * dependency that `depcheck` would then have to be told about.
 */
function extractNodeBinary (tarball, destPath) {
  const stem = path.basename(tarball, '.tar.gz')
  const destDir = path.dirname(destPath)
  fs.mkdirSync(destDir, { recursive: true })

  execFileSync('tar', [
    '-xzf', tarball,
    '-C', destDir,
    '--strip-components', '2',
    `${stem}/bin/node`
  ], { stdio: 'inherit' })

  // Stated rather than inherited. The executable bit is the whole
  // point of this file, and a spawn failure for the want of it reads
  // as "engine failed to spawn" with no hint why.
  fs.chmodSync(destPath, 0o755)
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tape test/unit/fetch-node.js`

Expected: PASS, 7 assertions. No network is touched -- every test
exercises the pure helpers.

- [ ] **Step 6: Verify the download path by hand, once**

Run:

```bash
node -e "
const { fetchNode, extractNodeBinary } = require('./bin/fetch-node')
fetchNode('darwin-arm64').then(tarball => {
  extractNodeBinary(tarball, '/tmp/probe-node/node')
  console.log(require('child_process')
    .execFileSync('/tmp/probe-node/node', ['--version']).toString())
})
"
```

Expected: `v24.19.0`. Then confirm it is self-contained, which is the
premise the whole approach rests on:

```bash
otool -L /tmp/probe-node/node | grep -c homebrew
```

Expected: `0`. If it is not 0, stop -- the official tarball is not
self-contained after all and the design's first decision needs
revisiting.

Then clean up: `rm -rf /tmp/probe-node`

- [ ] **Step 7: Check lint**

Run: `npx standard bin/fetch-node.js test/unit/fetch-node.js`

Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add bin/node-runtime.json bin/fetch-node.js test/unit/fetch-node.js
git commit -m "feat(packaging): fetch and verify the pinned Node runtime

US-047. Node 24.19.0 darwin-arm64, digest committed rather than read
from the SHASUMS beside the download. The build machine's node is not
an option: Homebrew's links against eighteen dylibs under
/opt/homebrew/opt/."
```

---

## Task 3: Assemble the staging root

**Files:**
- Create: `bin/stage-sidecar.js`
- Modify: `.gitignore`
- Modify: `bin/clean.js:18`
- Modify: `package.json` (`engines`, `scripts.test`, `scripts.watch`)
- Test: `test/unit/tauri-host.js` (one **existing** assertion changes)

**Interfaces:**
- Consumes: `resolveClosure` from Task 1; `fetchNode` and
  `extractNodeBinary` from Task 2.
- Produces: `OUT_DIR: 'build-sidecar'`, `COPY: string[]`,
  `PLATFORM: 'darwin-arm64'`. `stage()` stays module-private; the CLI
  path at the bottom of the file is its only caller.

- [ ] **Step 1: Write the failing tests**

Add to the end of `test/unit/tauri-host.js`:

```js
// US-047: the packaged app needs the sidecar and a runtime to spawn
// it with inside the bundle. Without them the app launches and the
// supervisor loops on `failed to spawn`, which is a window that opens
// and never torrents rather than a build error.

test('the sidecar staging root holds what the host resolves',
  function (t) {
    const { COPY, OUT_DIR, PLATFORM } = require('../../bin/stage-sidecar')

    t.equal(OUT_DIR, 'build-sidecar', 'the staging root is named')
    t.equal(PLATFORM, 'darwin-arm64', 'arm64 only')

    // `engine.rs` joins `build/engine/index.js` onto the resource
    // directory, and `build/config.js` is what the entry point
    // imports for APP_VERSION.
    t.deepEqual(
      COPY,
      [
        path.join('build', 'config.js'),
        path.join('build', 'engine'),
        path.join('build', 'shared')
      ],
      'the Babel output the sidecar loads is staged'
    )
    t.end()
  })

test('the sidecar staging output is not committed or scanned',
  function (t) {
    const { OUT_DIR } = require('../../bin/stage-sidecar')
    const gitignore = fs.readFileSync(
      path.join(REPO, '.gitignore'), 'utf8'
    ).split('\n').map(line => line.trim())

    t.ok(gitignore.includes(`${OUT_DIR}/`), `${OUT_DIR} is ignored`)
    t.ok(ignoredDirs().includes(OUT_DIR), 'depcheck skips it')
    t.ok(
      pkg.scripts.watch.includes(`--ignore ${OUT_DIR}/`),
      'nodemon skips it'
    )

    const clean = fs.readFileSync(
      path.join(REPO, 'bin', 'clean.js'), 'utf8'
    )
    t.ok(clean.includes(`'${OUT_DIR}/'`), 'bin/clean.js removes it')
    t.end()
  })
```

Add this helper just below `readConf` near the top of the same file:

```js
function ignoredDirs () {
  return pkg.scripts.test.match(/--ignore-dirs=(\S+)/)[1].split(',')
}
```

- [ ] **Step 2: Change the one existing assertion that this breaks**

`test/unit/tauri-host.js` currently asserts depcheck's ignore list as
one exact string:

```js
  t.ok(
    pkg.scripts.test.includes(`--ignore-dirs=build,build-vite,${OUT_DIR},dist`),
    'depcheck skips the document root'
  )
```

Adding `build-sidecar` to that list makes the substring stop existing,
so this passes today and fails in Step 4 for the wrong reason. Replace
those four lines with:

```js
  t.ok(ignoredDirs().includes(OUT_DIR), 'depcheck skips the document root')
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx tape test/unit/tauri-host.js`

Expected: FAIL with `Cannot find module '../../bin/stage-sidecar'`.

- [ ] **Step 4: Write the staging script**

Create `bin/stage-sidecar.js`:

```js
#!/usr/bin/env node

/**
 * Assembles the directory that becomes the bundle's
 * `Contents/Resources` (US-047).
 *
 * `engine::Runtime::resolve` branches on `!cfg!(debug_assertions)`: a
 * release build looks for `<resource_dir>/node` and
 * `<resource_dir>/build/engine/index.js` and runs the child with
 * `<resource_dir>` as its working directory. That layout is already
 * stated in Rust and asserted by a Rust test, so this script does not
 * choose it -- it satisfies it.
 *
 * A `cargo build` without the bundler is a debug build, so the
 * development path is untouched: `node` off the `PATH`, the
 * repository's own `build/`.
 */

const fs = require('fs')
const path = require('path')

const { fetchNode, extractNodeBinary } = require('./fetch-node')
const { resolveClosure } = require('./sidecar-closure')

const ROOT_PATH = path.join(__dirname, '..')

// The directory name is duplicated in four other places -- .gitignore,
// nodemon's --ignore list, depcheck's --ignore-dirs and bin/clean.js --
// because none of those can require this module. `tauri-host.js` holds
// them together.
const OUT_DIR = 'build-sidecar'

// Repo-relative paths from the Babel output, copied in the same layout
// they have here. `build/config.js` because the entry point imports it
// for APP_VERSION; `build/shared` for the wire envelope.
const COPY = [
  path.join('build', 'config.js'),
  path.join('build', 'engine'),
  path.join('build', 'shared')
]

const PLATFORM = 'darwin-arm64'

// Only what another file names, as `bin/build-tauri.js` does.
module.exports = { COPY, OUT_DIR, PLATFORM }

if (require.main === module) {
  stage().catch(err => {
    console.error(err.message)
    process.exit(1)
  })
}

async function stage () {
  const outPath = path.join(ROOT_PATH, OUT_DIR)
  fs.rmSync(outPath, { recursive: true, force: true })

  for (const entry of COPY) {
    const fromPath = path.join(ROOT_PATH, entry)
    if (!fs.existsSync(fromPath)) {
      throw new Error(
        `${entry} does not exist -- run 'npm run build' first`
      )
    }
    fs.cpSync(fromPath, path.join(outPath, entry), { recursive: true })
  }

  writeManifest(outPath)
  copyClosure(outPath)

  const tarball = await fetchNode(PLATFORM)
  extractNodeBinary(tarball, path.join(outPath, 'node'))

  console.log(`Assembled ${OUT_DIR}/ for ${PLATFORM}`)
}

/**
 * `build/config.js` requires `../package.json` and reads `version`
 * from it as APP_VERSION, which the engine folds into its peer ID.
 * Staged without one the sidecar dies on load with
 * `Cannot find module '../package.json'`.
 *
 * Generated rather than copied: the repository's dependency and script
 * maps describe a tree the packaged app does not have.
 */
function writeManifest (outPath) {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT_PATH, 'package.json'), 'utf8')
  )
  fs.writeFileSync(
    path.join(outPath, 'package.json'),
    JSON.stringify(
      { name: pkg.name, version: pkg.version, private: true }, null, 2
    ) + '\n'
  )
}

/** Each package at the same relative path it has in this repository. */
function copyClosure (outPath) {
  for (const entry of resolveClosure(ROOT_PATH)) {
    for (const file of entry.files) {
      const to = path.join(outPath, entry.relative, file)
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.copyFileSync(path.join(entry.dir, file), to)
    }
  }
}
```

- [ ] **Step 5: Register the staging root in the four places**

`.gitignore` -- add after the `build-tauri/` line:

```
build-sidecar/
```

`bin/clean.js` -- add after line 18 (`rimraf.sync('build-tauri/')`):

```js
rimraf.sync('build-sidecar/')
```

`package.json`, `scripts.test` -- change the depcheck ignore list from
`--ignore-dirs=build,build-vite,build-tauri,dist` to:

```
--ignore-dirs=build,build-vite,build-tauri,build-sidecar,dist
```

`package.json`, `scripts.watch` -- add one flag after
`--ignore build-tauri/`:

```
--ignore build-sidecar/
```

- [ ] **Step 6: Update the declared Node range**

`package.json`, `engines.node` -- replace
`"^16.0.0 || ^18.0.0"` with `">=24.0.0"`.

Open-ended rather than `^24.0.0` on purpose: `engines` constrains the
machine that runs the build and the test suite, not just the sidecar,
and that machine is on a newer line. A caret range would make
`npm install` complain locally.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx tape test/unit/tauri-host.js`

Expected: PASS. Both new tests and the rewritten depcheck assertion.

- [ ] **Step 8: Run the staging script end to end**

Run: `npm run build && node bin/stage-sidecar.js`

Expected: `Assembled build-sidecar/ for darwin-arm64`.

Then check the shape:

```bash
ls build-sidecar/
du -sh build-sidecar/
./build-sidecar/node --version
ls build-sidecar/node_modules/utp-native/prebuilds/
```

Expected: `build`, `node`, `node_modules`, `package.json`;
`v24.19.0`; and `darwin-arm64` as the only prebuild. The total is
dominated by the Node binary rather than by the 9.3MB closure -- note
what `du` reports, because it is the floor on the shipped `.app` and
Task 4 Step 6 should show the same figure inside the bundle.

- [ ] **Step 9: Run the staged sidecar directly**

This is the real check -- it proves the staged tree resolves before
any bundling is involved.

```bash
cd build-sidecar && WEBTORRENT_ENGINE_TOKEN=probe \
  ./node build/engine/index.js
```

Expected: `Initializing...` then a `WEBTORRENT_ENGINE_PORT=<port>`
line. Ctrl-C to stop, then `cd ..`.

If it fails with `Cannot find module`, the named module is missing
from `ROOTS` in `bin/sidecar-closure.js` -- add it there rather than
special-casing it here.

- [ ] **Step 10: Run the full suite**

Run: `npm test`

Expected: PASS. `standard`, then `depcheck` (which must not now scan
`build-sidecar/`), then the unit tests.

- [ ] **Step 11: Commit**

```bash
git add bin/stage-sidecar.js test/unit/tauri-host.js .gitignore \
  bin/clean.js package.json
git commit -m "feat(packaging): assemble the sidecar staging root

US-047. build-sidecar/ carries the pinned node, the Babel output, a
generated package.json for APP_VERSION, and the closure at its own
relative paths. engines.node moves to >=24.0.0 to stop declaring two
ranges that nothing satisfies."
```

---

## Task 4: Wire the bundler and verify a real bundle

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Test: `test/unit/tauri-host.js`

**Interfaces:**
- Consumes: `OUT_DIR` from Task 3.
- Produces: nothing later tasks depend on.

This is the task that answers the two questions the design left open,
so it ends with an actual bundle rather than a green test.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/tauri-host.js`:

```js
test('the bundler stages the sidecar into the app', function (t) {
  const conf = readConf()
  const { OUT_DIR } = require('../../bin/stage-sidecar')

  // The staging root is generated, so the bundler has to build it
  // rather than assume it: a stale or absent build-sidecar/ is an app
  // that opens and cannot torrent.
  t.ok(
    (conf.build.beforeBundleCommand || '').includes('stage-sidecar'),
    'the staging script runs before bundling'
  )

  const resources = conf.bundle.resources
  t.ok(resources, 'bundle.resources is declared')
  t.ok(
    JSON.stringify(resources).includes(OUT_DIR),
    `${OUT_DIR} is mapped into the bundle`
  )
  t.end()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tape test/unit/tauri-host.js`

Expected: FAIL -- `bundle.resources is declared` is falsy, because
`tauri.conf.json` has no such key today.

- [ ] **Step 3: Wire the config**

`src-tauri/tauri.conf.json`. Change the `build` block from:

```json
  "build": {
    "frontendDist": "../build-tauri"
  },
```

to:

```json
  "build": {
    "frontendDist": "../build-tauri",
    "beforeBundleCommand": "node bin/stage-sidecar.js"
  },
```

And add `resources` to the `bundle` block, so it reads:

```json
  "bundle": {
    "active": true,
    "targets": "all",
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

Run: `npx tape test/unit/tauri-host.js`

Expected: PASS.

- [ ] **Step 5: Build a real bundle**

Run: `npm run build:tauri && npx tauri build`

Expected: `Finished 2 bundles at:` naming a `.app` and a `.dmg`. Budget
15 minutes if the Rust cache is cold, about 2 minutes if warm.

If it fails with the staging script not found, `beforeBundleCommand`
ran from a different working directory than assumed -- change the
command to `node ../bin/stage-sidecar.js` and re-run. The script
itself resolves every path from `__dirname`, so only locating the
script is at issue.

- [ ] **Step 6: Answer the first open question -- the layout**

```bash
ls src-tauri/target/release/bundle/macos/WebTorrent.app/Contents/Resources/
```

Expected: `WebTorrent.icns`, `build`, `node`, `node_modules`,
`package.json`.

If instead there is a single `build-sidecar/` directory, the map form
nests rather than flattens. Change `bundle.resources` to the list form
`["../build-sidecar/*"]` and rebuild from Step 5.

- [ ] **Step 7: Answer the second open question -- the executable bit**

```bash
R=src-tauri/target/release/bundle/macos/WebTorrent.app/Contents/Resources
ls -l $R/node
$R/node --version
```

Expected: a mode including `x`, and `v24.19.0`.

If the bit was dropped, `extractNodeBinary` already sets it in the
staging root, so the loss is Tauri's copy and the fix belongs in the
host. `src-tauri/src/main.rs` around line 1692 currently builds the
runtime inline as an argument:

```rust
            let engine = Engine::new(
                engine::Runtime::resolve(
                    manifest.parent().unwrap_or(manifest),
                    app.path().resource_dir().ok().as_deref(),
                    !cfg!(debug_assertions),
                ),
                engine::Policy::default(),
            );
            engine.start();
```

Bind it first so there is something to chmod, then restore the bit
before the supervisor tries to spawn it:

```rust
            let runtime = engine::Runtime::resolve(
                manifest.parent().unwrap_or(manifest),
                app.path().resource_dir().ok().as_deref(),
                !cfg!(debug_assertions),
            );

            // Tauri's resource copy does not carry the executable bit,
            // and a runtime without it fails to spawn with the same
            // `os error 2` as a runtime that is not there at all.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = std::fs::metadata(&runtime.program) {
                    let mut perms = meta.permissions();
                    perms.set_mode(perms.mode() | 0o111);
                    let _ = std::fs::set_permissions(&runtime.program, perms);
                }
            }

            let engine = Engine::new(runtime, engine::Policy::default());
            engine.start();
```

- [ ] **Step 8: Confirm the packaged app starts its engine**

```bash
src-tauri/target/release/bundle/macos/WebTorrent.app/Contents/MacOS/webtorrent-desktop \
  > /tmp/packaged.log 2>&1 &
sleep 12
pkill -f "MacOS/webtorrent-desktop"
cat /tmp/packaged.log
```

Expected: **no** `Engine: failed to spawn` lines. This is the exact
symptom the whole plan exists to remove -- before this task the log
read `failed to spawn: No such file or directory (os error 2)` five
times with backoff.

- [ ] **Step 9: Run the full suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src-tauri/tauri.conf.json test/unit/tauri-host.js
git commit -m "feat(packaging): stage the sidecar into the app bundle

US-047. beforeBundleCommand builds build-sidecar/ and bundle.resources
maps it into Contents/Resources. The packaged app no longer loops on
'Engine: failed to spawn'."
```

If Step 7 needed the Rust change, add `src-tauri/src/main.rs` to that
commit.

---

## Task 5: Hold the two version numbers together

**Files:**
- Test: `test/unit/tauri-host.js`
- Modify: `src-tauri/Cargo.toml:4-6` (comment only)

`src-tauri/Cargo.toml` says its `version` is kept in sync with
`package.json` by hand, that nothing reads both, and that "the
packaging stories are where this stops being cosmetic". Packaging now
stamps a version into a distributable artifact and into the sidecar's
peer ID, so this closes that note.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/tauri-host.js`:

```js
test('the crate version matches the app version', function (t) {
  // Until US-047 nothing read both, so a drift was cosmetic. Now the
  // crate version names the .app and the .dmg while package.json's
  // reaches the sidecar's peer ID through APP_VERSION, so a drift
  // ships two different version numbers in one artifact.
  const cargo = fs.readFileSync(
    path.join(TAURI_DIR, 'Cargo.toml'), 'utf8'
  )
  const crate = cargo.match(/^version = "([^"]+)"/m)

  t.ok(crate, 'Cargo.toml declares a version')
  t.equal(crate[1], pkg.version, 'the two agree')
  t.end()
})
```

- [ ] **Step 2: Run the test to verify it passes for the right reason**

Run: `npx tape test/unit/tauri-host.js`

Expected: PASS -- both are `0.24.0` today. This test guards rather than
fixes, so confirm it can fail: temporarily change `version` in
`src-tauri/Cargo.toml` to `0.24.1`, re-run, see it fail with
`0.24.1 !== 0.24.0`, then change it back and re-run to green.

Do not skip this. A guard that cannot fail is worse than no guard,
because it reads as coverage.

- [ ] **Step 3: Update the Cargo.toml comment**

Replace lines 4-6 of `src-tauri/Cargo.toml`:

```toml
# Kept in sync with `version` in package.json by hand. Nothing reads
# both, so nothing catches a drift; the packaging stories (US-083,
# US-084) are where this stops being cosmetic.
```

with:

```toml
# Kept in sync with `version` in package.json by hand. US-047 gave the
# drift teeth -- this names the .app and the .dmg while package.json's
# reaches the sidecar's peer ID -- so `test/unit/tauri-host.js` now
# checks that the two agree.
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/unit/tauri-host.js src-tauri/Cargo.toml
git commit -m "test(packaging): hold the crate and app versions together

US-047. The drift stopped being cosmetic once one of them names a
distributable artifact and the other reaches the peer ID."
```

---

## After the plan

**The manual verification is not optional.** US-047's acceptance
criteria are behavioural and the story is marked `manual: true`.
Nothing above proves the packaged app torrents -- Task 4 Step 8 proves
only that the sidecar spawns. Someone has to open the packaged app and
watch a real torrent download, play and seed, then quit and confirm
with `pgrep -f build/engine` that no sidecar is left running.

That pass carries real weight rather than being ceremony: the engine's
dependency tree is 2022-era, Node 24 is well ahead of what it was
written against, and no automated end-to-end torrent test exists.

**Two things this plan deliberately does not do.** Signing, the
hardened runtime, notarization and stapling are US-083, and this work
makes that story larger in a specific way: the bundle now carries a
nested Mach-O (`Resources/node`) and a nested `.node` addon
(`utp-native`'s prebuild), and macOS notarization requires every
Mach-O in a bundle to be signed. US-083 has to sign those explicitly
rather than rely on the app signature.

And `README.md`'s "Package the app" section still says packaging is
not wired up, and cites a US-084 that does not exist in
`specs/prd.json`. Correcting it is a docs change worth making, but it
belongs with US-083 when the instructions can describe a distributable
build rather than a local one.
