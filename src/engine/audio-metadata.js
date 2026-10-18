// Audio metadata for one torrent file, read without leaking a stream.
//
// A file that is still downloading is parsed from a torrent read
// stream. Each such stream keeps up to a piece buffer and a
// high-priority selection until it is destroyed -- and that selection
// keeps the file downloading after the user deselects it. music-metadata
// stops reading once it has what it needs but never destroys the stream
// it was handed, so this module owns the stream and destroys it once
// the parse settles, whether it resolved or rejected.
//
// A finished file is parsed from disk by path; music-metadata opens and
// closes that file itself.

import path from 'path'
import mm from 'music-metadata'

// `parser` defaults to music-metadata and is a parameter so the stream
// handling can be tested without real audio.
export function readAudioMetadata (file, torrentPath, options, parser = mm) {
  if (file.done) {
    return parser.parseFile(path.join(torrentPath, file.path), options)
  }

  const stream = file.createReadStream()
  return parser.parseStream(stream, file.name, options)
    .finally(() => stream.destroy())
}
