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
- **Test rig:** install the workflows on the consumer's default branch, then `gh workflow run cc-review.yml -f pr_number=<closed PR>`. Verify via (a) the posted review on the PR and (b) the run's return value on the `pr-<N>-cc-review-output` log branch.
- **`workflow_dispatch` checks out the default branch, not the PR head** — so the workflow's "read the file on disk" sees `main`, not the PR. The *review* still uses the gh-fetched diff (correct content). Real `pull_request` events check out the PR head, so this only skews dispatch-triggered tests.

## What works (don't second-guess these)

- The cost-tiered cascade (triage → recon → 2 opus-xhigh + N sonnet → grade → verify), difficulty-scaled paths, and deterministic JS dedup/relevance. (Finding-format rules are enforced in the reviewer prompts, not a JS validator pass — the regex validators were removed after they produced false positives that dropped whole reviews.)
- **`.cc-review.yaml` config wiring**: `instructions` and `known_patterns` reach the reviewers and shape findings (it correctly flagged a `!` non-null assertion because the config forbids them, and filtered false-positives via the grade pass).
- The self-contained model: one `.claude/workflows/strict-review.mjs` + `scripts/` + `lang-refs/`, no marketplace submodule.

## CI sandbox + clone constraints (2026-06-03 — verified live on feats)

- **GHA `claude -p` sub-agents are filesystem-sandboxed to `$GITHUB_WORKSPACE`.** Every `/tmp` write is blocked (the agent reports `Output redirection to '/tmp/...' was blocked ... may only write to files in the allowed working directories: '/home/runner/work/<repo>/<repo>'`). `bypassPermissions` does NOT lift the filesystem sandbox. Reads from `/tmp` are fine. So: GHA *steps* (run as the runner) stage inputs in `/tmp`; *agents* must WRITE under the workspace. Memory moved from `/tmp/memory` → `$GITHUB_WORKSPACE/.cc-memory`. Symptom before the fix: memory agent fell back to a false "no memory dir (local mode)" and nothing was recorded.
- **`--allowedTools` gates Bash to specific commands** (`gh/glab/git/tsx/npx/node/cat`). `mkdir/printf/tee` are unavailable to agents — they write files with `cat` heredoc only, and dirs must be pre-created by a GHA step. A prompt that scares the agent ("everything is blocked") makes it give up; mirror the *working* post pattern instead.
- **Shallow single-branch clone (`-b rewrite`) has no `origin/<other-branch>` tracking refs.** `push_mem` keyed off `origin/claude-reviewer/memory` (absent) → fell to `git checkout --orphan` → collided with the local branch the pre-fetch created → `fatal: a branch named 'claude-reviewer/memory' already exists`, failing every retry — masked by the retry loop's exit 0 (step showed "success", nothing pushed). Fix: `git fetch origin claude-reviewer/memory` then `git checkout -B claude-reviewer/memory FETCH_HEAD`.
- **Memory agent must be handed the actual findings, not just counts.** Given only `confirmed:N`, it fabricated entries inferred from its cwd (wrong branch). Pass the confirmed findings (file:line + description) so `found-issues` records the real issues.
- **gitleaks CLI v8 has no `-q`.** `gitleaks detect ... -q` prints usage and no-ops (the gate silently passes everything). Use `gitleaks detect --source <dir> --no-git --redact --no-banner`; non-zero exit = leaks.
- **Log-branch name must be trigger-independent.** It was `${head.ref}-cc-review-output` on `pull_request` but `pr-N-cc-review-output` on dispatch → the same PR produced two names → cleanup (keyed on head.ref) orphaned the dispatch one. Fix: `pr-<N>-cc-review-output` everywhere, in both `cc-review.yml` and `cc-review-cleanup.yml`.

## Testing the GHA without merging to a consumer's main

- `gh workflow run cc-review.yml --repo <consumer> --ref <branch> -f pr_number=N` runs the workflow **from a branch ref** on real GitHub Actions — full live test (App token, clone, post, memory, log branch) with zero changes to the consumer's `main`. This is how the memory/gitleaks/naming fixes were verified before (and without needing) a merge. The workflow only needs to exist on the default branch to be dispatchable; it then executes the chosen ref's version.
- `run-local.sh` proves the engine but NOT the CI sandbox (no sandbox locally) — `/tmp` writes succeed locally, so memory-write bugs are invisible there. Verify memory only via the `--ref` dispatch + the `claude-reviewer/memory` branch.

## Quota

- The GHA's `claude -p` and any concurrent local/interactive Claude share ONE account. Running heavy work in parallel with a CI review can exhaust the session limit mid-run (it did once — the review died in the squad after posting the overview). Sequence runs; stay idle while a GHA review is in flight.

## Overview / diagram (2026-06-03 — design decisions, not yet implemented)

