# Review CLI Reference

All review operations go through `review-cli.ts`. Direct `gh pr review` and `gh api .../reviews` POST calls are blocked by the enforcement hook.

## Commands

### Post a Review

Pipe findings JSON via stdin using `--findings -`:

```bash
tsx .claude/skills/review-guidelines/scripts/review-cli.ts post \
  --repo owner/repo --pr 98 \
  --diff /tmp/pr-diff.txt \
  --findings - [--dry-run] <<'FINDINGS_EOF'
{
  "summary": "Found 2 issues.",
  "findings": [
    { "file": "src/auth.ts", "search": "user.active", "body": "Null check missing — user can be undefined when token is expired." },
    { "file": "src/config.ts", "search": "process.env.SECRET", "body": "Secret loaded without fallback — crashes on startup if SECRET env var is missing." },
    { "file": null, "body": "Cross-file issue: API contract mismatch between auth and config modules." }
  ]
}
FINDINGS_EOF
```

**Finding fields:**
| Field | Required | Description |
|-------|----------|-------------|
| `file` | Yes | File path, or `null` for cross-file/missing-code issues |
| `search` | No | Text pattern to match in the diff (resolves line number automatically) |
| `line` | No | Explicit line number (verified against diff) |
| `body` | Yes | Issue description |

**The CLI handles:**
1. Resolving line numbers via `diff-lines.ts`
2. Mapping findings to inline comments or "Outside Diff" body section
3. Setting event to `APPROVE` (0 findings) or `REQUEST_CHANGES` (any findings)
4. Building and posting the payload

**Dry run** (`--dry-run`): Prints the payload JSON to stdout without posting.

### Approve a PR

```bash
tsx .claude/skills/review-guidelines/scripts/review-cli.ts approve \
  --repo owner/repo --pr 98 \
  [--force] [--dry-run]
```

**Unresolved thread guard:** The CLI checks for unresolved review threads before approving. If any exist, it refuses and prints thread summaries. Use `--force` to override.

### Check Status

```bash
tsx .claude/skills/review-guidelines/scripts/review-cli.ts status \
  --repo owner/repo --pr 98
```

Output:
```json
{
  "latestReview": { "state": "CHANGES_REQUESTED", "user": "cc-review[bot]", "date": "2026-03-10T..." },
  "unresolvedThreads": 2,
  "totalThreads": 5
}
```

### List Reviews

```bash
tsx .claude/skills/review-guidelines/scripts/review-cli.ts list \
  --repo owner/repo --pr 98
```

Output: JSON array of `{id, state, user, submittedAt}`.

### Resolve a Thread

```bash
tsx .claude/skills/review-guidelines/scripts/review-cli.ts resolve \
  --repo owner/repo --pr 98 \
  --thread-id PRReviewThread_abc123
```

Resolves a review thread by its GraphQL node ID. Use after confirming a fix has been applied.

## What Goes Where

| Finding type | In findings JSON | CLI behavior |
|-------------|-----------------|-------------|
| Bug on a specific line in the diff | `file` + `search` | → Inline comment |
| Bug with known line number | `file` + `line` | → Inline comment (verified) |
| Missing code (nothing to point to) | `file: null` | → Body under "Outside Diff" |
| Cross-file architectural issue | `file: null` | → Body under "Outside Diff" |
| Line not in any diff hunk | `file` + `search` (no match) | → Body under "Outside Diff" (automatic) |

## diff-lines.ts — Direct Usage (Optional)

The CLI uses `diff-lines.ts` internally. You can also call it directly for exploration:

```bash
# All commentable lines across all files
tsx .claude/skills/review-guidelines/scripts/diff-lines.ts /tmp/pr-diff.txt

# Single file
tsx .claude/skills/review-guidelines/scripts/diff-lines.ts /tmp/pr-diff.txt src/auth.ts

# Search by content
tsx .claude/skills/review-guidelines/scripts/diff-lines.ts /tmp/pr-diff.txt src/auth.ts | jq '.[] | select(.content | contains("TODO"))'
```

Output: `{"file": "src/auth.ts", "line": 42, "side": "RIGHT", "type": "added", "content": "..."}`
