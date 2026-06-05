#!/usr/bin/env bash
# ============================================================================
#  ci-run.sh — the cc-review CI pipeline, as a RUNTIME-CLONED script.
#
#  WHY a script and not a composite `uses:` action: a PRIVATE repo's composite
#  action cannot be referenced cross-repo from a personal account (the `uses:`
#  ref is resolved at "Set up job" with the consumer's own GITHUB_TOKEN, which
#  can't read a private sibling repo — `access_level` sharing is org-only). So
#  consumers CLONE cc-review at runtime with the App token (which CAN read the
#  private repo) and run THIS. Edit the pipeline here once; every consumer picks
#  it up on its next run — same runtime-update model as the brain.
#
#  The consumer workflow MUST, before invoking this:
#    1. actions/checkout the consumer repo (PR head)
#    2. generate a GitHub App token (create-github-app-token@v3, client-id)
#    3. clone cc-review with a TOKENISED url so this script + the brain are present
#       (the clone dir's `origin` must be authenticated — the memory push reuses it)
#    4. export: GH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, PR_NUMBER, REPO,
#               CC_POST (1|0), PING_OVERRIDE (true|false)
#  Optional: /tmp/cc-user-msg.txt — the @cc-review message (interactive mode).
#
#  Runs as the runner (NOT the sandboxed agent), so it may write /tmp + mkdir.
#  It pre-creates the dirs the sandboxed brain agents cannot make themselves.
# ============================================================================
set -uo pipefail

CC_REVIEW_BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export GITHUB_TOKEN="${GH_TOKEN}"
: "${CC_POST:=1}" "${PING_OVERRIDE:=false}"
WS="${GITHUB_WORKSPACE:-$PWD}"
cd "$WS"

# ── 1) Pre-fetch diff + stage the memory slice ──────────────────────────────
# Agents are sandboxed to the workspace and cannot mkdir or write /tmp — pre-create
# the scratch dir (post payloads) and the memory dir (learnings + per-PR marker).
mkdir -p /tmp/run .cc-run .cc-memory/learnings ".cc-memory/pr-${PR_NUMBER}"
gh pr view "$PR_NUMBER" --repo "$REPO" --json title,body,author,baseRefName,headRefName,files > /tmp/pr-meta.json
BASE=$(jq -r '.baseRefName' /tmp/pr-meta.json); HEAD=$(jq -r '.headRefName' /tmp/pr-meta.json)
if ! gh pr diff "$PR_NUMBER" --repo "$REPO" > /tmp/pr-diff.txt 2>/dev/null; then
  git fetch origin "$HEAD" 2>/dev/null || true
  # core.quotepath=false: raw UTF-8 paths (not C-escaped) so the parser + inline-comment
  # posting see the same paths the gh API path produces.
  git -c core.quotepath=false diff "origin/$BASE...origin/$HEAD" > /tmp/pr-diff.txt 2>/dev/null || echo "" > /tmp/pr-diff.txt
fi
# Put the PR head on disk so file-reading agents judge the PR's code, not the trigger ref.
git fetch origin "$HEAD" 2>/dev/null && git checkout -q -f FETCH_HEAD 2>/dev/null || echo "PR-head checkout skipped (event already on head)"
# Stage this repo's memory slice INTO THE WORKSPACE (.cc-memory) — the brain writes
# there because the sandbox blocks /tmp writes. The slice carries the review-state marker.
if git -C "$CC_REVIEW_BOT_DIR" fetch origin claude-reviewer/memory 2>/dev/null; then
  git -C "$CC_REVIEW_BOT_DIR" archive FETCH_HEAD "${REPO}/" 2>/dev/null \
    | tar -x -C .cc-memory --strip-components=2 2>/dev/null || true
fi
[ -f .cc-memory/MEMORY.md ] || printf '# Project Memory: %s\n\n(empty)\n' "$REPO" > .cc-memory/MEMORY.md
mkdir -p .cc-memory/learnings ".cc-memory/pr-${PR_NUMBER}"

# ── 2) Install Claude Code + tsx + gitleaks ─────────────────────────────────
npm install -g tsx
curl -fsSL https://claude.ai/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
# gitleaks — pinned + checksum-verified (hardcoded SHA, NOT fetched from the same
# release, so a tampered asset fails here). The log-branch push gates on it.
GL_VER=8.30.1
GL_SHA=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
mkdir -p "$HOME/.local/bin"
curl -fsSL -o /tmp/gitleaks.tgz \
  "https://github.com/gitleaks/gitleaks/releases/download/v${GL_VER}/gitleaks_${GL_VER}_linux_x64.tar.gz"
echo "${GL_SHA}  /tmp/gitleaks.tgz" | sha256sum -c -
tar -xzf /tmp/gitleaks.tgz -C "$HOME/.local/bin" gitleaks
"$HOME/.local/bin/gitleaks" version

# ── 3) Run the strict-review workflow (headless) ────────────────────────────
# Sub-agents do NOT inherit env vars — pass inputs via a file.
jq -n --arg pr "$PR_NUMBER" --arg repo "$REPO" --arg post "$CC_POST" --argjson ping "${PING_OVERRIDE}" \
  '{pr_number:($pr|tonumber), repo:$repo, platform:"github", post:($post=="1"), ping_override:$ping}' > /tmp/cc-input.json
