# Conventions & Culture

- All multi-line CI shell scripts use `set -euo pipefail` (or `set -o pipefail` in pipe chains).
- Use `RUNNER_TEMP` for all temporary files and directories in CI; never hardcode `/tmp` paths.
- Badge JSON follows the shields.io endpoint schema: `{schemaVersion:1, label, message, color}` — one file per badge, written via a `badge()` shell function.
- Force-push to a dedicated `badges` branch is the accepted pattern for serving live shield badge data via raw GitHub URLs.
- Capture `bun test` output with `2>&1 | tee <file>` to both display results and persist them for downstream parsing steps.
- Automated git commits in CI use the standard `github-actions[bot]` name and `41898282+github-actions[bot]@users.noreply.github.com` email.
- Conventional Commits with scope in PR titles: `fix(ci):`, `feat:`, `chore:` — scope names the layer changed (ci, docs, src).
- In GitHub Actions `if:` conditions, place the most selective guard (e.g. Bot-author check) as the first predicate to short-circuit before heavier checks run.
- Volatile numbers (test counts, exact timings, binary sizes, Bun version) are removed from README and replaced with live CI badges.
- CodeRabbit auto-reviews are disabled; triggered manually with `@coderabbitai review`. The team intentionally runs a CHILL review profile.
- Low-risk CI fixes may be merged on bot approval alone without human review discussion.
