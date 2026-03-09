---
name: bug-hunt
description: "Deep bug hunting review focused on logic errors, edge cases, and runtime failures."
argument-hint: "<PR number>"
allowed-tools: "Bash,Read,Glob,Grep,Agent"
---

Perform a deep bug-hunting review on PR #$ARGUMENTS.

## Step 0: Load Context

```bash
git show claude-reviewer/memory:MEMORY.md 2>/dev/null || echo "No project memory yet."
cat .cc-review.yaml 2>/dev/null || echo "No project config — using defaults."
```

Pay attention to recurring bugs and known problem areas.

## Step 1: Gather PR

```bash
gh pr view $ARGUMENTS --json title,body,baseRefName,headRefName,files --jq '.'
gh pr diff $ARGUMENTS
```

If the diff is trivial (config changes, version bumps), approve immediately via `gh api` and stop.

## Step 2: Deploy Bug Hunting Agents in Parallel

Launch three agents using the Agent tool. Pass each the PR diff and changed file list.

1. **logic-bug-scanner** agent — Off-by-one, null derefs, race conditions, boolean logic, type coercion, state mutation, missing returns
2. **edge-case-scanner** agent — Empty collections, boundary values, unicode, timezones, floats, concurrent modification, resource exhaustion
3. **integration-bug-scanner** agent — API contracts, database bugs, serialization mismatches, event ordering, configuration, dependency versions

## Step 3: Synthesize and Post Review

Collect all agent findings. Deduplicate (same file + within 2 lines + similar description).

Build `/tmp/review-payload.json` and post ONE review:

**Zero findings:**
```json
{"body":"Bug hunt complete — no logic errors, edge case issues, or integration bugs found.","event":"APPROVE","comments":[]}
```

**Any findings** — `REQUEST_CHANGES` with in-diff comments in `comments[]` and out-of-diff issues in `body`.

```bash
gh api repos/{owner}/{repo}/pulls/$ARGUMENTS/reviews --method POST --input /tmp/review-payload.json
```

## Step 4: Update Memory

Note any new recurring patterns or project-specific insights for memory update.

## Rules

- Focus ONLY on bugs — not style, not dead code, not naming
- Every finding must describe the specific failure: "When X is empty, line Y throws because..."
- No severity labels — every bug is a required fix
- Verify before reporting — read surrounding code, check if handled elsewhere
- NEVER use `gh pr review` — always `gh api`
