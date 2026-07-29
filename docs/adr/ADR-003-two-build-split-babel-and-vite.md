# ADR-003: Keep two builds, and stop the ESM conversion at the renderer

**Date:** 2026-07-27

## Context

Introducing Vite (ADR-002) raised the question of how far it should
reach. The renderer UI needs bundling. The main process does not: it
is loaded by Node directly, has no bundler-shaped problems, and is
scheduled to be replaced by Rust in Phase 4 anyway.

Meanwhile several modules under `src/renderer/lib/` are loaded from
*both* sides. `lib/state.js` and `lib/migrations.js` are required by
`src/main/` as well as imported by the renderer.

Converting the renderer to ESM has an ordering hazard. Babel compiles
`export default X` to `exports.default = X`, so a still-CommonJS
consumer doing `require('./x')` breaks the moment its dependency is
converted. The reverse direction is safe, because an ESM module can
import a CommonJS one.

Converting the whole repo to ESM would remove the split, but it means
touching `src/main/` extensively for the sake of code that is being
deleted in Phase 4.

## Decision

Keep two builds:

- `npm run build:main` -- Babel compiles `src/` into `build/`,
  explicitly ignoring `src/renderer/main.js`,
  `src/renderer/components/**`, `src/renderer/controllers/**` and
  `src/renderer/pages/**`. Vite owns those.
- `npm run build:renderer` -- Vite bundles `src/renderer/main.js` into
  `build-vite/renderer/main.js`.

`npm run build` runs both; `index.js` is a one-line
`require('./build/main')`.

Convert only `src/renderer/` to ESM, and run that conversion
**top-down**: entry point first (US-005), then pages, components,
controllers, and `lib/` last (US-011 through US-013). The rest of the
repo stays CommonJS loaded by Node directly.

The Vite entry filename is pinned to `renderer/main.js` rather than
the default hashed name, because `static/main.html` references it with
a plain `<script src>`. Chunks and assets keep their hashes; nothing
links to them by name.

## Consequences

`src/main/` is untouched by the build change, which keeps Phase 1's
blast radius inside the renderer.

The top-down order means no commit leaves a CommonJS consumer
requiring an ESM dependency, so FR-2 (the app launches at every
commit) holds through the conversion.

The cost is a permanent seam that has to be explained: renderer `lib/`
modules exist in both `build/` (Babel, CommonJS) and inside the Vite
bundle, compiled twice from the same source. The two copies are
consistent because they come from one source tree, but the duplication
is real.

That seam also determines how tests work. `components/`,
`controllers/` and `main.js` have no prebuilt copy under `build/`, so
they cannot be required by a unit test. See ADR-010.

The two output directories mean `npm test`'s `depcheck` needs both
`build` and `build-vite` in `--ignore-dirs`.
