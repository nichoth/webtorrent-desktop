# src/shared/

Code that both sides of a process boundary have to agree on. Nothing
here may import Electron, Tauri, `electron.ipcRenderer`, or anything
from `src/main/`, `src/renderer/` or `src/engine/`: every module here
is loaded by at least two hosts, so a host-specific import breaks one
of them.

Written as ESM. `build:main` compiles the whole of `src` except the
four Vite-owned paths (`src/renderer/main.js`, `components/`,
`controllers/`, `pages/`), so a file added here is emitted to
`build/shared/` with no build change -- that is also the path unit
tests require.

Both hosts means both runtimes. Node globals (`Buffer`,
`TextDecoder`) may be *used* but must be feature-detected, never
assumed, and no Node builtin may be imported: `wire.js` runs in the
sidecar under plain `node` and in a webview that may not be
Node-integrated.

## `wire.js`

The `wt-*` codec (US-038, ADR-012). One `{ channel, args }` JSON
envelope, `encode(channel, args)` / `decode(message)`.

The channel names, argument lists and payload shapes it carries are
the contract in `docs/platform-shim.md`, not something this module
defines -- it knows only how values become bytes. When a payload shape
changes there, add a sample to `test/unit/wire.js`; that file
round-trips one payload per channel and is the only place the two
tables are checked against a real codec.

Two rules the tests enforce and that are easy to break:

- **`null` and `undefined` must stay distinguishable.** JSON turns
  both into `null` inside an array, but `wt-warning` and `wt-error`
  send a real `null` for `torrentKey`. `undefined` and non-finite
  numbers are therefore tagged, not left to `JSON.stringify`.
- **Nothing crosses the wire lossily.** A value JSON cannot carry
  (function, symbol, bigint, raw `ArrayBuffer`, non-byte typed array)
  throws in `encode` rather than arriving as `null` or `{}`. Adding a
  new carryable type means a tag plus a round-trip test, not a
  fallback.

`Uint8Array` and `Buffer` are tagged separately and each decodes back
to its own type. `Progress.bitfield` is the reason: the engine puts a
`bitfield` instance on the wire, the prototype does not survive, and
`pages/player-page.js` reads the result with
`BitField.prototype.get.call(...)`, which needs `buffer` to still be a
byte array.
