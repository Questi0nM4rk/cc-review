---
name: simplify-review
description: "Review PR for code reuse, quality, and efficiency improvements."
argument-hint: "<PR number>"
allowed-tools: "Bash,Read,Glob,Grep,Agent"
---

Perform a simplification review on PR #$ARGUMENTS — find opportunities to reduce complexity, reuse existing code, and improve efficiency.

## Step 0: Load Memory

```bash
git show claude-reviewer/memory:MEMORY.md 2>/dev/null || echo "No project memory yet."
```

Store the memory context — pay attention to existing utilities and patterns in this codebase.

## Step 1: Gather Context

```bash
gh pr view $ARGUMENTS --json title,body,baseRefName,headRefName,files --jq '.'
gh pr diff $ARGUMENTS
```

## Step 2: Deploy Simplification Agents in Parallel

Launch three focused agents using the Agent tool:

### Agent 1: Code Reuse Scanner
For each changed file:
1. **Search for existing utilities and helpers** that could replace newly written code. Look for similar patterns elsewhere in the codebase — common locations: utility directories, shared modules, files adjacent to the changed ones.
2. **Flag new functions that duplicate existing functionality.** Suggest the existing function to use instead.
3. **Flag inline logic that could use an existing utility** — hand-rolled string manipulation, manual path handling, custom environment checks, ad-hoc type guards.

### Agent 2: Code Quality Scanner
Review the changes for:
- **Redundant state** — state that duplicates existing state, cached values that could be derived
- **Parameter sprawl** — adding new parameters instead of restructuring
- **Copy-paste with variation** — near-duplicate code blocks that should be unified
- **Leaky abstractions** — exposing internal details, breaking abstraction boundaries
- **Stringly-typed code** — raw strings where constants, enums, or branded types already exist
- **Unnecessary nesting** — wrapper elements/calls that add no value

### Agent 3: Efficiency Scanner
Review the changes for:
- **Unnecessary work** — redundant computations, repeated file reads, duplicate API calls, N+1 patterns
- **Missed concurrency** — independent operations run sequentially when they could be parallel
- **Hot-path bloat** — blocking work added to startup or per-request/per-render paths
- **Unnecessary existence checks** — pre-checking before operating (TOCTOU anti-pattern)
- **Memory issues** — unbounded data structures, missing cleanup, listener leaks
- **Overly broad operations** — reading entire files when only a portion is needed

Each agent returns findings as:
```json
[{ "file": "...", "line": N, "description": "...", "in_diff": true/false }]
```

## Step 3: Synthesize and Post Review

Collect all findings. Deduplicate (same file + within 2 lines + similar description).

**Zero findings:**
```bash
gh pr review $ARGUMENTS --approve --body "Code is already clean — no simplification opportunities found."
```

**Any findings** — post as REQUEST_CHANGES with inline comments on diff lines and out-of-diff issues in the body using `gh api repos/{owner}/{repo}/pulls/$ARGUMENTS/reviews`.

## Step 4: Update Memory

If this review found new patterns about the codebase's existing utilities or conventions, note them for memory update.

## Rules

- Focus on making code simpler, not different — the goal is less complexity, not your preferred style.
- Every finding must include a concrete suggestion: "Use existing `formatDate()` from `utils/dates.ts`" not just "This could be simplified."
- No severity labels — every simplification is a required change.
- Before flagging duplication, verify the existing code actually does the same thing (check edge cases).
- If the PR is trivial (config changes, version bumps), approve immediately without deploying agents.
