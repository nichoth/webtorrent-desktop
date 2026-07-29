# ADR-002: Build the renderer UI with Vite

**Date:** 2026-07-27

## Context

Before this decision the renderer was not built at all in the bundler
sense. `src/renderer/main.js` was compiled file by file by Babel and
loaded by Electron with `nodeIntegration: true`, so every `require()`
resolved at runtime against the real Node module registry.

That arrangement had a load-bearing hack in it: a
`Module.prototype.require` monkey patch in `main.js`, used to redirect
`inline-style-prefixer` to a local stub. A monkey patch on the module
loader only works because the module loader is present at runtime,
which is exactly the assumption a Tauri host removes.

Nothing about the port could be validated while this was true. Until
the renderer builds as a bundle, there is no way to know which Node
and Electron surfaces the UI actually depends on, because every
dependency resolves silently.

Alternatives considered:

- **Keep Babel and add a bundler later.** Defers the inventory, which
  is the thing that makes the rest of the plan estimable.
- **webpack.** Would work, but is heavier configuration for a build
  with one entry point and no dev-server requirement.
- **esbuild directly.** Close to what Vite uses internally, but leaves
  externalization, aliasing and asset handling to hand-written config.

## Decision

Build `src/renderer/main.js` with Vite (`npm run build:renderer`),
output to `build-vite/`, and remove the `Module.prototype.require`
monkey patch in favour of a Vite `resolve.alias` entry pointing at
`stubs/inline-style-prefixer.js`.

Run the build early and deliberately let it fail. Each distinct
failure becomes one line of an inventory recorded in
`docs/vite-baseline.md`: JSX, CommonJS, Node builtins, Electron. That
inventory is what the subsequent stories work through.

Two Vite-specific accommodations were needed and are documented in
`vite.config.js`:

- Every renderer component puts JSX inside a `.js` file, which no
  bundler treats as JSX by default. Vite 8 is Rolldown-based and
  ignores an explicit `lang` for `.js` during a production build, so a
  small `enforce: 'pre'` plugin calls `transformWithOxc` directly with
  `lang: 'jsx'` and `runtime: 'classic'`, scoped by absolute path
  prefix to this repo's own `src/`.
- Vite targets browsers and statically replaces bare `process.env`
  with `{}`, which broke `application-config-path`'s `process.env.HOME`
  read on the first `path.join()` of startup. The replacement is
  routed through `globalThis.process.env` instead.

The alias is matched exactly (`/^inline-style-prefixer$/`) so
material-ui's deep imports into the real package still resolve.

## Consequences

The renderer's true dependency surface becomes visible and finite.
Anything the bundler cannot resolve is a decision that has to be made
rather than a runtime detail that happens to work.

The monkey patch is gone, so the renderer no longer depends on a
mutable Node module loader being present.

The JSX-in-`.js` convention now costs a custom plugin. A future move
to `.jsx` extensions would delete it, but that is a large mechanical
rename this project has not taken on.

`process.env` in the renderer still resolves to the real environment,
which is correct today and is one more thing a Tauri host will have to
provide or the call sites will have to lose.

Build output now lands in two directories, which ADR-003 covers.
