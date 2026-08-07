const test = require('tape')
const fs = require('fs')
const path = require('path')

// US-051: the Tauri host scaffold. Nothing here can launch a window, so
// what these tests hold is the wiring that a launch depends on: the
// document root the Tauri window is pointed at has to be the assembled
// `static/main.html` plus the Vite output.
//
// Until US-072 it also held ADR-014's other half -- that the Electron
// host stayed launchable beside this one. The cutover removed the
// second host, so those assertions became the opposite ones: one start
// script, one build, no flag to select between them. The rest of this
// file is unchanged, because the wiring a launch depends on did not
// move.

const REPO = path.join(__dirname, '..', '..')
const TAURI_DIR = path.join(REPO, 'src-tauri')
const CONF_PATH = path.join(TAURI_DIR, 'tauri.conf.json')

const pkg = JSON.parse(
  fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')
)

function readConf () {
  return JSON.parse(fs.readFileSync(CONF_PATH, 'utf8'))
}

function ignoredDirs () {
  return pkg.scripts.test.match(/--ignore-dirs=(\S+)/)[1].split(',')
}

test('src-tauri holds a Cargo crate with a main.rs', function (t) {
  for (const file of ['Cargo.toml', 'build.rs', 'src/main.rs']) {
    t.ok(
      fs.existsSync(path.join(TAURI_DIR, file)),
      `src-tauri/${file} exists`
    )
  }
  t.end()
})

test('tauri.conf.json opens exactly one window', function (t) {
  const conf = readConf()
  t.ok(conf.identifier, 'the bundle identifier is set')
  t.ok(Array.isArray(conf.app.windows), 'app.windows is a list')
  t.equal(conf.app.windows.length, 1, 'there is one window')
  t.end()
})

test('the Tauri window loads static/main.html and the Vite output',
  function (t) {
    const conf = readConf()
    const { COPY, OUT_DIR } = require('../../bin/build-tauri')

    // The document root is assembled rather than source-controlled, so
    // the config has to point at the assembly script's output.
    t.equal(
      path.resolve(TAURI_DIR, conf.build.frontendDist),
      path.join(REPO, OUT_DIR),
      'frontendDist is the assembled document root'
    )

    // `static/main.html` reaches the bundle through a relative
    // `<script src>`, so the window URL has to sit at the same depth
    // inside the document root as the file does inside the repo, or
    // that src escapes the root.
    const url = conf.app.windows[0].url
    t.equal(url, 'static/main.html', 'the window URL is static/main.html')

    const html = fs.readFileSync(
      path.join(REPO, 'static', 'main.html'), 'utf8'
    )
    const src = html.match(/<script src="([^"]+)"/)[1]
    const resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(url), src)
    )
    t.notOk(
      resolved.startsWith('..'),
      `the bundle at ${resolved} is inside the document root`
    )
    t.ok(
      COPY.includes(resolved.split('/')[0]),
      `the document root includes ${resolved.split('/')[0]}`
    )
    t.end()
  })

// US-056: where the window opens is a runtime decision -- the saved
// rectangle, the maximized flag and the `--hidden` launch are all read
// in `src-tauri/src/window.rs`. A window declared visible would come
// up at the default size before any of that was applied, and would
// ignore `--hidden` outright, so the declaration has to stay hidden
// and the host has to be the thing that shows it.
test('the Tauri window is opened by the host, not by the config',
  function (t) {
    const main = readConf().app.windows[0]
    t.equal(main.visible, false, 'the declared window starts hidden')

    const host = fs.readFileSync(
      path.join(TAURI_DIR, 'src', 'main.rs'), 'utf8'
    )
    t.ok(/\.show\(\)/.test(host), 'the host shows the window itself')
    t.ok(/is_hidden/.test(host), 'and honours a --hidden launch')
    t.ok(
      /single_instance/.test(host),
      'a second launch signals the first rather than opening a window'
    )
    t.end()
  })

// The renderer subscribes to `windowBoundsChanged` through
// `@tauri-apps/api`, which needs the core event permission. Tauri
// grants nothing without a capability file, so a missing one is a
// window that silently stops saving where it is.
test('the renderer is allowed to listen for host events', function (t) {
  const capability = JSON.parse(fs.readFileSync(
    path.join(TAURI_DIR, 'capabilities', 'default.json'), 'utf8'
  ))
  t.ok(capability.permissions.includes('core:default'),
    'the core permission set, which includes the event API')
  t.ok(capability.windows.includes(readConf().app.windows[0].label),
    'granted to the main window')
  t.end()
})

// US-072: there is one host now. `npm start` launches it, and it does
// so through `build:tauri` rather than through `tauri dev` alone --
// the Tauri document root is assembled by `bin/build-tauri.js` out of
// the Vite output and `static/`, so a launch that skips the assembly
// step opens a window on a stale or missing document root.
test('npm start launches the one host', function (t) {
  const start = pkg.scripts.start
  t.ok(
    start.includes('build:tauri'),
    `start assembles the document root first: ${start}`
  )
  t.ok(/tauri dev/.test(start), 'start runs the Tauri host')
  t.notOk(
    pkg.scripts['start:tauri'],
    'there is no second start script, because there is no second host'
  )
  t.ok(
    pkg.scripts['build:tauri'].includes('npm run build'),
    'build:tauri builds the renderer bundle'
  )
  t.end()
})

