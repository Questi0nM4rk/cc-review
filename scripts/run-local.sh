#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
#  run-local.sh — run the strict-review workflow locally, exactly as CI does.
# ----------------------------------------------------------------------------
#  The bot is designed to run INSIDE .github/workflows/cc-review.yml, which lays
#  down /tmp/cc-input.json + /tmp/pr-diff.txt before invoking the workflow.
#  Running the bare .mjs without that scaffolding makes the fetch fall back to
#  whatever git diff is lying around — which is why hand-runs "review the wrong
#  thing". This script reproduces the GHA's scaffolding faithfully, so the local
#  loop exercises the same path as production.
#
#  Posting is ALWAYS off locally (post=false) — this never touches a real PR.
#
#  Usage:
#    scripts/run-local.sh                       review the working-tree diff (git diff HEAD)
#    scripts/run-local.sh --staged              review staged changes only
#    scripts/run-local.sh --base main           review HEAD vs <ref>
#    scripts/run-local.sh --diff path/to.diff   review a saved unified diff
#    scripts/run-local.sh --pr 4 [--repo o/r]   fetch a real PR's diff (needs gh auth)
#    scripts/run-local.sh --message "@cc-review focus on auth"   set the maintainer message
#    scripts/run-local.sh --scaffold-only       write /tmp files, print the in-session call, then stop
#
#  Requires: claude, tsx, git on PATH (gh only for --pr mode).
# ============================================================================

BOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${BOT}/.claude/workflows/strict-review.mjs"

MODE="working"        # working | staged | base | diff | pr
BASE_REF=""
DIFF_FILE=""
PR_NUMBER=0
REPO=""
MESSAGE=""
SCAFFOLD_ONLY=false

die() { printf 'run-local: %s\n' "$1" >&2; exit 1; }

usage() {
  cat <<'USAGE'
run-local.sh — run the strict-review workflow locally, exactly as CI does.
Posting is ALWAYS off locally (post=false) — this never touches a real PR.

  scripts/run-local.sh                       review the working-tree diff (git diff HEAD)
  scripts/run-local.sh --staged              review staged changes only
  scripts/run-local.sh --base main           review HEAD vs <ref>
  scripts/run-local.sh --diff path/to.diff   review a saved unified diff
  scripts/run-local.sh --pr 4 [--repo o/r]   fetch a real PR's diff (needs gh auth)
  scripts/run-local.sh --message "<text>"    set the maintainer message (simulate @cc-review)
  scripts/run-local.sh --scaffold-only       write /tmp files, print the in-session call, then stop

Requires: claude, tsx, git on PATH (gh only for --pr mode).
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --working)       MODE="working"; shift ;;
    --staged)        MODE="staged"; shift ;;
    --base)          MODE="base"; BASE_REF="${2:?--base needs a ref}"; shift 2 ;;
    --diff)          MODE="diff"; DIFF_FILE="${2:?--diff needs a file}"; shift 2 ;;
    --pr)            MODE="pr"; PR_NUMBER="${2:?--pr needs a number}"; shift 2 ;;
    --repo)          REPO="${2:?--repo needs owner/name}"; shift 2 ;;
    --message)       MESSAGE="${2:?--message needs text}"; shift 2 ;;
    --message-file)  MESSAGE="$(cat "${2:?--message-file needs a path}")"; shift 2 ;;
    --scaffold-only) SCAFFOLD_ONLY=true; shift ;;
    -h|--help)       usage; exit 0 ;;
    *)               die "unknown flag: $1 (see --help)" ;;
  esac
done

command -v git >/dev/null  || die "git not on PATH"
[[ -f "$SCRIPT" ]]         || die "workflow not found: $SCRIPT"

# ---- assemble the diff into /tmp/pr-diff.txt --------------------------------
case "$MODE" in
  working) git diff HEAD               > /tmp/pr-diff.txt ;;
  staged)  git diff --cached           > /tmp/pr-diff.txt ;;
  base)    git diff "${BASE_REF}...HEAD" > /tmp/pr-diff.txt ;;
  diff)    [[ -f "$DIFF_FILE" ]] || die "diff file not found: $DIFF_FILE"; cp "$DIFF_FILE" /tmp/pr-diff.txt ;;
  pr)
    command -v gh >/dev/null || die "--pr mode needs gh on PATH"
    [[ -z "$REPO" ]] && REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
    [[ -z "$REPO" ]] && die "could not resolve --repo; pass it explicitly (owner/name)"
    gh pr diff "$PR_NUMBER" --repo "$REPO" > /tmp/pr-diff.txt \
      || die "gh pr diff $PR_NUMBER --repo $REPO failed (auth? does the PR exist?)"
    ;;
