# Controllers

Each file here exports a class whose public methods are dispatcher
**actions**. `src/renderer/main.js` builds a flat map of action name ->
handler, and `lib/dispatcher.js` looks actions up **by string name** at
call time.

Consequences when editing a controller:

- Never delete a public method just because its body became empty.
  Callers dispatch by name from JSX (`onClick={() => dispatch('foo')}`)
  and from the main process
  (`windows.main.dispatch('uncaughtError', ...)`), so a missing method
  is a runtime lookup failure, not a compile error. Leave an empty
  method with a comment instead.
- Renaming a method means grepping for the string, not for the
  identifier. Check `src/renderer/pages/`, `src/renderer/components/`
  and `src/main/` too.
- Controllers are lazily *constructed* via `fn-getter` in `main.js`, but
  since the ESM conversion they are no longer lazily *loaded* -- their
  `import` in `main.js` is hoisted, so every module-level import here is
  paid at startup. A heavy new dependency in a controller now costs
  startup time. There is no synchronous ESM equivalent of the old lazy
  `require`, so if that ever matters the fix is a bundler-level split,
  not an inner `require`.

Controllers reach the main process through `ipcRenderer` today. Phase 2
of the renderer-decoupling work replaces those calls with the platform
shim -- check `specs/prd.json` before adding a new direct `electron`
import here.
