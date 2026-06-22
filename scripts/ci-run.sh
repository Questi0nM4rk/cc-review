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
# Shared memory-branch slice fetch/push (also used by cc-review-cleanup.yml's Phase-1 harvest, so
# both read/write the slice identically — one implementation, no drift).
source "$CC_REVIEW_BOT_DIR/scripts/memory-slice.sh"
export GITHUB_TOKEN="${GH_TOKEN}"
# This pipeline runs ONLY inside an isolated CI runner (GitHub Actions: ephemeral VM, no persistent
# state, job-scoped secrets). We drive claude with `--permission-mode auto` (NOT
# `--dangerously-skip-permissions`): on a real install the bypass flag refuses under the runner's root
# uid AND, even past that, hits a "Bypass Permissions mode … Yes, I accept" consent dialog whose option
# 1 is "No, exit"; bypass is also disable-able by org/managed settings. Auto mode is governed by a
# separate gate and boots straight to ready (verified in a fresh-root container on claude 2.1.185) (#75).
# IS_SANDBOX is kept as a truthful assertion that this is an isolated runner (harmless; future-proofs any
# sandbox-gated behaviour). The assertion lives HERE, the CI entry point that knows it's in the runner.
# Local/GitLab paths (run-local.sh / run-gitlab.sh, non-root) never set this and don't need it.
export IS_SANDBOX=1
: "${CC_POST:=1}" "${PING_OVERRIDE:=false}"
WS="${GITHUB_WORKSPACE:-$PWD}"
cd "$WS"

# ── 1) Pre-fetch diff + stage the memory slice ──────────────────────────────
# Agents are sandboxed to the workspace and cannot mkdir or write /tmp — pre-create
# the scratch dir (post payloads) and the memory dir (learnings + per-PR marker).
mkdir -p /tmp/run .cc-run .cc-memory/learnings ".cc-memory/pr-${PR_NUMBER}" .cc-global/learnings
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
fetch_slice "$CC_REVIEW_BOT_DIR" "$REPO" .cc-memory
# Stage the cross-repo ADDITIVE `_global/` layer into a SEPARATE dir (.cc-global) — NOT under
# .cc-memory, so push_slice can't copy it into this repo's slice. The brain reads it read-only as
# additional context; only the maintenance job writes it. No-op until the layer exists.
fetch_global "$CC_REVIEW_BOT_DIR" .cc-global
# Phase-3 cold-start gate: a slice with no `.backfilled` sentinel has never been primed. Decide NOW,
# while .cc-memory reflects ONLY the fetched slice — the placeholder MEMORY.md write on the next line
# would otherwise mask an empty slice and this gate could never fire. Repos that predate backfill have
# no sentinel, so they get primed once on their next review. (Actual run happens after install, 3a.)
BACKFILL_NEEDED=0; [ -f .cc-memory/.backfilled ] || BACKFILL_NEEDED=1
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

# ── 3a) Cold-start backfill — prime the memory slice on a repo's first-ever review ──────────
# Learn ADDITIVE priors (conventions, recurring-issue themes, review culture) from recent merged PRs
# so the first review isn't cold. Sentinel-gated → runs at most once per repo. Best-effort: a failure
# leaves the repo to review cold (the prior baseline) and the sentinel unwritten, so it retries next
# run. It never posts and never writes suppression rules. The synth agent writes .cc-memory/.backfilled
# LAST (proof of completion); push_mem ships it with the slice. Tunable via BACKFILL_N (default 3 —
# a one-time-per-repo cost; 3 recent merged PRs still give convention/culture signal, raise if wanted).
if [ "$BACKFILL_NEEDED" = "1" ]; then
  BACKFILL_N="${BACKFILL_N:-3}"
  BF_PRS=$(gh pr list --repo "$REPO" --state merged --limit "$BACKFILL_N" --json number --jq '[.[].number]' 2>/dev/null || echo "[]")
  # Only proceed on a real non-empty JSON array — a gh/jq hiccup can yield "", "null", or a stray
  # string; validating here keeps a malformed value out of the agent prompt (and out of the log line).
  if printf '%s' "$BF_PRS" | jq -e 'type=="array" and length>0' >/dev/null 2>&1; then
    echo "backfill: priming memory for ${REPO} from merged PRs ${BF_PRS}"
    BF_PROMPT="Use the Workflow tool with scriptPath '${CC_REVIEW_BOT_DIR}/.claude/workflows/backfill-memory.mjs' and args { bot_dir: '${CC_REVIEW_BOT_DIR}', repo: '${REPO}', prs: ${BF_PRS} }. Run it to completion and report its return value verbatim as JSON."
    printf '%s' "$BF_PROMPT" > /tmp/run/bf-prompt.txt
    # Interactive via agentapi (5h bucket), not `claude -p`. Best-effort: a non-zero exit (never went
    # stable) is surfaced as a warning, not a failure — a cold review is the safe fallback (cf. #51).
    "$CC_REVIEW_BOT_DIR/scripts/agentapi-claude.sh" --prompt-file /tmp/run/bf-prompt.txt --out /tmp/run/backfill-transcript.txt \
      --claude-arg --model --claude-arg claude-sonnet-4-6 \
      --claude-arg --permission-mode --claude-arg auto \
      --claude-arg --add-dir --claude-arg "$CC_REVIEW_BOT_DIR" \
      --claude-arg --add-dir --claude-arg /tmp \
      || echo "::warning::cc-review backfill did not complete cleanly (possible usage/quota limit); proceeding to review without primed memory"
  else
    echo "backfill: no merged PRs to learn from (or gh list failed) — skipping; will retry next run"
  fi
