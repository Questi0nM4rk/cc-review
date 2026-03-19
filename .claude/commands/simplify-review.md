---
name: simplify-review
description: "Review PR for code reuse, quality, and efficiency improvements."
argument-hint: "<PR number>"
allowed-tools: "Bash,Read,Glob,Grep,Agent"
---

Perform a simplification review on PR #$ARGUMENTS — find opportunities to reduce complexity, reuse existing code, and improve efficiency.

## Step 0: Load Context

```bash
git show claude-reviewer/memory:MEMORY.md 2>/dev/null || echo "No project memory yet."
cat .cc-review.yaml 2>/dev/null || echo "No project config — using defaults."
```

Pay attention to existing utilities and patterns in this codebase.

## Step 1: Gather PR

```bash
gh pr view $ARGUMENTS --json title,body,baseRefName,headRefName,files --jq '.'
gh pr diff $ARGUMENTS
```

If the diff is trivial (config changes, version bumps), approve immediately via `review-cli.ts post` with zero findings and stop.

## Step 2: Deploy Simplification Agents in Parallel

Launch three agents using the Agent tool. Pass each the PR diff and changed file list.

1. **code-reuse-scanner** agent — Existing utilities, duplicated functionality, inline logic that should use helpers
2. **code-quality-scanner** agent — Redundant state, parameter sprawl, copy-paste, leaky abstractions, stringly-typed code
3. **efficiency-scanner** agent — Unnecessary work, missed concurrency, hot-path bloat, TOCTOU, memory issues

## Step 3: Synthesize and Post Review

Collect all agent findings. Deduplicate (same file + within 2 lines + similar description).

Pipe findings JSON via stdin (`--findings -`) to review-cli.ts:

**Zero findings:**
```bash
tsx .claude/skills/review-guidelines/scripts/review-cli.ts post --repo {owner}/{repo} --pr $ARGUMENTS --diff /tmp/pr-diff.txt --findings - <<'FINDINGS_EOF'
{"summary":"Code is already clean — no simplification opportunities found.","findings":[]}
FINDINGS_EOF
```

**Any findings:**
```bash
tsx .claude/skills/review-guidelines/scripts/review-cli.ts post --repo {owner}/{repo} --pr $ARGUMENTS --diff /tmp/pr-diff.txt --findings - <<'FINDINGS_EOF'
{"summary":"Found N simplification opportunities.","findings":[...]}
FINDINGS_EOF
```

## Step 4: Update Memory

Note any new patterns about the codebase's existing utilities or conventions.

## Rules

- Focus on making code simpler, not different — less complexity, not your preferred style
- Every finding must include a concrete suggestion: "Use existing `fn()` from `path`" not "this could be simplified"
- No severity labels — every simplification is a required change
- Before flagging duplication, verify the existing code does the same thing
- NEVER use `gh pr review` or raw `gh api` — always use review-cli.ts
