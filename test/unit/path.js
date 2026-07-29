const test = require('tape')
const nodePath = require('path').posix

// The renderer's `path` (US-035, ADR-011) replaces `path-browserify`.
// Correctness here is not a matter of taste: bundled dependencies --
// `application-config`, `write-file-atomic`, `make-dir`, `rimraf`,
// `path-scurry` -- were written against Node's posix behaviour, so the
// test is differential. Every case runs through both implementations
// and the answers have to match. Node is the oracle; no expected
// strings are hard-coded, so a Node version that changes an edge case
// changes the expectation with it.
const ours = require('../../build/renderer/lib/path')

const PATHS = [
  '', '.', '..', '...', '/', '//', '///',
  'a', '/a', 'a/', '/a/', 'a/b', '/a/b', 'a/b/', '//a', '//a/b',
  'a//b', 'a/./b', 'a/../b', '../a', './a', '/../a', '/a/../..',
  'a/b/../../..', './', '../', 'a/.', 'a/..',
  'file.txt', '.file', '.file.txt', 'file.', 'file..', 'a.b.c',
  '/a/b/file.txt', 'a/b.c/d', 'a/b.c/d.e', '/.file', 'file.txt/',
  '/home/user/Downloads/Some Torrent/video.mp4',
  '/home/user/Library/Application Support/WebTorrent/config.json',
  'C:\\Users\\test', 'C:\\Users\\test\\file.txt'
]

const SUFFIXES = ['.txt', 'txt', '.file', 'b', '', '.mp4']

const JOINS = [
  [], [''], ['', ''], ['a'], ['a', 'b'], ['a', '', 'b'],
  ['/a', 'b'], ['a', '/b'], ['a', '..'], ['a', '../..'],
  ['/', 'a'], ['a/', '/b'], ['.', 'a'], ['..', 'a'],
  ['/home/user', 'Downloads', 'file.mp4'],
  ['/a/b', '../c/./d'], ['a', 'b', 'c', '..', '..'],
  ['/', '..'], ['', 'a', ''], ['a//', '//b']
]

const RESOLVES = [
  ['/a'], ['/a', 'b'], ['/a', '/b'], ['/a', '..'], ['/a/b', '../c'],
  ['/a', ''], ['', '/a'], ['/'], ['/a/'], ['/a/b/c', '../../d'],
  ['/home/user', './Downloads', 'file.mp4']
]

const RELATIVES = [
  ['/a', '/a'], ['/a', '/a/b'], ['/a/b', '/a'], ['/a/b', '/a/c'],
  ['/a/b/c', '/a/d'], ['/', '/a'], ['/a', '/'],
  ['/home/user/Downloads', '/home/user/Downloads/x/y.mp4'],
  ['/home/user/a', '/home/user/b']
]

const OBJECTS = [
  { dir: '/a', base: 'b.txt' },
  { root: '/', base: 'b.txt' },
  { root: '/', name: 'b', ext: '.txt' },
  { dir: '/a', name: 'b', ext: '.txt' },
  { base: 'b.txt' },
  { name: 'b', ext: '.txt' },
  { dir: '/a', root: '/', base: 'b.txt' },
  { root: '/', dir: '/', base: 'b.txt' },
  {}
]

function label (name, args) {
  return name + '(' + args.map(a => JSON.stringify(a)).join(', ') + ')'
}

// `parse` returns an object; everything else returns a string. Compare
// through JSON so one assertion covers both.
function compare (t, name, args) {
  const expected = JSON.stringify(nodePath[name](...args))
  const actual = JSON.stringify(ours[name](...args))
  t.equal(actual, expected, label(name, args))
}

test('single-argument functions match node', function (t) {
  const names = [
    'normalize', 'isAbsolute', 'dirname', 'basename', 'extname', 'parse'
  ]

  for (const name of names) {
    for (const p of PATHS) compare(t, name, [p])
  }

  t.end()
})

test('basename with a suffix matches node', function (t) {
  for (const p of PATHS) {
    for (const suffix of SUFFIXES) compare(t, 'basename', [p, suffix])
  }

  t.end()
})

test('join matches node', function (t) {
  for (const args of JOINS) compare(t, 'join', args)
  t.end()
})

test('resolve matches node', function (t) {
  for (const args of RESOLVES) compare(t, 'resolve', args)

  // Relative input resolves against the working directory. Both
  // implementations read `process.cwd()`, so they still have to agree.
  compare(t, 'resolve', ['a', 'b'])
  compare(t, 'resolve', [])

  t.end()
})

test('relative matches node', function (t) {
  for (const args of RELATIVES) compare(t, 'relative', args)
  t.end()
})

test('format matches node', function (t) {
  for (const obj of OBJECTS) compare(t, 'format', [obj])
  t.end()
})

test('parse and format round-trip', function (t) {
  for (const p of PATHS) {
    if (p === '') continue
    const parsed = ours.parse(p)
    t.equal(
      ours.format(parsed),
      nodePath.format(nodePath.parse(p)),
      'round-trip ' + JSON.stringify(p)
    )
  }

  t.end()
})

test('non-string input throws, as node does', function (t) {
  const bad = [undefined, null, 42, {}, ['a']]

  for (const value of bad) {
    t.throws(
      () => ours.join(value),
      TypeError,
      'join ' + JSON.stringify(value) + ' throws TypeError'
    )
    t.throws(() => ours.normalize(value), TypeError)
    t.throws(() => ours.basename(value), TypeError)
  }

  t.end()
})

test('constants and namespaces match path-browserify', function (t) {
  t.equal(ours.sep, nodePath.sep, 'sep')
  t.equal(ours.delimiter, nodePath.delimiter, 'delimiter')

  // `path-scurry` does `import { posix, win32 } from 'path'`, so both
  // names must exist. `win32` is null here exactly as it was under
  // `path-browserify` (ADR-011).
  t.equal(ours.posix, ours.default, 'posix is the module itself')
  t.equal(ours.posix.posix.posix, ours.default, 'posix chains')
  t.equal(ours.win32, null, 'win32 is null')
  t.equal(ours.default.win32, null, 'win32 on the default export')

  t.equal(
    typeof ours.default.join, 'function',
    'default export carries the functions'
  )
  t.equal(ours.toNamespacedPath('/a'), '/a', 'toNamespacedPath')
  t.equal(ours._makeLong, ours.toNamespacedPath, '_makeLong alias')

  t.end()
})
