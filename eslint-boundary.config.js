// Shim-boundary lint rule (US-034, FR-11).
//
// This is a standalone ESLint config, run by `npm run lint:boundary`
// with `--no-eslintrc`. It deliberately does NOT extend, override or
// otherwise touch `standard`: `standard` keeps owning style, this file
// owns exactly one architectural rule, and the two never see each
// other's settings.
//
// The rule: nothing under `src/renderer/` may import the host
// directly. Every Tauri and Node surface the UI needs is reachable
// through `src/renderer/lib/platform/`, so a new direct import is
// always the decoupling eroding rather than a legitimate need.
//
// US-046 added the other side of the same seam. `src/engine/` is the
// torrent sidecar (ADR-012): a plain Node process, so it is exempt
// from the renderer's Node bans and may use `fs`, `os`, `crypto` and
// `http` freely. What it may not do is the mirror-image mistake --
// reach for a host API or for a DOM. It is spawned by
// `src-tauri/src/engine.rs` as a plain `node` child, so
// `@tauri-apps/api` there is a load error rather than a degraded
// feature, and there is no `window`. Both are banned below.
//
// The Electron specifiers are still banned by name after US-072
// deleted the host. Nothing imports them any more, and that is
// exactly the state worth pinning: the ban costs nothing and turns a
// reflexive `import { shell } from 'electron'` into a lint failure
// rather than a missing-module error at build time.
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

// US-056: the host's API package is a host module like any other, and
// it arrives with subpaths (`@tauri-apps/api/event`, `/core`, ...),
// so it is a pattern rather than a path. Same rule as `electron`:
// only the shim may name it.
const TAURI_API = [{
  group: ['@tauri-apps/api', '@tauri-apps/api/**'],
  message: 'The renderer must not reach Tauri directly. Import ' +
    SHIM + ' instead (FR-11).'
}]

// The host half of the renderer ban on its own, for the one shim file
// that is exempt from the Node half but not from this one:
// `ipc-engine.js` below.
const HOST_ONLY = ['error', { paths: HOST, patterns: TAURI_API }]

// The same specifiers for the sidecar, which is not a renderer and has
// no shim to be pointed at -- it simply has no host.
const ENGINE_SIDECAR = 'The engine sidecar is a plain Node process ' +
  'spawned by src-tauri/src/engine.rs: it has no host API to reach, ' +
  'and importing one is a load error rather than a degraded ' +
  'feature (ADR-012).'

const ENGINE_HOST = ['error', {
  paths: HOST.map(({ name }) => ({ name, message: ENGINE_SIDECAR })),
  patterns: [{
    group: ['@tauri-apps/api', '@tauri-apps/api/**'],
    message: ENGINE_SIDECAR
  }]
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

// The mirror-image rule for the renderer, and the one US-072 needed.
// `process` was readable from the UI only because the Electron window
// ran with `nodeIntegration: true`; a webview has no such global, so a
// bare read is a `ReferenceError` at whatever moment it happens to
// run. Two of the four in the tree ran at module scope, which meant a
// blank window rather than a broken feature -- the worst possible
// failure mode for the one thing there is no test-shaped signal for.
//
// `lib/os.js` answers the only question the UI actually asked (which
// OS) from `navigator` instead; anything else belongs to the host and
// goes through the shim. `test/unit/os.js` scans the source for the
// spellings a rule about identifiers cannot see.
const NO_NODE_GLOBALS = ['error',
  {
    name: 'process',
    message: 'The webview has no `process` -- see src/renderer/lib/os.js.'
  },
  {
    name: 'global',
    message: 'The webview has no `global` -- use `globalThis`.'
  },
  {
    name: '__dirname',
    message: 'The webview has no module paths -- ask the host.'
  },
  {
    name: '__filename',
    message: 'The webview has no module paths -- ask the host.'
  }
]

const RESTRICTED = ['error', {
  patterns: [...TAURI_API],
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
  // `src/engine/`, and nothing else. The host process is Rust now
  // (`src-tauri/`), so there is no third JavaScript tree to exempt.
  rules: {},
  overrides: [
    {
      files: ['src/renderer/**/*.js'],
      rules: {
        'no-restricted-imports': RESTRICTED,
        'no-restricted-globals': NO_NODE_GLOBALS
      }
    },
    {
      // `lib/path.js` is Node's `path` algorithms, and `resolve()` has
      // to resolve a relative segment against *something*. It reads
      // `process.cwd()` behind a `typeof process !== 'undefined'`
      // guard -- the real one under the unit suite, `/` in the webview
      // -- which is the same shape `src/config.js` uses, and the only
      // spelling that is safe where the global is absent.
      // `test/unit/os.js` asserts the guard is still there, so this
      // exemption cannot decay into an unguarded read.
      files: ['src/renderer/lib/path.js'],
      rules: { 'no-restricted-globals': 'off' }
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
      // at all -- which is why US-072 could promote it unchanged. The
      // blanket shim exemption would let that quietly regress, so the
      // host ban goes back on for this one file. The Node half stays
      // off: it is still a shim module, and the next thing it needs
      // may legitimately be a builtin.
      files: [SHIM + 'ipc-engine.js'],
      rules: { 'no-restricted-imports': HOST_ONLY }
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
      // no host module, no DOM global. Node builtins are its
      // native surface and are deliberately unrestricted here.
      files: ['src/engine/**/*.js'],
      rules: {
        'no-restricted-imports': ENGINE_HOST,
        'no-restricted-globals': NO_DOM
      }
    }
  ]
}
