#!/usr/bin/env bash
#
# ralph_device.sh -- attended, human-in-the-loop session for ONE manual story.
#
# ralph_claude.sh is headless. It cannot run the six-step smoke test, watch a
# video's audio tracks switch, or put a Chromecast on the network. Stories that
# need a human at a real app window are flagged `"manual": true` in
# specs/prd.json and are skipped by that loop. This script runs exactly one of
# them INTERACTIVELY: it builds the story context, hands it to a normal (not
# -p) Claude session, and Claude walks you through each device check and
# records what you report.
#
# Usage:  ./ralph_device.sh US-017
#         ./ralph_device.sh 17            # bare numbers are padded to US-0NN
#
# Env:
#   MODEL=opus              model to run (default: opus)
#   SKIP_PERMISSIONS=1      pass --dangerously-skip-permissions (default: off,
#                           because you are sitting here to approve things)
#   ALLOW_NON_MANUAL=1      run a story that is not flagged manual:true
#   RERUN=1                 run a story that already has passes:true
#   REAP_STRAYS=0           do not kill leftover Electron processes on exit
#
set -uo pipefail   # NOT -e: we report failures ourselves.

# --- Config -----------------------------------------------------------------
PROMPT_FILE="PROMPT.md"
PRD_FILE="specs/prd.json"
LOG_FILE="progress.log"
SPEC_MD="tasks/prd-renderer-decoupling.md"   # source of the smoke test steps
MODEL="${MODEL:-opus}"

# Logging helpers and the stray-process reaper, shared with ralph_claude.sh.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ralph_lib.sh
. "$SCRIPT_DIR/ralph_lib.sh" || { echo "Missing $SCRIPT_DIR/ralph_lib.sh"; exit 1; }

TMP_CONTEXT=""
cleanup() {
    rm -f "${TMP_CONTEXT:-}" 2>/dev/null || true
    reap_strays "exit"
}
trap cleanup EXIT
trap 'echo; log_warn "Stopping device session..."; exit 130' INT

