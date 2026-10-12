# Conventions & Culture Notes

## GitHub Actions
- In multi-clause `if:` conditions, place the cheapest/most-definitive short-circuit first (e.g., `comment.user.type != 'Bot'` before body-content checks).
- Protect interactive CI workflow triggers from bot self-invocation by filtering on `github.event.comment.user.type != 'Bot'` as the leading guard clause.
- Use App installation tokens (via `actions/create-github-app-token`) rather than PATs for bot comment posting, so `comment.user.type == 'Bot'` is reliably set and detectable.
- Keep paired workflow files (cc-review.yml and cc-review-interactive.yml) in sync when changing shared settings like timeout-minutes.
- Keep workflow header comments accurate and in sync with the actual pipeline location (composite action vs external script) whenever CI architecture changes.
- Timeout tuning for CI jobs is a first-class concern — when a job is observed timing out on real workloads, raise the limit rather than accept the failure.

## Commits & PRs
- Use conventional commit prefixes consistently: feat:, fix:, chore:, ci:, refactor:, test:, docs:.
- PR descriptions follow a structured What / Why / Verify format — each section is brief and factual.
- docs: prefix for comment/doc-only changes; do not use chore: or fix: for documentation.

## Review Culture
- cc-review is the primary automated reviewer; it is interactive via `@cc-review` in PR comments.
- The team invests in keeping the bot loop-free (guards against self-invocation) rather than working around bot noise.
- Human review is not always required for CI-only chore PRs; the no-review label suppresses bots on trivial doc PRs.
- Quota-exhaustion incidents are documented in PR bodies (e.g., cc-review#51) for explicit traceability.
- Fix ALL review findings before pushing; batch fixes and push once per review round.

## Subprocess & Hook Semantics
- Always pass an explicit `cwd` to subprocess spawns (Bun.spawn/execa) when the child binary reads config relative to its working directory — omitting it silently loads the caller's config.
- Claude Code hook exit-code contract: exit 2 = block; any other non-zero = non-blocking log/warn. Use `exitCode === 2` for block detection in benchmarks, tests, and harness code.
- Classify hook decisions from the structured `permissionDecision` field in stdout JSON, not from stdout presence or generic exit-code non-zero checks.

## Benchmarks
- Benchmark files (bench/) are subject to the same project constraints as src/: no `extends`, no unvalidated `any`, no non-null assertions.
- Validate JSONL/JSON corpus rows with a Zod schema immediately after `JSON.parse`; an unvalidated row with a typo silently skews results.
- Scratch/work directories must be created under `os.tmpdir()`, not inside the repository tree, to avoid dirty-tree CI failures on interrupted runs.

## Documentation Accuracy
- README stats must be precise about scope: a metric that only covers Bash inputs must not use a label that implies all dangerous inputs are counted.
- JSONL corpus category fields are load-bearing for by-category reporting — verify read vs write semantics when categorising redirect-write patterns.

## CI Permission Scoping
- Scope `permissions: contents: write` (or any elevated permission) to the smallest possible job — use a dedicated job with `needs:` for steps like badge publishing rather than granting the permission to the whole workflow. Least-privilege is a first-class CI correctness concern, not a nitpick.
