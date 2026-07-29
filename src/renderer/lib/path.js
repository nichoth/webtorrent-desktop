/**
 * The renderer's `path` implementation.
 *
 * `vite.config.js` aliases both `path` and `node:path` to this file, so
 * it serves every `path` import in the renderer bundle: the thirteen
 * first-party files that do string manipulation on file names, and the
 * bundled dependencies that reach further (`application-config`,
 * `write-file-atomic`, `make-dir`, `rimraf`, `path-scurry`, `mime`,
 * `parse-torrent`, `create-torrent`).
 *
 * It replaces the `path-browserify` package and matches its surface
 * exactly: the posix algorithms, `sep`, `delimiter`, a `posix`
 * self-reference and a null `win32`. Windows path semantics are
 * deliberately absent -- see ADR-011.
 *
 * Nothing here touches the host. `resolve()` is the single exception
 * and it reads `process.cwd` defensively; see the note there.
 */

const SLASH = 47 // '/'

/**
 * Node throws a TypeError rather than coercing, and callers rely on
 * that: a `process.env` lookup that Vite had statically replaced with
 * `{}` surfaced as "Path must be a string. Received undefined" from
 * the first `join()` of startup rather than as a corrupt path written
 * to disk. Keeping the check keeps that failure loud.
 */
function assertPath (value) {
  if (typeof value !== 'string') {
    throw new TypeError(
      'Path must be a string. Received ' + JSON.stringify(value)
    )
  }
}

/**
 * Collapses `.` and `..` segments. `allowAboveRoot` keeps leading
 * `..` segments that would otherwise escape the root, which is correct
 * for relative paths and wrong for absolute ones.
 */
function normalizeString (input, allowAboveRoot) {
  const out = []

  for (const segment of input.split('/')) {
    if (segment === '' || segment === '.') continue

    if (segment !== '..') {
      out.push(segment)
    } else if (out.length > 0 && out[out.length - 1] !== '..') {
      out.pop()
    } else if (allowAboveRoot) {
      out.push('..')
    }
  }

  return out.join('/')
}

/**
 * The working directory a relative `resolve()` resolves against.
 *
 * Node reads `process.cwd()`. Under Electron with `nodeIntegration`
 * that is the real thing, and this returns it, so behaviour matches
 * Node exactly. In a host without a `process` -- the Tauri renderer
 * this decoupling is aimed at -- it falls back to the root instead of
 * throwing. No renderer call site resolves a relative path today, so
 * the fallback is unreachable in the current app.
 */
function workingDirectory () {
  const hasCwd = typeof process !== 'undefined' &&
    typeof process.cwd === 'function'

  return hasCwd ? process.cwd() : '/'
}

/** The index just past the last non-slash character. */
function endOfPath (input) {
  let end = input.length
  while (end > 0 && input.charCodeAt(end - 1) === SLASH) end--
  return end
}

export function isAbsolute (input) {
  assertPath(input)
  return input.charCodeAt(0) === SLASH
}

export function normalize (input) {
  assertPath(input)
  if (input.length === 0) return '.'

  const absolute = input.charCodeAt(0) === SLASH
  const trailingSlash = input.charCodeAt(input.length - 1) === SLASH

  let normalized = normalizeString(input, !absolute)
  if (normalized.length === 0 && !absolute) normalized = '.'
  if (normalized.length > 0 && trailingSlash) normalized += '/'

  return absolute ? '/' + normalized : normalized
}

export function join (...segments) {
  let joined

  for (const segment of segments) {
    assertPath(segment)
    if (segment.length === 0) continue
    joined = joined === undefined ? segment : joined + '/' + segment
  }

  return joined === undefined ? '.' : normalize(joined)
}

export function resolve (...segments) {
  let resolved = ''
  let absolute = false

  // Right to left, stopping at the first absolute segment: everything
  // to its left is unreachable.
  for (let i = segments.length - 1; i >= 0 && !absolute; i--) {
    const segment = segments[i]
    assertPath(segment)
    if (segment.length === 0) continue

    resolved = resolved.length === 0 ? segment : segment + '/' + resolved
    absolute = segment.charCodeAt(0) === SLASH
  }

  if (!absolute) {
    const base = workingDirectory()
    resolved = resolved.length === 0 ? base : base + '/' + resolved
    absolute = base.charCodeAt(0) === SLASH
  }

  const normalized = normalizeString(resolved, !absolute)
  if (absolute) return '/' + normalized
  return normalized.length > 0 ? normalized : '.'
}

export function relative (from, to) {
  assertPath(from)
  assertPath(to)
  if (from === to) return ''

  const fromPath = resolve(from)
  const toPath = resolve(to)
  if (fromPath === toPath) return ''

  const fromParts = fromPath.split('/').filter(Boolean)
  const toParts = toPath.split('/').filter(Boolean)

  let shared = 0
  while (
    shared < fromParts.length &&
    shared < toParts.length &&
    fromParts[shared] === toParts[shared]
  ) shared++

  const up = fromParts.slice(shared).map(() => '..')
  return up.concat(toParts.slice(shared)).join('/')
}

