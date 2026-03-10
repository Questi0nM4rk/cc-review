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

**First**: Read `.claude/skills/review-guidelines/references/github-review-api.md` — it has the `diff-lines.ts` tool and exact payload format.

CRITICAL: Post exactly ONE review using a SINGLE `gh api` call. ALL findings go in this ONE call.

### 6a: Look up line numbers for each finding

For EACH finding, run `diff-lines.ts` to get the exact line number:

```bash
# Look up the line for a finding in src/steps/check.ts
tsx .claude/skills/review-guidelines/scripts/diff-lines.ts /tmp/pr-diff.txt src/steps/check.ts | jq '.[] | select(.content | contains("YOUR_SEARCH_TERM"))'
```

This returns `{"file": "...", "line": 42, "side": "RIGHT", ...}` — use those values directly.

- **Output exists** → inline comment: use `file` as `path`, `line` as `line`, `side` as `side`
- **Output empty** → finding is outside the diff. Put it in the review body under `### Outside Diff`

Do NOT skip this step. Do NOT guess line numbers. Run the script for every finding.

### 6b: Build the payload

```bash
cat > /tmp/review-payload.json <<'PAYLOAD_EOF'
{
  "body": "Summary.\n\n### Outside Diff\n\n- **`src/other.ts`**: Cross-file issue description.",
  "event": "REQUEST_CHANGES",
  "comments": [
    {"path": "src/file.ts", "line": 42, "side": "RIGHT", "body": "Issue on this line. Fix: ..."}
  ]
}
PAYLOAD_EOF
```

- Inline findings → `comments` array with `path`, `line`, `side`, `body`
- Outside-diff findings → `body` under `### Outside Diff` as bullet points
- Any findings → `"event": "REQUEST_CHANGES"`. Zero findings → `"event": "APPROVE"`
- If ALL findings are inline, body is just a one-line summary (no `### Outside Diff` needed)

### 6c: Validate before submitting

```bash
# Verify every comment line exists in the diff
for entry in $(jq -r '.comments[] | "\(.path)|\(.line)"' /tmp/review-payload.json); do
  FILE="${entry%|*}"; LINE="${entry#*|}"
  MATCH=$(tsx .claude/skills/review-guidelines/scripts/diff-lines.ts /tmp/pr-diff.txt "$FILE" | jq --argjson l "$LINE" '.[] | select(.line == $l)')
  [ -z "$MATCH" ] && echo "BAD: $FILE:$LINE" || echo "OK: $FILE:$LINE"
done
```

If any show `BAD`, move that finding to the body. Fix the payload, then submit.

### 6d: Submit

```bash
gh api repos/{owner}/{repo}/pulls/$ARGUMENTS/reviews --method POST --input /tmp/review-payload.json
```

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
