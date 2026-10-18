const test = require('tape')

// Which file selections reach webtorrent. Every `file.select()` adds a
// new entry to the torrent's selection list and `file.deselect()`
// removes only one, so the engine must send webtorrent changes, never
// the whole list again. Everything here is plain values: the
// selections last applied and the ones just requested. The wiring into
// `index.js` is checked in `engine-torrent-close-wiring.js`.
const { diffSelections } = require('../../build/engine/selections')

test('the first application replaces the default selection',
  function (t) {
    const changes = diffSelections(undefined, [true, false, true])

    t.equal(changes.replaceDefault, true,
      'the whole-torrent selection is removed first')
    t.deepEqual(changes.select, [0, 2], 'every wanted file is selected')
    t.deepEqual(changes.deselect, [1], 'and every other is deselected')
    t.end()
  })

test('applying the same selections twice changes nothing the second time',
  function (t) {
    const first = [true, false, true]
    const changes = diffSelections(first, [true, false, true])

    t.equal(changes.replaceDefault, false,
      'the default is not touched again')
    t.deepEqual(changes.select, [], 'nothing is selected')
    t.deepEqual(changes.deselect, [], 'and nothing is deselected')
    t.end()
  })

test('a deselect after a repeated select yields exactly one deselect',
  function (t) {
    const once = [true, true]
    const again = diffSelections(once, [true, true])
    t.deepEqual(again.select, [], 'the repeat adds no selection')

    const changes = diffSelections(once, [true, false])
    t.deepEqual(changes.select, [], 'nothing new is selected')
    t.deepEqual(changes.deselect, [1], 'and the one file is deselected')
    t.end()
  })

test('only files whose state flipped are reported', function (t) {
  const changes = diffSelections(
    [true, false, true, false], [false, true, true, false])

  t.deepEqual(changes.select, [1], 'the newly wanted file')
  t.deepEqual(changes.deselect, [0], 'the newly unwanted file')
  t.end()
})
