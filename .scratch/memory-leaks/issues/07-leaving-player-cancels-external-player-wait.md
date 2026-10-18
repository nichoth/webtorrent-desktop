# 07: Leaving the player cancels the external player's server wait

**What to build:** When the user opens a file in an external player and
the server is not up yet, the media controller waits for "server
running" and never cancels that wait. If the server answers after the
user has left the player, the app tries to open the external player
with an empty URL.

After this ticket, the media controller's external-player server wait
is cancelled when the user leaves the player, and a reply that arrives
after leaving never opens the external player.

**Blocked by:** None (can start immediately)

**Touches:** `src/renderer/controllers/media-controller.js` (the
external-player `onServerRunningFor` wait), new
`test/unit/media-controller-external-player.js` (controller-compile
recipe in `test/AGENTS.md`, prior art
`test/unit/media-controller-playability.js`; emit under a distinct
suffix and run alongside the existing controller tests in both orders)

**Status:** ready-for-agent

- [ ] Leaving the player before the server reply leaves no
      external-player subscription armed
- [ ] A server reply that arrives after leaving never opens the
      external player
