/**
 * Tauri shim: the engine protocol -- and the one module in this tree
 * that is not a stub.
 *
 * `ipc-engine.js` stopped being host code in US-044. It is a
 * WebSocket client of the sidecar (ADR-012), it imports no Electron
 * and no Node module, and `eslint-boundary.config.js` bans it from
 * ever importing one again. There is therefore nothing about it for a
 * Tauri implementation to do differently, and no Phase 4 story
 * reimplements it: US-070 moves the sidecar's *supervision* into
 * Rust, which this module reaches through
 * `ipc-os.getEngineEndpoint()` -- and that one is stubbed like the
 * rest.
 *
 * So this file re-exports the sibling rather than forking 500 lines
 * that would have to be kept in step by hand. Stubbing it instead
 * would have taken the torrent engine out of the Tauri build for the
 * whole of Phase 4 with no story to put it back, which ADR-014 calls
 * a sequencing error rather than a plan.
 *
 * The re-export is safe against the resolver in `bin/shim-resolver.js`
 * because that rewrite skips any import made from inside this
 * directory: `../ipc-engine` resolves to the sibling and is left
 * alone rather than bending back here.
 */

export * from '../ipc-engine'
