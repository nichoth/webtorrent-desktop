# src/renderer/pages/

## app.js owns the view and modal registries

`app.js` maps a route to a component through two plain objects, `Views`
(keyed by `state.location.url()`) and `Modals` (keyed by
`state.modal.id`). Adding a page or a modal means adding a static
`import` **and** an entry in the matching map -- there is no dynamic
lookup by filename.

Both maps used to hold `fn-getter` thunks wrapping lazy `require()`
calls. ESM has no synchronous import, so the thunks are gone and every
page and modal is now loaded at startup. Do not reintroduce a
`require()` here to make something lazy: the renderer is moving to a
Vite bundle where a bare `require()` does not resolve. If lazy loading
is ever needed again it has to be `import()` plus async handling in
`getView` / `getModal`.

## Importing still-CommonJS siblings

Most of `components/`, `controllers/` and `lib/` is still
`module.exports = X`. Import those with a default import
(`import Heading from '../components/heading'`) and multi-value modules
such as `lib/dispatcher` with named imports -- Babel's interop and
Rolldown both handle it. `material-ui/**` submodules end in
`.default`, so a default import is correct there too, except
`material-ui/styles/colors`, which is a bag of named exports with no
default (`import { grey400 } from ...`).

A third-party `require('pkg').default` (for example `bitfield`) becomes
a plain `import Pkg from 'pkg'`. Check the package first: dropping
`.default` is only correct when its CommonJS build sets
`__esModule`, or when its `exports.import` entry has a real
`export default`. If neither holds, a default import silently yields
the whole module object.