fi

# ── 3) Run the strict-review workflow (headless) ────────────────────────────
# Sub-agents do NOT inherit env vars — pass inputs via a file.
jq -n --arg pr "$PR_NUMBER" --arg repo "$REPO" --arg post "$CC_POST" --argjson ping "${PING_OVERRIDE}" \
  '{pr_number:($pr|tonumber), repo:$repo, platform:"github", post:($post=="1"), ping_override:$ping}' > /tmp/cc-input.json
MSG_CLAUSE=""
[ -s /tmp/cc-user-msg.txt ] && MSG_CLAUSE=", and the maintainer @cc-review message from /tmp/cc-user-msg.txt"
# bot_dir is passed via args (not an env var): the sandboxed brain agents don't inherit env, and
# the agent shell can't expand $CC_REVIEW_BOT_DIR — it would collapse to the consumer repo root.
PROMPT="Use the Workflow tool with scriptPath '${CC_REVIEW_BOT_DIR}/.claude/workflows/strict-review.mjs' and args { bot_dir: '${CC_REVIEW_BOT_DIR}' }. Run it to completion. The workflow reads PR number, repo, post-flag, and project config from /tmp/cc-input.json, /tmp, and .cc-review.yaml${MSG_CLAUSE}. When the Workflow tool RETURNS, write its return value verbatim as JSON to ${WS}/.cc-run/cc-result.json using a bash cat-heredoc (NOT the Write tool) — this file is the run's completion sentinel. Write it ONLY if the Workflow returned; if it did not return, write nothing. Then, as your final output, print this exact line on its own and nothing after it: <<<CC_REVIEW_COMPLETE>>>"

# Ground-truth snapshot (for the post-run gate): count the bot's EXISTING reviews + issue comments
# on the PR BEFORE the run. After the run we re-count and require the relevant one to actually go up
# when the brain claims it posted — we verify against GitHub, NOT the brain's self-reported flag.
# Returns "ERR" on an API failure so the gate can skip (degrade to trusting the brain) instead of
# false-failing on a transient query error. per_page=100 covers any realistic bot history depth.
# Match the EXACT bot identity (login == "cc-review[bot]" AND user.type == "Bot"), not a substring —
# a human contributor whose login merely contains "cc-review" (e.g. "cc-reviewer-dave") would
# otherwise inflate the count and mask a genuinely-failed post in this ground-truth gate.
bot_count() { # $1 = api path under repos/$REPO
  local out
  out=$(gh api "repos/${REPO}/$1" 2>/dev/null) || { echo "ERR"; return; }
  printf '%s' "$out" | jq -r 'if type=="array" then [.[] | select((.user.login // "") == "cc-review[bot]" and (.user.type // "") == "Bot")] | length else "ERR" end' 2>/dev/null || echo "ERR"
}
BEFORE_REVIEWS=$(bot_count "pulls/${PR_NUMBER}/reviews?per_page=100")
BEFORE_COMMENTS=$(bot_count "issues/${PR_NUMBER}/comments?per_page=100")

