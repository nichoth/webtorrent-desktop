import { reportErrors } from '../lib/dispatcher'
import * as ipcOs from '../lib/platform/ipc-os'

export default class FolderWatcherController {
  start () {
    console.log('-- IPC: start folder watcher')
    reportErrors(ipcOs.startFolderWatcher())
  }

  stop () {
    console.log('-- IPC: stop folder watcher')
    reportErrors(ipcOs.stopFolderWatcher())
  }
}
