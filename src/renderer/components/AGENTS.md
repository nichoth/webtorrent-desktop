# src/renderer/components/

Every file here is a single-component module: one `export default` and
nothing else. Keep it that way -- `pages/app.js` maps modals and views
to these modules by static default import, so adding a named export
alongside the default gains nothing and adding a second component to a
file breaks the one-file-one-component convention the page layer
assumes.

## Import conventions

Same rules as `pages/` (see `../pages/AGENTS.md`):

- `material-ui/**` submodules are CJS ending in `.default`, so a plain
  default import is correct (`import TextField from
  'material-ui/TextField'`).
- `material-ui/styles/colors` is the exception: named exports, no
  default. Import the specific colour (`import { grey100 } from
  'material-ui/styles/colors'`), not a namespace.
- `lib/dispatcher` is multi-value, so `import { dispatch, dispatcher }
  from '../lib/dispatcher'` even while that module is still CommonJS.

## `electron` imports are temporary

`unsupported-media-modal.js` and `update-available-modal.js` import
`shell`, and `open-torrent-address-modal.js` imports `clipboard`,
straight from `electron`. `path-selector.js` imports
`@electron/remote`. These are the call sites Phase 2 migrates to the
platform shim (US-022, US-024, US-027). Do not add new direct
`electron` imports here.

## create-torrent-error-page is unreachable today

`pages/create-torrent-page.js` renders it with
`return (<CreateTorrentErrorPage .../>)` from inside its
**constructor**, which JavaScript treats as replacing the instance
rather than as a render result. The component therefore never appears
on screen and cannot be exercised at runtime. This is pre-existing and
out of scope for the ESM work; verify changes to it statically
(lint, Babel compile, presence in the Vite bundle) rather than hunting
for a way to render it.
