# 13: The external player watcher and the VLC probe never strand a child process

**What to build:** Two host paths can leave a child process behind.
When the OS returns an error from `try_wait`, the external player
watcher drops the child without reaping it. The VLC `--version` probe
has no timeout, so a candidate that never exits strands a blocking
thread on every check.

After this ticket, when the watcher gets an error from `try_wait`, it
kills the child and waits on it instead of dropping it. The VLC version
probe has a bounded wait: a candidate that has not exited by the
deadline is killed, reaped, and treated as not answering.

**Blocked by:** None (can start immediately)

**Touches:** `src-tauri/src/external_player.rs` (`watch`,
`answers_version`), in-module `#[cfg(test)]` tests (prior art the
existing tests in `external_player.rs` and its `Sandbox` helper)

**Status:** done

- [x] The VLC probe returns "not answering" within its deadline for a
      command that never exits
- [x] Not automated: the `try_wait` error path kills and reaps the
      child (the OS error cannot be triggered on demand)
