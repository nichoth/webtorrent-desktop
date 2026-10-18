const test = require('tape')
const fs = require('fs')
const path = require('path')

// The stream handling lives in `audio-metadata.js` and is tested against
// a real Readable in `engine-audio-metadata.js`. What that cannot reach
// is whether `index.js` uses it, so this is a source check in the shape
// of `engine-sweep-wiring.js`: it asserts the parts are connected.

const ENTRY_SRC = path.join(
  __dirname, '..', '..', 'src', 'engine', 'index.js')

const source = fs.readFileSync(ENTRY_SRC, 'utf8')

// Comments are stripped whole, for the reason spelled out in
// `engine-sweep-wiring.js`: an unstripped comment reads as live code.
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !/^\s*\/\//.test(line))
  .join('\n')

test('wt-get-audio-metadata reads through the audio-metadata module',
  function (t) {
    t.ok(/import \{[^}]*readAudioMetadata[^}]*\} from '\.\/audio-metadata'/
      .test(code), 'readAudioMetadata comes from audio-metadata.js')

    const handler = /function getAudioMetadata \([\s\S]*?\n\}/.exec(code)
    t.ok(handler, 'getAudioMetadata is found')
    const body = handler ? handler[0] : ''
    t.ok(/readAudioMetadata\(/.test(body),
      'and it reads through the module')

    // A stream handed to the library directly is the leak itself.
    t.ok(!/\.parseStream\(/.test(code),
      'the engine never hands music-metadata a stream itself')
    t.ok(!/createReadStream\(\)/.test(body),
      'and the handler opens no stream of its own')
    t.end()
  })
