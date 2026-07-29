import path from 'path'
import parallel from 'run-parallel'
import concat from 'simple-concat'
import LanguageDetect from 'languagedetect'
import srtToVtt from 'srt-to-vtt'
import iso639 from 'iso-639-1'

import { dispatch } from '../lib/dispatcher'
import * as platformDialog from '../lib/platform/dialog'
import * as fs from '../lib/platform/fs'

export default class SubtitlesController {
  constructor (state) {
    this.state = state
  }

  openSubtitles () {
    platformDialog.showOpenDialog({
      title: 'Select a subtitles file.',
      filters: [{ name: 'Subtitles', extensions: ['vtt', 'srt'] }],
      properties: ['openFile']
    })
      .then(filenames => {
        if (filenames.length === 0) return // They clicked Cancel
        this.addSubtitles(filenames, true)
        // dispatch()'s own update() already ran while the dialog was
        // open, so the new subtitles need one of their own.
        dispatch('update')
      })
      .catch(err => dispatch('error', err))
  }

  selectSubtitle (ix) {
    this.state.playing.subtitles.selectedIndex = ix
  }

  toggleSubtitlesMenu () {
    const subtitles = this.state.playing.subtitles
    subtitles.showMenu = !subtitles.showMenu
  }

  addSubtitles (files, autoSelect) {
    // Subtitles are only supported when playing video files
    if (this.state.playing.type !== 'video') return
    if (files.length === 0) return
    const subtitles = this.state.playing.subtitles

    // Read the files concurrently, then add all resulting subtitle tracks
    const tasks = files.map((file) => (cb) => loadSubtitle(file, cb))
    parallel(tasks, (err, tracks) => {
      if (err) return dispatch('error', err)

      // No dupes allowed
      tracks.forEach((track, i) => {
        let trackIndex = subtitles.tracks.findIndex((t) =>
          track.filePath === t.filePath)

        // Add the track
        if (trackIndex === -1) {
          trackIndex = subtitles.tracks.push(track) - 1
        }

        // If we're auto-selecting a track, try to find one in the user's language
        if (autoSelect && (i === 0 || isSystemLanguage(track.language))) {
          subtitles.selectedIndex = trackIndex
        }
      })

      // Finally, make sure no two tracks have the same label
      relabelSubtitles(subtitles)
    })
  }

  checkForSubtitles () {
    if (this.state.playing.type !== 'video') return
    const torrentSummary = this.state.getPlayingTorrentSummary()
    if (!torrentSummary || !torrentSummary.progress) return

    torrentSummary.progress.files.forEach((fp, ix) => {
      if (fp.numPieces !== fp.numPiecesPresent) return // ignore incomplete files
      const file = torrentSummary.files[ix]
      if (!this.isSubtitle(file.name)) return
      const filePath = path.join(torrentSummary.path, file.path)
      this.addSubtitles([filePath], false)
    })
  }

  isSubtitle (file) {
    const name = typeof file === 'string' ? file : file.name
    const ext = path.extname(name).toLowerCase()
    return ext === '.srt' || ext === '.vtt'
  }
}

function loadSubtitle (file, cb) {
  // Read the .SRT or .VTT file, parse it, add subtitle track
  const filePath = file.path || file

  // The shim has no createReadStream, so the whole file is read and
  // pushed through the same srt-to-vtt transform. Subtitle files are
  // small, and the stream was concatenated in full anyway.
  const vttStream = srtToVtt()

  concat(vttStream, (err, buf) => {
    if (err) return dispatch('error', 'Can\'t parse subtitles file.')

    // Detect what language the subtitles are in
    const vttContents = buf.toString().replace(/(.*-->.*)/g, '')
    let langDetected = (new LanguageDetect()).detect(vttContents, 2)
    langDetected = langDetected.length ? langDetected[0][0] : 'subtitle'
    langDetected = langDetected.slice(0, 1).toUpperCase() + langDetected.slice(1)

    const track = {
      buffer: 'data:text/vtt;base64,' + buf.toString('base64'),
      language: langDetected,
      label: langDetected,
      filePath
    }

    cb(null, track)
  })

  fs.readFile(filePath)
    .then(bytes => vttStream.end(Buffer.from(bytes)))
    .catch(() => vttStream.destroy(new Error('Can\'t read subtitles file.')))
}

// Checks whether a language name like 'English' or 'German' matches the system
// language, aka the current locale
function isSystemLanguage (language) {
  const osLangISO = window.navigator.language.split('-')[0] // eg 'en'
  const langIso = iso639.getCode(language) // eg 'de' if language is 'German'
  return langIso === osLangISO
}

// Make sure we don't have two subtitle tracks with the same label
// Labels each track by language, eg 'German', 'English', 'English 2', ...
function relabelSubtitles (subtitles) {
  const counts = {}
  subtitles.tracks.forEach(track => {
    const lang = track.language
    counts[lang] = (counts[lang] || 0) + 1
    track.label = counts[lang] > 1 ? (lang + ' ' + counts[lang]) : lang
  })
}
