# Force Re-announce Diagnostic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manually triggered "force re-announce" for one torrent,
with before/after peer counts logged by the engine, so we can find out
whether re-announcing alone revives a stalled torrent.

**Architecture:** A new engine module `src/engine/announce.js` holds the
announce logic as a plain function that takes a torrent and a DHT, so it
is unit testable without a network or a spawned sidecar.
`src/engine/index.js` wires it to a new `wt-force-announce` command and
wraps it in diagnostic logging. The UI reaches it through a new
`ipc-engine.js` export and a torrent-row context menu item.

**Tech Stack:** Node sidecar (`src/engine/`), `webtorrent` 1.9.7,
`bittorrent-tracker` 9.19.0, `bittorrent-dht` 10.0.7, `tape` unit tests
against Babel output under `build/`.

## Why this exists

Torrents in this app sometimes stop downloading and sit at zero peers.
Destroying and re-adding them (which is what the "Highest playback
priority" preference already does on every play click) revives them.
Destroy plus re-add does four things: fresh tracker announce, fresh DHT
lookup, reset peer bookkeeping, and a full re-verify of every piece on
disk. This plan isolates the first two so we can find out whether they
are sufficient.

The natural re-discovery cadence is slow, which is the reason to suspect
discovery in the first place:

- `torrent-discovery` sets a 15 minute interval, then calls
  `tracker.start()`, which resets each individual tracker to its own
  `DEFAULT_ANNOUNCE_INTERVAL`: 30 minutes for HTTP and UDP
  (`node_modules/bittorrent-tracker/lib/client/http-tracker.js:257`,
  `udp-tracker.js:305`), 30 seconds for WebSocket.
- Each HTTP/UDP tracker then overwrites that with whatever interval the
  tracker returned, typically 1800 seconds (`http-tracker.js:179`,
  `udp-tracker.js:200`).
- The DHT re-announces every 15 minutes plus up to 3 minutes of jitter
  (`node_modules/torrent-discovery/index.js:196`).

**This plan does not fix anything.** Its deliverable is Task 5, a
measurement. The automatic sweep is a separate plan
(`2026-08-05-stalled-torrent-announce-sweep.md`) and should not be
started until Task 5 has produced a result.

## Global Constraints

- Style is `standard` (no semicolons, 2-space indent, space before
  function parens). `npm run lint` must pass.
- Keep lines under 80 columns to match the surrounding code.
- No em dashes in comments or docs. Use `--`. No `->` arrow character;
  use the ASCII `->`.
- `src/engine/index.js` is scanned by
  `test/unit/engine-entry.js:115`. That scan fails the build on: any
  `window.` / `document.` / `navigator.` reference, any `.send(` that is
  not `bus.send(`, and any `.on('wt-` subscription that is not
  `bus.on(`. New engine code must respect all three.
- `test/unit/platform-boundary.js` fails on any `wt-` string literal
  outside `src/renderer/lib/platform/`. Controllers call shim functions,
  never channel names.
- Unit tests are CommonJS and require the Babel output under `build/`,
  never the ESM sources under `src/`. `npm run test-unit` runs
  `npm run build` first; running `npx tape` alone tests a stale copy.
- Controllers are excluded from `build:node`. A unit test that needs one
  compiles it itself with `@babel/core` into
  `build/renderer/controllers/` under a file-suffixed name. See
  `test/AGENTS.md`.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/engine/announce.js` (new) | Peer-discovery actions on an existing torrent. Knows nothing about the bus, logging, or the client. |
| `test/unit/engine-announce.js` (new) | Unit tests for the above, with fake torrents. No network. |
| `test/unit/engine-force-announce.js` (new) | Spawns the real sidecar and drives `wt-force-announce` over a real socket. |
| `src/engine/index.js` | Wires the command, owns the diagnostic logging. |
| `src/renderer/lib/platform/ipc-engine.js` | New `forceAnnounce(infoHash)` export. |
| `src/renderer/controllers/torrent-list-controller.js` | New `forceAnnounce` method plus the context menu item that calls it. |
| `docs/platform-shim.md` | The wire protocol tables. |
| `src/engine/AGENTS.md` | Engine-directory notes. |

---

### Task 1: The announce action

**Files:**
- Create: `src/engine/announce.js`
- Test: `test/unit/engine-announce.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `announceNow(torrent, dht)` returning
  `{ tracker: boolean, dht: boolean }`. `torrent` is a WebTorrent
  `Torrent` (only `infoHash` and `discovery.tracker` are touched); `dht`
  is the client-wide `bittorrent-dht` instance or a falsy value when
  DHT is disabled. Task 2 and the sweep plan both call this.

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine-announce.js`:

```js
const test = require('tape')

// The discovery half of "destroy and re-add", on its own. Fakes stand
// in for the torrent and the DHT: what is under test is which calls go
// out and how missing pieces are tolerated, not the network.
const { announceNow } = require('../../build/engine/announce')

const INFO_HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function fakeTorrent (calls, overrides = {}) {
  return Object.assign({
    infoHash: INFO_HASH,
    discovery: {
      tracker: {
        update () { calls.push(['tracker.update']) }
      }
    }
  }, overrides)
}

function fakeDht (calls) {
  return {
    lookup (hash) { calls.push(['dht.lookup', hash]) }
  }
}

test('announceNow updates the trackers and looks up the DHT',
  function (t) {
    const calls = []
    const result = announceNow(fakeTorrent(calls), fakeDht(calls))

    t.deepEqual(calls, [
      ['tracker.update'],
      ['dht.lookup', INFO_HASH]
    ], 'both halves fired, and the lookup names this torrent')
    t.deepEqual(result, { tracker: true, dht: true },
      'and the result says so')
    t.end()
  })

test('announceNow tolerates a torrent with no discovery yet',
  function (t) {
    const calls = []
    const torrent = fakeTorrent(calls, { discovery: null })
    const result = announceNow(torrent, fakeDht(calls))

    t.deepEqual(calls, [['dht.lookup', INFO_HASH]],
      'the DHT half still fires')
    t.deepEqual(result, { tracker: false, dht: true })
    t.end()
  })

test('announceNow tolerates discovery with trackers disabled',
  function (t) {
    const calls = []
    const torrent = fakeTorrent(calls, { discovery: { tracker: null } })
    const result = announceNow(torrent, fakeDht(calls))

    t.deepEqual(calls, [['dht.lookup', INFO_HASH]])
    t.deepEqual(result, { tracker: false, dht: true })
    t.end()
  })

test('announceNow tolerates a client with no DHT', function (t) {
  const calls = []
  const result = announceNow(fakeTorrent(calls), false)

  t.deepEqual(calls, [['tracker.update']], 'the tracker half still fires')
  t.deepEqual(result, { tracker: true, dht: false },
    'the tracker half ran and the DHT half did not')
  t.end()
})

test('announceNow does nothing at all for a missing torrent',
  function (t) {
    const calls = []
    const result = announceNow(null, fakeDht(calls))

    t.deepEqual(calls, [], 'no call went out')
    t.deepEqual(result, { tracker: false, dht: false })
    t.end()
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build:node && npx tape test/unit/engine-announce.js`
Expected: FAIL, `Cannot find module '../../build/engine/announce'`.

- [ ] **Step 3: Write the implementation**

Create `src/engine/announce.js`:

```js
// Peer discovery for a torrent the client already holds.
//
// `torrent.destroy()` followed by `client.add()` revives a stalled
// torrent, but it does four things at once: fresh tracker announce,
// fresh DHT lookup, reset peer bookkeeping, and a re-verify of every
// piece already on disk. This module is the first two on their own --
// no re-hash, no dropped peer connections, safe to call on a healthy
// torrent.
//
// It exists because the natural cadence is slow. `torrent-discovery`
// asks for a 15 minute interval and then calls `tracker.start()`,
// which resets each tracker to its own DEFAULT_ANNOUNCE_INTERVAL: 30
// minutes for HTTP and UDP. The DHT re-announces every 15 minutes plus
// jitter. A torrent whose last peer drops can therefore sit at zero
// peers for half an hour before it next asks anyone for peers.

/**
 * Force one round of peer discovery for a torrent.
 *
 * Every argument is optional in practice: `discovery` does not exist
 * until the torrent has been parsed, `discovery.tracker` is null when
 * trackers are disabled, and `dht` is false when the client has no
 * DHT. None of those is an error, so each half reports whether it ran
 * rather than throwing.
 *
 * @param {object} torrent A WebTorrent torrent, or null.
 * @param {object|false} dht The client-wide DHT, or a falsy value.
 * @returns {{ tracker: boolean, dht: boolean }} What actually fired.
 */
export function announceNow (torrent, dht) {
  const result = { tracker: false, dht: false }
  if (!torrent) return result

  const tracker = torrent.discovery && torrent.discovery.tracker
  if (tracker) {
    // A no-event announce to every tracker in the list.
    tracker.update()
    result.tracker = true
  }

  if (torrent.infoHash && dht && typeof dht.lookup === 'function') {
    // `torrent-discovery` is already subscribed to the DHT's `peer`
    // event for this info hash, so a plain lookup feeds peers back
    // through the path the torrent already uses.
    dht.lookup(torrent.infoHash)
    result.dht = true
  }

  return result
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build:node && npx tape test/unit/engine-announce.js`
Expected: PASS, all five tests.

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/engine/announce.js test/unit/engine-announce.js
git commit -m "feat(engine): add announceNow, the discovery half of a re-add"
```

---

### Task 2: The `wt-force-announce` command

**Files:**
- Modify: `src/engine/index.js`
- Modify: `src/engine/AGENTS.md`
- Test: `test/unit/engine-force-announce.js` (create)

**Interfaces:**
- Consumes: `announceNow(torrent, dht)` from Task 1.
- Produces: the `wt-force-announce` command, argument list
  `(infoHash: string)`, fire-and-forget, no reply. Its output is stdout
  lines beginning `DIAG announce`. Task 3 sends it from the UI.

The log prefix `DIAG announce` is the contract of this task: it is what
Task 5 reads, so do not change the spelling without changing Task 5.

- [ ] **Step 1: Write the failing test**

Create `test/unit/engine-force-announce.js`. It follows the recipe in
`test/AGENTS.md` for driving the real sidecar, which
`test/unit/engine-entry.js` also uses: spawn with `process.execPath`,
read the port line off stdout, connect a real `ws` client, speak `wt-*`
through `build/shared/wire.js`, kill the child in a `finally`.

```js
const test = require('tape')
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const parseTorrent = require('parse-torrent')
const WebSocket = require('ws')

// `wt-force-announce` is a diagnostic command: it asks one torrent to
// re-announce and prints peer counts around the call. What is asserted
// here is the wiring -- that the command reaches the engine, that an
// unknown info hash is survivable, and that a known one produces the
// readout Task 5 reads. The announce itself is unit tested in
// engine-announce.js against fakes.

const { decode, encode } = require('../../build/shared/wire')

const REPO = path.join(__dirname, '..', '..')
const ENTRY = path.join(REPO, 'build', 'engine', 'index.js')
const FIXTURE = path.join(REPO, 'static', 'sintel.torrent')
const TOKEN = 'test-token-announce'
const UNKNOWN = 'b'.repeat(40)

test('the engine answers wt-force-announce', async function (t) {
  const expected = parseTorrent(await fs.promises.readFile(FIXTURE))
  const downloadPath = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'wt-announce-test-')
  )

  const child = spawn(process.execPath, [ENTRY], {
    cwd: REPO,
    // NODE_ENV=test keeps config off the real profile directory.
    env: {
      ...process.env,
      NODE_ENV: 'test',
      WEBTORRENT_ENGINE_TOKEN: TOKEN
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const stdout = []
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => stdout.push(chunk))
  child.stderr.on('data', (chunk) => stdout.push(chunk))
  const out = () => stdout.join('')

  let client = null
  try {
    const port = await waitFor(() => {
      const line = out().split('\n')
        .find((l) => l.startsWith('WEBTORRENT_ENGINE_PORT='))
      return line ? Number(line.slice('WEBTORRENT_ENGINE_PORT='.length)) : null
    }, 'the engine printed its port')

    client = new WebSocket('ws://127.0.0.1:' + port, {
      headers: { authorization: 'Bearer ' + TOKEN }
    })
    const frames = []
    client.on('message', (data) => frames.push(decode(data)))
    await new Promise((resolve, reject) => {
      client.once('open', resolve)
      client.once('error', reject)
    })

    // An info hash the engine has never seen must not take it down.
    client.send(encode('wt-force-announce', [UNKNOWN]))
    await waitFor(
      () => out().includes('DIAG announce: no torrent ' + UNKNOWN) || null,
      'the engine reported the missing torrent'
    )

    // Now a torrent it does hold. Every file is deselected, so nothing
    // downloads; the fixture only has to exist for `client.get` to
    // find it.
    client.send(encode('wt-start-torrenting', [
      1, FIXTURE, downloadPath, null,
      new Array(expected.files.length).fill(false)
    ]))
    await waitFor(
      () => frames.find((f) => f.channel === 'wt-ready') || null,
      'the fixture torrent is ready'
    )

    client.send(encode('wt-force-announce', [expected.infoHash]))
    await waitFor(
      () => out().includes('DIAG announce ' + expected.infoHash +
        ': before peers=') || null,
      'the engine printed the before readout'
    )
    await waitFor(
      () => out().includes('DIAG announce ' + expected.infoHash +
        ': sent tracker=') || null,
      'and reported which halves fired'
    )

    t.pass('wt-force-announce is wired end to end')
  } finally {
    if (client) client.close()
    child.kill()
    await new Promise((resolve) => child.once('exit', resolve))
    await fs.promises.rm(downloadPath, { recursive: true, force: true })
  }

  t.end()
})

// Wait on a condition, never on a delay (test/AGENTS.md). `check`
// returns a truthy value to stop, or null to keep waiting.
async function waitFor (check, what, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > deadline) throw new Error('timed out waiting: ' + what)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build:node && npx tape test/unit/engine-force-announce.js`
Expected: FAIL, timing out on "the engine reported the missing torrent"
because no handler is registered for the channel.

- [ ] **Step 3: Import the announce module**

In `src/engine/index.js`, add to the import block after
`import { createWebSocketBus } from './bus-websocket'`:

```js
import { announceNow } from './announce'
```

- [ ] **Step 4: Register the command**

In `init()` in `src/engine/index.js`, after the existing
`bus.on('wt-select-files', ...)` registration:

```js
  bus.on('wt-force-announce', (infoHash) =>
    forceAnnounce(infoHash))
```

- [ ] **Step 5: Write the diagnostic handler**

In `src/engine/index.js`, add below `stopTorrenting`:

```js
// How long after a forced announce to report the peer count again. The
// answer to "did re-announcing help" is a number a few seconds later,
// not a return value, so the readout is scheduled.
const ANNOUNCE_DIAG_DELAYS_MS = [5000, 15000, 30000]

// DIAGNOSTIC: a manually triggered re-announce, so we can find out
// whether peer discovery on its own revives a torrent that has stalled
// at zero peers -- the question the automatic sweep depends on. The
// `DIAG announce` prefix is what the operator greps for.
function forceAnnounce (infoHash) {
  const torrent = client.get(infoHash)
  if (!torrent) {
    console.log('DIAG announce: no torrent %s', infoHash)
    return
  }

  console.log(
    'DIAG announce %s: before peers=%d down=%dB/s progress=%s',
    infoHash, torrent.numPeers, Math.round(torrent.downloadSpeed),
    torrent.progress.toFixed(4))

  const fired = announceNow(torrent, client.dht)
  console.log('DIAG announce %s: sent tracker=%s dht=%s',
    infoHash, fired.tracker, fired.dht)

  for (const delay of ANNOUNCE_DIAG_DELAYS_MS) {
    const timer = setTimeout(() => {
      const later = client.get(infoHash)
      if (!later) return
      console.log('DIAG announce %s: +%ds peers=%d down=%dB/s',
        infoHash, delay / 1000, later.numPeers,
        Math.round(later.downloadSpeed))
    }, delay)
    // A pending readout must not hold the process open on shutdown.
    if (timer.unref) timer.unref()
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run build:node && npx tape test/unit/engine-force-announce.js`
Expected: PASS.

- [ ] **Step 7: Verify the engine source scan still passes**

The scan at `test/unit/engine-entry.js:115` fails on a `.send(` that is
not `bus.send(` and on a `wt-` subscription that is not `bus.on(`. The
new code adds neither, but confirm rather than assume.

Run: `npx tape test/unit/engine-entry.js`
Expected: PASS, including "every subscription goes through the bus".

- [ ] **Step 8: Document it in the engine notes**

In `src/engine/AGENTS.md`, add to the end of the `index.js` section:

```markdown
## `announce.js`

`announceNow(torrent, dht)` is the discovery half of "destroy and
re-add": a tracker `update()` plus a DHT `lookup()`, with no re-verify
of pieces on disk and no dropped peer connections. It exists because
the natural cadence is slow -- 30 minutes per tracker, 15 minutes plus
jitter for the DHT -- so a torrent whose last peer drops can sit at
zero peers for half an hour.

`wt-force-announce` in `index.js` is the manually triggered form, and
it is **diagnostic instrumentation, not a feature**: it logs peer
counts before the call and again at 5, 15 and 30 seconds after, all
under the `DIAG announce` prefix. It answers one question -- does
re-announcing on its own revive a stalled torrent -- and it comes out
once that question has an answer.
```

- [ ] **Step 9: Lint and run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/engine/index.js src/engine/AGENTS.md \
  test/unit/engine-force-announce.js
git commit -m "feat(engine): add wt-force-announce with a peer-count readout"
```

---

### Task 3: The shim export

**Files:**
- Modify: `src/renderer/lib/platform/ipc-engine.js`
- Test: `test/unit/platform-ipc-engine.js`

**Interfaces:**
- Consumes: the `wt-force-announce` channel from Task 2.
- Produces: `forceAnnounce(infoHash: string): Promise<void>`, exported
  from `ipc-engine.js`. Task 4 calls it.

- [ ] **Step 1: Write the failing test**

In `test/unit/platform-ipc-engine.js`, add after the existing
`stopServer names the torrent to release` test:

```js
test('forceAnnounce names the torrent to re-announce',
  async function (t) {
    const socket = await connected()
    const before = socket.sent.length
    await ipcEngine.forceAnnounce('abc')
    t.deepEqual(socket.frames().slice(before),
      [{ channel: 'wt-force-announce', args: ['abc'] }])
    t.end()
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build:node && npx tape test/unit/platform-ipc-engine.js`
Expected: FAIL, `ipcEngine.forceAnnounce is not a function`.

- [ ] **Step 3: Add the export**

In `src/renderer/lib/platform/ipc-engine.js`, after the `stopServer`
export:

```js
/**
 * Ask the engine to re-announce one torrent to its trackers and the
 * DHT, without tearing the torrent down. Fire-and-forget: the engine
 * logs the result rather than replying, because the answer is a peer
 * count some seconds later.
 *
 * DIAGNOSTIC. Paired with the `DIAG announce` logging in
 * `src/engine/index.js`, and comes out with it.
 *
 * @param {string} infoHash
 * @returns {Promise<void>}
 */
export async function forceAnnounce (infoHash) {
  send('wt-force-announce', [infoHash])
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build:node && npx tape test/unit/platform-ipc-engine.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/lib/platform/ipc-engine.js \
  test/unit/platform-ipc-engine.js
git commit -m "feat(shim): expose forceAnnounce on the engine shim"
```

---

### Task 4: The context menu item

**Files:**
- Modify: `src/renderer/controllers/torrent-list-controller.js:257-304`
- Modify: `test/unit/engine-ipc-call-sites.js`
- Modify: `test/unit/torrent-context-menu.js`
- Modify: `docs/platform-shim.md:770-783`, `:938-946`

**Interfaces:**
- Consumes: `ipcEngine.forceAnnounce(infoHash)` from Task 3.
- Produces: `TorrentListController.prototype.forceAnnounce(infoHash)`
  and a context menu item labelled `Force Re-announce`.

The menu item's `click` calls a named controller method rather than
inlining the shim call. That is what lets
`test/unit/engine-ipc-call-sites.js` assert the routing without opening
a menu: that file stubs `ipc-engine` but not `lib/platform/menu`, and
`test/unit/torrent-context-menu.js` stubs `menu` but not `ipc-engine`.
Splitting the assertion across both files keeps each one away from the
stub-leak hazard documented in `test/AGENTS.md`.

- [ ] **Step 1: Write the failing routing test**

In `test/unit/engine-ipc-call-sites.js`, add `'forceAnnounce'` to the
`ENGINE_COMMANDS` array (a shim export missing from that list is not
stubbed, so the call would reach the real socket):

```js
const ENGINE_COMMANDS = [
  'setGlobalTrackers',
  'startTorrenting',
  'stopTorrenting',
  'createTorrent',
  'saveTorrentFile',
  'getAudioMetadata',
  'startServer',
  'stopServer',
  'selectFiles',
  'forceAnnounce'
```

Then add a test alongside the other torrent-list-controller tests:

```js
test('a forced re-announce goes through the shim', async function (t) {
  reset()
  const state = {
    saved: { torrents: [{ torrentKey: 7, infoHash: 'abc' }] }
  }
  new TorrentListController(state).forceAnnounce('abc')
  await flush()
  t.deepEqual(record.engine, [['forceAnnounce', 'abc']],
    'the info hash goes out as forceAnnounce')
  t.end()
})
```

- [ ] **Step 2: Write the failing menu test**

In `test/unit/torrent-context-menu.js`, add:

```js
test('the menu offers a forced re-announce', function (t) {
  const items = openMenu()
  const item = itemNamed(items, 'Force Re-announce')
  t.ok(item, 'the item is present')
  t.equal(typeof item.click, 'function', 'and it is clickable')
  t.end()
})
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `npm run build:node && npx tape test/unit/engine-ipc-call-sites.js
test/unit/torrent-context-menu.js`
Expected: FAIL. The routing test fails with
`controller.forceAnnounce is not a function`; the menu test fails on
`the item is present`.

- [ ] **Step 4: Add the controller method**

In `src/renderer/controllers/torrent-list-controller.js`, add after
`pauseTorrent`:

```js
  // DIAGNOSTIC: ask the engine to re-announce this torrent to its
  // trackers and the DHT without tearing it down. Paired with the
  // `DIAG announce` logging in the engine, and comes out with it.
  forceAnnounce (infoHash) {
    const torrentSummary = TorrentSummary.getByKey(this.state, infoHash)
    reportErrors(ipcEngine.forceAnnounce(torrentSummary.infoHash))
  }
```

- [ ] **Step 5: Add the menu item**

In `openTorrentContextMenu`, insert immediately before the
`{ type: 'separator' }` that precedes the `Sort by Name` item:

```js
      {
        label: 'Force Re-announce',
        click: () => this.forceAnnounce(torrentSummary.infoHash)
      },
```

- [ ] **Step 6: Run both tests to verify they pass**

Run: `npx tape test/unit/engine-ipc-call-sites.js
test/unit/torrent-context-menu.js`
Expected: PASS.

- [ ] **Step 7: Update the protocol tables**

In `docs/platform-shim.md`, add to the Commands table under
`### Commands` (around line 783), after the `selectFiles` row:

```markdown
| `forceAnnounce(infoHash)` | `wt-force-announce` | new in this story (diagnostic) |
```

And in the command table under `## The `wt-*` protocol` (around line
946), after the `wt-select-files` row:

```markdown
| `wt-force-announce` | `(infoHash: string)` | fire-and-forget; the engine logs `DIAG announce` lines rather than replying |
```

Add this paragraph directly below that table:

```markdown
`wt-force-announce` is **diagnostic instrumentation, not a feature.**
It asks one torrent to re-announce to its trackers and the DHT without
destroying it, and the engine prints peer counts before the call and
again at 5, 15 and 30 seconds after. It exists to answer whether peer
discovery on its own revives a torrent stalled at zero peers, and it
comes out once that question has an answer.
```

- [ ] **Step 8: Run the whole suite**

Run: `npm test`
Expected: PASS. `test/unit/platform-boundary.js` in particular must
still pass -- it fails on a `wt-` string literal in a controller, and
the controller here names only the shim function.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/controllers/torrent-list-controller.js \
  test/unit/engine-ipc-call-sites.js test/unit/torrent-context-menu.js \
  docs/platform-shim.md
git commit -m "feat(ui): add a Force Re-announce item to the torrent menu"
```

---

### Task 5: Run the experiment

**Files:** none. This task produces a written result, not a diff.

This is the deliverable of the whole plan. Do not skip it and do not
start the sweep plan before it has an answer.

- [x] **Step 1: Build and start the app with a visible terminal**

Run: `npm start`

Engine stdout is relayed to this terminal with an `Engine:` prefix.

- [ ] **Step 2: Wait for a stall**

Leave the app downloading until at least one torrent shows no peer
count in the list. The row renders `N peers` only when `numPeers > 0`
(`src/renderer/pages/torrent-list-page.js:179`), so no peer text means
zero peers.

Do not click play on anything while waiting. The "Highest playback
priority" preference destroys and re-adds every other active torrent on
a play click (`controllers/torrent-list-controller.js:161`), which is
the confound this whole experiment exists to avoid.

- [x] **Step 3: Record the starting state**

Note, for each stalled torrent: its name, its percentage, and how long
it has shown zero peers.

Stalled torrent: "Boris & Merxbow - Gensho", 97%, I think the full time since
`npm start`.

- [x] **Step 4: Fire the diagnostic**

Right-click one stalled torrent and choose **Force Re-announce**.

- [x] **Step 5: Read the result**

For the "Boris + Merzbow" torrent:

```
Engine: DIAG announce ac9a4009c5b137c69c8d27fd295079c6e5b7a065: before peers=0 down=0B/s progress=0.9796
Engine: DIAG announce ac9a4009c5b137c69c8d27fd295079c6e5b7a065: sent tracker=true dht=true
Engine: DIAG announce ac9a4009c5b137c69c8d27fd295079c6e5b7a065: +5s peers=0 down=0B/s
Engine: DIAG announce ac9a4009c5b137c69c8d27fd295079c6e5b7a065: +15s peers=0 down=0B/s
Engine: DIAG announce ac9a4009c5b137c69c8d27fd295079c6e5b7a065: +30s peers=0 down=0B/
```

Four lines appear in the terminal:

```
Engine: DIAG announce <hash>: before peers=0 down=0B/s progress=0.0412
Engine: DIAG announce <hash>: sent tracker=true dht=true
Engine: DIAG announce <hash>: +5s peers=? down=?B/s
Engine: DIAG announce <hash>: +15s peers=? down=?B/s
Engine: DIAG announce <hash>: +30s peers=? down=?B/s
```

- [ ] **Step 6: Repeat on two or three more stalled torrents**

One torrent might have a dead swarm. Three agreeing is a result.

"Mount Eerie - A Crow Looked at Me"

```
Engine: DIAG announce d9622023f2fbc923147348f84c8445c719fba2b7: before peers=0 down=0B/s progress=0.0224
Engine: DIAG announce d9622023f2fbc923147348f84c8445c719fba2b7: sent tracker=true dht=true
Engine: DIAG announce d9622023f2fbc923147348f84c8445c719fba2b7: +5s peers=2 down=169B/s
Engine: DIAG announce d9622023f2fbc923147348f84c8445c719fba2b7: +15s peers=2 down=16514B/s
Engine: DIAG announce d9622023f2fbc923147348f84c8445c719fba2b7: +30s peers=2 down=12612B/s
```

---

Mount Eerie - Discography

```
Engine: DIAG announce b6a81577180871a034901b43e4cf4a492c1019c7: before peers=0 down=0B/s progress=0.1958
Engine: DIAG announce b6a81577180871a034901b43e4cf4a492c1019c7: sent tracker=true dht=true
Engine: DIAG announce b6a81577180871a034901b43e4cf4a492c1019c7: +5s peers=1 down=140B/s
Engine: DIAG announce b6a81577180871a034901b43e4cf4a492c1019c7: +15s peers=1 down=8176B/s
Engine: DIAG announce b6a81577180871a034901b43e4cf4a492c1019c7: +30s peers=1 down=8176B/s
```

- [ ] **Step 7: Write down the verdict**

Read it as follows:

1. **`sent tracker=false` or `dht=false`.** The announce did not
   actually go out. Investigate why that half was missing before
   concluding anything about peers -- most likely `discovery` had not
   been created yet, which means the torrent had no metadata.
2. **Peers rise above zero within 30 seconds, on most torrents
   tried.** Hypothesis confirmed: stalls are a discovery problem and a
   forced announce fixes them. Proceed to **yes**
   `2026-08-05-stalled-torrent-announce-sweep.md`.
3. **Peers stay at zero, but destroying and re-adding the same torrent
   does revive it.** Re-announcing is not sufficient. The difference is
   in what a re-add resets and an announce does not: the tracker client
   itself, the peer bookkeeping (`torrent._peers`), and the connection
   queue. Do not build the sweep. Investigate the tracker client's
   state instead -- specifically whether its UDP sockets are still
   live, which is the likely casualty of a sleep/wake cycle.
4. **Peers stay at zero and a re-add does not revive it either.** The
   swarm is empty and nothing in this plan or the next one is relevant.
   Re-test on a better-seeded torrent before drawing any conclusion.

Record which of the four happened, with the log lines, before starting
any follow-up work.
