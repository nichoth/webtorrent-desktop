const test = require('tape')
const fs = require('fs')
const path = require('path')
const babel = require('@babel/core')

// US-081: a file this webview has been measured as unable to decode
// opens the unsupported-media modal, with the external player offered,
// instead of leaving a black window.
//
// Controllers are excluded from `build:main`, so the one under test is
// compiled here and emitted into `build/renderer/controllers/`, where
// its relative imports resolve against the real built
// `build/renderer/lib/**`. See test/AGENTS.md.
//
// The emitted name is not the controller's, because
// `os-ipc-call-sites.js` compiles the same source in the same `tape`
// process and stubs the same shim: two files requiring one path get
// one module object, bound to whichever file's stubs loaded first, and
// the loser records nothing. A name of its own gives each file its own
// instance -- it sits in the same directory, so `../lib/...` still
// resolves against the real build.

const ROOT = path.join(__dirname, '..', '..')
const SRC = path.join(
  ROOT, 'src', 'renderer', 'controllers', 'media-controller.js'
)
const OUT_DIR = path.join(ROOT, 'build', 'renderer', 'controllers')
const OUT = path.join(OUT_DIR, 'media-controller.playability-test.js')

fs.mkdirSync(OUT_DIR, { recursive: true })
fs.writeFileSync(
  OUT, babel.transformFileSync(SRC, { root: ROOT, cwd: ROOT }).code
)

const BUILT = path.join(ROOT, 'build', 'renderer')
const { setDispatch } = require(path.join(BUILT, 'lib', 'dispatcher'))

let record = null

function reset () {
  record = { dispatches: [], externalPlayer: true }
  // One process-wide dispatch, re-registered per test (test/AGENTS.md).
  setDispatch((...args) => record.dispatches.push(args))
}

function stub (modulePath, exports) {
  const id = require.resolve(modulePath)
  const previous = require.cache[id]
  require.cache[id] = { id, filename: id, loaded: true, exports }
  return () => {
    if (previous) require.cache[id] = previous
    else delete require.cache[id]
  }
}

// The shims reach the host; here they only have to answer.
const withdraw = [
  stub(path.join(BUILT, 'lib', 'platform', 'ipc-os'), {
    __esModule: true,
    async checkForExternalPlayer () { return record.externalPlayer },
    async openExternalPlayer () {},
    async notifyPlayerOpen () {}
  }),
  stub(path.join(BUILT, 'lib', 'platform', 'ipc-engine'), {
    __esModule: true,
    async onServerRunningFor () { return () => {} }
  })
]

const MediaController = require(OUT).default

// Withdraw the stubs immediately: Babel has bound the module objects,
// and other files in the same `tape` process test the real shims.
withdraw.forEach((undo) => undo())

const WKWEBVIEW_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko)'

// `unsupportedMediaMessage` reads the webview through globals when it
// is not handed a probe, which is how the controller calls it.
function withWebview (userAgent, canPlayType, fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const hadDoc = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent }, configurable: true, writable: true
  })
  Object.defineProperty(globalThis, 'document', {
    value: { createElement: () => ({ canPlayType }) },
    configurable: true,
    writable: true
  })
  try {
    fn()
  } finally {
    if (had) Object.defineProperty(globalThis, 'navigator', had)
    else delete globalThis.navigator
    if (hadDoc) Object.defineProperty(globalThis, 'document', hadDoc)
    else delete globalThis.document
  }
}

function makeState (fileName) {
  return {
    playing: { location: 'local', fileName },
    location: { url: () => 'player' },
    saved: { prefs: { externalPlayerPath: null } },
    modal: null
  }
}

function dispatched (name) {
  return record.dispatches.filter((args) => args[0] === name)
}

test('an undecodable file opens the modal before playback fails', function (t) {
  reset()
  const state = makeState('The.Movie.mkv')
  withWebview(WKWEBVIEW_UA, () => '', () => {
    new MediaController(state).checkMediaPlayability()
  })

  const errors = dispatched('mediaError')
  t.equal(errors.length, 1, 'one mediaError')
  t.ok(String(errors[0][1]).includes('.mkv'), 'the message names the format')
  t.end()
})

test('a decodable file is left alone', function (t) {
  reset()
  const state = makeState('The.Movie.mp4')
  withWebview(WKWEBVIEW_UA, () => 'maybe', () => {
    new MediaController(state).checkMediaPlayability()
  })

  t.equal(dispatched('mediaError').length, 0, 'no modal')
  t.end()
})

test('a file already handed to the external player is left alone', function (t) {
  reset()
  const state = makeState('The.Movie.mkv')
  state.playing.location = 'external'
  withWebview(WKWEBVIEW_UA, () => '', () => {
    new MediaController(state).checkMediaPlayability()
  })

  t.equal(dispatched('mediaError').length, 0, 'VLC has it')
  t.end()
})

test('the modal is offered the external player', function (t) {
  reset()
  const state = makeState('The.Movie.mkv')
  const controller = new MediaController(state)
  controller.mediaError('This window can\'t decode .mkv files.')

  // `checkForExternalPlayer` answers a turn later, and the modal is
  // opened from that answer.
  setTimeout(() => {
    t.equal(state.modal.id, 'unsupported-media-modal', 'the modal is open')
    t.equal(state.modal.externalPlayerInstalled, true,
      'the external player is offered')
    t.ok(dispatched('update').length >= 1, 'the modal gets its own render')
    t.end()
  }, 0)
})

test('the modal reports when there is no external player', function (t) {
  reset()
  record.externalPlayer = false
  const state = makeState('The.Movie.mkv')
  new MediaController(state).mediaError('nope')

  setTimeout(() => {
    t.equal(state.modal.externalPlayerInstalled, false, 'VLC is offered instead')
    t.end()
  }, 0)
})
