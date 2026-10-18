import path from 'path'

import { dispatch, dropDispatchers, reportErrors } from '../lib/dispatcher'
import { TorrentKeyNotFoundError } from '../lib/errors'
import * as os from '../lib/os'
import * as sound from '../lib/sound'
import * as TorrentSummary from '../lib/torrent-summary'
import * as clipboard from '../lib/platform/clipboard'
import * as platformDialog from '../lib/platform/dialog'
import * as fs from '../lib/platform/fs'
import * as ipcEngine from '../lib/platform/ipc-engine'
import * as menu from '../lib/platform/menu'
import * as shell from '../lib/platform/shell'

const instantIoRegex = /^(https:\/\/)?instant\.io\/#/

// Controls the torrent list: creating, adding, deleting, & manipulating torrents
export default class TorrentListController {
  constructor (state) {
    this.state = state
  }

  // Adds a torrent to the list, starts downloading/seeding.
  // TorrentID can be a magnet URI, infohash, or torrent file: https://git.io/vik9M
  addTorrent (torrentId) {
    if (torrentId.path) {
      // Use path string instead of W3C File object
      torrentId = torrentId.path
    }

    // Trim extra spaces off pasted magnet links
    if (typeof torrentId === 'string') {
      torrentId = torrentId.trim()
    }

    // Allow a instant.io link to be pasted
    if (typeof torrentId === 'string' && instantIoRegex.test(torrentId)) {
      torrentId = torrentId.slice(torrentId.indexOf('#') + 1)
    }

    const torrentKey = this.state.nextTorrentKey++
    const path = this.state.saved.prefs.downloadPath

    reportErrors(ipcEngine.startTorrenting(torrentKey, torrentId, path))

    dispatch('backToList')
  }

  // Shows the Create Torrent page with options to seed a given file or folder
  showCreateTorrent (files) {
    // You can only create torrents from the home screen.
    if (this.state.location.url() !== 'home') {
      return dispatch('error', 'Please go back to the torrent list before creating a new torrent.')
    }

    // Files will either be an array of file objects, which we can send directly
    // to the create-torrent screen
    if (files.length === 0 || typeof files[0] !== 'string') {
      this.state.location.go({
        url: 'create-torrent',
        files,
        setup: (cb) => {
          this.state.window.title = 'Create New Torrent'
          cb(null)
        }
      })
      return
    }

    // ... or it will be an array of mixed file and folder paths. We have to walk
    // through all the folders and find the files
    findFilesRecursive(files, (allFiles) => this.showCreateTorrent(allFiles))
  }

  // Creates a new torrent and start seeeding
  createTorrent (options) {
    const state = this.state
    const torrentKey = state.nextTorrentKey++
    reportErrors(ipcEngine.createTorrent(torrentKey, options))
    state.location.cancel()
  }

  // Starts downloading and/or seeding a given torrentSummary.
  startTorrentingSummary (torrentKey) {
    const s = TorrentSummary.getByKey(this.state, torrentKey)
    if (!s) throw new TorrentKeyNotFoundError(torrentKey)

    // New torrent: give it a path
    if (!s.path) {
      // Use Downloads folder by default
      s.path = this.state.saved.prefs.downloadPath
      return start()
    }

    const fileOrFolder = TorrentSummary.getFileOrFolder(s)

    // New torrent: metadata not yet received
    if (!fileOrFolder) return start()

    // Existing torrent: check that the path is still there
    fs.stat(fileOrFolder).then(start, () => {
      s.error = 'path-missing'
      dispatch('backToList')
    })

    function start () {
      reportErrors(ipcEngine.startTorrenting(
        s.torrentKey,
        TorrentSummary.getTorrentId(s),
        s.path,
        s.fileModtimes,
        s.selections))
    }
  }

  setGlobalTrackers (globalTrackers) {
    reportErrors(ipcEngine.setGlobalTrackers(globalTrackers))
  }

  // TODO: use torrentKey, not infoHash
  toggleTorrent (infoHash) {
    const torrentSummary = TorrentSummary.getByKey(this.state, infoHash)
    if (torrentSummary.status === 'paused') {
      torrentSummary.status = 'new'
      this.startTorrentingSummary(torrentSummary.torrentKey)
      sound.play('ENABLE')
      return
    }

    this.pauseTorrent(torrentSummary, true)
  }

  pauseAllTorrents () {
    this.state.saved.torrents.forEach((torrentSummary) => {
      if (torrentSummary.status === 'downloading' ||
          torrentSummary.status === 'seeding') {
        torrentSummary.status = 'paused'
        reportErrors(ipcEngine.stopTorrenting(torrentSummary.infoHash))
      }
    })
    sound.play('DISABLE')
  }

