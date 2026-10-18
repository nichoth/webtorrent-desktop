const test = require('tape')
const { Readable } = require('stream')

// Reading audio metadata from a file that is still downloading opens a
// torrent read stream. That stream holds a piece buffer and a
// high-priority selection until it is destroyed, so the reader has to
// destroy it once the parse settles, however it settles. The parser is
// a parameter, so none of this needs a real torrent or real audio.
const { readAudioMetadata } = require('../../build/engine/audio-metadata')

// A file in the shape of a webtorrent file, handing out a real Readable
// and keeping it so the test can look at it afterwards.
function unfinishedFile () {
  const file = {
    name: 'track.mp3',
    length: 4,
    done: false,
    stream: null,
    createReadStream () {
      file.stream = new Readable({ read () {} })
      return file.stream
    }
  }
  return file
}

test('the stream is destroyed after a parse that resolves', function (t) {
  const file = unfinishedFile()
  const parser = {
    parseStream: () => Promise.resolve({ common: { title: 'A' } })
  }

  readAudioMetadata(file, '/torrents', {}, parser).then(function (meta) {
    t.deepEqual(meta, { common: { title: 'A' } },
      'the parsed metadata is handed back')
    t.ok(file.stream, 'a stream was opened')
    t.equal(file.stream.destroyed, true, 'and it has been destroyed')
    t.end()
  }, t.end)
})

test('the stream is destroyed after a parse that rejects', function (t) {
  const file = unfinishedFile()
  const parser = {
    parseStream: () => Promise.reject(new Error('not audio'))
  }

  readAudioMetadata(file, '/torrents', {}, parser).then(function () {
    t.fail('a failed parse should reject')
    t.end()
  }, function (err) {
    t.equal(err.message, 'not audio', 'the failure is passed on')
    t.ok(file.stream, 'a stream was opened')
    t.equal(file.stream.destroyed, true, 'and it has been destroyed')
    t.end()
  })
})

test('the stream is not destroyed before the parse settles', function (t) {
  const file = unfinishedFile()
  let settle
  const parser = {
    parseStream: () => new Promise((resolve) => { settle = resolve })
  }

  const reading = readAudioMetadata(file, '/torrents', {}, parser)
  t.equal(file.stream.destroyed, false,
    'the parser still has its stream while it reads')
  settle({})
  reading.then(function () {
    t.equal(file.stream.destroyed, true, 'and loses it once it is done')
    t.end()
  }, t.end)
})

test('a finished file is read from disk, with no stream', function (t) {
  const file = unfinishedFile()
  file.done = true
  file.path = 'album/track.mp3'
  let parsedPath = null
  const parser = {
    parseFile: (p) => { parsedPath = p; return Promise.resolve({}) },
    parseStream: () => Promise.reject(new Error('should not stream'))
  }

  readAudioMetadata(file, '/torrents', {}, parser).then(function () {
    t.equal(parsedPath, '/torrents/album/track.mp3',
      'the parser is given the file on disk')
    t.equal(file.stream, null, 'and no torrent stream is opened')
    t.end()
  }, t.end)
})
