---
description: "Code review guidelines, language-specific patterns, and quality standards for the cc-review bot. Covers C#/.NET, TypeScript, and Python review patterns."
globs: "**/*"
alwaysApply: true
---

# Review Guidelines

## Read When

| File | Read When |
|------|-----------|
| `references/csharp-patterns.md` | PR contains `.cs`, `.csproj`, `.sln` files |
| `references/typescript-patterns.md` | PR contains `.ts`, `.tsx`, `.js`, `.jsx` files |
| `references/python-patterns.md` | PR contains `.py` files |

Load only the references matching the PR's languages. Do not load all three.

## Review Iron Laws

1. **Single review block** — ONE `gh api` call with ALL comments in the `comments` array. NEVER post comments separately.
2. **No severity labels** — NEVER write "Bug (MED)", "Bug (LOW)", "Critical", "High", "Medium", "Low", or any ranking. Every finding is just a finding. Every finding is a requested change. No tiers, no categories, no priorities.
3. **Every finding needs a failure scenario** — "When X happens, Y breaks because..."
4. **Verify before reporting** — Read surrounding code, check if issue is handled elsewhere
5. **No false positives from config** — Check `.cc-review.yaml` `known_patterns` and project memory
6. **Comments need valid diff lines** — If a finding can't map to an exact line in the diff, describe it in the review `body` instead. NEVER put a comment with `line: null` or a line that doesn't exist in the diff.
7. **All findings or none** — If you found 3 issues, ALL 3 must appear in the review. Not 1 inline + 2 dropped.

## Review Decision

- **Any findings at all** → `REQUEST_CHANGES` with all findings as inline comments (if line is in diff) or in the body (if not)
- **No findings** → `APPROVE`
- There is no middle ground. No "approve with suggestions". No "comment only". Every finding = required change.

## What to Ignore

- Formatting, whitespace, naming style
- Missing comments or docs
- "I would have done it differently" opinions
- Test coverage (unless tests are actively broken)
- Patterns listed as known false positives

## DON'Ts

- Do NOT use severity labels, priorities, or rankings of any kind
- Do NOT dump every pattern from references — only flag patterns you actually see in the diff
- Do NOT use generic descriptions ("this could be improved") — be specific
- Do NOT report the same issue on multiple lines — pick the most representative line
- Do NOT pad reviews with praise ("great PR overall") — get to the point
- Do NOT post inline comments with null/invalid line numbers — put those in the body
- Do NOT split findings across multiple API calls — everything in ONE call