  resumeAllTorrents () {
    this.state.saved.torrents.forEach((torrentSummary) => {
      if (torrentSummary.status === 'paused') {
        torrentSummary.status = 'downloading'
        this.startTorrentingSummary(torrentSummary.torrentKey)
      }
    })
    sound.play('ENABLE')
  }

  pauseTorrent (torrentSummary, playSound) {
    torrentSummary.status = 'paused'
    reportErrors(ipcEngine.stopTorrenting(torrentSummary.infoHash))

    if (playSound) sound.play('DISABLE')
  }

  prioritizeTorrent (infoHash) {
    this.state.saved.torrents
      .filter(torrent => ['downloading', 'seeding'].includes(torrent.status)) // Active torrents only.
      .forEach((torrent) => { // Pause all active torrents except the one that started playing.
        if (infoHash === torrent.infoHash) return

        // Pause torrent without playing sounds.
        this.pauseTorrent(torrent, false)

        const toResume = this.state.saved.torrentsToResume
        if (!toResume.includes(torrent.infoHash)) {
          toResume.push(torrent.infoHash)
        }
      })

    console.log('Playback Priority: paused torrents: ', this.state.saved.torrentsToResume)
  }

  resumePausedTorrents () {
    console.log('Playback Priority: resuming paused torrents')
    const toResume = this.state.saved.torrentsToResume
    if (!toResume || !toResume.length) return

    // reset paused torrents first, so the list is cleared even if
    // resuming one of them throws
    this.state.saved.torrentsToResume = []

    // skip any info hash that no longer names a torrent (one deleted
    // while paused, or saved in a profile before deletes cleaned up)
    toResume
      .filter((infoHash) => TorrentSummary.getByKey(this.state, infoHash))
      .forEach((infoHash) => this.toggleTorrent(infoHash))
  }

  toggleTorrentFile (infoHash, index) {
    const torrentSummary = TorrentSummary.getByKey(this.state, infoHash)
    torrentSummary.selections[index] = !torrentSummary.selections[index]

    // Let the WebTorrent process know to start or stop fetching that file
    if (torrentSummary.status !== 'paused') {
      reportErrors(
        ipcEngine.selectFiles(infoHash, torrentSummary.selections))
    }
  }

  confirmDeleteTorrent (infoHash, deleteData) {
    this.state.modal = {
      id: 'remove-torrent-modal',
      infoHash,
      deleteData
    }
  }

  confirmDeleteAllTorrents (deleteData) {
    this.state.modal = {
      id: 'delete-all-torrents-modal',
      deleteData
    }
  }

  // TODO: use torrentKey, not infoHash
  deleteTorrent (infoHash, deleteData) {
    const index = this.state.saved.torrents.findIndex((x) => x.infoHash === infoHash)

    if (index > -1) {
      const summary = this.state.saved.torrents[index]
      deleteTorrentFile(summary, deleteData)

      // remove torrent from saved list
      this.state.saved.torrents.splice(index, 1)

      // a deleted torrent must never be resumed after playback
      if (this.state.saved.torrentsToResume) {
        this.state.saved.torrentsToResume =
          this.state.saved.torrentsToResume.filter((x) => x !== infoHash)
      }
      // memoized handlers can name the deleted torrent's files
      dropDispatchers()
      dispatch('stateSave')

      // prevent user from going forward to a deleted torrent
      this.state.location.clearForward('player')
      sound.play('DELETE')
    } else {
      throw new TorrentKeyNotFoundError(infoHash)
    }
  }

  deleteAllTorrents (deleteData) {
    // Go back to list before the current playing torrent is deleted
    if (this.state.location.url() === 'player') {
      dispatch('backToList')
    }

    this.state.saved.torrents.forEach((summary) => deleteTorrentFile(summary, deleteData))

    this.state.saved.torrents = []
    this.state.saved.torrentsToResume = []
    dropDispatchers()
    dispatch('stateSave')

    // prevent user from going forward to a deleted torrent
    this.state.location.clearForward('player')
    sound.play('DELETE')
  }

  toggleSelectTorrent (infoHash) {
    if (this.state.selectedInfoHash === infoHash) {
      this.state.selectedInfoHash = null
    } else {
      this.state.selectedInfoHash = infoHash
    }
  }

