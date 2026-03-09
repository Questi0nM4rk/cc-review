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

If the diff is trivial (config changes, version bumps), approve immediately via `gh api` and stop.

## Step 2: Deploy Simplification Agents in Parallel

Launch three agents using the Agent tool. Pass each the PR diff and changed file list.

1. **code-reuse-scanner** agent — Existing utilities, duplicated functionality, inline logic that should use helpers
2. **code-quality-scanner** agent — Redundant state, parameter sprawl, copy-paste, leaky abstractions, stringly-typed code
3. **efficiency-scanner** agent — Unnecessary work, missed concurrency, hot-path bloat, TOCTOU, memory issues

## Step 3: Synthesize and Post Review

Collect all agent findings. Deduplicate (same file + within 2 lines + similar description).

Build `/tmp/review-payload.json` and post ONE review:

**Zero findings:**
```json
{"body":"Code is already clean — no simplification opportunities found.","event":"APPROVE","comments":[]}
```

**Any findings** — `REQUEST_CHANGES` with in-diff comments in `comments[]` and out-of-diff issues in `body`.

```bash
gh api repos/{owner}/{repo}/pulls/$ARGUMENTS/reviews --method POST --input /tmp/review-payload.json
```

## Step 4: Update Memory

Note any new patterns about the codebase's existing utilities or conventions.

## Rules

- Focus on making code simpler, not different — less complexity, not your preferred style
- Every finding must include a concrete suggestion: "Use existing `fn()` from `path`" not "this could be simplified"
- No severity labels — every simplification is a required change
- Before flagging duplication, verify the existing code does the same thing
- NEVER use `gh pr review` — always `gh api`
