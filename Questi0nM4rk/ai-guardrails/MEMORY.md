A TypeScript monorepo (Bun runtime) that ships pedantic AI-assisted code-quality guardrails as a CLI and a Claude Code hook adapter.

Recurring review themes:
- GitHub Actions multi-clause `if:` conditions must short-circuit with the cheapest guard first (e.g., `comment.user.type != 'Bot'` before body checks).
- Paired workflow files (cc-review.yml / cc-review-interactive.yml) must stay in sync on shared settings.
- Conventional commit prefixes (feat:, fix:, ci:, chore:, refactor:, test:, docs:) are enforced on all commits and PR titles.
- PR descriptions follow a structured What / Why / Verify format.
- App installation tokens preferred over PATs for bot comment posting.
- Timeout-minutes in CI is a first-class concern; raise when observed to be too tight.
- bench/ code repeatedly violates project constraints: forbidden `interface extends`, unvalidated `any` from JSON.parse, missing `cwd` on subprocess spawns, scratch dirs created inside the repo.
- Subprocess spawns that load config from `process.cwd()` must pass an explicit `cwd` option or the hook reads the wrong config.
- Hook exit-code semantics: exit 2 = block (Claude Code); any other non-zero = non-blocking. Benchmarks and tests must use `exitCode === 2` for block detection.
- README metric labels must exactly match what is measured — a label covering only Bash commands must not claim coverage of Write/Edit/NotebookEdit inputs.
- Markdown files must stay under the configured line-length limit (300 cols in .markdownlint-cli2.jsonc); violations fail the lefthook pre-commit gate.
- JSONL corpus category fields must be accurate — a write-redirect (echo x > .env) is not a read.
- CI workflow `permissions:` must be scoped to the minimum necessary job — steps that need `contents: write` (e.g., badge publishing) belong in a separate job with `needs:` rather than broadening the whole workflow's permission surface.

_Priors seeded from the last 3 merged PRs at install; refined as reviews run._