  openTorrentContextMenu (infoHash) {
    const torrentSummary = TorrentSummary.getByKey(this.state, infoHash)
    const sortedByName = this.state.saved.prefs.sortByName

    // The menu is data (FR-12): plain descriptors, no MenuItem here.
    // The shim pops it up and parents it to the current window itself.
    const items = [
      {
        label: 'Remove From List',
        click: () => dispatch('confirmDeleteTorrent', torrentSummary.infoHash, false)
      },
      {
        label: 'Remove Data File',
        click: () => dispatch('confirmDeleteTorrent', torrentSummary.infoHash, true)
      },
      { type: 'separator' },
      // Nothing to reveal until the torrent's metadata has arrived.
      ...(torrentSummary.files
        ? [
            {
              label: os.isDarwin() ? 'Show in Finder' : 'Show in Folder',
              click: () => showItemInFolder(torrentSummary)
            },
            { type: 'separator' }
          ]
        : []),
      {
        label: 'Copy Magnet Link to Clipboard',
        click: () => copyToClipboard(torrentSummary.magnetURI)
      },
      {
        label: 'Copy Instant.io Link to Clipboard',
        click: () => copyToClipboard(`https://instant.io/#${torrentSummary.infoHash}`)
      },
      {
        label: 'Save Torrent File As...',
        click: () => dispatch('saveTorrentFileAs', torrentSummary.torrentKey),
        enabled: torrentSummary.torrentFileName != null
      },
      { type: 'separator' },
      {
        label: `${sortedByName ? '✓ ' : ''}Sort by Name`,
        click: () => dispatch('updatePreferences', 'sortByName', !sortedByName)
      }
    ]

    menu.showContextMenu(items).catch((err) => dispatch('error', err))
  }

  // Takes a torrentSummary or torrentKey
  // Shows a Save File dialog, then saves the .torrent file wherever the user requests
  saveTorrentFileAs (torrentKey) {
    const torrentSummary = TorrentSummary.getByKey(this.state, torrentKey)
    if (!torrentSummary) throw new TorrentKeyNotFoundError(torrentKey)
    const downloadPath = this.state.saved.prefs.downloadPath
    const newFileName = path.parse(torrentSummary.name).name + '.torrent'
    const opts = {
      title: 'Save Torrent File',
      defaultPath: path.join(downloadPath, newFileName),
      filters: [
        { name: 'Torrent Files', extensions: ['torrent'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      buttonLabel: 'Save'
    }

    // The shim parents the dialog to the current window itself.
    platformDialog.showSaveDialog(opts)
      .then(savePath => {
        if (!savePath) return // They clicked Cancel
        console.log('Saving torrent ' + torrentKey + ' to ' + savePath)
        const torrentPath = TorrentSummary.getTorrentPath(torrentSummary)
        return fs.readFile(torrentPath)
          .then(torrentFile => fs.writeFile(savePath, torrentFile))
      })
      .catch(err => dispatch('error', err))
  }
}

// Recursively finds {name, path, size} for all files in a folder
// Calls `cb` on success, calls `onError` on failure
function findFilesRecursive (paths, cb_) {
  if (paths.length > 1) {
    let numComplete = 0
    const ret = []
    paths.forEach(path => {
      findFilesRecursive([path], fileObjs => {
        ret.push(...fileObjs)
        if (++numComplete === paths.length) {
          ret.sort((a, b) => a.path < b.path ? -1 : Number(a.path > b.path))
          cb_(ret)
        }
      })
    })
    return
  }

  const fileOrFolder = paths[0]
  // The shim's stat resolves a plain object, so `isDirectory` is a
  // boolean rather than a method.
  fs.stat(fileOrFolder)
    .then(stat => {
      // Files: return name, path, and size
      if (!stat.isDirectory) {
        const filePath = fileOrFolder
        return cb_([{
          name: path.basename(filePath),
          path: filePath,
          size: stat.size
        }])
      }

      // Folders: recurse, make a list of all the files
      const folderPath = fileOrFolder
      return fs.readdir(folderPath).then(fileNames => {
        const paths = fileNames.map((fileName) =>
          path.join(folderPath, fileName))
        findFilesRecursive(paths, cb_)
      })
    })
    .catch(err => dispatch('error', err))
}

function deleteFile (path) {
  if (!path) return
  fs.unlink(path).catch(err => dispatch('error', err))
}

// Context-menu click handlers cannot await, so the shim's promise
// (FR-10) is terminated here rather than left floating.
function copyToClipboard (text) {
  clipboard.writeText(text).catch((err) => dispatch('error', err))
}

// Delete all files in a torrent
function moveItemToTrash (torrentSummary) {
  const filePath = TorrentSummary.getFileOrFolder(torrentSummary)
  if (!filePath) return
  shell.moveItemToTrash(filePath).catch((err) => dispatch('error', err))
}

function showItemInFolder (torrentSummary) {
  shell.showItemInFolder(TorrentSummary.getFileOrFolder(torrentSummary))
    .catch((err) => dispatch('error', err))
}

function deleteTorrentFile (torrentSummary, deleteData) {
  reportErrors(ipcEngine.stopTorrenting(torrentSummary.infoHash))

  // remove torrent and poster file
  deleteFile(TorrentSummary.getTorrentPath(torrentSummary))
  deleteFile(TorrentSummary.getPosterPath(torrentSummary))

  // optionally delete the torrent data
  if (deleteData) moveItemToTrash(torrentSummary)
}
