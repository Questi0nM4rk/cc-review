#!/usr/bin/env bash
set -euo pipefail
# ============================================================================
#  run-gitlab.sh — run cc-review on a GitLab MR, LOCALLY, posting via glab.
# ----------------------------------------------------------------------------
#  THE PLATFORM SPLIT
#    GitHub  -> CI + App. Install the workflows (.github/workflows/cc-review*.yml);
#               the bot runs in GitHub Actions and posts as the cc-review App.
#    GitLab  -> LOCAL only (this script). There is no GitLab App / CI install.
#               You run this from inside a clone of the GitLab repo and it posts
#               to the MR using YOUR `glab` credentials. It NEVER pushes branches
#               (no log/memory branch). Review memory stays OUT of the product repo,
#               under ~/.claude/cc-review-memory/<repo-slug>/ (per-machine, never the
#               CI memory branch — local and CI memory never cross).
#
#  The review engine (.claude/workflows/strict-review.mjs) and the I/O adapter
#  (scripts/review-platform.ts) are platform-agnostic: `detect()` routes every
#  verb to the GitHub (`gh`) or GitLab (`glab`) backend. Only the ENTRY POINT
#  differs — that's this script vs the GHA workflow.
#
#  Usage (run from INSIDE a clone of the GitLab repo):
#    scripts/run-gitlab.sh --mr <iid>             review MR + POST to it (your creds)
#    scripts/run-gitlab.sh --mr <iid> --dry-run   review only, post nothing
#    scripts/run-gitlab.sh --mr <iid> --message "focus on the auth change"
#
#  Requires: glab (authed: `glab auth login --hostname <your-instance>`),
#            claude, tsx, git, jq on PATH.
# ============================================================================

BOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${BOT}/.claude/workflows/strict-review.mjs"
ADAPTER="${BOT}/scripts/review-platform.ts"

MR=0
POST=true
MESSAGE=""

die() { printf 'run-gitlab: %s\n' "$1" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mr)           MR="${2:?--mr needs an MR iid}"; shift 2 ;;
    --dry-run)      POST=false; shift ;;
    --message)      MESSAGE="${2:?--message needs text}"; shift 2 ;;
    --message-file) MESSAGE="$(cat "${2:?--message-file needs a path}")"; shift 2 ;;
    -h|--help)      sed -n '4,/^# ===/p' "$0"; exit 0 ;;
    *)              die "unknown flag: $1 (see --help)" ;;
  esac
done

[[ "$MR" =~ ^[0-9]+$ && "$MR" -gt 0 ]] || die "--mr <iid> is required (a positive MR number)"
for c in glab claude tsx git jq; do command -v "$c" >/dev/null || die "$c not on PATH"; done

# ---- Platform gate: this is GitLab-only --------------------------------------
# detect() reads the repo's origin remote (host) — so run from inside the clone.
DET="$(tsx "$ADAPTER" detect 2>/dev/null)" || die "run this from inside a clone of the GitLab repo (could not detect the remote)"
PLATFORM="$(printf '%s' "$DET" | jq -r .platform)"
REPO="$(printf '%s' "$DET" | jq -r .repo)"
HOST="$(printf '%s' "$DET" | jq -r .host)"
[[ "$PLATFORM" == "gitlab" ]] || die "detected '$PLATFORM' (host: $HOST), not gitlab. GitHub uses the CI workflows — this script is GitLab-only."
glab auth status >/dev/null 2>&1 || die "glab is not authenticated for $HOST — run: glab auth login --hostname $HOST"

# ---- Local review memory: OUT of the product repo (#73) ----------------------
# A local ad-hoc run must not pollute the product working tree, and must stay separate from the
# GitHub-CI memory branch (local and CI memory never cross). Memory is keyed by the repo path under
# ~/.claude/cc-review-memory/<slug>/, passed to the brain via args.mem_dir and allowed for writes via
# --add-dir (review agents are filesystem-sandboxed). Never fetched/pushed — purely local, per-machine.
SLUG="$(printf '%s' "$REPO" | tr '/' '-' | tr -cd '[:alnum:]._-')"
MEMDIR="${HOME}/.claude/cc-review-memory/${SLUG:-repo}"

# ---- Stage the same inputs the GHA writes (minus the App/CI bits) ------------
# Truncate any stale prefetched diff so the adapter fetches THIS MR fresh via glab.
mkdir -p /tmp/run "${MEMDIR}/learnings" "${MEMDIR}/pr-${MR}"
: > /tmp/pr-diff.txt
printf '%s' "$MESSAGE" > /tmp/cc-user-msg.txt
[[ -f "${MEMDIR}/MEMORY.md" ]] || printf '# Project Memory: %s\n\n(empty)\n' "$REPO" > "${MEMDIR}/MEMORY.md"
# ping_override:true — a manual local run is an explicit "review now", like an @cc-review ping.
printf '{ "pr_number": %s, "repo": "%s", "platform": "gitlab", "post": %s, "ping_override": true }\n' \
  "$MR" "$REPO" "$POST" > /tmp/cc-input.json

echo "cc-review (GitLab local) — repo=$REPO  MR=!$MR  host=$HOST  post=$POST  mem=$MEMDIR"

# Assemble the review context deterministically (reshape Phase 1) into /tmp/cc-ctx.json — the brain's
# fetch agent relays it verbatim (the Workflow runtime has no fs access). Real GitLab context/threads/
# get-overview via glab; the prior review-state marker lives under $MEMDIR (local memory, #73). A
# platform failure yields the abort shape so the brain aborts instead of reviewing a fallback.
tsx "$ADAPTER" prefetch --pr "$MR" --bot-login "cc-review[bot]" --mem-dir "$MEMDIR" > /tmp/cc-ctx.json

# bot_dir is passed via args so the brain builds absolute adapter/tool paths (it can't read
# $CC_REVIEW_BOT_DIR — sub-agents don't inherit env). Locally BOT is the bot repo root.
PROMPT="Use the Workflow tool with scriptPath '${SCRIPT}' and args { prNumber: ${MR}, repo: '${REPO}', bot_dir: '${BOT}', mem_dir: '${MEMDIR}' }. Run it to completion and report its return value verbatim as JSON. It reads PR/MR number, repo, post-flag, and the @cc-review message from /tmp/cc-input.json + /tmp/cc-user-msg.txt, talks to GitLab via glab through ${ADAPTER}, reads/writes local review memory under ${MEMDIR}, and reads project config from .cc-review.yaml."

# GitLab path: glab only (no gh). Posting is via the adapter's gl.* verbs.
# --dangerously-skip-permissions, NOT --permission-mode bypassPermissions: the latter is silently
# downgraded (to default/auto), which would block the agent's tool calls in a headless run.
printf '%s' "$PROMPT" > /tmp/run/prompt.txt
"$(dirname "${BASH_SOURCE[0]}")/agentapi-claude.sh" --prompt-file /tmp/run/prompt.txt --out /tmp/run/transcript.txt \
  --claude-arg --model --claude-arg claude-sonnet-4-6 \
  --claude-arg --dangerously-skip-permissions \
  --claude-arg --add-dir --claude-arg /tmp \
  --claude-arg --add-dir --claude-arg "${MEMDIR}"

echo "----- workflow transcript (posting happens via glab inside the run; verify on the MR) -----"
cat /tmp/run/transcript.txt 2>/dev/null || echo "(no transcript captured)"
