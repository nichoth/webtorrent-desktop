/**
 * The app's own files -- the five default torrents, their posters, the
 * notification sounds -- addressed as URLs.
 *
 * Under Electron these were read off disk. `config.STATIC_PATH` was
 * `<repo>/static`, derived from `__dirname`; `lib/state.js` seeded a
 * fresh profile by copying out of it through the fs shim, and
 * `lib/sound.js` built `file://` URLs from it. US-072 broke all three
 * halves of that at once:
 *
 * - there is no `__dirname` in a webview to anchor the path to;
 * - `file://` is not the protocol the window is served over, so those
 *   URLs never loaded a sound;
 * - and in a packaged build the files are embedded in the binary by
 *   `tauri::generate_context!` rather than unpacked beside it, so no
 *   filesystem path names them at all. `resource_dir()` is the
 *   directory the executable sits in during development, and `static/`
 *   is not in it.
 *
 * What does name them is the document they ship alongside. The
 * document root `bin/build-tauri.js` assembles has `static/` and
 * `build-vite/` side by side, the window loads `static/main.html`, and
 * the torrents and sounds are that page's siblings -- so a relative URL
 * resolves to them over the asset protocol, in a `cargo build` run and
 * in a bundle alike, with no host round trip and no allowlist entry.
 *
 * This is a different thing from the fs shim and stays separate from
 * it on purpose. The shim reaches the *user's* files, which the host
 * guards with an allowlist because the renderer must not be able to
 * name an arbitrary path. These are the app's own files, they are
 * read-only, and they are already inside the sandbox the page runs in.
 */

/**
 * The URL a bundled file is served at.
 *
 * Resolved against the running document rather than against a constant
 * so that nothing here knows the protocol: `tauri://localhost` in the
 * app, a `file://` path if the same output is opened directly, and
 * whatever a future host serves it over.
 *
 * @param {string} name Repo-relative to `static/`, e.g. `sound/add.wav`.
 * @returns {string}
 */
export function url (name) {
  return new URL(name, document.baseURI).href
}

/**
 * Read a bundled file.
 *
 * Answers a `Uint8Array`, which is what `lib/platform/fs.js` resolves
 * too -- so a caller that reads one of these and writes it into the
 * profile hands the bytes straight across.
 *
 * @param {string} name
 * @returns {Promise<Uint8Array>}
 */
export async function read (name) {
  const response = await fetch(url(name))

  // `fetch` rejects only on a transport failure; a 404 is a resolved
  // response carrying an error page. Left unchecked, that page would
  // be written into the profile as if it were the file asked for --
  // a .torrent that fails to parse hours later, or a poster that is
  // HTML. Fail here, where the name is still in hand.
  if (!response.ok) {
    throw new Error(
      `Cannot read bundled file ${name}: HTTP ${response.status}`
    )
  }

  return new Uint8Array(await response.arrayBuffer())
}
