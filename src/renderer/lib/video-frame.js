/**
 * Grab a still frame out of a streaming video URL (US-043, ADR-013).
 *
 * This is the one piece of poster generation that needs a browser: a
 * media decoder and a rasteriser. It lived in the hidden WebTorrent
 * window until ADR-012 turned the engine into a Node process with no
 * DOM, and it now runs in the UI window instead.
 *
 * It is a module of its own for two reasons. It is the only part of
 * `lib/torrent-poster.js` that cannot run under Node, so keeping it
 * separate keeps the selection and fetch logic unit-testable; and it
 * is the seam a future host replaces if the webview cannot decode what
 * it plays (see the codec bet in ADR-013, and US-081).
 *
 * Nothing here touches Node: the frame comes back as a `Uint8Array`
 * from `canvas.toBlob`, not as a `Buffer` from `capture-frame`, so no
 * host object crosses the shim boundary (ADR-007).
 */

const msgCaptureFailed = 'Cannot capture a video frame'

// Seek 3% in, capped at a minute, exactly as the hidden window did:
// far enough past a black or logo-filled opening to be recognisable,
// near enough the start that the engine has probably already fetched
// the pieces.
const SEEK_FRACTION = 0.03
const SEEK_CAP_SECONDS = 60
const ASSUMED_DURATION_SECONDS = 600

/**
 * Capture one frame of a video as JPEG bytes.
 *
 * The element is never added to the document -- it decodes, it is
 * read, and it is unloaded -- so nothing about this is visible to the
 * user beyond the work itself.
 *
 * @param {string} url An HTTP URL the webview can stream.
 * @returns {Promise<Uint8Array>} JPEG bytes.
 */
export async function captureVideoFrame (url) {
  const video = document.createElement('video')
  video.volume = 0
  video.muted = true
  video.preload = 'auto'

  try {
    video.src = url
    // The hidden window called `play()` to make Chromium pull the
    // stream rather than stop at metadata. Keep it: `preload` is a
    // hint, `play()` is not. Muted autoplay needs no gesture, and a
    // rejected play promise shows up as a decode failure below.
    video.play().catch(() => {})
    await once(video, 'canplay')

    video.currentTime = Math.min(
      (video.duration || ASSUMED_DURATION_SECONDS) * SEEK_FRACTION,
      SEEK_CAP_SECONDS
    )
    await once(video, 'seeked')

    const width = video.videoWidth
    const height = video.videoHeight
    if (!width || !height) throw new Error(msgCaptureFailed)

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.getContext('2d').drawImage(video, 0, 0, width, height)

    // `capture-frame` defaulted to PNG and the result was written as
    // `.jpg` regardless, so every video poster on disk today is a
    // mislabelled PNG. Ask for what the file name claims.
    const blob = await new Promise((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg')
    })
    if (!blob || blob.size === 0) throw new Error(msgCaptureFailed)

    return new Uint8Array(await blob.arrayBuffer())
  } finally {
    // Unload the element, or the stream keeps running and the decoded
    // frames stay in memory.
    video.pause()
    video.removeAttribute('src')
    video.load()
  }
}

/**
 * Resolve on the next `name` event, reject if the element errors.
 *
 * @param {HTMLMediaElement} element
 * @param {string} name
 * @returns {Promise<void>}
 */
function once (element, name) {
  return new Promise((resolve, reject) => {
    const settle = (fn, arg) => {
      element.removeEventListener(name, onEvent)
      element.removeEventListener('error', onError)
      fn(arg)
    }
    const onEvent = () => settle(resolve)
    const onError = () => settle(reject, new Error(
      `${msgCaptureFailed}: the video element reported an error`
    ))
    element.addEventListener(name, onEvent)
    element.addEventListener('error', onError)
  })
}
