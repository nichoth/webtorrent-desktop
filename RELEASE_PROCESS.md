## Release Process

A release is an arm64 macOS `.dmg` that you hand to people directly.
It is **ad-hoc signed**: signed without a certificate, so there is no
Apple Developer Program membership involved and no cost. The price is
that macOS cannot verify who made it, so everyone who installs it has
to approve it once (see [First launch](#first-launch) below).

Developer ID signing and notarization, which remove that prompt, are
US-083 in `specs/prd.json` and need a paid membership. Until then, do
not publish a build anywhere the public will find it -- a GitHub
release, or the webtorrent.io update feed -- because every download
would stop at the Gatekeeper prompt.

### 1. Create a new version

- Update `AUTHORS`

  ```
  npm run update-authors
  ```

  Commit if necessary. The commit message should be "authors".

- Write the changelog

  You can use `git log --oneline <last version tag>..HEAD` to get a
  list of changes.

  Summarize them concisely in `CHANGELOG.md`. The commit message should
  be "changelog".

- Update the version

  ```
  npm version [major|minor|patch]
  ```

  This creates both a commit and a `vX.Y.Z` git tag.

- Make a PR

  Once the PR is reviewed, merge it:

  ```
  git push origin <branch-name>:master
  ```

  This makes it so that the commit hash on master matches the commit
  hash of the version tag.

  Finally, run:

  ```
  git push --tags
  ```

  Pushing the tag is what builds the release (next step).

### 2. Build the release

Once per fork: GitHub leaves a fork's workflows switched off until
someone opens its Actions tab and enables them. Until that is done,
neither the tag push nor `gh workflow run` starts anything, and
`gh run list` answers `workflow package.yml not found`.

The tag push starts the `package` workflow
(`.github/workflows/package.yml`). It runs `npm test`, then
`npm run package`, then checks the bundle's signature with
`codesign --verify --deep --strict`, and uploads the `.dmg` as a
workflow artifact named after the file, e.g.
`WebTorrent_0.24.0_aarch64.dmg`.

Follow the run and download the artifact:

```
gh run list -R nichoth/webtorrent-desktop --workflow package.yml --limit 1
gh run watch <run-id> -R nichoth/webtorrent-desktop
gh run download <run-id> -R nichoth/webtorrent-desktop
```

`-R` is there because `gh` otherwise resolves this fork to the
upstream `webtorrent/webtorrent-desktop` repo. The artifact is also on
the run's page in the Actions tab. Downloading it needs a GitHub login
with access to the repo, and GitHub keeps it for 90 days.

To build a branch without tagging, start the workflow by hand:

```
gh workflow run package.yml -R nichoth/webtorrent-desktop --ref <branch>
```

To build locally instead, on an Apple Silicon Mac:

```
npm run package
```

That writes the `.dmg` to `src-tauri/target/release/bundle/dmg/`. CI
runs the same script, so the two builds are equivalent.

### 3. Test it

**This is the most important part.**

- Download the `.dmg` from the workflow run's page **in a browser**,
  and test on a Mac other than the one that built it if you can.

  **Do not use your locally built binaries**, and do not use the copy
  `gh run download` fetched either. macOS marks files downloaded by a
  browser (or Mail, AirDrop, Messages and most chat apps) as
  quarantined, and only a quarantined copy goes through the Gatekeeper
  check the people you send it to will hit. A local build and a `gh`
  download skip it.

- Go through [First launch](#first-launch) exactly as a recipient
  would. If macOS says the app "is damaged and can't be opened"
  instead of offering Open Anyway, the signature is broken: do not
  send that build.

- Smoke test WebTorrent Desktop. Check that the following basic use
  cases work correctly:

  1. Click "Play" to stream a built-in torrent (e.g. Sintel)
    - Ensure that seeking to undownloaded region works and plays immediately.
    - Ensure that sintel.mp4 gets downloaded to `~/Downloads`.

  2. Check that the update check runs
    - Quit the app and start it from a terminal, so its output is
      visible:

      ```
      /Applications/WebTorrent.app/Contents/MacOS/webtorrent-desktop
      ```

    - The check runs about three seconds after launch. An up-to-date
      app prints nothing; a failed check prints a line starting
      `Update error:`. The check only announces a newer version -- it
      never downloads or installs one.

  3. Add a new .torrent file via drag-and-drop.
    - Ensure that it gets added to the list and starts downloading.

  4. Remove a torrent from the client
    - Ensure that the file is removed from `~/Downloads`

  5. Create and seed a new a torrent via drag-and-drop.
    - Ensure that the torrent gets created and seeding begins.

### 4. Ship it

Send the `.dmg` to the people who should have it, with the
[First launch](#first-launch) steps below. It runs on Apple Silicon
Macs only; an Intel Mac cannot open it.

### First launch

Recipients do this once per install. Copy it into the message you send
the `.dmg` with:

> Open the .dmg and drag WebTorrent to Applications. Double-click it;
> macOS will say it can't verify the app -- click Done. Then open
> System Settings > Privacy & Security, scroll down, click "Open
> Anyway" next to WebTorrent, and confirm with your password. After
> that it opens normally.

The Terminal equivalent, for anyone who prefers it, is:

```
xattr -dr com.apple.quarantine /Applications/WebTorrent.app
```

Right-click > Open, the old way around this prompt, no longer works as
of macOS 15.
