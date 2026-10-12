`vori` is a read-only CLI for querying Obsidian-style markdown vaults, compiled to a self-contained binary via Bun.

Recurring review themes:
- CI correctness: shell safety (`set -euo pipefail`), temp-dir hygiene (`RUNNER_TEMP` not `/tmp`), badge schema compliance
- Conventional Commits enforced in PR titles (feat:, fix:, chore:, docs: with optional scope)
- Volatile numbers (test counts, timings, sizes) belong in live CI badges, not in README prose
- Bot-author guard must be the first predicate in GitHub Actions `if:` conditions

_Priors seeded from the last 3 merged PRs at install; refined as reviews run._
