# GitHub Pull Request Reviews API — Complete Reference

## Endpoint

```
POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews
```

Use `gh api` to call it:
```bash
gh api repos/{owner}/{repo}/pulls/N/reviews --method POST --input /tmp/review-payload.json
```

## Payload Structure

```json
{
  "body": "Review summary. Findings outside the diff go here.",
  "event": "REQUEST_CHANGES",
  "comments": [
    {
      "path": "src/file.ts",
      "line": 42,
      "side": "RIGHT",
      "body": "Description of the issue and suggested fix."
    }
  ]
}
```

### Top-Level Fields

| Field | Required | Values |
|-------|----------|--------|
| `body` | Yes | Review summary text. Findings that can't be inline go here. |
| `event` | Yes | `APPROVE`, `REQUEST_CHANGES`, or `COMMENT` |
| `comments` | Yes | Array of inline comments (can be empty `[]`) |

### Comment Fields

| Field | Required | Description |
|-------|----------|-------------|
| `path` | Yes | Relative file path exactly as shown in the diff (e.g. `src/file.ts`) |
| `body` | Yes | Comment text — the issue description and fix suggestion |
| `line` | Yes | **File line number** (NOT diff position). Must be within a diff hunk. |
| `side` | No | `RIGHT` (new file, default) or `LEFT` (old/deleted file) |
| `start_line` | No | First line for multi-line comments |
| `start_side` | No | Side for `start_line` |

## CRITICAL: How `line` Works

The `line` field is the **line number in the actual file**, NOT the position within the diff output.

BUT — the line **must exist within a diff hunk**. You can only comment on lines that appear in the diff:
- Added lines (`+` prefix) — use `side: "RIGHT"`, `line` = new file line number
- Removed lines (`-` prefix) — use `side: "LEFT"`, `line` = old file line number
- Context lines (space prefix) — use `side: "RIGHT"`, `line` = new file line number

If a line is NOT in any diff hunk, you CANNOT comment on it inline. Put that finding in the review `body` instead.

## How to Parse Diff Hunks for Valid Line Numbers

### Diff Format

```diff
diff --git a/src/config/schema.ts b/src/config/schema.ts
index abc123..def456 100644
--- a/src/config/schema.ts
+++ b/src/config/schema.ts
@@ -98,7 +98,10 @@ export function buildConfig() {
   const rules = config.rules;          // context: line 98 (old) / 98 (new)
   const merged = mergeDefaults(rules); // context: line 99 / 99
   const validated = validate(merged);  // context: line 100 / 100
-  return validated;                    // removed: old line 101
+  const allowed = filterAllowed(validated); // added: NEW line 101
+  return allowed;                      // added: NEW line 102
+}                                      // added: NEW line 103
+                                       // added: NEW line 104
   // trailing context                  // context: line 105 / 105 (if shown)
```

### The `@@` Header

`@@ -98,7 +98,10 @@` means:
- **Old file**: starts at line 98, shows 7 lines
- **New file**: starts at line 98, shows 10 lines

### Algorithm to Extract Commentable Lines

```
Parse each @@ header: @@ -OLD_START,OLD_COUNT +NEW_START,NEW_COUNT @@

Set old_line = OLD_START
Set new_line = NEW_START

For each line in the hunk:
  If line starts with '+':
    → Commentable on RIGHT side at line = new_line
    → new_line++
  If line starts with '-':
    → Commentable on LEFT side at line = old_line
    → old_line++
  If line starts with ' ' (space/context):
    → Commentable on RIGHT side at line = new_line
    → old_line++, new_line++
```

### Practical Shortcut

For most review findings on **added or modified code**, you want:
1. Find the `+` line in the diff that contains the issue
2. Count its position relative to the `@@` header's `+NEW_START`
3. That gives you the `line` number for `side: "RIGHT"`