# --add-dir is REQUIRED and is a SEPARATE gate from the permission mode (--permission-mode auto).
# claude confines file access to cwd (the consumer checkout) + each --add-dir; the permission mode only
# governs tool approval, NOT which paths they may touch. Without it the agent can't
# read the bot clone ($CC_REVIEW_BOT_DIR) or the /tmp-staged inputs (cc-input.json, pr-diff.txt) — it
# then non-deterministically refuses ("won't run a script I can't read"), giving flaky red checks (#49).
# Drive the brain through an INTERACTIVE claude session via coder/agentapi (5-hour bucket) — NOT
# `claude -p`, which bills the scarce headless/SDK pool (~3% of weekly /usage per run). agentapi runs
# claude interactively + exposes POST /message + GET /status (running|stable); completion = the official
# "stable" status (agentapi-claude.sh handles it). A non-zero exit = it never went stable (timed out /
# auth failed / died). Correctness is verified below against GitHub ground truth, so the captured
# conversation is only a best-effort log — we never parse it for the verdict.
printf '%s' "$PROMPT" > /tmp/run/prompt.txt
"$CC_REVIEW_BOT_DIR/scripts/agentapi-claude.sh" --prompt-file /tmp/run/prompt.txt --out /tmp/run/transcript.txt \
  --done-marker '<<<CC_REVIEW_COMPLETE>>>' \
  --claude-arg --model --claude-arg claude-sonnet-4-6 \
  --claude-arg --permission-mode --claude-arg auto \
  --claude-arg --add-dir --claude-arg "$CC_REVIEW_BOT_DIR" \
  --claude-arg --add-dir --claude-arg /tmp
RUN_RC=$?
cp /tmp/pr-diff.txt /tmp/run/diff.txt 2>/dev/null || true

# ── Everything below ALWAYS runs (even if the review died mid-way) ───────────
RUN_FAILED=0

# 4) Completion + ground-truth gate (#75). The verdict logic lives in scripts/gate.mjs (pure,
# unit-tested) so it can't drift like the old OR-rule did; this shell only gathers inputs and acts on
# the result. Surface the sentinel into the log dir first so a post-mortem can read the brain's return.
cp .cc-run/cc-result.json /tmp/run/cc-result.json 2>/dev/null || true
AFTER_REVIEWS="ERR"; AFTER_COMMENTS="ERR"
if [ "$CC_POST" = "1" ]; then
  AFTER_REVIEWS=$(bot_count "pulls/${PR_NUMBER}/reviews?per_page=100")
  AFTER_COMMENTS=$(bot_count "issues/${PR_NUMBER}/comments?per_page=100")
fi
# gate.mjs reads the sentinel (.cc-run/cc-result.json — absent ⇒ the run never finished, even if
# agentapi said 'stable') and cross-checks GitHub PER MODE: a normal review (first/rerun) must raise
# the FORMAL review count; answer/rerun-blocked accept comment growth; an overview comment alone never
# passes. Non-empty stdout = the failure reason; empty = verified success. gate.mjs always exits 0.
REASON="$(SENTINEL="$WS/.cc-run/cc-result.json" RUN_RC="$RUN_RC" CC_POST="$CC_POST" \
  BEFORE_REVIEWS="$BEFORE_REVIEWS" AFTER_REVIEWS="$AFTER_REVIEWS" \
  BEFORE_COMMENTS="$BEFORE_COMMENTS" AFTER_COMMENTS="$AFTER_COMMENTS" \
  node "$CC_REVIEW_BOT_DIR/scripts/gate.mjs" 2>/dev/null)"

if [ -n "$REASON" ]; then
  echo "::error::cc-review did not complete: ${REASON}"
  # IMPORTANT: this comment must NOT contain the literal '@cc-review' — the interactive workflow
  # triggers on `issue_comment` bodies containing that token, so a failure comment that mentions it
  # re-triggers the bot, which fails again on the same rate limit and re-posts → infinite self-loop
  # that exhausts the org quota (#51). Tell the user to re-run the job instead of pinging the bot.
  BODY="<!-- cc-review:status -->"$'\n'"**cc-review did not finish this run** — ${REASON}. No verdict was posted; any overview above may be stale. Re-run the cc-review job from this PR's **Checks** tab once resolved."
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

# 6) Push the project memory slice back to claude-reviewer/memory (shared with the Phase-1 harvest).
push_slice "$CC_REVIEW_BOT_DIR" "$REPO" "$WS/.cc-memory" "memory: ${REPO} PR #${PR_NUMBER}" || true

exit $RUN_FAILED
