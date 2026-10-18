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

## The player's DOM reads run in a webview, not in Chromium

`player-page.js` is the only page that touches media APIs, and the
window is no longer the same engine on every platform (ADR-014). Two
rules, both learned in US-081 and both enforced by
`lib/media-playability.js` rather than inline here:

- **A non-standard property may be missing, and missing is not empty.**
  `videoTracks` and `audioTracks` exist on WebKit and are behind a flag
  in Chromium, and Electron turned that flag on. Reading `.length` off
  the absent one threw from inside `loadedmetadata`, which took the
  rest of the handler with it -- no `mediaError`, no `mediaSuccess`, no
  window resize, and a black window with no modal to explain it. Treat
  absent as "no opinion".
- **Present is not populated, and `loadedmetadata` is too early.**
  WKWebView reports both lists with `length === 0` at
  `loadedmetadata` and fills them from `addtrack` before `loadeddata`
  (US-082, measured). Every read of either list belongs in
  `onLoadedData`; read them a beat earlier and the codec check sees no
  decodable track in a file that plays perfectly, and the
  unsupported-media modal covers every video. `test/unit/audio-
  tracks.js` asserts this against this file's source, because a page
  with a media element in it cannot be loaded in a unit test.
- **The element chooses the starting audio track, not this file.**
  Read back whichever track is `enabled` and apply the user's later
  choice on top (`lib/audio-tracks.js`). Assuming track 0 and forcing
  it on overrides the default track of any file that has another one.
- **Ask `lib/media-playability.js`, do not re-derive.** What this
  window can decode is measured, per engine, and written down in
  `docs/codec-support.md`; an extension list in this file would be the
  Chromium assumption again under another name.

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

## React lifecycle hooks must use React's exact names

A misnamed hook such as `onComponentWillUnmount` is just an unused
method: React never calls it, and nothing warns you. Pages cannot be
loaded in the unit suite, so check by hand that teardown code in a
page actually runs. `player-page.js`'s `componentWillUnmount` unloads
every media element (main and `video#preview`) and resets
`navigator.mediaSession`. `renderMedia()` sets the metadata only while
it is `null`, so that reset is what lets the next play show fresh
metadata.
