/**
 * The user-facing error list, `state.errors`. The error banner shows
 * only errors younger than `ERROR_WINDOW_MS`, so anything older is
 * dropped whenever a new error is recorded and the list stays bounded.
 */

export const ERROR_WINDOW_MS = 5000

export function isRecent (error, now) {
  return now - error.time < ERROR_WINDOW_MS
}

// Mutates `errors` in place so every holder of `state.errors` sees it
export function recordError (errors, message, now = new Date().getTime()) {
  let kept = 0
  for (const error of errors) {
    if (isRecent(error, now)) errors[kept++] = error
  }
  errors.length = kept
  errors.push({ time: now, message })
}
