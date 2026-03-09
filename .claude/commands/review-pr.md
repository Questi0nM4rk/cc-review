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
cat > /tmp/review-payload.json <<'EOF'
{"body":"LGTM — trivial change, no review needed.","event":"APPROVE","comments":[]}
EOF
gh api repos/{owner}/{repo}/pulls/$ARGUMENTS/reviews --method POST --input /tmp/review-payload.json
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

**First**: Read `.claude/skills/review-guidelines/references/github-review-api.md` for the exact API format and line-number algorithm.

CRITICAL: Post exactly ONE review using a SINGLE `gh api` call. ALL findings go in this ONE call.

### Mapping findings to inline comments

For EACH finding, determine if it can be an inline comment:

1. Search the diff (from `/tmp/pr-diff.txt` or `gh pr diff`) for the file
2. Find the `@@` hunk that covers the line you want to comment on
3. Parse the hunk header `@@ -OLD,COUNT +NEW,COUNT @@`:
   - The `+NEW` number is where new-file line counting starts
   - Count down through the hunk: `+` lines and context lines increment the new-file counter, `-` lines do NOT
4. If your finding's line is a `+` or context line in a hunk → it's an inline comment:
   ```json
   {"path": "src/file.ts", "line": 42, "side": "RIGHT", "body": "Issue description."}
   ```
5. If the line is NOT in any diff hunk → it goes in the review body under `### Outside Diff`

### Building the payload

1. Collect ALL findings — no severity labels, no ranking
2. **Inline findings** (line exists in diff): add to `comments` array with `path`, `line`, `side: "RIGHT"`, `body`
3. **Outside-diff findings** (missing code, cross-file, line not in any hunk): add to `body` under `### Outside Diff` as bullet points
4. If any findings exist → `"event": "REQUEST_CHANGES"`. If zero → `"event": "APPROVE"`

### Payload format

```json
{
  "body": "Summary.\n\n### Outside Diff\n\n- **`src/other.ts`**: Cross-file issue description.",
  "event": "REQUEST_CHANGES",
  "comments": [
    {"path": "src/file.ts", "line": 42, "side": "RIGHT", "body": "Issue on this line. Fix: ..."}
  ]
}
```

If ALL findings are inline, the body is just a one-line summary (no `### Outside Diff` section needed).

### Submit

```bash
cat > /tmp/review-payload.json <<'PAYLOAD_EOF'
<your JSON here>
PAYLOAD_EOF
gh api repos/{owner}/{repo}/pulls/$ARGUMENTS/reviews --method POST --input /tmp/review-payload.json
```

### Verification before submitting

- Every `line` value → check it exists as a `+` or context line in the diff for that file
- Every `path` → must match `diff --git a/PATH b/PATH` exactly
- Every comment has `"side": "RIGHT"` (unless commenting on a removed line)
- No comment has `line: null` — those MUST be in the body
- Finding count: inline comments + body bullet points = total findings. Nothing dropped.

## Step 7: STOP

Once the review is posted, you are DONE. Do not post additional reviews, test the API, or do anything else.

Memory save is optional and only if you have turns remaining — usually skip it.

## Rules

- Post ONE review via ONE `gh api` call — never multiple calls
- ALL inline comments inside the `comments` array — never separate API calls
- NEVER use `gh pr review` — always `gh api repos/{owner}/{repo}/pulls/N/reviews`
- NEVER use severity labels (Critical, High, Medium, Low) — every finding is a requested change, no ranking
- NEVER post a comment with `line: null` — put those findings in the review body instead
- If you found N issues, ALL N must appear in the review (inline + body). Do not drop findings.
- Be concise — no filler, no padding
- Trivial diffs → approve immediately
