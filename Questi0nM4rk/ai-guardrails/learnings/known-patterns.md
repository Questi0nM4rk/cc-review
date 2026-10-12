# Known Patterns — Do Not Re-Flag

- pytest-style test classes with unused self in test methods — intentional grouping, not a bug (DeepSource false positive).
- Template files (CLAUDE.md.guardrails and similar) duplicating content from the repo's own docs — they are designed to be installed into consumer projects.
- ai-guardrails comments CLI tool documentation referencing consumer-project usage — the tool is installed alongside the CLI by definition.
- bun build --compile produces a standalone binary that embeds the Bun runtime — the output binary does NOT require Bun on target machines.
- Cumulative diff anchoring: inline bot comments may reference intermediate file states that were already fixed in later commits — always verify against HEAD.
- SPEC-001 library table with separate rows for Pre-commit hooks, Claude Code hooks runtime, and Hook target projects — intentional split.
- isAvailable(commandRunner) parameter naming is correct and consistent — older diff hunks may show earlier naming.
- ruff.toml exclude array for tests/fixtures is intentional — do not flag its presence or removal based on stale diff state.
- Review bot rules ('fix every comment') in CLAUDE.md are NOT philosophically inconsistent with hard-stops policy — review bots ARE the enforcement mechanism.
- CLAUDE.md template content not being DRY violation relative to repo's own CLAUDE.md — separate target audiences.
