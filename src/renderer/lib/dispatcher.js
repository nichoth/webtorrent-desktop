const dispatchers = {}
let _dispatch = () => {}

export function setDispatch (dispatch) {
  _dispatch = dispatch
}

export function dispatch (...args) {
  _dispatch(...args)
}

// Every platform-shim export is a promise (FR-10), but most call sites
// -- controller methods invoked by name, DOM handlers, route
// lifecycle hooks -- have nowhere to await. They pass the promise here
// instead of leaving it floating, so a shim failure surfaces as an
// error the user sees rather than an unhandled rejection.
export function reportErrors (promise) {
  promise.catch((err) => dispatch('error', err))
}

// Most DOM event handlers are trivial functions like `() => dispatch(<args>)`.
// For these, `dispatcher(<args>)` is preferred because it memoizes the handler
// function. This prevents React from updating the listener functions on
// each update().
export function dispatcher (...args) {
  const str = JSON.stringify(args)
  let handler = dispatchers[str]
  if (!handler) {
    handler = dispatchers[str] = e => {
      // Do not propagate click to elements below the button
      e.stopPropagation()

      if (e.currentTarget.classList.contains('disabled')) {
        // Ignore clicks on disabled elements
        return
      }

      dispatch(...args)
    }
  }
  return handler
}
