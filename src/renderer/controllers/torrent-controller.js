import path from 'path'

import * as TorrentSummary from '../lib/torrent-summary'
import * as sound from '../lib/sound'
import * as ipcEngine from '../lib/platform/ipc-engine'
import * as ipcOs from '../lib/platform/ipc-os'
import { generateTorrentPoster as makePoster } from '../lib/torrent-poster'
import { dispatch, reportErrors } from '../lib/dispatcher'

export default class TorrentController {
  constructor (state) {
    this.state = state
  }

  torrentParsed (torrentKey, infoHash, magnetURI) {
    let torrentSummary = this.getTorrentSummary(torrentKey)
    console.log('got infohash for %s torrent %s',
      torrentSummary ? 'existing' : 'new', torrentKey)

    if (!torrentSummary) {
      const torrents = this.state.saved.torrents

      // Check if an existing (non-active) torrent has the same info hash
      if (torrents.find((t) => t.infoHash === infoHash)) {
        reportErrors(ipcEngine.stopTorrenting(infoHash))
        return dispatch('error', 'Cannot add duplicate torrent')
      }

      torrentSummary = {
        torrentKey,
        status: 'new'
      }
      torrents.unshift(torrentSummary)
      sound.play('ADD')
    }

    torrentSummary.infoHash = infoHash
    torrentSummary.magnetURI = magnetURI
    dispatch('update')
  }

  torrentWarning (torrentKey, message) {
    console.log('warning for torrent %s: %s', torrentKey, message)
  }

  torrentError (torrentKey, message) {
    // TODO: WebTorrent needs semantic errors
    if (message.startsWith('Cannot add duplicate torrent')) {
      // Remove infohash from the message
      message = 'Cannot add duplicate torrent'
    }
    dispatch('error', message)

    const torrentSummary = this.getTorrentSummary(torrentKey)
    if (torrentSummary) {
      console.log('Pausing torrent %s due to error: %s', torrentSummary.infoHash, message)
      torrentSummary.status = 'paused'
      dispatch('update')
    }
  }

  torrentMetadata (torrentKey, torrentInfo) {
    // Summarize torrent
    const torrentSummary = this.getTorrentSummary(torrentKey)
    torrentSummary.status = 'downloading'
    torrentSummary.name = torrentSummary.displayName || torrentInfo.name
    torrentSummary.path = torrentInfo.path
    // TODO: make torrentInfo immutable, save separately as torrentSummary.info
    // For now, check whether torrentSummary.files has already been set:
    const hasDetailedFileInfo = torrentSummary.files && torrentSummary.files[0].path
    if (!hasDetailedFileInfo) {
      torrentSummary.files = torrentInfo.files
    }
    if (!torrentSummary.selections) {
      torrentSummary.selections = torrentSummary.files.map((x) => true)
    }
    dispatch('update')

    // Save the .torrent file, if it hasn't been saved already
    if (!torrentSummary.torrentFileName) {
      reportErrors(ipcEngine.saveTorrentFile(torrentKey))
    }

    // Auto-generate a poster image, if it hasn't been generated already.
    // ADR-013: the poster is made here, in the window that has a media
    // decoder and a canvas, not by the engine.
    if (!torrentSummary.posterFileName) {
      reportErrors(this.generateTorrentPoster(torrentKey))
    }
  }

  torrentDone (torrentKey, torrentInfo) {
    // Update the torrent summary
    const torrentSummary = this.getTorrentSummary(torrentKey)
    torrentSummary.status = 'seeding'

    // Notify the user that a torrent finished, but only if we actually DL'd at least part of it.
    // Don't notify if we merely finished verifying data files that were already on disk.
    if (torrentInfo.bytesReceived > 0) {
      if (!this.state.window.isFocused) {
        this.state.dock.badge += 1
      }
      showDoneNotification(torrentSummary)
      reportErrors(ipcOs.notifyDownloadFinished(getTorrentPath(torrentSummary)))
    }

    dispatch('update')
  }

