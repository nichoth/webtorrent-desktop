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

// `stream` and `util` are aliased on the same terms again, and they
// are the two that are not dead code. `through2`'s bundled
// `readable-stream@1.x` inherits from `stream` in its module body and
// `through2` itself calls `util.inherits` in its own, and `srt-to-vtt`
// -- a static import of `controllers/subtitles-controller.js` --
// brings both in. Left un-aliased they are the empty object again, so
// the bundle died at load twice over. Each file's doc comment says why
// its deliberately small surface is the whole requirement.
//
// `lib/stream.js` is CommonJS while its three siblings are ESM,
// because a CJS `require()` of an ESM module yields a namespace
// object: fine for `path`/`events`/`util`, whose consumers only read a
// property off it, and useless for `stream`, which is called as
// `Stream.call(this)`.
const rendererStream = fileURLToPath(
  new URL('./src/renderer/lib/stream.js', import.meta.url)
)

const rendererUtil = fileURLToPath(
  new URL('./src/renderer/lib/util.js', import.meta.url)
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
// which is `undefined()`. Four builtins therefore have real
// first-party implementations aliased in above -- `path`
// (`lib/path.js`, ADR-011), `events` (`lib/events.js`), `stream`
// (`lib/stream.js`) and `util` (`lib/util.js`) -- and `src/config.js`
// no longer reads a Node global at load.
//
// Those four are exactly the ones a module body *calls* into. Finding
// them was iterative rather than analytical, and has to be: each fix
// only reveals the next `undefined()` one frame further in, so the
// procedure is to run `test/unit/renderer-boots.js` and read the
// stack, not to reason about the list. What is left resolves to that
// empty object, and every one of them is reached only from code that
// cannot work in a webview anyway:
//
// - `fs`, `os`: the `application-config` stack under `src/config.js`.
//   Its module body never runs now, because `getConfigPath()` stops
//   before constructing it.
// - `http`, `https`, `net`, `tls`, `dgram`, `url`, `querystring`,
//   `timers`: the casting stack under `lib/cast.js`, whose three
//   `require()` calls are inside `init()` and so never evaluate at
//   load. Casting is the PRD's deferred casualty; US-076 through
//   US-079 move it to the host, and it stays broken until they do.
//
// `test/unit/renderer-boots.js` runs the emitted bundle in a
// webview-shaped sandbox with no `require` and no `process`, which is
// what holds all of this in place.

// `process` is the same problem as the builtins, one level down, and
// it gets a different answer because it is a *global* rather than a
// module: there is nothing to alias.
//
// Nothing first-party needs the substitutions below. The renderer's
// own four reads of `process.platform` moved to `lib/os.js` in
// US-072, and the two that remain -- in `lib/path.js` and
// `src/config.js` -- are behind `typeof process !== 'undefined'`
// guards and correctly take the "no Node here" branch on their own.
// `test/unit/os.js` is what keeps it that way.
//
// What is left is bundled dependencies written for Node, reading these
// keys in their module bodies, where `undefined` is a load-time throw
// rather than a dormant one. Each value below is the honest webview
// answer rather than a plausible-looking Node one, and the list is
// short because it is exactly what the boot test demanded -- do not
// add to it speculatively.
const PROCESS_SHIM = {
  // The browser equivalent, with the arguments forwarded: Node's
  // `nextTick` takes them (`process.nextTick(upgrade, 42)` is in the
  // bundle) and `queueMicrotask` does not. This one has to *work*, not
  // merely not throw -- `readable-stream` schedules every callback
  // through it, and that is the live subtitle path.
  'process.nextTick': '((fn, ...args) => queueMicrotask(() => fn(...args)))',

  // What `process.browser` is for. Several dependencies branch on it
  // to pick their non-Node path, which is the one we want.
  'process.browser': 'true',

  // There is no Node version here, and the empty string is what the
  // three readers do the right thing with: they all test it for the
  // 0.x series (`/^v?\.0/`, `.indexOf('v0.')`, `.slice(0, 5)`) to
  // decide whether to work around an ancient runtime, and no match is
  // the modern branch.
  'process.version': '""',

  // Compared by identity, never called: `readable-stream`'s `pipe()`
  // exempts the two standard streams from its automatic `end()`.
  // Neither exists in a webview, so no destination can be one.
  'process.stdout': 'undefined',
  'process.stderr': 'undefined'
}

// No `define` for `process.env`, deliberately.
//
// This used to map it to `globalThis.process.env`, which under
// Electron's `nodeIntegration: true` handed back the real environment.
// The Tauri webview has no `globalThis.process` either, so the mapping
// turned one failure into another. Vite's own default applies instead:
// bare `process.env` becomes `{}` and `process.env.NODE_ENV` becomes
// the mode, which is what React and friends want. `src/config.js`
// reads its own guarded reference rather than relying on either
// substitution.

export default defineConfig({
  plugins: [jsxInJs],
  define: PROCESS_SHIM,
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
      { find: /^stream$/, replacement: rendererStream },
      { find: /^node:stream$/, replacement: rendererStream },
      { find: /^util$/, replacement: rendererUtil },
      { find: /^node:util$/, replacement: rendererUtil },
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
