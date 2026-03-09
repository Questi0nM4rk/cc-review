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
echo '{"body":"LGTM — trivial change, no review needed.","event":"APPROVE","comments":[]}' > /tmp/review-payload.json
gh api repos/{owner}/{repo}/pulls/$ARGUMENTS/reviews --method POST --input /tmp/review-payload.json
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

CRITICAL: Post exactly ONE review using a SINGLE `gh api` call. All inline comments MUST be inside the review — never post comments separately.

Build a JSON payload and submit it in one call:

```bash
gh api repos/{owner}/{repo}/pulls/$ARGUMENTS/reviews \
  --method POST \
  --input /tmp/review-payload.json
```

The JSON payload must follow this structure:

```json
{
  "body": "Review summary here",
  "event": "APPROVE or REQUEST_CHANGES",
  "comments": [
    {
      "path": "src/file.ts",
      "line": 42,
      "body": "Description of the issue and suggested fix."
    }
  ]
}
```

### How to build the payload:

1. Collect ALL findings from Step 5 into a list
2. For each finding that maps to a specific line in the diff, create a comment object with `path`, `line`, and `body`
3. For findings that don't map to a specific diff line (e.g. missing functionality, architectural issues), mention them in the review `body` instead
4. Set `event` to `"APPROVE"` if no must-fix issues, `"REQUEST_CHANGES"` if any must-fix issues exist
5. Write the JSON to `/tmp/review-payload.json` then submit with `gh api`

**Important rules for the comments array:**
- The `line` must be a line number that exists in the diff (the NEW file side)
- The `path` must match exactly the file path shown in the diff
- If you cannot determine the exact line, put the finding in the review `body` instead
- Use `side: "RIGHT"` if needed (defaults to RIGHT which is correct for new code)

**If no issues found (approve):**
```json
{
  "body": "LGTM — reviewed for bugs, security, and logic issues. No problems found.",
  "event": "APPROVE",
  "comments": []
}
```

**If must-fix issues found:**
```json
{
  "body": "Found issues that should be addressed before merging:\n\n- Issue 1 summary\n- Issue 2 summary",
  "event": "REQUEST_CHANGES",
  "comments": [
    {"path": "src/config.ts", "line": 14, "body": "Detailed explanation of issue 1."},
    {"path": "src/utils.ts", "line": 28, "body": "Detailed explanation of issue 2."}
  ]
}
```

## Step 7: Update Memory

Evaluate what you learned from this review:
- New recurring pattern or anti-pattern?
- Discovered a project convention?
- Found a utility that could have been reused?
- Hit a false positive that should be skipped next time?

If you have new insights, update the memory on the `claude-reviewer/memory` branch. Merge new insights with existing content — don't overwrite. Keep it under 200 lines.

## Rules
- Post exactly ONE review via a SINGLE `gh api` call — never multiple calls
- ALL inline comments MUST be inside the `comments` array of that single review — never use `gh pr review`, `gh pr comment`, or separate API calls for comments
- Do not use `gh pr review` command at all — always use `gh api repos/{owner}/{repo}/pulls/NUMBER/reviews --method POST --input /tmp/review-payload.json`
- Be concise — no filler, no preamble, no "great PR overall" padding
- If the diff is trivial (version bumps, config changes, dependency updates), approve immediately
