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
