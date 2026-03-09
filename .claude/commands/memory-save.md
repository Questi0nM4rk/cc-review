---
name: memory-save
description: "Save updated project memory to the claude-reviewer/memory branch."
argument-hint: "<memory content to save>"
allowed-tools: "Bash(git:*)"
---

Save updated project memory to the `claude-reviewer/memory` branch.

First, capture the current ref so we can return to it:
```bash
ORIG_REF=$(git rev-parse HEAD)
```

Fetch the latest memory branch and check if it exists:
```bash
git fetch origin claude-reviewer/memory:claude-reviewer/memory 2>/dev/null || true
git rev-parse --verify claude-reviewer/memory 2>/dev/null && echo "EXISTS" || echo "NEW"
```

If NEW, create the orphan branch:
```bash
git checkout --orphan claude-reviewer/memory
git reset --hard
```

If EXISTS, check it out:
```bash
git checkout claude-reviewer/memory
```

Write the memory content to MEMORY.md. The content should follow this structure:

```markdown
# Project Memory — [repo name]

Last updated: [date]

## Codebase Profile
- Primary languages: [detected]
- Framework: [detected]
- Architecture: [detected patterns]

## Recurring Patterns
[List of patterns seen across multiple PRs]

## Common Mistakes
[Issues that keep appearing in PRs from this codebase]

## Known False Positives
[Things that look like issues but are intentional in this project]

## Project Conventions
[Conventions specific to this project that differ from defaults]

## Review Insights
[Accumulated learnings from past reviews]
```

Commit and push:
```bash
git add MEMORY.md
git commit -m "Update reviewer memory"
git push origin claude-reviewer/memory
```

Then switch back to the original ref:
```bash
git checkout $ORIG_REF
```