export function dirname (input) {
  assertPath(input)
  if (input.length === 0) return '.'

  const rooted = input.charCodeAt(0) === SLASH
  const end = endOfPath(input)

  // All slashes: the path is its own root.
  if (end === 0) return rooted ? '/' : '.'

  const lastSlash = input.lastIndexOf('/', end - 1)
  if (lastSlash === -1) return rooted ? '/' : '.'
  if (lastSlash === 0) return '/'

  // `//a` is rooted at `//`, which Node preserves here -- but not in
  // `parse().dir`, which reports `/` for the same input.
  if (rooted && lastSlash === 1) return '//'

  return input.slice(0, lastSlash)
}

export function basename (input, suffix) {
  assertPath(input)
  if (suffix !== undefined) assertPath(suffix)

  // Node runs a separate algorithm when a suffix is given, and it only
  // engages for a non-empty suffix that could actually fit. Two of its
  // quirks are load-bearing and reproduced below.
  const stripping = suffix !== undefined && suffix.length > 0 &&
    suffix.length <= input.length

  // Quirk one: a suffix equal to the whole input yields nothing, even
  // though the same suffix against the same *name* under a directory
  // does not -- `basename('.txt', '.txt')` is `''`, while
  // `basename('a/.txt', '.txt')` is `.txt`.
  if (stripping && suffix === input) return ''

  const end = endOfPath(input)

  // Quirk two: an input of nothing but slashes comes back unchanged
  // when a suffix was passed, and empty when one was not.
  if (end === 0) return stripping ? input : ''

  const start = input.lastIndexOf('/', end - 1) + 1
  const base = input.slice(start, end)

  // Stripping a suffix that is the entire name would leave nothing, so
  // Node keeps the name instead.
  if (stripping && suffix !== base && base.endsWith(suffix)) {
    return base.slice(0, base.length - suffix.length)
  }

  return base
}

/** The extension of an already-extracted base name, `''` if none. */
function extensionOf (base) {
  const dot = base.lastIndexOf('.')

  // `dot === 0` is a dotfile, not an extension. `..` is the parent
  // directory, and Node reports no extension for it either.
  if (dot <= 0 || base === '..') return ''

  return base.slice(dot)
}

export function extname (input) {
  assertPath(input)
  return extensionOf(basename(input))
}

export function parse (input) {
  assertPath(input)

  const root = input.charCodeAt(0) === SLASH ? '/' : ''
  const parsed = { root, dir: '', base: '', ext: '', name: '' }
  if (input.length === 0) return parsed

  const end = endOfPath(input)

  // All slashes: root only, no base to speak of.
  if (end === 0) {
    parsed.dir = root
    return parsed
  }

  const lastSlash = input.lastIndexOf('/', end - 1)
  const base = input.slice(lastSlash + 1, end)
  const ext = extensionOf(base)

  // A bare name has no directory at all -- `''`, not the `'.'` that
  // `dirname()` returns for the same input.
  if (lastSlash > 0) parsed.dir = input.slice(0, lastSlash)
  else if (lastSlash === 0) parsed.dir = '/'

  parsed.base = base
  parsed.ext = ext
  parsed.name = ext.length === 0 ? base : base.slice(0, -ext.length)

  return parsed
}

export function format (parsed) {
  if (parsed === null || typeof parsed !== 'object') {
    throw new TypeError(
      'The "pathObject" argument must be of type Object. Received ' +
      typeof parsed
    )
  }

  const dir = parsed.dir || parsed.root
  const base = parsed.base ||
    ((parsed.name || '') + (parsed.ext || ''))

  if (!dir) return base
  return dir === parsed.root ? dir + base : dir + '/' + base
}

/** Posix has no namespaced paths; Node returns the input unchanged. */
export function toNamespacedPath (input) {
  return input
}

export const sep = '/'
export const delimiter = ':'

// Kept because `path-browserify` exported it and Node still carries it
// as the pre-`toNamespacedPath` spelling.
export const _makeLong = toNamespacedPath

const path = {
  resolve,
  normalize,
  isAbsolute,
  join,
  relative,
  dirname,
  basename,
  extname,
  format,
  parse,
  toNamespacedPath,
  _makeLong,
  sep,
  delimiter,
  win32: null,
  posix: null
}

// `path.posix.posix.posix` has to keep working: dependencies chain it.
path.posix = path

export const posix = path

// No Windows semantics here, exactly as `path-browserify` had none.
// `path-scurry` reads this, so it must exist as a name.
export const win32 = null

export default path
