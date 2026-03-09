---
name: bug-hunt
description: "Deep bug hunting review focused on logic errors, edge cases, and runtime failures."
argument-hint: "<PR number>"
allowed-tools: "Bash,Read,Glob,Grep,Agent"
---

Perform a deep bug-hunting review on PR #$ARGUMENTS.

## Step 0: Load Memory

```bash
git show claude-reviewer/memory:MEMORY.md 2>/dev/null || echo "No project memory yet."
```

Store the memory context — pay attention to recurring bugs and known problem areas.

## Step 1: Gather Context

```bash
gh pr view $ARGUMENTS --json title,body,baseRefName,headRefName,files --jq '.'
gh pr diff $ARGUMENTS
```

## Step 2: Deploy Bug Hunting Agents in Parallel

Launch three focused agents using the Agent tool:

### Agent 1: Logic Bug Scanner
Scan the diff for:
- **Off-by-one errors** in loops, slices, array indices, pagination
- **Null/undefined dereferences** — accessing properties on potentially null values
- **Race conditions** — shared mutable state, async operations without proper synchronization
- **Incorrect boolean logic** — inverted conditions, wrong operator precedence, De Morgan violations
- **Type coercion bugs** — implicit conversions that change behavior (`==` vs `===`, string/number mixing)
- **State mutation bugs** — mutating objects that are shared or expected immutable
- **Missing return statements** — functions that fall through without returning in all branches
- **Integer overflow/underflow** — arithmetic on user-controlled values without bounds

### Agent 2: Edge Case Scanner
Scan the diff for:
- **Empty collection handling** — code that assumes non-empty arrays/lists/maps
- **Boundary values** — zero, negative, MAX_INT, empty string, null, NaN
- **Unicode handling** — string operations that break on multi-byte characters or emojis
- **Timezone issues** — date/time code that assumes UTC or local time
- **Floating point comparison** — `==` on floats instead of epsilon comparison
- **Concurrent modification** — iterating and modifying a collection simultaneously
- **Resource exhaustion** — unbounded allocations, missing stream closes, connection leaks
- **Error path bugs** — error handlers that themselves throw or corrupt state

### Agent 3: Integration Bug Scanner
Scan the diff for:
- **API contract violations** — returned shapes that don't match declared types/interfaces
- **Database bugs** — missing WHERE clauses, UPDATE without transaction, wrong join type
- **Serialization mismatches** — JSON field names that don't match between producer and consumer
- **Event ordering bugs** — handlers that assume specific event order
- **Configuration bugs** — env vars used without defaults, missing required config
- **Dependency version bugs** — using APIs from a different version than what's installed

Each agent returns findings as:
```json
[{ "file": "...", "line": N, "description": "...", "in_diff": true/false }]
```

## Step 3: Synthesize and Post Review

Collect all findings. Deduplicate (same file + within 2 lines + similar description).

**Zero findings:**
```bash
gh pr review $ARGUMENTS --approve --body "Bug hunt complete — no logic errors, edge case issues, or integration bugs found."
```

**Any findings** — post as REQUEST_CHANGES with inline comments on diff lines and out-of-diff issues in the body using `gh api repos/{owner}/{repo}/pulls/$ARGUMENTS/reviews`.

## Step 4: Update Memory

If this review found new recurring patterns or project-specific insights, note them for memory update.

## Rules

- Focus ONLY on bugs — not style, not dead code, not naming.
- Every finding must describe the specific failure scenario: "When X is empty, line Y throws because..."
- No severity labels — every bug is a required fix.
- Verify before reporting: read surrounding code, check if the "bug" is actually handled elsewhere.
- If the PR is trivial (config changes, version bumps), approve immediately without deploying agents.
