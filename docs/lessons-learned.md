# Lessons learned — building cc-review as a self-contained workflow

Hard-won during the rewrite. Each of these cost a debugging cycle or a CI run to find. Read this before changing the runtime, the input plumbing, or the GitHub Action.

## Runtime & invocation

- **Workflows run headless via `claude -p` + the Workflow tool by `scriptPath`.** Empirically verified.
  - `claude -p "/my-workflow"` → **"Unknown command"**. User-invoked slash commands are interactive-only.
  - `Workflow` tool with `name: "my-workflow"` → **"not found"**. Project `.claude/workflows/*.mjs` are NOT auto-registered (only built-ins like `deep-research`, `code-review` are).
  - `Workflow` tool with `scriptPath: "<abs path>"` → **runs and returns**. This is the only headless path.
  - Invocation: `claude -p "Use the Workflow tool with scriptPath '…/strict-review.mjs'. Report its return value." --allowedTools "Workflow,…" --output-format stream-json | tee` (use `--permission-mode bypassPermissions` in CI).

## Inputs — the biggest trap

- **Workflow sub-agents do NOT inherit the launching process's environment variables.** A sub-agent's `echo $PR_NUMBER` returns nothing. Symptom: the Fetch agent hallucinated the PR number (used `10` instead of the dispatched `4`) and silently dropped `CC_POST`, so it never posted.
- **`args` do NOT reach the workflow's `args` global** through a `claude -p` prompt-driven Workflow call — `received_args: null` even when the args object is written into the prompt. Do not depend on `args` for CI inputs.
- **Files DO cross the boundary.** Sub-agent bash can read/write `/tmp` (the diff arrived fine via `/tmp/pr-diff.txt`). **So pass all inputs as files.** The GHA writes `/tmp/cc-input.json` (`{pr_number, repo, platform, post}`) in its own bash (the GHA step *does* have the env); the Fetch agent reads that file.

## Sub-agent sandbox

- **The Read/Write/Edit file tools are sandboxed to the repo workspace** (`/home/runner/work/<repo>/<repo>`). A sub-agent **cannot** Write to `/tmp/...`. Write `/tmp` files with **bash**, not the Write tool.
- **The GHA `--allowedTools` Bash allowlist binds sub-agents** (even with `--permission-mode bypassPermissions`). `Bash(cat:*)` permits `cat >`/`cat >>`; **`mkdir`, `printf`, `tee` are blocked unless listed.** Don't widen the allowlist for an untrusted-code reviewer — instead **pre-create dirs in the GHA** and have agents append with `cat >>` (an allowed command).

## Model tiers

- **Never put a haiku agent on a data or judgment task.** Haiku fumbled the env/file plumbing (dropped the post flag, invented the PR number). Use **sonnet** for Fetch / recon / memory / post-glue, **opus (+effort)** for triage / domain review / grade.
- **Haiku is only for "a bash script that's too dynamic to write as a script"** — e.g. the literal tool-runner step (`run tsx analysis-tools.ts, return its JSON`).

## Platform (GitHub vs GitLab)

- **GitHub thread replies need the REST `comment_db_id` (`in_reply_to`), NOT the reviewThread node id** (which `resolveReviewThread` uses). Carry both ids per thread; the reply verb takes `--comment-id` for GitHub, `--thread` for GitLab. GitLab uses the discussion id for both, so the bug is invisible until you run GitHub.
- **`gh pr diff` 404s on diffs too large for the API.** Pre-fetch to `/tmp/pr-diff.txt` with a `git diff base...head` fallback; the adapter prefers the pre-fetched file.

## Deployment & testing

- **Don't push the rewrite to cc-review `main` directly.** Push a branch (`rewrite`), point a consumer's installed `cc-review.yml` clone at it (`git clone -b rewrite …`), validate, then PR `rewrite → main`. This breaks the chicken-and-egg (the consumer GHA clones cc-review at runtime, so the brain must be on a branch it can reach).
- **Test rig:** install the workflows on the consumer's default branch, then `gh workflow run cc-review.yml -f pr_number=<closed PR>`. Verify via (a) the posted review on the PR and (b) the run's return value on the `<branch>-cc-review-output` log branch.
- **`workflow_dispatch` checks out the default branch, not the PR head** — so the workflow's "read the file on disk" sees `main`, not the PR. The *review* still uses the gh-fetched diff (correct content). Real `pull_request` events check out the PR head, so this only skews dispatch-triggered tests.

## What works (don't second-guess these)

- The cost-tiered cascade (triage → recon → 2 opus-xhigh + N sonnet → grade → verify), difficulty-scaled paths, and deterministic JS dedup/relevance. (Finding-format rules are enforced in the reviewer prompts, not a JS validator pass — the regex validators were removed after they produced false positives that dropped whole reviews.)
- **`.cc-review.yaml` config wiring**: `instructions` and `known_patterns` reach the reviewers and shape findings (it correctly flagged a `!` non-null assertion because the config forbids them, and filtered false-positives via the grade pass).
- The self-contained model: one `.claude/workflows/strict-review.mjs` + `scripts/` + `lang-refs/`, no marketplace submodule.
