# 09: Leaving the player unloads its media and resets the media session

**What to build:** The player page's unmount hook is misnamed, so React
never calls it. The media element is never unloaded, and the media
session metadata is set on the first play of the session and never
refreshed. The system media controls show a stale title and stale next
and previous actions.

After this ticket, the unmount hook has React's real lifecycle name, so
it runs. When it runs, it unloads both the main media element and the
preview element and resets the media session metadata, so the next play
sets fresh metadata and media-key actions.

Pages are Vite-only and cannot be required in the unit suite, so this
ticket is verified by hand.

**Blocked by:** None (can start immediately)

**Touches:** `src/renderer/pages/player-page.js` (the
`onComponentWillUnmount` hook, `navigator.mediaSession`)

**Status:** ready-for-agent

- [ ] Manual check: play one file, close the player, play a different
      file, and the system media controls show the second file's title
- [ ] Manual check: after closing the player, the main and preview media
      elements no longer hold a source
