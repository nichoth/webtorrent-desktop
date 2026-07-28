const test = require('tape')
const { calculateEta } = require('../../build/renderer/lib/time')

test('calculateEta returns undefined when there is nothing to do', function (t) {
  t.equal(calculateEta(0, 100), undefined, 'nothing missing')
  t.equal(calculateEta(100, 0), undefined, 'no download speed')
  t.end()
})

test('calculateEta formats seconds only under a minute', function (t) {
  t.equal(calculateEta(30, 1), '  30 s remaining')
  t.end()
})

test('calculateEta includes minutes past a minute', function (t) {
  t.equal(calculateEta(90, 1), ' 1 min 30 s remaining')
  t.end()
})

test('calculateEta includes hours past an hour', function (t) {
  t.equal(calculateEta(3661, 1), '1 h 1 min 1 s remaining')
  t.end()
})
