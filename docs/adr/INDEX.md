# Architecture Decision Records

Decisions that shape how WebTorrent Desktop is built, recorded as they
are made. Read this index first; open an individual ADR only when its
subject is relevant to what you are doing.

ADR-001 through ADR-010 were written on 2026-07-29 by reading back
over Phases 1 and 2, which had already shipped. Each is dated to the
commit that put the decision into effect, not to the day it was
written down. The source material was `docs/init.md`,
`specs/prd.json`, `docs/vite-baseline.md` and `docs/platform-shim.md`;
those remain the detailed references, and the ADRs record why the
decisions were taken and what they cost.

| # | Decision | Date |
|---|----------|------|
| [ADR-001](ADR-001-decouple-renderer-before-porting-to-tauri.md) | Decouple the renderer in place before porting to Tauri | 2026-07-26 |
| [ADR-002](ADR-002-vite-builds-the-renderer.md) | Build the renderer UI with Vite | 2026-07-27 |
| [ADR-003](ADR-003-two-build-split-babel-and-vite.md) | Keep two builds, and stop the ESM conversion at the renderer | 2026-07-27 |
| [ADR-004](ADR-004-cjs-output-with-host-externals.md) | Emit CommonJS and externalize host modules | 2026-07-27 |
| [ADR-005](ADR-005-platform-shim-is-the-only-host-access.md) | Route all renderer host access through an all-async platform shim | 2026-07-28 |
| [ADR-006](ADR-006-engine-ipc-separate-from-os-ipc.md) | Split engine IPC from OS IPC into two modules sharing no exports | 2026-07-28 |
| [ADR-007](ADR-007-no-host-objects-cross-the-boundary.md) | No host object crosses the shim boundary | 2026-07-28 |
| [ADR-008](ADR-008-deferred-casualties-exempt-from-the-shim.md) | Name two deferred casualties and exempt them from the shim | 2026-07-27 |
| [ADR-009](ADR-009-two-mechanisms-enforce-the-boundary.md) | Enforce the shim boundary with two complementary mechanisms | 2026-07-28 |
| [ADR-010](ADR-010-unit-tests-run-against-babel-output.md) | Unit tests require Babel output under `build/`, never `src/` | 2026-07-28 |
| [ADR-011](ADR-011-first-party-path-implementation.md) | Own the renderer's `path` implementation | 2026-07-29 |
| [ADR-012](ADR-012-engine-runs-as-a-node-sidecar.md) | Run the engine as a Node sidecar the renderer connects to | 2026-07-29 |
| [ADR-013](ADR-013-poster-generation-without-a-dom.md) | Generate posters in the UI renderer, not in the engine | 2026-07-29 |
| [ADR-014](ADR-014-dual-host-during-the-tauri-port.md) | Run two hosts side by side, and select the shim at build time | 2026-07-29 |
| [ADR-015](ADR-015-casting-without-node.md) | Move casting into the host, one protocol at a time | 2026-08-04 |
| [ADR-016](ADR-016-pinned-runtime-and-closure-in-the-bundle.md) | Ship a pinned Node runtime and the engine's closure in the bundle | 2026-08-07 |

## Related documents

- `docs/init.md` -- the original five-phase plan and the measurements
  behind it.
- `docs/vite-baseline.md` -- the Phase 1 failure inventory, resolved
  item by item.
- `docs/platform-shim.md` -- the shim's API surface and the full
  `wt-*` protocol contract.
- `specs/prd.json` and `tasks/prd-renderer-decoupling.md` -- the
  numbered requirements (FR-*) the ADRs cite.
