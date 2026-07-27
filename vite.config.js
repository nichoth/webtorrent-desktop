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

// Baseline config for the renderer bundle. Later Phase 1 stories add the
// Node builtin/Electron externals and the HTML entry point.
export default defineConfig({
  plugins: [jsxInJs],
  resolve: {
    alias: [
      {
        find: /^inline-style-prefixer$/,
        replacement: inlineStylePrefixerStub
      }
    ]
  },
  build: {
    outDir: 'build-vite',
    emptyOutDir: true,
    rollupOptions: {
      input: 'src/renderer/main.js'
    }
  }
})
