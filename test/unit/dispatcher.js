const test = require('tape')
const {
  dispatcher,
  dropDispatchers
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

test('dropping the memo hands out a fresh handler', function (t) {
  const before = dispatcher('dispatcher-test', 'dropped')
  dropDispatchers()
  const after = dispatcher('dispatcher-test', 'dropped')
  t.equal(typeof after, 'function', 'a handler is still handed out')
  t.notEqual(after, before, 'it is a new handler')
  t.equal(dispatcher('dispatcher-test', 'dropped'), after,
    'and it is memoized again')
  t.end()
})
