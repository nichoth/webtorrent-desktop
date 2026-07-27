import { defineConfig } from 'vite'

// Minimal baseline config for the renderer bundle. It is deliberately
// bare: US-001 only needs `vite build` to run far enough to report every
// module it cannot resolve. Later Phase 1 stories add the JSX transform,
// the Node builtin/Electron externals, and the HTML entry point.
export default defineConfig({
  build: {
    outDir: 'build-vite',
    emptyOutDir: true,
    rollupOptions: {
      input: 'src/renderer/main.js'
    }
  }
})
