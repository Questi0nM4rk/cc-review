---
name: review-pr
description: "Review a PR for bugs, security, and logic issues."
argument-hint: "<PR number>"
allowed-tools: "Bash,Read,Glob,Grep,Agent"
---

Review PR #$ARGUMENTS in this repository.

## Step 0: Load Memory

```bash
git show claude-reviewer/memory:MEMORY.md 2>/dev/null || echo "No project memory yet — this is a fresh project."
```

Store the memory context. Use it to skip known false positives and focus on patterns this codebase is prone to.

## Step 1: Gather Context

Fetch the PR diff and metadata:

```bash
gh pr view $ARGUMENTS --json title,body,author,baseRefName,headRefName,files
gh pr diff $ARGUMENTS
```

## Step 2: Triage

If the diff is trivial (version bumps, config-only changes, dependency updates, markdown edits), approve immediately and skip remaining steps:
```bash
gh pr review $ARGUMENTS --approve --body "LGTM — trivial change, no review needed."
```

## Step 3: Slop Research

Deploy the `slop-researcher` agent with the PR diff and changed file list. It returns a targeted watchlist of AI-generated code patterns specific to this PR's languages and feature domain. Keep this watchlist in context for Step 5.

## Step 4: Understand the Change

Before reviewing line-by-line:
- Read the PR title and description to understand intent
- Identify which areas of the codebase are touched
- Cross-reference with memory for known patterns in these areas
- If the diff is large (>500 lines), use subagents to review different files in parallel

## Step 5: Review the Changes

For each file changed, check for:

### Must-fix (request changes)
- Bugs: null refs, off-by-one, race conditions, incorrect logic
- Security: injection, auth bypass, secrets in code, insecure defaults
- Data loss: missing transactions, incorrect deletes, broken migrations
- Breaking changes: API contract violations, removed public members without deprecation
- AI slop: patterns flagged by the slop researcher (hallucinated APIs, premature abstractions, etc.)

### Nice-to-have (mention but still approve)
- Performance: obvious N+1 queries, unnecessary allocations in hot paths
- Error handling: swallowed exceptions, missing null checks on external input
- Readability: only if genuinely confusing, not style preferences

### Ignore completely
- Formatting, whitespace, naming style
- Missing comments or docs
- "I would have done it differently" opinions
- Test coverage (unless tests are actively broken)
- Patterns listed as known false positives in project memory

## Step 6: Post the Review

Based on your findings:

**If no must-fix issues found:**
```bash
gh pr review $ARGUMENTS --approve --body "LGTM — reviewed for bugs, security, and logic issues. No problems found."
```

**If only nice-to-have suggestions:**
```bash
gh pr review $ARGUMENTS --approve --body "Approved with minor suggestions (see inline comments)."
```

**If must-fix issues found:**
```bash
gh pr review $ARGUMENTS --request-changes --body "Found issues that should be addressed before merging:

- [list each issue concisely]

See inline comments for details."
```

## Step 7: Update Memory

Evaluate what you learned from this review:
- New recurring pattern or anti-pattern?
- Discovered a project convention?
- Found a utility that could have been reused?
- Hit a false positive that should be skipped next time?

If you have new insights, update the memory on the `claude-reviewer/memory` branch. Merge new insights with existing content — don't overwrite. Keep it under 200 lines.

## Rules
- Post exactly ONE review action (approve or request-changes), never both
- Do not post separate PR comments — use the review body and inline review comments only
- Be concise — no filler, no preamble, no "great PR overall" padding
- If the diff is trivial (version bumps, config changes, dependency updates), approve immediately
