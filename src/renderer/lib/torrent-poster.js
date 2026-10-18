/**
 * Choose, fetch and save the poster image for a torrent.
 *
 * US-043 / ADR-013: this runs in the UI renderer. It used to run in the
 * hidden WebTorrent window, which had both a DOM and the torrent
 * objects; the engine is a Node process now (ADR-012) and has neither a
 * media decoder nor a canvas, so poster generation moved here rather
 * than being shimmed. wt-generate-torrent-poster and wt-poster are
 * gone from the wire with it.
 *
 * Three things changed shape in the move, and all three are deliberate:
 *
 * 1. Input is `torrentSummary.files` -- `{ name, length, path }` per
 *    file, which the UI already holds from wt-metadata. No `torrent`
 *    object, no new data on the wire.
 * 2. File bytes come from the engine's streaming HTTP server by index
 *    (`${serverURL}/${index}`) with `fetch`, replacing
 *    `file.getBuffer()`. The video branch already built that URL.
 * 3. Bytes are `Uint8Array` throughout and the file is written through
 *    `platform/fs`, so no Node object is involved. `capture-frame`,
 *    which returned a `Buffer`, is gone (ADR-007).
 *
 * The file name is unchanged -- `infoHash + extension` under
 * `config.POSTER_PATH` -- so state saved by earlier versions still
 * resolves through `lib/torrent-summary.js`.
 */

import path from 'path'

import config from '../../config'
import mediaExtensions from './media-extensions'
import { captureVideoFrame } from './video-frame'
import * as fs from './platform/fs'
import * as ipcEngine from './platform/ipc-engine'

const msgNoSuitablePoster =
  'Cannot generate a poster from any files in the torrent'

// One job at a time. The decode, seek and canvas read now happen in the
// window the user is looking at, so a burst of added torrents must not
// turn into a burst of concurrent video decodes (ADR-013).
let queue = Promise.resolve()

// Nothing here is allowed to wedge the queue. A torrent whose pieces
// never arrive would otherwise hold it forever and no later torrent
// would ever get a poster.
const JOB_TIMEOUT = 60 * 1000

/**
 * @typedef {object} PosterSource
 * @property {'file'|'video'} kind  `file` is read as-is, `video` is
 *   decoded and a frame captured.
 * @property {number} index        Index within the torrent's file list.
 * @property {string} extension    Extension for the saved poster.
 */

/**
 * Decide where a torrent's poster should come from. Pure: file names
 * and lengths only, no IO.
 *
 * @param {{name: string, length: number}[]} files
 * @returns {PosterSource|null} `null` when no file is suitable.
 */
export function choosePosterSource (files) {
  if (!files || files.length === 0) return null

  // First, use a poster image if the torrent ships one
  const posterIndex = files
    .findIndex(file => /^poster\.(jpg|png|gif)$/.test(file.name))
  if (posterIndex !== -1) return asFile(files, posterIndex)

  // 'score' each media type based on total size present in torrent
  const bestScore = ['audio', 'video', 'image'].map(mediaType => ({
    type: mediaType,
    size: totalLengthByExtension(files, mediaExtensions[mediaType])
  })).sort((a, b) => b.size - a.size)[0] // sort descending on size

  // Admit defeat, no video, audio or image had a significant presence
  if (bestScore.size === 0) return null

  switch (bestScore.type) {
    case 'audio':
      return chooseAudioCover(files)
    case 'image':
      return asFile(files, largestByExtension(files, mediaExtensions.image))
    case 'video': {
      const index = largestByExtension(files, mediaExtensions.video)
      return { kind: 'video', index, extension: '.jpg' }
    }
  }
}

/**
 * Read the poster bytes for a torrent off the engine's streaming
 * server.
 *
 * @param {{infoHash: string, files: object[]}} torrentSummary
 * @param {string} serverURL Base URL of the engine's HTTP server.
 * @returns {Promise<{bytes: Uint8Array, extension: string}>}
 * @throws When the torrent has no suitable file, or the read fails.
 */
export default async function torrentPoster (torrentSummary, serverURL) {
  const source = choosePosterSource(torrentSummary.files)
  if (!source) throw new Error(msgNoSuitablePoster)

  const url = `${serverURL}/${source.index}`
  const bytes = source.kind === 'video'
    ? await captureVideoFrame(url)
    : await fetchBytes(url)

  if (!bytes || bytes.length === 0) throw new Error(msgNoSuitablePoster)
  return { bytes, extension: source.extension }
}

/**
 * Generate a torrent's poster and save it under `config.POSTER_PATH`.
 *
 * Quiet on failure, as the wt-generate-torrent-poster channel was:
 * the caller keeps the placeholder and the user is told nothing. Jobs
 * are serialized, so this may not start immediately.
 *
 * @param {{infoHash: string, files: object[]}} torrentSummary
 * @param {{timeout?: number}} [opts] `timeout` overrides how long a job
 *   may run before it gives up, in ms. For tests.
 * @returns {Promise<string|null>} The poster's file name, or `null` if
 *   no poster could be made.
 */
export function generateTorrentPoster (torrentSummary, opts = {}) {
  const timeout = opts.timeout || JOB_TIMEOUT
  const job = queue.then(
    () => runPosterJob(torrentSummary, timeout),
    () => runPosterJob(torrentSummary, timeout)
  )
  // The queue must survive a failed job, and a rejection here is
  // already reported by `runPosterJob`.
  queue = job.then(() => {}, () => {})
  return job
}

