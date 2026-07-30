/**
 * The Tauri tree's barrel, mirroring `../index.js` namespace for
 * namespace.
 *
 * It exists so the rewrite in `bin/shim-resolver.js` needs no special
 * case: every `.js` file directly under `lib/platform/` has a
 * counterpart here, the barrel included, so a caller that imports the
 * barrel gets the same tree as a caller that imports a module.
 *
 * The relative imports below resolve inside this directory on their
 * own -- the resolver skips anything imported from in here -- so this
 * file is a plain mirror with no host knowledge of its own.
 *
 * Keep the `import * as x` plus `export { x }` shape of `../index.js`:
 * three toolchains (`standard`, Babel, Rolldown) have to agree on the
 * syntax, which is why it is not `export * as x from`.
 */

import * as clipboard from './clipboard'
import * as dialog from './dialog'
import * as fs from './fs'
import * as ipcEngine from './ipc-engine'
import * as ipcOs from './ipc-os'
import * as menu from './menu'
import * as shell from './shell'
import * as window from './window'

export {
  clipboard,
  dialog,
  fs,
  ipcEngine,
  ipcOs,
  menu,
  shell,
  window
}
