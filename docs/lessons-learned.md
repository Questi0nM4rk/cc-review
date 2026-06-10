# Lessons learned — building cc-review as a self-contained workflow

Hard-won during the rewrite. Each of these cost a debugging cycle or a CI run to find. Read this before changing the runtime, the input plumbing, or the GitHub Action.

## Runtime & invocation

- **Workflows run headless via `claude -p` + the Workflow tool by `scriptPath`.** Empirically verified.
  - `claude -p "/my-workflow"` → **"Unknown command"**. User-invoked slash commands are interactive-only.
  - `Workflow` tool with `name: "my-workflow"` → **"not found"**. Project `.claude/workflows/*.mjs` are NOT auto-registered (only built-ins like `deep-research`, `code-review` are).
  - `Workflow` tool with `scriptPath: "<abs path>"` → **runs and returns**. This is the only headless path.
  - Invocation: `claude -p "Use the Workflow tool with scriptPath '…/strict-review.mjs'. Report its return value." --allowedTools "Workflow,…" --output-format stream-json | tee` (use `--dangerously-skip-permissions` in CI — **not** `--permission-mode bypassPermissions`, which is silently downgraded to default/auto in a headless run and then blocks the agent's tool calls).

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

- The difficulty-scaled pipeline (holistic → gather [2 web-research agents + memories/docs + static tools] → squad [2 opus-xhigh + N sonnet] → single check/false-positive-filter agent) and the deterministic JS dedup/relevance. (The old separate grade [opus] + verify [sonnet skeptics] passes were folded into the one check agent. Finding-format rules are enforced in the reviewer prompts, not a JS validator pass — the regex validators were removed after they produced false positives that dropped whole reviews.)
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
- **Composite / reusable GHA `uses:` actions do NOT work cross-repo for a private bot on a PERSONAL
  account — CONFIRMED, and the access toggle does NOT save you.** `uses: owner/repo/...@ref` resolves
  at "Set up job" with the consumer's own `GITHUB_TOKEN` (not the App token), so a private action repo
  fails with `Unable to resolve action … not found`. The Actions `access_level` sharing setting is an
  ORG feature: setting a personal repo to `access_level=user` did **not** grant other personal repos
  access (verified — feats still 404'd after the toggle). So the #18 composite only ever worked for
  cc-review reviewing **itself**. Fix (live): both entry workflows clone cc-review at runtime via the
  App token and run `scripts/ci-run.sh` — one clone, DRY, runtime-updated. Going public would also fix
  resolution but leaks the `claude-reviewer/memory` branch (private-repo findings). **For a private
  personal-account bot: runtime-cloned script, never a cross-repo `uses:`.**
- **Key failure-detection on the run ARTIFACT, not a wrapper step's outcome.** `ci-run.sh` decides
  pass/fail from `session.jsonl` ("no final result object" = died mid-run, usually a quota kill) and
  exits non-zero itself — a quota-kill leaves no result object regardless, the robust signal.
  (Historically this also mattered because `steps.<id>.outcome` was unreliable inside the #18 composite.)
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

## RESOLVED — the GitHub App auth (was: "unreachable")

`run 26985091589` failed at **"Generate GitHub App token"** with **`404 Integration not found`**. Root
cause: the `REVIEWER_APP_ID` secret pointed at a **deleted** App's id (written 2026-03-19 from an App
that no longer existed), while the live App `cc-review` (id `3045790`) was never wired in.

The hard-won lesson — **read the error code, it names the failing input:**
- **`404 Integration not found`** = the App-**ID**/Client-ID secret resolves to no App (or no install).
- **`401 A JSON web token could not be decoded`** = the **private key** doesn't match the App.
The key was valid the whole time; chasing a 404 by regenerating the key only spawns orphan keys.

Fix (now the standing config): auth migrated to the App **Client ID** via `create-github-app-token@v3`.
- Secrets: `REVIEWER_APP_CLIENT_ID` = `Iv23li5vyhPbOhwtOGZM`, `REVIEWER_APP_PRIVATE_KEY` <
  `~/.claude/cc-review-app.pem` (the one canonical key). App installed **account-wide** (All repos).
- Verify a key matches an App **locally** (no CI run, no new key): mint a JWT and call `GET /app` —
  snippet in the `add-cc-review` skill's `references/app-recovery.md` (the full recovery runbook).
- A private App is NOT readable via `GET /apps/<slug>` with a user token (404). Read its App ID /
  Client ID / install scope from `github.com/settings/apps/cc-review` — the **Playwright MCP** drives
  that browser flow (its own profile needs a one-time GitHub login; downloads, e.g. a generated key,
  land in `.playwright-mcp/`).
Verified live on PR #38 (first review → APPROVED) and #39 (the bot reviewed its own modernization).

---

## Incident: the interactive self-comment loop (#51)

`cc-review interactive` triggers on `issue_comment` bodies containing `@cc-review`. It had **no
author guard**, and the bot posts status comments from inside its own runs. The failure-path comment
(`ci-run.sh`'s "did not finish") used to say **"Re-run with `@cc-review`"** — so a rate-limited run
posted a comment that re-triggered the workflow, which failed on the same limit and re-posted →
**≥200 runs in ~24 min**, exhausting the org's 5-hour Anthropic quota (overage is org-disabled, so
every request then hard-failed and starved all other Claude usage on the key).

**Kill switch (do this first):** disable the looping workflow in the affected consumer repo —
`gh workflow disable "cc-review interactive" --repo <owner>/<repo>`. Re-enable with `gh workflow
enable` only after the fix is in. (A loop is also visible as a burst of runs: `gh run list --repo
<r> --workflow cc-review-interactive.yml --limit 50`.)

**Root-cause fixes (both shipped):**
- **Author guard** in `cc-review-interactive.yml`: `if: github.event.comment.user.type != 'Bot' && …`.
  The structural fix — bot comments can never trigger the workflow. Lives in the *consumer's* installed
  file, so it must be re-distributed to existing consumers (not runtime-cloned).
- **No trigger token on the failure path**: `ci-run.sh`'s status comment must never contain the literal
  `@cc-review`. This is runtime-cloned, so it breaks the loop on every consumer the moment it's on `main`.

Two layers because they distribute at different speeds: scrubbing the comment stops the loop instantly
everywhere; the author guard is the belt-and-suspenders that doesn't depend on comment hygiene.
