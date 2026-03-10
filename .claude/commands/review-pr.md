---
name: review-pr
description: "Review a PR for bugs, security, and logic issues."
argument-hint: "<PR number>"
allowed-tools: "Bash,Read,Glob,Grep,Agent"
---

Review PR #$ARGUMENTS in this repository.

## Step 0: Load Context

```bash
git show claude-reviewer/memory:MEMORY.md 2>/dev/null || echo "No project memory yet — fresh project."
cat .cc-review.yaml 2>/dev/null || echo "No project config — using defaults."
```

Store both the memory and config. Use them throughout the review.

## Step 1: Gather PR

If pre-fetched files exist (CI environment), use them:
```bash
cat /tmp/pr-meta.json 2>/dev/null && cat /tmp/pr-diff.txt 2>/dev/null
```

Otherwise (local/manual), fetch directly:
```bash
gh pr view $ARGUMENTS --json title,body,author,baseRefName,headRefName,files
gh pr diff $ARGUMENTS
```

If `gh pr diff` fails with 406 "too large", use local git diff:
```bash
BASE=$(gh pr view $ARGUMENTS --json baseRefName --jq '.baseRefName')
HEAD=$(gh pr view $ARGUMENTS --json headRefName --jq '.headRefName')
git diff origin/$BASE...origin/$HEAD
```

## Step 2: Triage

If the diff is trivial (version bumps, config-only, dependency updates, markdown edits), approve immediately:
```bash
echo '{"summary":"LGTM — trivial change, no review needed.","findings":[]}' > /tmp/findings.json
tsx .claude/skills/review-guidelines/scripts/review-cli.ts post --repo {owner}/{repo} --pr $ARGUMENTS --diff /tmp/pr-diff.txt --findings /tmp/findings.json
```

## Step 3: Slop Research

If `.cc-review.yaml` has `slop_detection: true` AND the diff is under 500 lines:
Deploy the `slop-researcher` agent with the PR diff and changed file list. Keep its watchlist in context for Step 5.
For large diffs (>500 lines), skip this step to conserve turns.

## Step 4: Understand the Change

Before reviewing line-by-line:
- Read the PR title and description to understand intent
- Identify which areas of the codebase are touched
- Cross-reference with memory for known patterns in these areas
- For large diffs (>500 lines), focus on the most critical files first, do NOT spawn subagents

## Step 5: Review the Changes

Apply the review-guidelines skill. Load language-specific references matching the PR's languages.

For each file changed, check for:
- Bugs: null refs, off-by-one, race conditions, incorrect logic
- Security: injection, auth bypass, secrets in code, insecure defaults
- Data loss: missing transactions, incorrect deletes, broken migrations
- Breaking changes: API contract violations, removed public members
- AI slop: patterns flagged by the slop researcher

Apply `.cc-review.yaml` overrides:
- Skip `ignore_paths` files
- Skip `known_patterns` findings
- Apply `instructions` context

## Step 6: Post the Review

The review CLI handles line resolution, payload building, validation, and posting automatically.

### 6a: Write findings JSON

Write your findings to `/tmp/findings.json`:
```json
{
  "summary": "Review summary here.",
  "findings": [
    { "file": "src/file.ts", "search": "pattern on the line", "body": "Issue description." },
    { "file": null, "body": "Cross-file or missing-code issue." }
  ]
}
```

Each finding needs:
- `file` — the file path (or `null` for cross-file issues)
- `search` — text on the line to match in the diff (the CLI resolves the exact line number)
- `body` — the issue description

### 6b: Post via review-cli.ts

```bash
tsx .claude/skills/review-guidelines/scripts/review-cli.ts post --repo {owner}/{repo} --pr $ARGUMENTS --diff /tmp/pr-diff.txt --findings /tmp/findings.json
```

The CLI:
1. Resolves each finding's line number via `diff-lines.ts`
2. Maps findings to inline comments or "Outside Diff" body section
3. Sets event to `APPROVE` (0 findings) or `REQUEST_CHANGES` (any findings)
4. Posts the review via GitHub API

Done. No manual payload building, no line lookups, no validation step.

## Step 7: STOP

Once the review is posted, you are DONE. Do not post additional reviews, test the API, or do anything else.

Memory save is optional and only if you have turns remaining — usually skip it.

## Rules

- ALWAYS use `review-cli.ts post` to post reviews — never raw `gh` commands
- NEVER use `gh pr review` or `gh api .../reviews --method POST` directly
- NEVER use severity labels (Critical, High, Medium, Low) — every finding is a requested change, no ranking
- If you found N issues, ALL N must appear in the findings JSON. Do not drop findings.
- Be concise — no filler, no padding
- Trivial diffs → approve immediately
