module.exports = {
  init,
  setModule
}

const { app, ipcMain } = require('electron')

const log = require('./log')
const menu = require('./menu')
const windows = require('./windows')

// Will hold modules injected from the app that will be used on fired
// IPC events.
const modules = {}

function setModule (name, module) {
  modules[name] = module
}

function init () {
  ipcMain.once('ipcReady', e => {
    app.ipcReady = true
    app.emit('ipcReady')
  })

  /**
   * Dialog
   */

  ipcMain.on('openTorrentFile', () => {
    const dialog = require('./dialog')
    dialog.openTorrentFile()
  })
  ipcMain.on('openFiles', () => {
    const dialog = require('./dialog')
    dialog.openFiles()
  })

  /**
   * Dock
   */

  ipcMain.on('setBadge', (e, ...args) => {
    const dock = require('./dock')
    dock.setBadge(...args)
  })
  ipcMain.on('downloadFinished', (e, ...args) => {
    const dock = require('./dock')
    dock.downloadFinished(...args)
  })

  /**
   * Player Events
   */

  ipcMain.on('onPlayerOpen', () => {
    const powerSaveBlocker = require('./power-save-blocker')
    const shortcuts = require('./shortcuts')

    menu.togglePlaybackControls(true)
    powerSaveBlocker.enable()
    shortcuts.enable()
  })

  ipcMain.on('onPlayerUpdate', (e, ...args) => {
    menu.onPlayerUpdate(...args)
  })

  ipcMain.on('onPlayerClose', () => {
    const powerSaveBlocker = require('./power-save-blocker')
    const shortcuts = require('./shortcuts')

    menu.togglePlaybackControls(false)
    powerSaveBlocker.disable()
    shortcuts.disable()
  })

  ipcMain.on('onPlayerPlay', () => {
    const powerSaveBlocker = require('./power-save-blocker')
    powerSaveBlocker.enable()
  })

  ipcMain.on('onPlayerPause', () => {
    const powerSaveBlocker = require('./power-save-blocker')
    powerSaveBlocker.disable()
  })

  /**
   * Folder Watcher Events
   */

  ipcMain.on('startFolderWatcher', () => {
    if (!modules.folderWatcher) {
      log('IPC ERR: folderWatcher module is not defined.')
      return
    }

    modules.folderWatcher.start()
  })

  ipcMain.on('stopFolderWatcher', () => {
    if (!modules.folderWatcher) {
      log('IPC ERR: folderWatcher module is not defined.')
      return
    }

    modules.folderWatcher.stop()
  })

  /**
   * Shell
   */

  ipcMain.on('openPath', (e, ...args) => {
    const shell = require('./shell')
    shell.openPath(...args)
  })
  ipcMain.on('showItemInFolder', (e, ...args) => {
    const shell = require('./shell')
    shell.showItemInFolder(...args)
  })
  ipcMain.on('moveItemToTrash', (e, ...args) => {
    const shell = require('./shell')
    shell.moveItemToTrash(...args)
  })

  /**
   * File handlers
   */

  ipcMain.on('setDefaultFileHandler', (e, flag) => {
    const handlers = require('./handlers')

    if (flag) handlers.install()
    else handlers.uninstall()
  })

  /**
   * Auto start on login
   */

  ipcMain.on('setStartup', (e, flag) => {
    const startup = require('./startup')

    if (flag) startup.install()
    else startup.uninstall()
  })

  /**
   * Windows: Main
   */

  const main = windows.main

  ipcMain.on('setAspectRatio', (e, ...args) => main.setAspectRatio(...args))
  ipcMain.on('setBounds', (e, ...args) => main.setBounds(...args))
  ipcMain.on('setProgress', (e, ...args) => main.setProgress(...args))
  ipcMain.on('setTitle', (e, ...args) => main.setTitle(...args))
  ipcMain.on('show', () => main.show())
  ipcMain.on('toggleFullScreen', (e, ...args) => main.toggleFullScreen(...args))
  ipcMain.on('setAllowNav', (e, ...args) => menu.setAllowNav(...args))

  /**
   * Engine sidecar (US-042)
   *
   * Request/response over one channel, answering with plain data: the
   * URL and the per-launch token, never the supervisor or any Electron
   * object (ADR-007). The renderer asks on every connect because the
   * port changes across a restart, and the reply is deliberately made
   * to wait while a restart is in flight rather than reporting `null`
   * for a sidecar that is about to come back.
   */

  ipcMain.on('getEngineEndpoint', e => {
    const engineProcess = require('./engine-process')

    // The window can go away during that wait, and sending to a
    // destroyed webContents throws.
    const reply = endpoint => {
      if (!e.sender.isDestroyed()) e.sender.send('getEngineEndpoint', endpoint)
    }

    engineProcess.waitForEndpoint().then(reply, err => {
      log.error('engine: no endpoint to report: ' + err.message)
      reply(null)
    })
  })

  /**
   * External Media Player
   */

  ipcMain.on('checkForExternalPlayer', (e, path) => {
    const externalPlayer = require('./external-player')

    externalPlayer.checkInstall(path, err => {
      windows.main.send('checkForExternalPlayer', !err)
    })
  })

  ipcMain.on('openExternalPlayer', (e, ...args) => {
    const externalPlayer = require('./external-player')
    const shortcuts = require('./shortcuts')

    menu.togglePlaybackControls(false)
    shortcuts.disable()
    externalPlayer.spawn(...args)
  })

  ipcMain.on('quitExternalPlayer', () => {
    const externalPlayer = require('./external-player')
    externalPlayer.kill()
  })

  /**
   * No engine traffic passes through here (US-045, ADR-012). The UI
   * reaches the sidecar over its own WebSocket, so `ipcMain.emit` is
   * left as Electron shipped it and the host's only engine-related job
   * is the endpoint reply above.
   */
}
