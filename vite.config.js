import { fileURLToPath } from 'node:url'
import { defineConfig, transformWithOxc } from 'vite'

// Replaces the old `Module.prototype.require` hook in
// `src/renderer/main.js`. Matched exactly (not as a prefix) so that
// material-ui's deep imports -- `inline-style-prefixer/static/...`,
// `inline-style-prefixer/dynamic/...` -- still resolve to the real
// package rather than to a non-existent path inside `stubs/`.
const inlineStylePrefixerStub = fileURLToPath(
  new URL('./stubs/inline-style-prefixer.js', import.meta.url)
)

// Every renderer component in this repo puts JSX inside a `.js` file,
// which no bundler treats as JSX by default.
//
// Vite 8 is Rolldown-based, so the `esbuild` config key is translated to
// `oxc` internally, and esbuild's `loader: 'jsx'` becomes oxc's
// `lang: 'jsx'`. Setting it through the `oxc` key does not work for a
// production build: `vite build` hands the transform to the native
// `builtin:vite-transform` plugin, which derives the language from the
// file extension and ignores an explicit `lang`, so `.js` files still
// fail to parse. The equivalent plugin configuration below calls Vite's
// own `transformWithOxc` directly, which does honour `lang`.
//
// The filter is scoped to this repo's own `src/**/*.js` by absolute
// path prefix rather than by a `/src/` regex, because plenty of
// packages under node_modules ship their own `src/` directory and none
// of them should be parsed as JSX. `enforce: 'pre'` puts this ahead of
// Vite's own transform pipeline.
//
// `runtime: 'classic'` matches the Babel build: components do
// `const React = require('react')` and rely on the default
// `React.createElement` pragma, so the automatic runtime would be wrong.
//
// On `useBuiltIns: true` from the `babel` key in package.json: that
// option only changes how JSX *spread attributes* (`<div {...props} />`)
// compile -- `Object.assign` instead of a Babel helper. oxc has no
// equivalent option because it always emits native `Object.assign`, and
// in any case `grep` finds zero JSX spread attributes anywhere under
// `src/renderer/`. The behaviour is therefore preserved, and the option
// has no counterpart to carry over.
const srcDir = fileURLToPath(new URL('./src/', import.meta.url))

const jsxInJs = {
  name: 'webtorrent:jsx-in-js',
  enforce: 'pre',
  async transform (code, id) {
    const file = id.split('?')[0]
    if (!file.startsWith(srcDir) || !file.endsWith('.js')) return null
    const result = await transformWithOxc(code, id, {
      lang: 'jsx',
      jsx: { runtime: 'classic' },
      sourcemap: true
    })
    return { code: result.code, map: result.map, moduleType: 'js' }
  }
}

// `path` is the widest Node dependency in the renderer -- 13 first-party
// files import it -- and every one of those uses is pure string
// manipulation (`join`, `basename`, `extname`, `parse`). It is therefore
// bundled rather than externalized, so that none of those 13 call sites
// has to change and none of them needs a Phase 2 shim.
//
// The implementation is first-party (`src/renderer/lib/path.js`, ADR-011)
// rather than the `path-browserify` package: the alias also catches the
// `path` imports of bundled dependencies, so this is renderer code the
// app ships and it should be code the repo owns and tests.
//
// Matched exactly (`/^path$/`) so a package literally named
// `path-something` is not captured; `node:path` is aliased separately
// because dependencies spell it either way.
const rendererPath = fileURLToPath(
  new URL('./src/renderer/lib/path.js', import.meta.url)
)

// `events` is aliased for the same reason and on the same terms: one
// first-party file needs it (`lib/state.js`, for `EventEmitter`) and
// several bundled dependencies inherit from it. Left un-aliased, Vite
// rewrites it to an empty object for the browser and `new
// EventEmitter()` throws at load, which took the whole renderer down
// before US-072. See `src/renderer/lib/events.js`.
const rendererEvents = fileURLToPath(
  new URL('./src/renderer/lib/events.js', import.meta.url)
)

