const test = require('tape')
const fs = require('fs')
const path = require('path')

const {
  CRATE, setManifestVersion, setLockVersion
} = require('../../bin/sync-crate-version')

// `npm version` bumps package.json and nothing else, so the crate
// version (which Tauri reads for the .app and the .dmg) drifted on the
// first release after `tauri-host.js` started checking the two agree.
// The `version` lifecycle script closes that gap: npm runs it after the
// bump and before the commit and tag, so what it stages is tagged.

const REPO = path.join(__dirname, '..', '..')

const MANIFEST = [
  '[package]',
  `name = "${CRATE}"`,
  '# a comment that stays put',
  'version = "0.24.0"',
  'edition = "2021"',
  '',
  '[dependencies]',
  'serde = { version = "1.0.0" }',
  ''
].join('\n')

const LOCK = [
  '[[package]]',
  'name = "serde"',
  'version = "0.24.0"',
  '',
  '[[package]]',
  `name = "${CRATE}"`,
  'version = "0.24.0"',
  'dependencies = [',
  ' "serde",',
  ']',
  ''
].join('\n')

function versionsOf (text) {
  return [...text.matchAll(/^version = "([^"]+)"/gm)].map(m => m[1])
}

test('the version script runs the sync', function (t) {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')
  )
  t.ok(
    pkg.scripts.version.includes('bin/sync-crate-version.js'),
    'npm version syncs the crate before it commits'
  )
  t.end()
})

test('the manifest takes the new version', function (t) {
  const out = setManifestVersion(MANIFEST, '0.25.1')
  t.deepEqual(versionsOf(out), ['0.25.1'], 'the package version moved')
  t.ok(
    out.includes('serde = { version = "1.0.0" }'),
    'a dependency version is left alone'
  )
  t.equal(
    out.split('\n').length, MANIFEST.split('\n').length,
    'nothing else is added or removed'
  )
  t.end()
})

test('the lockfile takes the new version for this crate only',
  function (t) {
    const out = setLockVersion(LOCK, '0.25.1')
    t.deepEqual(
      versionsOf(out), ['0.24.0', '0.25.1'],
      'another package at the same version is left alone'
    )
    t.end()
  })

test('a missing version is an error rather than a silent no-op',
  function (t) {
    t.throws(
      () => setManifestVersion('[package]\nname = "x"\n', '1.0.0'),
      'manifest without a version'
    )
    t.throws(
      () => setLockVersion('[[package]]\nname = "x"\n', '1.0.0'),
      'lockfile without this crate'
    )
    t.end()
  })
