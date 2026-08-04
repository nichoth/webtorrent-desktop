const test = require('tape')
const fs = require('fs')
const path = require('path')

// US-051: the Tauri host scaffold. Nothing here can launch a window, so
// what these tests hold is the wiring that a launch depends on: the
// document root the Tauri window is pointed at has to be the same
// `static/main.html` and the same Vite output Electron loads, and the
// two hosts have to stay side by side (ADR-014) rather than one
// replacing the other.

const REPO = path.join(__dirname, '..', '..')
const TAURI_DIR = path.join(REPO, 'src-tauri')
const CONF_PATH = path.join(TAURI_DIR, 'tauri.conf.json')

const pkg = JSON.parse(
  fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')
)

function readConf () {
  return JSON.parse(fs.readFileSync(CONF_PATH, 'utf8'))
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

test('both hosts stay launchable side by side', function (t) {
  t.equal(
    pkg.scripts.start,
    'npm run build && electron --no-sandbox .',
    'npm start still launches Electron unchanged'
  )
  t.ok(pkg.scripts['start:tauri'], 'npm run start:tauri exists')
  t.ok(
    pkg.scripts['start:tauri'].includes('build:tauri'),
    'start:tauri builds the renderer first'
  )
  t.ok(
    pkg.scripts['build:tauri'].includes('build:renderer'),
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
  t.ok(
    pkg.scripts.test.includes(`--ignore-dirs=build,build-vite,${OUT_DIR},dist`),
    'depcheck skips the document root'
  )
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
// It is the Babel output of `src/engine/`, which only `build:main`
// produces -- and nothing else in the Tauri build has ever needed it,
// so it is easy to leave out and the symptom is a window with no
// torrenting rather than a build error.

test('the Tauri build produces the engine sidecar it spawns', function (t) {
  t.ok(
    pkg.scripts['build:tauri'].includes('build:main'),
    'build:tauri builds the sidecar entry point'
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
