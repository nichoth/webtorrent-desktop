const test = require('tape')
const {
  recordError,
  ERROR_WINDOW_MS
} = require('../../build/renderer/lib/error-list')

test('recording many errors over a long span keeps the list bounded',
  function (t) {
    const errors = []
    const step = 100
    for (let now = 0; now < 60000; now += step) {
      recordError(errors, 'boom', now)
    }
    // One error per 100 ms, so a 5 s window holds about 50
    t.ok(errors.length <= ERROR_WINDOW_MS / step + 1,
      'list holds only the banner window, got ' + errors.length)
    t.end()
  })

test('errors recorded within the banner window are kept', function (t) {
  const errors = []
  recordError(errors, 'old', 0)
  recordError(errors, 'a', 10000)
  recordError(errors, 'b', 12000)
  recordError(errors, 'c', 14000)
  t.deepEqual(errors.map((e) => e.message), ['a', 'b', 'c'])
  t.equal(errors[2].time, 14000, 'records the time')
  t.end()
})

test('recordError keeps the same array', function (t) {
  const errors = []
  recordError(errors, 'x', 0)
  const ref = errors
  recordError(errors, 'y', 100000)
  t.equal(ref, errors)
  t.deepEqual(ref.map((e) => e.message), ['y'])
  t.end()
})

// Every site that records an error goes through `recordError`, so no
// source under `src/renderer/` pushes onto `state.errors` directly.
test('no renderer source pushes to state.errors directly', function (t) {
  const fs = require('fs')
  const path = require('path')
  const root = path.join(__dirname, '..', '..', 'src', 'renderer')
  const offenders = []
  ;(function walk (dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (/\.js$/.test(ent.name)) {
        const src = fs.readFileSync(p, 'utf8')
        if (/\.errors\.(push|unshift|splice)\s*\(/.test(src)) {
          offenders.push(path.relative(root, p))
        }
      }
    }
  })(root)
  t.deepEqual(offenders, [], 'no direct pushes')
  t.end()
})
