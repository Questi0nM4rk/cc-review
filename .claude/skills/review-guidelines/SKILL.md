---
description: "Code review guidelines, language-specific patterns, and quality standards for the cc-review bot. Covers C#/.NET, TypeScript, and Python review patterns."
globs: "**/*"
alwaysApply: true
---

# Review Guidelines

## Read When

| File | Read When |
|------|-----------|
| `references/github-review-api.md` | **ALWAYS** — read this before posting ANY review. Contains `diff-lines.ts` tool. |
| `references/csharp-patterns.md` | PR contains `.cs`, `.csproj`, `.sln` files |
| `references/typescript-patterns.md` | PR contains `.ts`, `.tsx`, `.js`, `.jsx` files |
| `references/python-patterns.md` | PR contains `.py` files |

**You MUST read `references/github-review-api.md` before Step 6 of every review.** It explains exactly how to map findings to inline diff comments. Load language references only for the PR's languages.

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/review-cli.ts` | **The ONLY way to post reviews.** Single CLI for post, approve, status, list, resolve. |
| `scripts/diff-lines.ts` | Parses unified diff → JSON of commentable lines. Used internally by review-cli.ts. |

## Review Iron Laws

1. **Use review-cli.ts** — ALL review operations go through `review-cli.ts`. NEVER use `gh pr review` or `gh api .../reviews --method POST` directly.
2. **No severity labels** — NEVER write "Bug (MED)", "Bug (LOW)", "Critical", "High", "Medium", "Low", or any ranking. Every finding is just a finding. Every finding is a requested change. No tiers, no categories, no priorities.
3. **Every finding needs a failure scenario** — "When X happens, Y breaks because..."
4. **Verify before reporting** — Read surrounding code, check if issue is handled elsewhere
5. **No false positives from config** — Check `.cc-review.yaml` `known_patterns` and project memory
6. **Inline comments are automatic** — The CLI resolves line numbers from your `search` pattern via `diff-lines.ts`. Provide `file` and `search` in your findings JSON. Findings that can't be mapped go to "Outside Diff" automatically.
7. **All findings or none** — If you found 3 issues, ALL 3 must appear in the findings JSON. Not 1 kept + 2 dropped.

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
- Do NOT use `gh pr review` or `gh api .../reviews --method POST` directly — use review-cli.ts
- Do NOT split findings across multiple review-cli.ts calls — everything in ONE call
