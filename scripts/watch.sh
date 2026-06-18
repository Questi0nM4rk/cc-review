#!/usr/bin/env bash
# ============================================================================
#  watch.sh — live view of a running (or just-finished) cc-review workflow.
# ----------------------------------------------------------------------------
#  Works for ANY local run (GitLab `run-gitlab.sh`, or `run-local.sh`): it
#  auto-discovers the newest workflow journal under ~/.claude/projects and
#  prints the driving-session status + each agent's result as it completes.
#
#  Usage:
#    scripts/watch.sh                     one snapshot
#    watch -n5 scripts/watch.sh           refresh every 5s (live)
#  Env:
#    AGENTAPI_PORT=3284   driving-session control port (default 3284)
#    CC_WATCH_PROJECTS    projects root (default ~/.claude/projects)
# ============================================================================
set -uo pipefail
PORT="${AGENTAPI_PORT:-3284}"
PROJECTS="${CC_WATCH_PROJECTS:-$HOME/.claude/projects}"

command -v jq >/dev/null 2>&1 || { echo "watch: jq is required" >&2; exit 2; }

# 1) driving-session status + workflow progress line (best-effort; server gone once the run ends)
st=$(curl -s --max-time 5 "http://localhost:${PORT}/status" 2>/dev/null | jq -r '.status // "down"')
prog=$(curl -s --max-time 8 "http://localhost:${PORT}/messages" 2>/dev/null \
        | jq -r '(.messages // [])[-1].content // ""' | grep -oE '◯ strict-review.*' | tail -1)
printf '── session: %s   %s\n\n' "$st" "${prog:-(no live workflow line — run may have finished)}"

# 2) newest workflow journal — per-agent results as they land
J=$(find "$PROJECTS" -path '*subagents/workflows/*/journal.jsonl' -printf '%T@ %p\n' 2>/dev/null \
      | sort -nr | head -1 | cut -d' ' -f2-)
[ -z "$J" ] && { echo "(no workflow journal found under $PROJECTS)"; exit 0; }
printf '── journal: %s\n\n' "$J"

n=0
grep '"result"' "$J" 2>/dev/null | while IFS= read -r line; do
  n=$((n+1))
  res=$(printf '%s' "$line" | jq -r '.result // ""' 2>/dev/null)
  kind=$(printf '%s' "$res" | jq -r '
    if .difficulty then "HOLISTIC"
    elif (.graded!=null) then "CHECK"
    elif (.findings!=null) then "REVIEW"
    elif .observations then "RESEARCH"
    elif .diff then "FETCH"
    elif .notes then "MEMDOCS"
    elif .available then "TOOLS"
    elif .is_question!=null then "ANSWER"
    else (try (keys|tostring) catch "TEXT") end' 2>/dev/null)
  case "${kind:-TEXT}" in
    FETCH)    echo "#$n 📥 FETCH — diff fetched" ;;
    HOLISTIC) printf '%s' "$res" | jq -r '"#'"$n"' 🧭 HOLISTIC — \(.category) · difficulty \(.difficulty)/5"' 2>/dev/null ;;
    RESEARCH) printf '%s' "$res" | jq -r '"#'"$n"' 📚 RESEARCH(\(.source)) — \(.observations|length) obs"' 2>/dev/null ;;
    MEMDOCS)  printf '%s' "$res" | jq -r '"#'"$n"' 🗃️  MEMDOCS — \(.notes|length) notes"' 2>/dev/null ;;
    TOOLS)    printf '%s' "$res" | jq -r '"#'"$n"' 🔧 TOOLS — available=[\(.available|join(","))]"' 2>/dev/null ;;
    ANSWER)   printf '%s' "$res" | jq -r '"#'"$n"' 💬 ANSWER — is_question=\(.is_question)"' 2>/dev/null ;;
    REVIEW)   echo "#$n 🔎 REVIEW —"; printf '%s' "$res" | jq -r '.findings[]? | "      • \(.file):\(.line) — \(.description)"' 2>/dev/null ;;
    CHECK)    echo "#$n 🔬 CHECK —"; printf '%s' "$res" | jq -r '.graded[]? | "      [\(.verdict)/\(.confidence)] \(.original.file):\(.original.line)"' 2>/dev/null ;;
    *)        echo "#$n ${kind:-TEXT}" ;;
  esac
done