**Example**: If the diff header is `@@ -98,7 +98,10 @@` and the problematic `+` line is the 5th new-file line in the hunk, then `line = 98 + 4 = 102`.

## What Can and Cannot Be Inline Comments

### CAN be inline (put in `comments` array):
- Bug on a specific added line (`+` line in diff)
- Issue with a specific modified line
- Problem visible on a context line within a diff hunk
- Issue on a removed line (use `side: "LEFT"`)

### CANNOT be inline (put in review `body`):
- Finding about **missing** code (no line to point to)
- Cross-file architectural issue
- Issue on a line that is NOT in any diff hunk
- Integration mismatch between two files
- Pattern that spans many files

## Building the Review Payload — Step by Step

### Step 1: Collect Findings

After reviewing, you have a list of findings. Each has:
- File path
- Line number (if applicable)
- Description

### Step 2: Classify Each Finding

For each finding, check if the line appears in the diff:
1. Search `/tmp/pr-diff.txt` for the file's diff section
2. Find the `@@` hunk that covers the line
3. Verify the line is a `+`, `-`, or context line within a hunk

If YES → goes in `comments` array with `path`, `line`, `side`, `body`
If NO → goes in `body` under `### Outside Diff` section

### Step 3: Build Payload

```bash
cat > /tmp/review-payload.json <<'PAYLOAD_EOF'
{
  "body": "Summary of review.\n\n### Outside Diff\n\n- **`src/other.ts`**: Description of issue not in the diff.",
  "event": "REQUEST_CHANGES",
  "comments": [
    {
      "path": "src/config/schema.ts",
      "line": 101,
      "side": "RIGHT",
      "body": "Description of issue on this specific line.\n\nSuggested fix: ..."
    }
  ]
}
PAYLOAD_EOF
```

### Step 4: Verify

Before posting, verify every comment:
- `path` matches the diff exactly (check `diff --git a/PATH b/PATH`)
- `line` is within a `@@` hunk for that file
- `side` is `RIGHT` for added/context lines, `LEFT` for removed lines
- No comment has `line: null` — those go in the body

### Step 5: Post

```bash
gh api repos/{owner}/{repo}/pulls/N/reviews --method POST --input /tmp/review-payload.json
```

## Common Mistakes

| Mistake | Result | Fix |
|---------|--------|-----|
| `line: null` | Creates a broken file-level comment | Put finding in review body |
| `line` not in diff hunk | API returns 422 error | Move to body or find correct hunk line |
| Wrong `path` (doesn't match diff) | API returns 422 error | Copy path from `diff --git a/PATH` |
| Using `position` instead of `line` | Wrong line targeted | Always use `line` + `side`, never `position` |
| Missing `side` | Defaults to RIGHT | Explicit `"side": "RIGHT"` for clarity |
| Using `gh pr review` | Posts individual COMMENTED reviews | Always use `gh api .../reviews` with bundled payload |

## Multi-Line Comments

To highlight a range of lines:

```json
{
  "path": "src/file.ts",
  "start_line": 10,
  "start_side": "RIGHT",
  "line": 15,
  "side": "RIGHT",
  "body": "This entire block has an issue..."
}
```

Both `start_line` and `line` must be within the same diff hunk.

## Quick Reference: Diff Line to API Line

Given a unified diff:
```
@@ -20,6 +22,8 @@ function example() {
 line A   → RIGHT, line=22
 line B   → RIGHT, line=23
+line C   → RIGHT, line=24  ← new code, commentable
+line D   → RIGHT, line=25  ← new code, commentable
 line E   → RIGHT, line=26
 line F   → RIGHT, line=27
+line G   → RIGHT, line=28  ← new code, commentable
+line H   → RIGHT, line=29  ← new code, commentable
```

The `+22` in `@@ -20,6 +22,8 @@` means the new file starts at line 22 in this hunk. Context lines (no prefix) and `+` lines increment the new-file counter. `-` lines do NOT increment it.