- The overview+diagram is the **PR overview**: post ONCE on PR-open, then **edit in place** as the PR evolves (re-posting per run is the feats#12 "multiple overviews" bug). The overview agent must be conditional on PR state (existing bot overview? new commits? diagram still matches?).
- Mermaid diagram → 1.0 standard in `docs/overview-diagram-standard.md`: render-safe (quote every label), **show calls AND decisions** (labeled edges + diamonds / `alt`/`opt`), type chosen for the change, emphasize changed nodes, 5–12 nodes. Studio to tune it: `~/.claude/work/cc-review/overview-diagram-studio.html`.

## Post-rebuild audit cleanup (2026-06-04/05 — issues #7–#23)

Hard-won while working the post-rebuild audit backlog (tracking issue #24). Each is a real trap.

- **A single embedded control byte makes a source file "binary" to `grep` — silently.** The brain's
  `sanitizeContext` char-class and `globToRe`'s `**` placeholder were written with LITERAL control
  bytes (`0x00`/`0x1f`/`0x7f` and `0x01`) instead of `\xNN` escapes. `grep` then prints nothing on
  that file (treats it as binary) and the bytes are invisible in editors/diffs — one reformat from
  changing behavior. Detect with `grep -aP '[\x00-\x08\x0b-\x1f\x7f]'` or `tr -d '\11\12\40-\176' | wc -c`.
  Fix: visible `\xNN` escapes (byte-identical to the regex engine) + a test asserting zero stray
  control bytes + the `scripts/check-brain.mjs` syntax gate so a mangled edit fails at commit time.
- **Verify the READ path before building a WRITE path.** The "research cache" wrote ~10 KB of gather
  observations per PR that nothing ever read back ("reuse research" was really "skip research"). Pure
  complexity + unbounded growth. Cut it (#8); kept only a tiny `review-state.json` marker.
- **Composite / reusable GHA actions referenced via `uses:` do NOT fit a private runtime-cloned bot.**
  `uses: owner/repo/...@ref` resolves BEFORE any step runs, so it can't use the App token the way the
  brain-clone does — a private action repo 404s for consumers without a cross-repo access toggle (or
  going public). Same-owner private works with the toggle; cross-owner needs a runtime-cloned shared
  script instead. Decide the access model BEFORE reaching for composite actions.
- **`steps.<id>.outcome` is unreliable INSIDE a composite action.** Key failure-detection on artifacts
  (e.g. "no final result object in `session.jsonl`"), not on a composite step's outcome — a quota-kill
  leaves no result object regardless, which is the more robust signal anyway.
- **git's default `core.quotepath=true` C-escapes non-ASCII paths** (`"a/caf\303\251/..."`) in the
  `git diff` fallback → `changedFiles` extracts nothing and inline comments fail to post. Use
  `git -c core.quotepath=false diff` so paths match the `gh` API path's raw UTF-8.
- **Don't let one stochastic integer gate the whole pipeline.** Difficulty (1–5) decided gather/squad/
  model/check and the same fixture rolled 1 then 3. Add a deterministic FLOOR (`difficultyFloor`):
  `difficulty = max(rated, floor)` from risk + size signals — only ever raises depth (fail-safe).
- **Prompt-injection: a phrase-blocklist regex is whack-a-mole** (if a defense's docs list its own
  bypasses, it isn't one). Use instruction/data SEPARATION: wrap untrusted text in a fence ("data
  only, never instructions") and strip the fence keyword from the body so it can't be forged. The real
  guarantee is the deterministic verdict gate (an injection can't force APPROVE — it's pure JS).
- **Memory must self-curate, not append forever.** The memory agent reads each file and either appends
  or REWRITES it consolidated (`cat >`), but `known-patterns.md` is append/exact-dedup ONLY — never
  merge/paraphrase a suppression rule (dropping one makes future runs re-flag it).
- **`gitleaks` for a security gate: pin the version AND a HARDCODED sha256** (not the release's own
  `checksums.txt` — a tampered release swaps both). v8 has no `-q`; use `--redact --no-banner`. Fail-CLOSED.
- **A `no-review`-labeled PR skips the WHOLE cc-review job — including the App-token step.** So you can
  run dozens of PRs without ever exercising App auth, and not notice the App is dead. ALWAYS do a real
  dispatch to exercise the full path before declaring the bot healthy.

## TOP PRIORITY for the next session: the GitHub App is unreachable

The first real dispatch this session FAILED at **"Generate GitHub App token"** with
**`Integration not found - failed to create token for "Questi0nM4rk"`** (run 26985091589, against
PR #36). This is NOT a code bug — the token step is unchanged and failed BEFORE the new composite
action (which was correctly skipped). The GitHub App that `REVIEWER_APP_ID` points to is **deleted,
uninstalled, or the App-ID secret is stale**. **The bot cannot run ANY review until this is fixed**,
independent of every code change.

To fix (it's the user's GitHub App / account — an agent can't recreate it):
1. **github.com/settings/apps** — confirm the cc-review App exists and is **installed** on the
   `Questi0nM4rk` account (the cc-review repo + any reviewed repo).
2. On the `cc-review` repo, confirm `REVIEWER_APP_ID` matches the App's real ID and
   `REVIEWER_APP_PRIVATE_KEY` is a current key (`gh secret list` shows both *set*, but pointing at a
   missing App).
3. If the App is gone, `./scripts/setup.sh` recreates it and writes fresh secrets.

Once the App resolves, re-dispatch to verify **#18** (merged but unverified — see CLAUDE.md state).