// `application-config` is dead code in this bundle -- `getConfigPath()`
// never reaches it in a webview -- but dead code still runs: a static
// ESM import of a CommonJS module evaluates it at the importer's
// initialization, and this one's dependency chain reassigns
// `process.cwd` at load. Stubbed rather than externalized so the
// package and its `graceful-fs`/`write-json-file` chain leave the
// bundle entirely.
const applicationConfigStub = fileURLToPath(
  new URL('./stubs/application-config.js', import.meta.url)
)

// No externals. Every module the bundle names is bundled into it.
//
// Until US-072 the Node builtins below were left as `require()`
// calls and answered at runtime by the Electron window's
// `nodeIntegration: true` (ADR-004). A WKWebView/WebView2 has no
// `require`, so in the Tauri host the very first line of the bundle
// threw `ReferenceError: Can't find variable: require` and nothing
// rendered -- recorded against US-070 and US-071, and fixed here.
//
// Removing the list is most of the fix but not all of it. Vite
// rewrites an un-externalized builtin to an **empty object** rather
// than to an error, so the failure moves rather than disappearing: the
// next thing to run is `os.platform()` inside `application-config`,
// which is `undefined()`. Two builtins therefore have real
// first-party implementations aliased in above -- `path`
// (`lib/path.js`, ADR-011) and `events` (`lib/events.js`) -- and
// `src/config.js` no longer reads a Node global at load.
//
// What is left resolves to that empty object, and every one of them is
// reached only from code that cannot work in a webview anyway:
//
// - `fs`, `util`, `os`, `stream`: the `application-config` stack
//   under `src/config.js`. Its module body never runs now, because
//   `getConfigPath()` stops before constructing it.
// - `http`, `https`, `net`, `tls`, `dgram`, `url`, `querystring`,
//   `timers`: the casting stack under `lib/cast.js`, whose three
//   `require()` calls are inside `init()` and so never evaluate at
//   load. Casting is the PRD's deferred casualty; US-076 through
//   US-079 move it to the host, and it stays broken until they do.
//
// `test/unit/renderer-boots.js` runs the emitted bundle in a
// webview-shaped sandbox with no `require` and no `process`, which is
// what holds all of this in place.
// No `define` for `process`.
//
// This used to map `process.env` to `globalThis.process.env`, which
// under Electron's `nodeIntegration: true` handed back the real
// environment. The Tauri webview has no `globalThis.process` either,
// so the mapping turned one failure into another. Vite's own default
// applies instead: bare `process.env` becomes `{}` and
// `process.env.NODE_ENV` becomes the mode, which is what React and
// friends want. `src/config.js` reads its own guarded reference
// rather than relying on either substitution.

export default defineConfig({
  plugins: [jsxInJs],
  resolve: {
    alias: [
      {
        find: /^inline-style-prefixer$/,
        replacement: inlineStylePrefixerStub
      },
      { find: /^path$/, replacement: rendererPath },
      { find: /^node:path$/, replacement: rendererPath },
      { find: /^events$/, replacement: rendererEvents },
      { find: /^node:events$/, replacement: rendererEvents },
      {
        find: /^application-config$/,
        replacement: applicationConfigStub
      }
    ]
  },
  build: {
    outDir: 'build-vite',
    emptyOutDir: true,
    rollupOptions: {
      input: 'src/renderer/main.js',
      output: {
        // `iife`, not `cjs`. The output was CommonJS so that the
        // externals above could stay `require()` calls (ADR-004);
        // with nothing external there is nothing to require, and a
        // module format the webview does not implement is a trap
        // waiting for the first top-level export. `iife` is what a
        // classic `<script src>` wants, and it keeps the bundle's
        // internals off `window`.
        format: 'iife',
        // `static/main.html` references the entry with a plain
        // `<script src>`, so the entry filename has to be stable --
        // the default `assets/main-[hash].js` would change on every
        // build and break the tag. Chunks and assets keep their
        // hashes; nothing links to them by name.
        entryFileNames: 'renderer/main.js',
        chunkFileNames: 'renderer/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  }
})