test('the Tauri build output is not committed or scanned', function (t) {
  const { OUT_DIR } = require('../../bin/build-tauri')
  const gitignore = fs.readFileSync(
    path.join(REPO, '.gitignore'), 'utf8'
  ).split('\n').map(line => line.trim())

  t.ok(gitignore.includes('src-tauri/target/'), 'the Cargo target is ignored')
  t.ok(gitignore.includes(`${OUT_DIR}/`), `${OUT_DIR} is ignored`)

  // A generated directory needs registering everywhere a generated
  // directory is already named, or depcheck scans it and nodemon
  // restarts on it forever.
  t.ok(ignoredDirs().includes(OUT_DIR), 'depcheck skips the document root')
  t.ok(
    pkg.scripts.watch.includes(`--ignore ${OUT_DIR}/`),
    'nodemon skips the document root'
  )
  const clean = fs.readFileSync(path.join(REPO, 'bin', 'clean.js'), 'utf8')
  t.ok(clean.includes(`'${OUT_DIR}/'`), 'bin/clean.js removes it')
  t.end()
})

// US-070: the Tauri host supervises the engine sidecar itself, so a
// Tauri launch needs the sidecar on disk the way an Electron one does.
// It is the Babel output of `src/engine/`, which only `build:node`
// produces (`build:main` until US-072 renamed it) -- and nothing else
// in the Tauri build has ever needed it, so it is easy to leave out
// and the symptom is a window with no torrenting rather than a build
// error.

test('the Tauri build produces the engine sidecar it spawns', function (t) {
  t.ok(
    pkg.scripts.build.includes('build:node'),
    'the build the host launches through compiles the sidecar entry point'
  )

  const entry = path.join('build', 'engine', 'index.js')
  const supervisor = fs.readFileSync(
    path.join(TAURI_DIR, 'src', 'engine.rs'), 'utf8'
  )

  // The Rust side joins the three components rather than carrying the
  // path as a string, so this is what it spells rather than where it
  // says it.
  t.ok(
    supervisor.includes('join("build").join("engine").join("index.js")'),
    `the host spawns ${entry}`
  )
  t.ok(
    fs.existsSync(path.join(REPO, entry)),
    `${entry} is where build:main puts it`
  )
  t.end()
})

test('the host and the sidecar agree on the port line', function (t) {
  const supervisor = fs.readFileSync(
    path.join(TAURI_DIR, 'src', 'engine.rs'), 'utf8'
  )
  const sidecar = fs.readFileSync(
    path.join(REPO, 'src', 'engine', 'index.js'), 'utf8'
  )

  // One line of stdout is the whole of the handshake, so a rename on
  // either side is a host that waits forever for a port.
  const prefix = 'WEBTORRENT_ENGINE_PORT='
  t.ok(sidecar.includes(`'${prefix}'`), 'the sidecar prints it')
  t.ok(supervisor.includes(`"${prefix}"`), 'the host parses it')

  // Same for the pipe that stops an orphan: the child only watches it
  // when the host asks it to.
  const pipe = 'WEBTORRENT_ENGINE_PARENT_PIPE'
  t.ok(sidecar.includes(pipe), 'the sidecar watches the parent pipe')
  t.ok(supervisor.includes(`"${pipe}"`), 'the host sets it')
  t.end()
})

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

  // The map's direction is load-bearing and not symmetric: the key is
  // the source on disk and the value is the destination inside
  // `Contents/Resources`. Swapped, it would declare a resource named
  // `./` -- so pin the pair rather than asserting the string appears
  // somewhere in it.
  const resources = conf.bundle.resources
  t.ok(resources, 'bundle.resources is declared')
  t.deepEqual(
    Object.keys(resources), [`../${OUT_DIR}/`],
    `the source is ${OUT_DIR}, relative to src-tauri`
  )
  t.equal(
    resources[`../${OUT_DIR}/`], './',
    'staged at the root of Contents/Resources, where engine.rs looks'
  )

  // Not a glob: tauri-utils flattens glob matches onto the
  // destination with `dest.join(file_name)`, which would put every
  // staged file in one directory and drop every subdirectory. A plain
  // directory path is walked and keeps its structure.
  t.notOk(
    Object.keys(resources).some(key => key.includes('*')),
    'the staged tree keeps its structure rather than being globbed'
  )
  t.end()
})

// C1: `bundle.resources` is read by tauri-build's *build script*, so
// the path has to exist during `cargo build` -- which happens before
// `beforeBundleCommand` creates it, and after `npm run clean` deletes
// it. A missing path is a hard error there, so without this a clean
// checkout could not build at all. An empty directory is walked and
// skipped, so creating it in `build.rs` costs a debug build nothing.
test('the build script creates the staging root it points at',
  function (t) {
    const { OUT_DIR } = require('../../bin/stage-sidecar')
    const buildScript = fs.readFileSync(
      path.join(TAURI_DIR, 'build.rs'), 'utf8'
    )

    t.ok(
      buildScript.includes(OUT_DIR),
      `build.rs names ${OUT_DIR}`
    )
    t.ok(
      /create_dir_all/.test(buildScript),
      'and creates it rather than assuming it'
    )

    // Order is the whole point: created after `tauri_build::build()`
    // has already read the config would be created too late.
    t.ok(
      buildScript.indexOf('create_dir_all') <
      buildScript.indexOf('tauri_build::build()'),
      'before tauri_build::build() reads bundle.resources'
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
