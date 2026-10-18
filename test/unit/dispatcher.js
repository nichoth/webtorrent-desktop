const test = require('tape')
const {
  dispatcher
} = require('../../build/renderer/lib/dispatcher')

test('dispatcher returns the same handler for the same arguments',
  function (t) {
    const first = dispatcher('dispatcher-test', 'stable', 1)
    t.equal(dispatcher('dispatcher-test', 'stable', 1), first,
      'the handler is memoized')
    t.notEqual(dispatcher('dispatcher-test', 'stable', 2), first,
      'different arguments get a different handler')
    t.end()
  })
