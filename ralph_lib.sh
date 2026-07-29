#!/usr/bin/env bash
#
# ralph_lib.sh -- helpers shared by ralph_claude.sh (the headless loop) and
# ralph_device.sh (an attended, human-in-the-loop session).
#
# This file is SOURCED, never executed. It defines logging helpers and the
# stray-process reaper, and sets REPO_ROOT.

# --- UI Colors --------------------------------------------------------------
BLUE='\033[1;34m'; YELLOW='\033[1;33m'; GREEN='\033[1;32m'; MAGENTA='\033[1;35m'; RED='\033[1;31m'; NC='\033[0m'
log_info()    { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_step()    { echo -e "${YELLOW}➔ $1${NC}"; }
log_success() { echo -e "${GREEN}✅ $1${NC}"; }
log_warn()    { echo -e "${MAGENTA}⚠️  $1${NC}"; }
log_error()   { echo -e "${RED}✖ $1${NC}"; }

# --- Stray process reaper ----------------------------------------------------
# Every app launch here is a real Electron process tree (main + helpers), and
# `npm run test-integration` adds a chromedriver. A session that forgets to kill
# what it started leaves that tree running, and across N iterations they stack
# up until the machine is out of memory. The reaper kills anything still running
# out of THIS repo's node_modules.
#
# Scoping matters: match on the absolute repo path so we can never touch VS Code,
# Discord, or any other Electron app on the machine. The path test is a fixed
# string (grep -F), so nothing in the path is treated as a regex.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
STRAY_MATCH='/(electron|chromedriver|vite)'   # binaries worth reaping
REAP_STRAYS=${REAP_STRAYS:-1}                 # set to 0 to disable the reaper

list_strays() {
    ps -Ao pid=,command= 2>/dev/null \
      | grep -F "$REPO_ROOT/node_modules/" \
      | grep -Ei "$STRAY_MATCH" \
      | awk '{print $1}' || true
}

# Signal PIDs read one-per-line from stdin. Reading rather than word-splitting
# an unquoted "$pids" keeps this correct under bash 3.2 (macOS system bash),
# bash 5, and any shell that does not split unquoted expansions.
kill_pids() {
    local sig="$1" pid
    while read -r pid; do
        [ -n "$pid" ] && kill "-$sig" "$pid" 2>/dev/null
    done
    return 0
}

# Reap in two passes: TERM first so Electron can shut down cleanly, then KILL
# whatever ignored it. Helper processes normally die with their main process, so
# the second pass is usually a no-op.
reap_strays() {
    [ "${REAP_STRAYS:-1}" = "1" ] || return 0
    local when="${1:-}" pids
    pids="$(list_strays)"
    [ -z "$pids" ] && return 0
    log_warn "Reaping stray repo processes ($when): $(echo "$pids" | tr '\n' ' ')"
    printf '%s\n' "$pids" | kill_pids TERM
    sleep 3
    pids="$(list_strays)"
    if [ -n "$pids" ]; then
        log_warn "Force-killing survivors: $(echo "$pids" | tr '\n' ' ')"
        printf '%s\n' "$pids" | kill_pids KILL
    fi
    return 0
}