esac

if [[ ! -s /tmp/pr-diff.txt ]]; then
  die "the diff is empty — nothing to review (mode=$MODE). Make some changes or pick a different mode."
fi

# repo label for local-diff modes (best-effort; "" is fine — local mode tolerates it)
if [[ "$MODE" != "pr" && -z "$REPO" ]]; then
  REPO="$(tsx "${BOT}/scripts/review-platform.ts" detect 2>/dev/null | sed -n 's/.*"repo":"\([^"]*\)".*/\1/p' || true)"
fi

# ---- lay down the same /tmp inputs the GHA writes ---------------------------
mkdir -p /tmp/run
printf '%s' "${MESSAGE}" > /tmp/cc-user-msg.txt
PLATFORM="github"; [[ "$REPO" == *gitlab* ]] && PLATFORM="gitlab"
# post is hard-false locally; pr_number 0 => the workflow treats this as a local dry-run.
cat > /tmp/cc-input.json <<JSON
{ "pr_number": ${PR_NUMBER}, "repo": "${REPO}", "platform": "${PLATFORM}", "post": false }
JSON

DIFF_LINES=$(wc -l < /tmp/pr-diff.txt | tr -d ' ')
printf 'scaffolded: mode=%s repo=%s pr=%s diff=%s lines  ->  /tmp/cc-input.json, /tmp/pr-diff.txt\n' \
  "$MODE" "${REPO:-(none)}" "$PR_NUMBER" "$DIFF_LINES"

# In --pr mode we also pass the expected target as args, which engages the identity
# gate: if the fetch fails to resolve PR #N, the workflow aborts instead of reviewing
# a fallback diff. Local-diff modes pass no args (pr_number 0 => local dry-run).
# bot_dir is always passed so the brain builds absolute adapter/tool paths from it (it can't read
# $CC_REVIEW_BOT_DIR — sub-agents don't inherit env). Locally BOT is the bot repo root, so this
# matches the old '.' fallback; it just makes the path explicit instead of cwd-dependent.
if [[ "$MODE" == "pr" ]]; then
  WF_ARGS="{ prNumber: ${PR_NUMBER}, repo: '${REPO}', bot_dir: '${BOT}' }"
else
  WF_ARGS="{ bot_dir: '${BOT}' }"
fi

if [[ "$SCAFFOLD_ONLY" == true ]]; then
  printf '\nScaffold written. Inside a Claude Code session, run:\n\n'
  if [[ -n "$WF_ARGS" ]]; then
    printf "  Workflow tool with scriptPath '%s' and args %s\n\n" "$SCRIPT" "$WF_ARGS"
  else
    printf "  Workflow tool with scriptPath '%s'\n\n" "$SCRIPT"
  fi
  exit 0
fi

command -v claude >/dev/null || die "claude not on PATH (use --scaffold-only to run via the in-session Workflow tool instead)"

PROMPT="Use the Workflow tool with scriptPath '${SCRIPT}'"
[[ -n "$WF_ARGS" ]] && PROMPT="${PROMPT} and args ${WF_ARGS}"
PROMPT="${PROMPT}. Run it to completion and report its return value verbatim as JSON. It reads PR number, repo, post-flag from /tmp/cc-input.json, the diff from /tmp/pr-diff.txt, and project config from .cc-review.yaml."

echo "running workflow via an interactive claude session in tmux (post=false)…"
printf '%s' "$PROMPT" > /tmp/run/prompt.txt
"$(dirname "${BASH_SOURCE[0]}")/tmux-claude.sh" --prompt-file /tmp/run/prompt.txt --out /tmp/run/transcript.txt \
  --claude-arg --model --claude-arg claude-sonnet-4-6 \
  --claude-arg --dangerously-skip-permissions \
  --claude-arg --add-dir --claude-arg /tmp

echo "----- workflow transcript -----"
cat /tmp/run/transcript.txt 2>/dev/null || echo "(no transcript captured)"
