const test = require('tape')

const fs = require('fs')
const path = require('path')

const WebTorrent = require('webtorrent')
const { choosePosterSource } = require('../build/renderer/lib/torrent-poster')

const client = new WebTorrent()

// US-043 (ADR-013): poster generation moved into the UI renderer, so the
// interesting half of it -- the decode and the canvas read -- cannot run
// under plain Node at all. What is left to check here without a browser
// is the choice: which file of a real torrent the poster comes from.
// `test/unit/poster.js` covers the fetch, the save and the video seam.
test("get cover from: 'wiredCd.torrent'", (t) => {
  const torrentPath = path.join(__dirname, '..', 'static', 'wiredCd.torrent')
  const torrentData = fs.readFileSync(torrentPath)

  client.add(torrentData, (torrent) => {
    const source = choosePosterSource(torrent.files.map((file) => ({
      name: file.name,
      length: file.length,
      path: file.path
    })))
    t.ok(source, 'a poster source was chosen')
    t.equals(source.kind, 'file', 'cover art, not a video frame')
    t.equals(source.extension, '.jpg')
    torrent.destroy()
    t.end()
  })
})
