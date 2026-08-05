/**
 * The one thing every unported export in the shim does until the story
 * that owns it lands.
 *
 * ADR-014 planned for the window to be partly broken for most of Phase
 * 4, so the failure mode matters: a stub that returned `undefined`
 * would let a caller carry on with a plausible-looking value and fail
 * somewhere unrelated, which is the expensive kind of incomplete.
 * Throwing names the module and the export in one line, so a console
 * message is enough to tell "this concern is not ported yet" from
 * "this concern is ported and broken".
 *
 * It is a `throw` rather than a rejected promise returned by the
 * caller, because every export in the tree is `async` (FR-10): the
 * throw becomes a rejection at the call site anyway, and the stack
 * points at the stub.
 */

/**
 * The `code` every error below carries, so a caller or a test can
 * recognise one without matching on the message.
 */
export const NOT_IMPLEMENTED = 'WT_TAURI_NOT_IMPLEMENTED'

/**
 * Fail with a named, greppable not-implemented error.
 *
 * @param {string} moduleName the shim module, e.g. `'clipboard'`
 * @param {string} name the export, e.g. `'readText'`
 * @returns {never}
 */
export function notImplemented (moduleName, name) {
  const error = new Error(
    `platform/${moduleName}.${name}() is not implemented yet ` +
    '(ADR-014). Implement it in ' +
    `src/renderer/lib/platform/${moduleName}.js and in the host ` +
    'command it needs.'
  )
  error.name = 'NotImplementedError'
  error.code = NOT_IMPLEMENTED
  throw error
}
