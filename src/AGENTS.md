# src/

## Module systems

`src/renderer/` is being converted to ESM; `src/main/` stays CommonJS.
Both are compiled by `npm run build` (`babel src --out-dir build`) and
loaded by Electron as CommonJS.

The `babel` key in `package.json` carries
`@babel/plugin-transform-modules-commonjs` with
`sourceType: "unambiguous"`. Without that plugin Babel leaves `import`
and `export` untouched in the output, and Electron 27 (Node 18) cannot
`require()` an ES module -- the app dies at startup. Do not remove it.
`unambiguous` is what keeps files with no `import`/`export` compiling as
scripts, so the still-CommonJS files are not silently switched to strict
mode.

Convert consumers before their dependencies. Babel compiles
`export default X` to `exports.default = X`, so a CommonJS caller doing
`require('./x')` on a converted module gets a wrapper object instead of
the value. The reverse (ESM importing CommonJS) is safe via Babel's
`_interopRequireDefault`.

## `src/config.js`

Exports every value **twice**: once as a named export and once inside
the default export object. Both are load-bearing.

- Named exports serve `src/main/` (`config.APP_NAME` and
  `const { APP_NAME } = require('../config')`).
- The default export serves ESM renderer code
  (`import config from '../config'`).

Adding a value to one and not the other makes it silently missing for
half the codebase. There is a "keep in sync" comment on the default
export object.

`bin/clean.js`, `bin/package.js` and `bin/open-config.js` require this
file **straight from source**, so plain Node loads it as real ESM rather
than through Babel. That is why `__dirname` is read through the
`DIRNAME` guard at the top -- it does not exist in an ES module scope.
Anything new added here that depends on a CommonJS-only global will
break those three npm scripts, and nothing else will notice.

## `src/renderer/webtorrent.js`

Exempt from all of the above (FR-4): it stays CommonJS, is never passed
through Vite, and loads via `static/webtorrent.html`.
