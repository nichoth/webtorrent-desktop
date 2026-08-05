/**
 * Platform shim (FR-8): the sole source of Electron and Node access
 * for `src/renderer/`.
 *
 * Import the namespace you need rather than the barrel where you can
 * -- `import * as shell from '../lib/platform/shell'` -- so the
 * bundler can drop what you do not use. The barrel exists so a
 * caller that needs several concerns has one import, and so the
 * shim's whole surface is discoverable from one file.
 *
 * `ipcOs` and `ipcEngine` are separate namespaces on purpose (FR-9):
 * the engine is swapped independently of the UI host.
 *
 * See docs/platform-shim.md for the surface mapped against the call
 * sites it replaces.
 */

import * as clipboard from './clipboard'
import * as dialog from './dialog'
import * as fs from './fs'
import * as ipcEngine from './ipc-engine'
import * as ipcOs from './ipc-os'
import * as menu from './menu'
import * as paths from './paths'
import * as shell from './shell'
import * as window from './window'

export {
  clipboard,
  dialog,
  fs,
  ipcEngine,
  ipcOs,
  menu,
  paths,
  shell,
  window
}
