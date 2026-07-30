#!/usr/bin/env node

/**
 * Assembles the document root that the Tauri window loads.
 *
 * Both hosts load the same `static/main.html` and the same Vite output
 * (ADR-014), and that HTML reaches the bundle through a relative
 * `<script src="../build-vite/renderer/main.js">`. Electron loads the
 * file straight off disk, so the `..` resolves; Tauri serves a single
 * directory through its asset protocol and cannot see outside it.
 *
 * So the document root is this repo's layout, minus everything the
 * window does not load: `static/` and `build-vite/` copied side by
 * side, which makes the relative src resolve inside the root. Copies,
 * not symlinks -- Tauri walks the directory at compile time to embed
 * it and does not follow links.
 */

const fs = require('fs')
const path = require('path')

const ROOT_PATH = path.join(__dirname, '..')

// The directory name is duplicated in five other places -- .gitignore,
// nodemon's --ignore list, depcheck's --ignore-dirs, bin/clean.js and
// bin/package.js -- because none of those can require this module.
const OUT_DIR = 'build-tauri'

// Repo-relative directories copied into the document root, in the
// same layout they have here.
const COPY = ['static', 'build-vite']

module.exports = { COPY, OUT_DIR }

if (require.main === module) assemble()

function assemble () {
  const outPath = path.join(ROOT_PATH, OUT_DIR)
  fs.rmSync(outPath, { recursive: true, force: true })

  for (const dir of COPY) {
    const fromPath = path.join(ROOT_PATH, dir)
    if (!fs.existsSync(fromPath)) {
      throw new Error(
        `${dir}/ does not exist -- run 'npm run build:renderer' first`
      )
    }
    fs.cpSync(fromPath, path.join(outPath, dir), { recursive: true })
  }

  console.log(`Assembled ${OUT_DIR}/ from ${COPY.join(', ')}`)
}