MSG_CLAUSE=""
[ -s /tmp/cc-user-msg.txt ] && MSG_CLAUSE=", and the maintainer @cc-review message from /tmp/cc-user-msg.txt"
PROMPT="Use the Workflow tool with scriptPath '${CC_REVIEW_BOT_DIR}/.claude/workflows/strict-review.mjs'. Run it to completion and report its return value verbatim as JSON. The workflow reads PR number, repo, post-flag, and project config from /tmp/cc-input.json, /tmp, and .cc-review.yaml${MSG_CLAUSE}."
claude -p "$PROMPT" \
  --model claude-sonnet-4-6 \
  --output-format stream-json --verbose \
  --allowedTools "Workflow,Bash(gh:*),Bash(glab:*),Bash(git:*),Bash(tsx:*),Bash(npx:*),Bash(node:*),Bash(cat:*),Read,Write,Edit,Grep,Glob,WebSearch,WebFetch" \
  --permission-mode bypassPermissions \
  | tee /tmp/run/session.jsonl || true
jq -r 'select(.type=="result") | .result' /tmp/run/session.jsonl > /tmp/run/result.txt 2>/dev/null || true
cp /tmp/pr-diff.txt /tmp/run/diff.txt 2>/dev/null || true

# ── Everything below ALWAYS runs (even if the review died mid-way) ───────────
RUN_FAILED=0

# 4) Surface an incomplete / quota-failed run LOUDLY (keyed on session content —
# a quota-kill leaves no final result object, the more robust signal).
SESSION=/tmp/run/session.jsonl
RESULT=$(jq -c 'select(.type=="result")' "$SESSION" 2>/dev/null | tail -1)
IS_ERR=$(printf '%s' "$RESULT" | jq -r '.is_error // empty' 2>/dev/null)
REASON=""
if [ ! -s "$SESSION" ] || [ -z "$RESULT" ]; then
  REASON="the run ended without a final result (died mid-review — often a usage/quota limit)"
elif [ "$IS_ERR" = "true" ]; then
  REASON="the run reported an error result"
fi
if [ -n "$REASON" ]; then
  echo "::error::cc-review did not complete: ${REASON}"
  BODY="<!-- cc-review:status -->"$'\n'"**cc-review did not finish this run** — ${REASON}. No verdict was posted; any overview above may be stale. Re-run with \`@cc-review\` once resolved."
  gh api "repos/${REPO}/issues/${PR_NUMBER}/comments" --method POST -f body="$BODY" >/dev/null 2>&1 \
    || echo "(could not post the incomplete-run status comment)"
  RUN_FAILED=1
else
  echo "run completed cleanly"
fi

# 5) Push run output to the ephemeral per-PR log branch (gitleaks-gated, fail-closed).
( LOG_BRANCH="pr-${PR_NUMBER}-cc-review-output"
  WORK=$(mktemp -d); cd "$WORK"
  git init -q; git config user.name "cc-review[bot]"; git config user.email "cc-review[bot]@users.noreply.github.com"
  git remote add origin "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git"
  git checkout -q --orphan out
  mkdir -p run; cp /tmp/run/* run/ 2>/dev/null || true
  # The run output (full PR diff + transcript) is about to be pushed to the consumer
  # repo. Scan it first and FAIL-CLOSED — skip the push if the scanner is missing or hits.
  if ! command -v gitleaks >/dev/null 2>&1; then
    echo "::error::gitleaks unavailable — skipping log-branch push for PR #${PR_NUMBER} (fail-closed)"; exit 0; fi
  if ! gitleaks detect --source run --no-git --redact --no-banner; then
    echo "::error::gitleaks flagged a potential secret in the run output — skipping log-branch push"; exit 0; fi
  printf '# cc-review run log — %s\n\nrun: https://github.com/%s/actions/runs/%s\n' "$LOG_BRANCH" "$REPO" "${GITHUB_RUN_ID:-?}" > README.md
  git add -A; git commit -q -m "cc-review run for ${LOG_BRANCH}" || true
  git push -f origin "out:refs/heads/${LOG_BRANCH}" || echo "log branch push failed (non-fatal)"
) || true

# 6) Push the project memory slice back to claude-reviewer/memory (reuses the bot
# clone's authenticated origin; shallow clone has no tracking ref → key off FETCH_HEAD).
( SRC="$WS/.cc-memory"; SLICE="$REPO"
  [ -d "$SRC" ] || { echo "no .cc-memory to push"; exit 0; }
  cd "$CC_REVIEW_BOT_DIR"
  git config user.name "cc-review[bot]"; git config user.email "cc-review[bot]@users.noreply.github.com"
  push_mem() {
    if git fetch origin claude-reviewer/memory 2>/dev/null; then
      git checkout -B claude-reviewer/memory FETCH_HEAD
    else
      git checkout --orphan claude-reviewer/memory; git rm -rf . 2>/dev/null || true
      printf '# cc-review memory\n\nPer-project palace. Each top dir is one consumer repo.\n' > README.md
      git add README.md; git commit -q -m "init memory"
    fi
    mkdir -p "$SLICE"
    cp -r "$SRC/." "$SLICE/" 2>/dev/null || true
    git add "$SLICE/"
    git diff --cached --quiet && { echo "no memory changes"; return 0; }
    git commit -q -m "memory: ${REPO} PR #${PR_NUMBER}"; git push origin claude-reviewer/memory
  }
  for n in 1 2 3; do push_mem && break; echo "memory push retry $n"; sleep $((n*5)); done
) || true

exit $RUN_FAILED