  torrentProgress (progressInfo) {
    // Overall progress across all active torrents, 0 to 1, or -1 to hide the progress bar
    // Hide progress bar when client has no torrents, or progress is 100%
    const progress = (!progressInfo.hasActiveTorrents || progressInfo.progress === 1)
      ? -1
      : progressInfo.progress

    // Show progress bar under the WebTorrent taskbar icon, on OSX
    this.state.dock.progress = progress

    // Update progress for each individual torrent
    progressInfo.torrents.forEach((p) => {
      const torrentSummary = this.getTorrentSummary(p.torrentKey)
      if (!torrentSummary) {
        console.log('warning: got progress for missing torrent %s', p.torrentKey)
        return
      }
      torrentSummary.progress = p
    })

    // TODO: Find an efficient way to re-enable this line, which allows subtitle
    //       files which are completed after a video starts to play to be added
    //       dynamically to the list of subtitles.
    // checkForSubtitles()
  }

  torrentFileModtimes (torrentKey, fileModtimes) {
    const torrentSummary = this.getTorrentSummary(torrentKey)
    if (!torrentSummary) throw new Error('Not saving modtimes for deleted torrent ' + torrentKey)
    torrentSummary.fileModtimes = fileModtimes
    dispatch('stateSave')
  }

  torrentFileSaved (torrentKey, torrentFileName) {
    console.log('torrent file saved %s: %s', torrentKey, torrentFileName)
    const torrentSummary = this.getTorrentSummary(torrentKey)
    torrentSummary.torrentFileName = torrentFileName
    dispatch('stateSave')
  }

  // Make a poster for a torrent and record it, if one could be made.
  // Failure is quiet, as it was on wt-generate-torrent-poster: the
  // torrent list keeps the default placeholder.
  async generateTorrentPoster (torrentKey) {
    const torrentSummary = this.getTorrentSummary(torrentKey)
    const posterFileName = await makePoster(torrentSummary)
    if (posterFileName) this.torrentPosterSaved(torrentKey, posterFileName)
  }

  torrentPosterSaved (torrentKey, posterFileName) {
    const torrentSummary = this.getTorrentSummary(torrentKey)
    // The torrent may have been removed while the poster was being made
    if (!torrentSummary) return
    torrentSummary.posterFileName = posterFileName
    dispatch('stateSave')
  }

  torrentAudioMetadata (infoHash, index, info) {
    const torrentSummary = this.getTorrentSummary(infoHash)
    const fileSummary = torrentSummary.files[index]
    fileSummary.audioInfo = info
    dispatch('update')
  }

  torrentServerRunning (serverInfo) {
    // `state.server` is the *playing* torrent's server. Since ADR-013
    // poster generation starts servers too, so a wt-server-running
    // broadcast can be for a torrent the user is not watching -- taking
    // it would point playback at the wrong port.
    const playing = this.state.playing &&
      this.getTorrentSummary(this.state.playing.infoHash)
    if (!playing || playing.torrentKey !== serverInfo.torrentKey) return
    this.state.server = serverInfo
  }

  // Gets a torrent summary {name, infoHash, status} from state.saved.torrents
  // Returns undefined if we don't know that infoHash
  getTorrentSummary (torrentKey) {
    return TorrentSummary.getByKey(this.state, torrentKey)
  }
}

function getTorrentPath (torrentSummary) {
  let itemPath = TorrentSummary.getFileOrFolder(torrentSummary)
  if (torrentSummary.files.length > 1) {
    itemPath = path.dirname(itemPath)
  }
  return itemPath
}

function showDoneNotification (torrent) {
  const notif = new window.Notification('Download Complete', {
    body: torrent.name,
    silent: true
  })

  notif.onclick = () => {
    reportErrors(ipcOs.show())
  }

  // Only play notification sound if player is inactive
  if (this.state.playing.isPaused) sound.play('DONE')
}
