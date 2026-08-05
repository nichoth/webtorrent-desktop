import * as staticAsset from './static-asset'
import { InvalidSoundNameError } from './errors'

const VOLUME = 0.25

// App state to access the soundNotifications preference
let state

/* Cache of Audio elements, for instant playback */
const cache = {}

// The name of the bundled file rather than a URL, resolved through
// `lib/static-asset.js` at first playback.
//
// Under Electron these were `'file://' + path.join(config.STATIC_PATH,
// 'sound', name)`, built at module load. US-072 broke that three
// times over: `STATIC_PATH` came off `__dirname`, which a webview does
// not have; `file://` is not the protocol the window is served over;
// and in a packaged build the files are embedded in the binary by
// `tauri::generate_context!` rather than unpacked beside it, so no
// filesystem path names them at all.
//
// Resolved lazily, and not merely for the usual reason. `url()` reads
// `document.baseURI`, so at module scope it would demand a document --
// and this module is also compiled to CommonJS and loaded by plain
// Node in the unit suite, through `controllers/torrent-list-controller
// .js`. The `cache` below already defers construction to the first
// `play()`, so there is nothing to defer that was not deferred.
export const sounds = {
  ADD: { file: 'sound/add.wav', volume: VOLUME },
  DELETE: { file: 'sound/delete.wav', volume: VOLUME * 0.5 },
  DISABLE: { file: 'sound/disable.wav', volume: VOLUME * 0.5 },
  DONE: { file: 'sound/done.wav', volume: VOLUME },
  ENABLE: { file: 'sound/enable.wav', volume: VOLUME * 0.5 },
  ERROR: { file: 'sound/error.wav', volume: VOLUME },
  PLAY: { file: 'sound/play.wav', volume: VOLUME },
  STARTUP: { file: 'sound/startup.wav', volume: VOLUME }
}

export function init (appState) {
  state = appState
}

export function play (name) {
  if (state == null) {
    return
  }

  if (!state.saved.prefs.soundNotifications) {
    return
  }

  let audio = cache[name]
  if (!audio) {
    const sound = sounds[name]
    if (!sound) {
      throw new InvalidSoundNameError(name)
    }
    audio = cache[name] = new window.Audio()
    audio.volume = sound.volume
    audio.src = staticAsset.url(sound.file)
  }
  audio.currentTime = 0
  audio.play()
}