usage() {
    sed -n '3,22p' "$0" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

# --- Preflight --------------------------------------------------------------
[ $# -ge 1 ] || { log_error "No story id given."; echo; usage 1; }
case "$1" in -h|--help|help) usage 0 ;; esac

for bin in claude jq git; do
    command -v "$bin" >/dev/null 2>&1 || { log_error "'$bin' not found in PATH."; exit 1; }
done
for f in "$PROMPT_FILE" "$PRD_FILE"; do
    [ -f "$f" ] || { log_error "Missing required file: $f"; exit 1; }
done
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { log_error "Not inside a git repo."; exit 1; }
jq -e 'has("userStories") and (.userStories | type == "array")' "$PRD_FILE" >/dev/null 2>&1 \
    || { log_error "$PRD_FILE is missing/malformed or has no 'userStories' array."; exit 3; }
touch "$LOG_FILE"

# Accept "US-017", "us-017", or "17".
RAW_ID="$1"
if echo "$RAW_ID" | grep -Eq '^[0-9]+$'; then
    STORY_ID="$(printf 'US-%03d' "$RAW_ID")"
else
    STORY_ID="$(echo "$RAW_ID" | tr '[:lower:]' '[:upper:]')"
fi

STORY="$(jq -e --arg id "$STORY_ID" '.userStories[] | select(.id == $id)' "$PRD_FILE" 2>/dev/null)"
if [ -z "$STORY" ]; then
    log_error "No story '$STORY_ID' in $PRD_FILE. Manual stories still pending:"
    jq -r '.userStories[] | select((.passes == false or .passes == null) and (.manual == true)) | "  [\(.id)] \(.title)"' "$PRD_FILE"
    exit 1
fi

IS_MANUAL="$(echo "$STORY" | jq -r '.manual // false')"
IS_PASSING="$(echo "$STORY" | jq -r '.passes // false')"
STORY_TITLE="$(echo "$STORY" | jq -r '.title')"

if [ "$IS_MANUAL" != "true" ] && [ "${ALLOW_NON_MANUAL:-0}" != "1" ]; then
    log_error "$STORY_ID is not flagged manual:true. Headless stories belong to ./ralph_claude.sh."
    log_info  "Run it here anyway with: ALLOW_NON_MANUAL=1 ./ralph_device.sh $STORY_ID"
    exit 1
fi
if [ "$IS_PASSING" = "true" ] && [ "${RERUN:-0}" != "1" ]; then
    log_success "$STORY_ID already passes. Nothing to do."
    log_info "Re-verify anyway with: RERUN=1 ./ralph_device.sh $STORY_ID"
    exit 0
fi

# Start from a clean slate: an app window left over from an earlier run would
# make "is the app behaving?" ambiguous for the whole session.
reap_strays "preflight"

# --- Helpers ----------------------------------------------------------------
# The smoke test steps live in the source PRD, not in prd.json. Pull the section
# verbatim so the human and the model are reading the same list.
smoke_test_section() {
    [ -f "$SPEC_MD" ] || return 0
    awk '
        /^### Standard smoke test/ { inside = 1; print; next }
        inside && (/^## / || /^---[[:space:]]*$/) { exit }
        inside { print }
    ' "$SPEC_MD"
}

# --- Build the session context ----------------------------------------------
TMP_CONTEXT="$(mktemp)"
{
    cat "$PROMPT_FILE"
    echo
    echo "# THIS SESSION IS ATTENDED"
    echo
    echo "A human is at the keyboard, sitting in front of a real machine with a"
    echo "real screen, speakers, and network. That is the whole point of this"
    echo "session: you are running story $STORY_ID, which is flagged"
    echo "\"manual\": true in $PRD_FILE precisely because it cannot be verified"
    echo "headlessly. The autonomous loop (./ralph_claude.sh) skips it."
    echo
    echo "## The story"
    echo
    echo '```json'
    echo "$STORY"
    echo '```'
    echo
    echo "## Conventions from the PRD"
    echo
    echo '```json'
    jq '.conventions' "$PRD_FILE"
    echo '```'
    echo
    SMOKE="$(smoke_test_section)"
    if [ -n "$SMOKE" ]; then
        echo "## The smoke test, verbatim from $SPEC_MD"
        echo
        echo "$SMOKE"
        echo
    fi
    cat <<'RULES'
## How to run an attended session

1. SPLIT THE WORK. Everything that can be checked headlessly (builds, lint,
   `npm test`, `npm run test-integration`, greps, reading code, writing docs)
   is YOUR job and you do it yourself, first. Do not spend the human's
   attention on anything a command can answer.
2. ASK, THEN WAIT. For each criterion that needs eyes, ears, or hardware:
   say which step it is, tell the human exactly what to do and exactly what
   to look for, then STOP and wait for their reply. One step per message.
   Do not batch six questions into one wall of text, and do not carry on as
   if they had answered.
3. NEVER INVENT A RESULT. You cannot see the screen. If the human has not
   told you what happened, the criterion is UNVERIFIED, and unverified is
   not passing. Do not write "smoke test passes" on the strength of a clean
   build, a screenshot you did not take, or a log line that looks healthy.
   This is the single most important rule in this file.
4. RECORD WHAT THEY SAID. Quote the human's actual report in the doc the
   story asks you to update and in `progress.log`. If they describe
   something odd but not fatal, write it down as a known issue rather than
   smoothing it over.
5. MARK DONE HONESTLY. Set `passes: true` for this story ONLY when every
   acceptance criterion is either verified by a command you ran or
   confirmed by the human. Otherwise leave it `false`, and record exactly
   which criteria are outstanding and why. A half-verified story left
   `false` is a good outcome; a fabricated `true` poisons every later story.
6. IF SOMETHING FAILS. Report it to the human, write it up in
   `progress.log`, and recommend a fix. Do not edit other stories in
   specs/prd.json and do not start fixing unrelated things this session.
7. PROCESS HYGIENE. You will be launching the app. Launch it in the
   background, keep the PID, and kill it when the check is done. Before you
   finish, run `pgrep -fl "$PWD/node_modules/"` and kill anything left. Do
   not stack up app windows: relaunching for every question is what caused
   twenty Electron instances to pile up before.
8. COMMIT at the end, as the main PROMPT.md rules describe. Work on this one
   story only, then stop.

Start by telling the human, in a few lines: what you are about to verify
headlessly, and the list of checks you will need them to perform. Then do
the headless part.
RULES
    echo
    echo "LAST_LOG_ENTRIES:"
    tail -n 8 "$LOG_FILE" 2>/dev/null
} > "$TMP_CONTEXT"

# --- Run --------------------------------------------------------------------
HEAD_BEFORE="$(git rev-parse HEAD 2>/dev/null || echo none)"

echo -e "${BLUE}------------------------------------------------------------${NC}"
log_info "ATTENDED SESSION  |  MODEL: $MODEL"
log_step "TARGET: [$STORY_ID] $STORY_TITLE"
log_info "Claude will ask you to perform the device checks. Answer honestly;"
log_info "'I did not check that' is a valid and useful answer."
echo -e "${BLUE}------------------------------------------------------------${NC}"

CLAUDE_ARGS=(--model "$MODEL")
if [ "${SKIP_PERMISSIONS:-0}" = "1" ]; then
    CLAUDE_ARGS+=(--dangerously-skip-permissions)
fi

claude "${CLAUDE_ARGS[@]}" "$(cat "$TMP_CONTEXT")"
CLAUDE_RC=$?
[ "$CLAUDE_RC" -ne 0 ] && log_warn "claude exited non-zero (rc=$CLAUDE_RC)."

# --- Report -----------------------------------------------------------------
echo -e "${BLUE}------------------------------------------------------------${NC}"
PASSES_AFTER="$(jq -r --arg id "$STORY_ID" '.userStories[] | select(.id == $id) | .passes // false' "$PRD_FILE" 2>/dev/null)"
HEAD_AFTER="$(git rev-parse HEAD 2>/dev/null || echo none)"

if [ "$PASSES_AFTER" = "true" ]; then
    log_success "$STORY_ID is now marked passing."
else
    log_warn "$STORY_ID is still passes:false. Check progress.log for what is outstanding."
fi
if [ "$HEAD_AFTER" = "$HEAD_BEFORE" ]; then
    log_warn "No new commit this session (HEAD unchanged at $HEAD_BEFORE)."
fi
if [ -n "$(git status --porcelain)" ]; then
    log_warn "Working tree is dirty. Commit or discard before running the loop again:"
    git status --short
fi

REMAINING_MANUAL="$(jq -r '[.userStories[] | select((.passes == false or .passes == null) and (.manual == true))] | length' "$PRD_FILE" 2>/dev/null)"
log_info "Manual stories still pending: $REMAINING_MANUAL"
exit 0
