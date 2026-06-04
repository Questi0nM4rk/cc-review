# Strict review checklist — Shell (bash/sh/zsh)

Read this when the diff touches `*.sh`, `*.bash`, `*.zsh`, or shell in CI YAML / `RUN` steps. Flag any violation as a required change (imperative mood, no severity labels).

## Safety preamble
- Missing `set -euo pipefail` (bash) at the top of a non-interactive script — errors and unset vars pass silently, pipe failures are masked.
- `|| true` appended to a command whose failure actually matters — it hides real errors.

## Quoting / expansion
- Unquoted variable expansion (`$var`, `$(cmd)`, `${arr[@]}`) — word-splitting and glob expansion bugs. Quote everything: `"$var"`, `"${arr[@]}"`.
- Parsing `ls` output, or iterating `for f in $(ls)` — breaks on spaces/newlines. Use a glob or `find ... -print0 | while IFS= read -r -d ''`.
- `[ ]` test with unquoted operands — prefer `[[ ]]` in bash.

## Correctness
- Command substitution result used without checking the command succeeded.
- `cd` without `|| exit` / error handling — subsequent commands run in the wrong directory.
- Temp files created without a `trap '...' EXIT` cleanup, or via predictable names (use `mktemp`).
- Functions mutating globals instead of declaring `local`.

## Security
- `eval` on constructed/untrusted input.
- `curl ... | bash` / `wget ... | sh` of a non-pinned, untrusted source.
- Secrets echoed, logged, or passed on the command line (visible in `ps`) — use env or files.

## Verify
- `shellcheck` clean on changed scripts (treat warnings as findings).
- For CI YAML inline shell, apply the same rules to each `run:` block.
