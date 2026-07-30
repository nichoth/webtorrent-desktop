// Shim-boundary lint rule (US-034, FR-11).
//
// This is a standalone ESLint config, run by `npm run lint:boundary`
// with `--no-eslintrc`. It deliberately does NOT extend, override or
// otherwise touch `standard`: `standard` keeps owning style, this file
// owns exactly one architectural rule, and the two never see each
// other's settings.
//
// The rule: nothing under `src/renderer/` may import the host
// directly. Every Electron and Node surface the UI needs is reachable
// through `src/renderer/lib/platform/`, so a new direct import is
// always the decoupling eroding rather than a legitimate need.
//
// US-046 added the other side of the same seam. `src/engine/` is the
// torrent sidecar (ADR-012): a plain Node process, so it is exempt
// from the renderer's Node bans and may use `fs`, `os`, `crypto` and
// `http` freely. What it may not do is the mirror-image mistake --
// reach for Electron or for a DOM. It runs under
// `ELECTRON_RUN_AS_NODE`, where `require('electron')` returns no
// `app`, and a packaged sidecar has no `node_modules/electron` to
// resolve at all, so an Electron import there fails at load rather
// than degrading. There is no `window` either. Both are banned below.
//
// Scope note: `no-restricted-imports` sees `import` declarations only,
// not `require()`. The `require()` spellings of the same specifiers
// are covered by the source scan in `test/unit/platform-boundary.js`,
// which also covers the usage-level concerns no import rule can
// express (`ipcRenderer.` member reads, `wt-` channel strings,
// `new remote.Menu`). The two checks are complementary; neither
// replaces the other.

const SHIM = 'src/renderer/lib/platform/'

function banned (name, why) {
  return {
    name,
    message: why + ' Import it from ' + SHIM + ' instead (FR-11).'
  }
}

const ELECTRON = 'The renderer must not reach Electron directly.'
const NODE = 'The renderer must not reach Node builtins directly.'

const HOST = [
  banned('electron', ELECTRON),
  banned('@electron/remote', ELECTRON),
  banned('original-fs', ELECTRON)
]

// The Electron half of the renderer ban on its own, for the one shim
// file that is exempt from the Node half but not from this one:
// `ipc-engine.js` below.
const ELECTRON_ONLY = ['error', { paths: HOST }]

// The same specifiers for the sidecar, which is not a renderer and has
// no shim to be pointed at -- it simply has no Electron.
const ENGINE_ELECTRON = ['error', {
  paths: HOST.map(({ name }) => ({
    name,
    message: 'The engine sidecar is a plain Node process: it runs ' +
      'under ELECTRON_RUN_AS_NODE and a packaged sidecar has no ' +
      'node_modules/electron to resolve (ADR-012).'
  }))
}]

// The DOM globals a Node process cannot have. `no-restricted-globals`
// catches both a real global and an unresolved reference, which is
// what a stray `window.x` in the sidecar would be.
const NO_DOM = ['error',
  { name: 'window', message: 'The engine is a Node process, not a DOM.' },
  { name: 'document', message: 'The engine is a Node process, not a DOM.' },
  { name: 'navigator', message: 'The engine is a Node process, not a DOM.' },
  { name: 'localStorage', message: 'The engine has no web storage.' },
  { name: 'sessionStorage', message: 'The engine has no web storage.' },
  { name: 'XMLHttpRequest', message: 'The engine is a Node process.' }
]

// US-052: the shim has two implementations now (ADR-014), and which
// one a build talks to is a property of the build -- the `WT_HOST`
// resolver in `bin/shim-resolver.js` swaps the whole tree. A UI file
// that named `lib/platform/tauri/` directly would pin itself to one
// host and defeat that, so the subdirectory is banned by name while
// `lib/platform/` itself stays the way in. The shim override below
// switches this off inside the shim, which is where the Tauri tree's
// own relative imports live.
const TAURI_TREE = [{
  group: ['**/platform/tauri', '**/platform/tauri/**'],
  message: 'The Tauri shim tree is selected at build time by ' +
    'WT_HOST (ADR-014), never imported by name. Import ' +
    SHIM + ' instead (FR-11).'
}]

const RESTRICTED = ['error', {
  patterns: TAURI_TREE,
  paths: [
    ...HOST,

    // `fs` is behind `lib/platform/fs.js` since US-028. The
    // `fs/promises` and `node:` spellings are listed so the ban cannot
    // be sidestepped by renaming the import; Electron's `original-fs`
    // is in HOST above, with the other host modules.
    banned('fs', NODE),
    banned('fs/promises', NODE),
    banned('node:fs', NODE),
    banned('node:fs/promises', NODE),

    // `os` and `crypto` are preventive: no renderer file has used
    // either since the US-002 telemetry deletion, and neither has a
    // shim module. Banning them now means the next use has to add one
    // rather than reach past the boundary.
    banned('os', NODE),
    banned('node:os', NODE),
    banned('crypto', NODE),
    banned('node:crypto', NODE),

    // `http` is only used by `lib/cast.js`, exempted below.
    banned('http', NODE),
    banned('node:http', NODE)
  ]
}]

module.exports = {
  root: true,
  // The same parser `standard` uses, so this rule parses exactly what
  // `standard` parses -- JSX inside `.js` files included.
  parser: '@babel/eslint-parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true }
  },
  // No rules at the top level: this config polices `src/renderer/` and
  // nothing else. `src/main/` is the host process and is supposed to
  // import Electron and Node freely.
  rules: {},
  overrides: [
    {
      files: ['src/renderer/**/*.js'],
      rules: { 'no-restricted-imports': RESTRICTED }
    },
    {
      // The shim is the boundary; it is the one place that is meant to
      // hold these imports.
      files: [SHIM + '**/*.js'],
      rules: { 'no-restricted-imports': 'off' }
    },
    {
      // ...with one exception. `ipc-engine.js` needed `ipcRenderer`
      // while the `wt-*` protocol rode Electron IPC; since US-044 it
      // is a WebSocket client of the sidecar and needs no host module
      // at all. The blanket shim exemption would let that quietly
      // regress, so the Electron ban goes back on for this one file.
      // The Node half stays off: it is still a shim module, and the
      // next thing it needs may legitimately be a builtin.
      files: [SHIM + 'ipc-engine.js'],
      rules: { 'no-restricted-imports': ELECTRON_ONLY }
    },
    {
      // Deferred casualty: `lib/cast.js` runs an http server inside
      // the renderer for Chromecast/DLNA/AirPlay. It is exempt from
      // the shim by the same decision that exempted it in US-013.
      files: ['src/renderer/lib/cast.js'],
      rules: { 'no-restricted-imports': 'off' }
    },
    {
      // The sidecar (US-046). Exempt from the renderer rules by not
      // matching them, and policed for the opposite mistake instead:
      // no Electron module, no DOM global. Node builtins are its
      // native surface and are deliberately unrestricted here.
      files: ['src/engine/**/*.js'],
      rules: {
        'no-restricted-imports': ENGINE_ELECTRON,
        'no-restricted-globals': NO_DOM
      }
    }
  ]
}
