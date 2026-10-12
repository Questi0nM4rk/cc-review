# Recurring Issue Themes

## bench/hook-corpus.ts (bench harness — multiple violations, one file)
- Missing `cwd: dir` on `Bun.spawn` — hook binary reads `.ai-guardrails/config.toml` from `process.cwd()` via `loadHookConfig`; without an explicit cwd the wrong config is loaded. (bench/hook-corpus.ts:60)
- Hook output classified by stdout presence instead of `permissionDecision` field — for PreToolUse, `ask` and `block` must be mapped from the structured field, not inferred from non-empty stdout. (bench/hook-corpus.ts:77)
- Block detection uses any non-zero exit code; must use `exitCode === 2` exclusively — Claude Code treats only exit 2 as blocking. (bench/hook-corpus.ts:78)
- `JSON.parse` result assigned to `Row[]` without Zod validation — a misspelled `expected` field silently produces wrong benchmark results instead of a schema error. (bench/hook-corpus.ts:87)
- Scratch directory created under `bench/` inside the repo — must use `os.tmpdir()` or add `bench/.work-*/` to .gitignore; `finally` cleanup does not prevent dirty-tree failures if the process is killed. (bench/hook-corpus.ts:89)
- `interface Result extends Row` — the project forbids `extends` (except Error subclasses); use composition instead (e.g. `interface Result { row: Row; actual: Decision; raw: string }`). (bench/hook-corpus.ts:26)

## README.md
- Stat label `'Dangerous commands flagged'` is inaccurate — 16 of the 70 dangerous corpus rows (ids 55–70) are Write/Edit/NotebookEdit inputs, not commands; rename to `'Dangerous inputs flagged'` or report the Bash-only rate. (README.md:86)
- Line at 451 chars exceeds markdownlint MD013 limit of 300 cols configured in `.markdownlint-cli2.jsonc`; fails the lefthook pre-commit gate. (README.md:103)

## bench/corpus.jsonl
- Entry id 54 (`echo x > .env`) is in category `secret-read-bash` but is a redirect write, not a read; move to `secret-write-bash` for accurate by-category reporting. (bench/corpus.jsonl:54)

## .github/workflows/check.yml
- `Publish badges` step grants `permissions: contents: write` at workflow scope; move it into a separate job with `needs: test` and scope the write permission to that job alone — the current placement elevates write access for the entire workflow unnecessarily. (.github/workflows/check.yml:46)
