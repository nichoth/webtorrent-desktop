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

const RESTRICTED = ['error', {
  paths: [
    banned('electron', ELECTRON),
    banned('@electron/remote', ELECTRON),

    // `fs` is behind `lib/platform/fs.js` since US-028. The
    // `fs/promises`, `node:` and Electron `original-fs` spellings are
    // listed so the ban cannot be sidestepped by renaming the import.
    banned('fs', NODE),
    banned('fs/promises', NODE),
    banned('node:fs', NODE),
    banned('node:fs/promises', NODE),
    banned('original-fs', ELECTRON),

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
      // Deferred casualty (FR-4): the hidden WebTorrent window is a
      // Node process by design and is slated for replacement by
      // librqbit rather than migration to the shim.
      files: ['src/renderer/webtorrent.js'],
      rules: { 'no-restricted-imports': 'off' }
    },
    {
      // Deferred casualty: `lib/cast.js` runs an http server inside
      // the renderer for Chromecast/DLNA/AirPlay. It is exempt from
      // the shim by the same decision that exempted it in US-013.
      files: ['src/renderer/lib/cast.js'],
      rules: { 'no-restricted-imports': 'off' }
    }
  ]
}
