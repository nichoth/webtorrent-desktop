import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineConfig, transformWithOxc } from 'vite'

const require = createRequire(import.meta.url)

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
// bundled from `path-browserify` rather than externalized, so that none
// of those 13 call sites has to change and none of them needs a Phase 2
// shim. Matched exactly (`/^path$/`) so a package literally named
// `path-something` is not captured; `node:path` is aliased separately
// because dependencies spell it either way.
const pathBrowserify = require.resolve('path-browserify')

// Externals. The bundle is emitted as CommonJS and loaded by an Electron
// renderer with `nodeIntegration: true`, so a `require()` left in the
// output resolves against the real Node/Electron module registry at load
// time. That is what makes externalizing meaningful here: without it
// Rolldown silently swaps in a browser stub that throws on first use, and
// without CJS output the `require()` calls could not be emitted at all.
//
// - `fs`: 6 first-party renderer files. Phase 2 replaces these call sites
//   with the platform shim; until then external keeps them working.
// - `fs/promises`: the shim itself (`lib/platform/fs.js`, US-023). It was
//   in the transitive list until then, reached only through
//   dependencies. As US-028 moves call sites, `fs` drains from this list
//   and `fs/promises` is what remains.
// - `http`: only `lib/cast.js`, the deferred casualty the PRD exempts
//   from the shim.
// - `events`: only `lib/state.js`, for `EventEmitter`.
// - `electron` / `@electron/remote`: these MUST be external. Left to the
//   bundler, `electron` resolves to `node_modules/electron/index.js` --
//   the npm CLI helper, which exports a path string, not the runtime API
//   -- with no warning at all, so `ipcRenderer` would be `undefined` at
//   runtime while the build reported success.
//
// `crypto` and `os` are deliberately absent from this list: grep confirms
// `crypto` is used only by `src/renderer/webtorrent.js`, which FR-4
// exempts from this build, and `os` has had no renderer importer since
// the US-002 telemetry deletion. See docs/vite-baseline.md.
const firstPartyExternals = [
  'fs',
  'fs/promises',
  'http',
  'events',
  'electron',
  '@electron/remote'
]

// Builtins no first-party renderer file imports, reached only through
// dependencies -- the config-persistence stack under `lib/state.js`
// (`application-config`, `write-file-atomic`, `graceful-fs`, `rimraf`)
// and the casting stack under `lib/cast.js`. They are externalized for
// the same reason as the list above: the alternative is a browser stub
// that throws the first time config is written or a cast device is
// discovered. Kept in a separate list so the first-party inventory above
// stays an accurate statement of what Phase 2's shim has to cover -- `os`
// in particular is here for `application-config-path` and
// `multicast-dns`, NOT for any renderer file.
//
// Enumerated from the externalization warnings of a build with only the
// list above applied, rather than taken wholesale from
// `module.builtinModules`, so that a dependency reaching for a new
// builtin shows up as a warning instead of being silently absorbed.
const transitiveExternals = [
  'assert', 'constants', 'dgram', 'https', 'net', 'os',
  'querystring', 'stream', 'timers', 'tls', 'url', 'util',
  'worker_threads'
]

// Dependencies spell builtins either way, so both forms are listed.
const external = [...firstPartyExternals, ...transitiveExternals]
  .flatMap(id => (
    id === '@electron/remote' || id === 'electron'
      ? [id]
      : [id, `node:${id}`]
  ))

// Vite targets browsers, so it statically replaces bare `process.env`
// with `{}` -- which turned `application-config-path`'s
// `process.env.HOME` into `{}["HOME"]` and made the very first
// `path.join()` of startup throw "Path must be a string. Received
// undefined". This renderer runs with `nodeIntegration: true`, so
// `process.env` is the real thing at runtime; routing the replacement
// through `globalThis` hands it back without re-triggering the
// substitution. `process.env.NODE_ENV` is a longer key and still wins,
// so React et al. keep whatever Vite decides for the mode.
const processEnv = { 'process.env': 'globalThis.process.env' }

export default defineConfig({
  define: processEnv,
  plugins: [jsxInJs],
  resolve: {
    alias: [
      {
        find: /^inline-style-prefixer$/,
        replacement: inlineStylePrefixerStub
      },
      { find: /^path$/, replacement: pathBrowserify },
      { find: /^node:path$/, replacement: pathBrowserify }
    ]
  },
  build: {
    outDir: 'build-vite',
    emptyOutDir: true,
    rollupOptions: {
      input: 'src/renderer/main.js',
      external,
      output: {
        format: 'cjs',
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