async function runPosterJob (torrentSummary, timeout) {
  const { infoHash } = torrentSummary

  // Nothing needs a server if nothing can be made from the torrent.
  if (!choosePosterSource(torrentSummary.files)) {
    console.log('no poster for torrent %s: %s', infoHash, msgNoSuitablePoster)
    return null
  }

  // What this job holds, so it can let go of all of it if it gives up
  // while `savePoster` is still waiting on the engine.
  const job = { unsubscribe: null }

  try {
    return await withTimeout(savePoster(torrentSummary, job), timeout)
  } catch (err) {
    // Same silence the engine kept: log it, leave the placeholder.
    console.log('error generating poster for %s: %o', infoHash, err)
    return null
  } finally {
    if (job.unsubscribe) job.unsubscribe()
    // Release this job's hold on the server whatever happened. The
    // engine counts holders, so this does not disturb a player
    // streaming the same torrent.
    try {
      await ipcEngine.stopServer(infoHash)
    } catch (err) {
      console.log('error releasing poster server for %s: %o', infoHash, err)
    }
  }
}

async function savePoster (torrentSummary, job) {
  const { infoHash } = torrentSummary
  const serverURL = await startServer(infoHash, job)
  const { bytes, extension } = await torrentPoster(torrentSummary, serverURL)

  const posterFileName = infoHash + extension
  await fs.mkdir(config.POSTER_PATH)
  await fs.writeFile(path.join(config.POSTER_PATH, posterFileName), bytes)
  console.log('saved poster %s', posterFileName)
  return posterFileName
}

/**
 * Ask the engine for this torrent's streaming server and wait for its
 * URL. wt-start-server is idempotent per torrent and always replies,
 * so this resolves whether or not a server was already up (ADR-013).
 */
async function startServer (infoHash, job) {
  try {
    return await new Promise((resolve, reject) => {
      ipcEngine.onServerRunningFor(
        infoHash, (info) => resolve(info.localURL), { once: true }
      ).then((off) => {
        job.unsubscribe = off
        return ipcEngine.startServer(infoHash)
      }).catch(reject)
    })
  } finally {
    if (job.unsubscribe) job.unsubscribe()
    job.unsubscribe = null
  }
}

async function fetchBytes (url) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`${msgNoSuitablePoster}: HTTP ${response.status}`)
  }
  return new Uint8Array(await response.arrayBuffer())
}

function withTimeout (promise, ms) {
  let timer = null
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms`)), ms
    )
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * @param {object[]} files
 * @param {number} index
 * @returns {PosterSource}
 */
function asFile (files, index) {
  return {
    kind: 'file',
    index,
    extension: path.extname(files[index].name)
  }
}

/**
 * Total size of the files matching one of the given extensions.
 *
 * @param {object[]} files
 * @param {string[]} extensions
 * @returns {number} Total size of the matches found (>= 0)
 */
function totalLengthByExtension (files, extensions) {
  return indexesByExtension(files, extensions)
    .reduce((total, index) => total + files[index].length, 0)
}

/**
 * Index of the largest file matching one of the given extensions.
 *
 * @param {object[]} files
 * @param {string[]} extensions
 * @returns {number} -1 when nothing matches
 */
function largestByExtension (files, extensions) {
  return indexesByExtension(files, extensions)
    .reduce((a, b) => (a === -1 || files[b].length > files[a].length ? b : a), -1)
}

/**
 * Indexes of the files matching one of the given extensions.
 *
 * @param {object[]} files
 * @param {string[]} extensions
 * @returns {number[]}
 */
function indexesByExtension (files, extensions) {
  return files
    .map((file, index) => index)
    .filter(index => {
      const extname = path.extname(files[index].name).toLowerCase()
      return extensions.indexOf(extname) !== -1
    })
}

/**
 * Pick the image most likely to be an album cover.
 *
 * @param {object[]} files
 * @returns {PosterSource|null}
 */
function chooseAudioCover (files) {
  const candidates = indexesByExtension(files, mediaExtensions.image)
  if (candidates.length === 0) return null

  const best = candidates
    .map(index => ({ index, score: scoreAudioCoverFile(files[index]) }))
    .reduce((a, b) => {
      if (a.score !== b.score) return a.score > b.score ? a : b
      // If score is equal, pick the largest file, aiming for the
      // highest resolution
      return files[a.index].length > files[b.index].length ? a : b
    })

  return asFile(files, best.index)
}

/**
 * Returns a score how likely the file is suitable as a poster
 * @param imgFile File object of an image
 * @returns {number} Score, higher score is a better match
 */
function scoreAudioCoverFile (imgFile) {
  const fileName = path
    .basename(imgFile.name, path.extname(imgFile.name))
    .toLowerCase()
  const relevanceScore = {
    cover: 80,
    folder: 80,
    album: 80,
    front: 80,
    back: 20,
    spectrogram: -80
  }

  for (const keyword in relevanceScore) {
    if (fileName === keyword) {
      return relevanceScore[keyword]
    }
    if (fileName.indexOf(keyword) !== -1) {
      return relevanceScore[keyword]
    }
  }
  return 0
}
