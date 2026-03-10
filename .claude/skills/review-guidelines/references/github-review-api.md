# GitHub Pull Request Reviews API — Operational Reference

## The One Rule

Every finding on a specific line that exists in the diff **MUST** be an inline comment. No exceptions. Body-only findings are reserved for missing code, cross-file patterns, and lines outside all diff hunks.

## Tools Available

### diff-lines.ts — Your Line Number Lookup Tool

This script parses the diff and returns every commentable line with its exact `line` number and `side`. **Use it. Do not count lines manually.**

```bash
# All commentable lines across all files
tsx .claude/skills/review-guidelines/scripts/diff-lines.ts /tmp/pr-diff.txt

# Single file — use this when you have a finding on a specific file
tsx .claude/skills/review-guidelines/scripts/diff-lines.ts /tmp/pr-diff.txt src/steps/check.ts

# Find the line for a specific code pattern
tsx .claude/skills/review-guidelines/scripts/diff-lines.ts /tmp/pr-diff.txt src/steps/check.ts | jq '.[] | select(.content | contains("TODO"))'
```

Output format:
```json
{"file": "src/auth.ts", "line": 42, "side": "RIGHT", "type": "added", "content": "  if (!user.active) throw new AuthError(...)"}
```

- `line` → use directly as the `line` field in your comment
- `side` → use directly as the `side` field in your comment
- `file` → use directly as the `path` field in your comment
- `type` → `"added"` = new code, `"removed"` = deleted code, `"context"` = unchanged

### jq Recipes for Common Lookups

```bash
# List all files in the diff with line counts
tsx .claude/skills/review-guidelines/scripts/diff-lines.ts /tmp/pr-diff.txt | jq '[group_by(.file)[] | {file: .[0].file, lines: length}]'

# Find all added lines containing a keyword
tsx .claude/skills/review-guidelines/scripts/diff-lines.ts /tmp/pr-diff.txt | jq '.[] | select(.type=="added" and (.content | test("TODO|FIXME|HACK"; "i")))'

# Get line numbers for a specific file (just the numbers)
tsx .claude/skills/review-guidelines/scripts/diff-lines.ts /tmp/pr-diff.txt src/foo.ts | jq '[.[] | .line]'
```

## Workflow: Building the Review Payload

### Step 1: For Each Finding, Look Up the Line

You found an issue. Now determine if it can be inline:

```bash
# Example: you found a bug in src/steps/check.ts involving "classifyFingerprint"
tsx .claude/skills/review-guidelines/scripts/diff-lines.ts /tmp/pr-diff.txt src/steps/check.ts | jq '.[] | select(.content | contains("classifyFingerprint"))'
```

**If output exists** → use the `line`, `side`, and `file` values for your inline comment.
**If output is empty** → the line is not in the diff. Put the finding in the review body under `### Outside Diff`.

### Step 2: Build the Comments Array

For each finding that matched a diff line:

```json
{
  "path": "<file from diff-lines output>",
  "line": <line from diff-lines output>,
  "side": "<side from diff-lines output>",
  "body": "Issue description.\n\nSuggested fix: ..."
}
```

### Step 3: Build the Full Payload

```bash
cat > /tmp/review-payload.json <<'PAYLOAD_EOF'
{
  "body": "Review summary.\n\n### Outside Diff\n\n- **`src/other.ts`**: Finding about missing code not in the diff.",
  "event": "REQUEST_CHANGES",
  "comments": [
    {
      "path": "src/auth.ts",
      "line": 42,
      "side": "RIGHT",
      "body": "Null check missing — `user` can be undefined when token is expired."
    },
    {
      "path": "src/config.ts",
      "line": 4,
      "side": "RIGHT",
      "body": "Secret loaded without fallback — crashes on startup if SECRET env var is missing."
    }
  ]
}
PAYLOAD_EOF
```

### Step 4: Validate Before Posting

Run this check — every comment's `path:line` must exist in the diff:

```bash
# Extract paths and lines from your payload
jq -r '.comments[] | "\(.path):\(.line)"' /tmp/review-payload.json

# Verify each one exists in the diff
for entry in $(jq -r '.comments[] | "\(.path)|\(.line)"' /tmp/review-payload.json); do
  FILE="${entry%|*}"
  LINE="${entry#*|}"
  MATCH=$(tsx .claude/skills/review-guidelines/scripts/diff-lines.ts /tmp/pr-diff.txt "$FILE" | jq --argjson line "$LINE" '.[] | select(.line == $line)')
  if [ -z "$MATCH" ]; then
    echo "WARNING: $FILE:$LINE not in diff — move to body"
  else
    echo "OK: $FILE:$LINE"
  fi
done
```

### Step 5: Post

```bash
gh api repos/{owner}/{repo}/pulls/N/reviews --method POST --input /tmp/review-payload.json
```

## Payload Reference

### Top-Level Fields

| Field | Required | Values |
|-------|----------|--------|
| `body` | Yes | Review summary. Outside-diff findings go here under `### Outside Diff`. |
| `event` | Yes | `APPROVE` (zero findings), `REQUEST_CHANGES` (any findings) |
| `comments` | Yes | Array of inline comments. Can be `[]` only if all findings are outside-diff. |

### Comment Fields

| Field | Required | Value |
|-------|----------|-------|
| `path` | Yes | File path from diff (use `file` from diff-lines output) |
| `line` | Yes | Line number (use `line` from diff-lines output) |
| `side` | Yes | `"RIGHT"` for added/context, `"LEFT"` for removed (use `side` from diff-lines output) |
| `body` | Yes | Issue description + suggested fix |

### Multi-Line Comments

```json
{
  "path": "src/file.ts",
  "start_line": 10,
  "start_side": "RIGHT",
  "line": 15,
  "side": "RIGHT",
  "body": "This block has an issue..."
}
```

Both `start_line` and `line` must exist in the diff-lines output for the same file.

## What Goes Where

| Finding type | Location | Example |
|-------------|----------|---------|
| Bug on a specific added/changed line | `comments[]` inline | Null deref, SQL injection, off-by-one |
| Bug on a context line in a hunk | `comments[]` inline | Issue with unchanged code near changes |
| Bug on a removed line | `comments[]` inline with `side: "LEFT"` | Wrong code being removed |
| Missing code (nothing to point to) | `body` under `### Outside Diff` | Missing validation, missing error handling |
| Cross-file architectural issue | `body` under `### Outside Diff` | API contract mismatch between files |
| Line exists but not in any diff hunk | `body` under `### Outside Diff` | Issue in untouched part of file |

## Common Mistakes

| Mistake | Result | Fix |
|---------|--------|-----|
| Not using diff-lines.ts | All findings in body, 0 inline | Run the script for every finding |
| `line: null` | Broken file-level comment | Must be a number or move to body |
| Line not in diff hunk | API 422 error | Verify with diff-lines.ts first |
| Wrong path | API 422 error | Use `file` field from diff-lines output exactly |
| Using `gh pr review` | Individual COMMENTED reviews | Always `gh api .../reviews` |
| Skipping validation step | 422 errors on submit | Always run Step 4 before posting |
