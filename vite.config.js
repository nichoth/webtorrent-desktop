import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// Replaces the old `Module.prototype.require` hook in
// `src/renderer/main.js`. Matched exactly (not as a prefix) so that
// material-ui's deep imports -- `inline-style-prefixer/static/...`,
// `inline-style-prefixer/dynamic/...` -- still resolve to the real
// package rather than to a non-existent path inside `stubs/`.
const inlineStylePrefixerStub = fileURLToPath(
  new URL('./stubs/inline-style-prefixer.js', import.meta.url)
)

// Minimal baseline config for the renderer bundle. It is deliberately
// bare: US-001 only needs `vite build` to run far enough to report every
// module it cannot resolve. Later Phase 1 stories add the JSX transform,
// the Node builtin/Electron externals, and the HTML entry point.
export default defineConfig({
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
