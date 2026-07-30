#!/usr/bin/env node

/**
 * Builds the renderer bundle against the Tauri shim tree (ADR-014).
 *
 * The selection is an environment variable, `WT_HOST`, read by
 * `vite.config.js` through `bin/shim-resolver.js`. Setting one inline
 * in an npm script -- `WT_HOST=tauri vite build` -- is a POSIX shell
 * spelling that fails on Windows, and Windows is one of the three
 * platforms Phase 4 targets. Setting it here works everywhere and
 * keeps `npm run build:renderer` exactly as it was, which is what
 * makes the Electron build the default by construction rather than by
 * convention.
 *
 * Vite's JS API is used rather than a child process so there is one
 * process, one exit code and no shell in between.
 */

const { TAURI } = require('./shim-resolver')

process.env.WT_HOST = TAURI

import('vite')
  .then(({ build }) => build())
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
