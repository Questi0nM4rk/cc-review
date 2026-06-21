# Lessons learned — building cc-review as a self-contained workflow

Hard-won during the rewrite. Each of these cost a debugging cycle or a CI run to find. Read this before changing the runtime, the input plumbing, or the GitHub Action.

## Runtime & invocation

- **⚡ SUPERSEDED INVOCATION (2026-06-16): the bot drives the brain through an INTERACTIVE `claude`
  session via [coder/agentapi](https://github.com/coder/agentapi), NOT `claude -p`.** Empirically (observed
  5×): `claude -p` (headless/print) bills the **headless/SDK** pool — each review moved the **weekly**
  `/usage` ~3% while the **5-hour** session window didn't budge. Anthropic split interactive vs headless/SDK
  billing (~June 15 2026), so an interactive session draws from the abundant 5-hour bucket. **First cut was
  a hand-rolled tmux driver** (send-keys + bracketed paste + a sentinel file) — it worked locally but is
  reinventing the wheel; **`coder/agentapi` is the purpose-built tool** and replaced it. Fix:
  **`scripts/agentapi-claude.sh`** runs `agentapi server -- claude`, POSTs the prompt, polls `GET /status`
  until `stable` (turn complete — the official signal, no TUI scraping), GETs `/messages` as a best-effort
  log. Correctness is verified against **GitHub ground truth** (review/comment count rose), never by parsing
  the log. `--selftest` is a reachability check (a `bash` stand-in can't reach `stable` — agentapi needs a
  known agent type). **FRESH-RUNNER BOOT (cost ~8 live GHA rounds; RESOLVED — bot is LIVE on CI):**
  `CLAUDE_CODE_OAUTH_TOKEN` (an `sk-ant-oat01` subscription token) **does** authenticate interactive
  `claude` on CI — auth was never the blocker. The blockers were five first-run TUI gates that a logged-in
  dev machine has pre-cleared (so this is **unreproducible locally** — only a real CI dispatch shows it):
  (1) theme picker → seed `hasCompletedOnboarding`, gate on the semantic state not file-absence, merge over
  the installer stub; (2) trust dialog → per-project `hasTrustDialogAccepted` injected at runtime for `$PWD`
  + `--add-dir` paths; (3) auth → the env token (shows as "Claude API"); (4) per-tool prompts → the
  `--dangerously-skip-permissions` FLAG (NOT `--permission-mode bypassPermissions`, silently downgraded; and
  don't set `permissions.defaultMode` — it conflicts with the flag); (5) **"Run a dynamic workflow?" consent
  → nothing suppresses it in interactive mode, so the invoker auto-answers it with `POST "1"`** in its poll
  loop. Seeds live in `ci-claude.json` + `ci-claude-settings.json`. Every entry script uses
  agentapi-claude.sh; **no `claude -p` remains in the project.** ⇒ The notes immediately below about `claude -p`,
  `--allowedTools`, `--output-format stream-json`, and the session.jsonl gate are **HISTORICAL** — the
  `scriptPath`/Workflow-tool facts still hold, but the invocation + the stream-json gate are superseded.

- **Workflows run via the Workflow tool by `scriptPath`** (historically through `claude -p`; now interactive). Empirically verified.
  - `claude -p "/my-workflow"` → **"Unknown command"**. User-invoked slash commands are interactive-only.
  - `Workflow` tool with `name: "my-workflow"` → **"not found"**. Project `.claude/workflows/*.mjs` are NOT auto-registered (only built-ins like `deep-research`, `code-review` are).
  - `Workflow` tool with `scriptPath: "<abs path>"` → **runs and returns**. This is the only headless path.
  - Invocation: `claude -p "Use the Workflow tool with scriptPath '…/strict-review.mjs'. Report its return value." --allowedTools "Workflow,…" --output-format stream-json | tee` (use `--dangerously-skip-permissions` in CI — **not** `--permission-mode bypassPermissions`, which is silently downgraded to default/auto in a headless run and then blocks the agent's tool calls).

## Inputs — the biggest trap

- **Workflow sub-agents do NOT inherit the launching process's environment variables.** A sub-agent's `echo $PR_NUMBER` returns nothing. Symptom: the Fetch agent hallucinated the PR number (used `10` instead of the dispatched `4`) and silently dropped `CC_POST`, so it never posted.
- **`args` do NOT reach the workflow's `args` global** through a `claude -p` prompt-driven Workflow call — `received_args: null` even when the args object is written into the prompt. Do not depend on `args` for CI inputs.
  - **⚡ 2026-06-18 UPDATE — interactive/agentapi DOES pass `args`.** The `received_args: null` was a `claude -p` artifact. Under the current interactive/agentapi invocation the brain DOES receive `args` and relies on it: `args.bot_dir` (absolute bot clone path) and `args.mem_dir` (GitLab-local memory dir, #73) are both read via `normArgs()` in the brain, which also tolerates `args` arriving as a JSON-encoded string. **So:** static, per-run-invariant config rides `args`; per-run runtime values (pr_number, repo, post, ping_override) still arrive via `/tmp/cc-input.json`. Don't be misled by the line above when working the interactive path.
- **Files DO cross the boundary.** Sub-agent bash can read/write `/tmp` (the diff arrived fine via `/tmp/pr-diff.txt`). **So pass all inputs as files.** The GHA writes `/tmp/cc-input.json` (`{pr_number, repo, platform, post}`) in its own bash (the GHA step *does* have the env); the Fetch agent reads that file.

## Sub-agent sandbox

- **The Read/Write/Edit file tools are sandboxed to the repo workspace** (`/home/runner/work/<repo>/<repo>`). A sub-agent **cannot** Write to `/tmp/...`. Write `/tmp` files with **bash**, not the Write tool.
- **(HISTORICAL — interactive + `--dangerously-skip-permissions` no longer passes `--allowedTools`; only the filesystem sandbox below still binds. The dir-precreation + `cat >>` convention is retained because it's harmless and battle-tested.)** The GHA `--allowedTools` Bash allowlist bound sub-agents (even with `--permission-mode bypassPermissions`). `Bash(cat:*)` permitted `cat >`/`cat >>`; `mkdir`, `printf`, `tee` were blocked unless listed — so agents pre-created dirs in the GHA and appended with `cat >>`.

## Model tiers

- **Never put a haiku agent on a data or judgment task.** Haiku fumbled the env/file plumbing (dropped the post flag, invented the PR number). Use **sonnet** for Fetch / recon / memory / post-glue, **opus (+effort)** for triage / domain review / grade.
- **Haiku is only for "a bash script that's too dynamic to write as a script"** — e.g. the literal tool-runner step (`run tsx analysis-tools.ts, return its JSON`).

## Platform (GitHub vs GitLab)

- **GitHub thread replies need the REST `comment_db_id` (`in_reply_to`), NOT the reviewThread node id** (which `resolveReviewThread` uses). Carry both ids per thread; the reply verb takes `--comment-id` for GitHub, `--thread` for GitLab. GitLab uses the discussion id for both, so the bug is invisible until you run GitHub.
- **GitLab silently drops the bracketed `position[...]` form fields (#74).** A POST to `.../discussions` with `-f "position[new_line]=N" -f "position[position_type]=text" …` returns **HTTP 201** but creates a floating `DiscussionNote`, not an inline `DiffNote` — so findings land as floating MR comments and `inline_fallbacks` reports **0** because the POST "succeeded". There is no error to detect, which is why it went unnoticed through every dry-run. Fix: send `position` as a **nested object in a JSON body** (`glab api … -H "Content-Type: application/json" --input -`), then **VERIFY** the created note's `type === "DiffNote"`; on a non-positioned result, DELETE the stray note and fall back to the summary list (so a finding is neither lost nor left floating). The spine principle again — the 201 is a self-report; the `DiffNote` check is ground truth. Lives in `gl.postReview` (`scripts/review-platform.ts`).
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
- **(HISTORICAL — no `--allowedTools` is passed in interactive mode.)** It used to gate Bash to specific commands (`gh/glab/git/tsx/npx/node/cat`); `mkdir/printf/tee` were unavailable, so agents wrote files with `cat` heredoc into pre-created dirs. The `cat`-heredoc-into-pre-created-dirs convention stays (harmless), but the filesystem sandbox — not an allowlist — is the only remaining constraint.
- **Shallow single-branch clone (`-b rewrite`) has no `origin/<other-branch>` tracking refs.** `push_mem` keyed off `origin/claude-reviewer/memory` (absent) → fell to `git checkout --orphan` → collided with the local branch the pre-fetch created → `fatal: a branch named 'claude-reviewer/memory' already exists`, failing every retry — masked by the retry loop's exit 0 (step showed "success", nothing pushed). Fix: `git fetch origin claude-reviewer/memory` then `git checkout -B claude-reviewer/memory FETCH_HEAD`.
- **Memory agent must be handed the actual findings, not just counts.** Given only `confirmed:N`, it fabricated entries inferred from its cwd (wrong branch). Pass the confirmed findings (file:line + description) so `found-issues` records the real issues.
- **gitleaks CLI v8 has no `-q`.** `gitleaks detect ... -q` prints usage and no-ops (the gate silently passes everything). Use `gitleaks detect --source <dir> --no-git --redact --no-banner`; non-zero exit = leaks.
- **Log-branch name must be trigger-independent.** It was `${head.ref}-cc-review-output` on `pull_request` but `pr-N-cc-review-output` on dispatch → the same PR produced two names → cleanup (keyed on head.ref) orphaned the dispatch one. Fix: `pr-<N>-cc-review-output` everywhere, in both `cc-review.yml` and `cc-review-cleanup.yml`.

## Testing the GHA without merging to a consumer's main

- `gh workflow run cc-review.yml --repo <consumer> --ref <branch> -f pr_number=N` runs the workflow **from a branch ref** on real GitHub Actions — full live test (App token, clone, post, memory, log branch) with zero changes to the consumer's `main`. This is how the memory/gitleaks/naming fixes were verified before (and without needing) a merge. The workflow only needs to exist on the default branch to be dispatchable; it then executes the chosen ref's version.
- `run-local.sh` proves the engine but NOT the CI sandbox (no sandbox locally) — `/tmp` writes succeed locally, so memory-write bugs are invisible there. Verify memory only via the `--ref` dispatch + the `claude-reviewer/memory` branch.

## Quota

- The GHA's interactive session and any concurrent local Claude work draw from the **same 5-hour bucket** (one account). Running heavy work in parallel with a CI review can exhaust the session limit mid-run (it did once — the review died in the squad after posting the overview). Sequence runs; stay idle while a GHA review is in flight. (The whole point of the agentapi/interactive switch is to draw the abundant 5h bucket, not the scarce weekly/SDK pool that `claude -p` billed.)

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
- **Failure-detection on GROUND TRUTH, not a self-report.** `ci-run.sh` decides pass/fail from the
  agentapi exit code (`$RUN_RC`: 0 only when the turn reached `stable`) **plus** a GitHub ground-truth
  gate — did the review/comment count on the PR actually rise? A quota-kill / hang leaves the count
  unchanged regardless of what the transcript claims, so the gate is robust to a lying self-report.
  (SUPERSEDED: the old headless era parsed `session.jsonl` for "no final result object" — `session.jsonl`
  is no longer produced or read; the agentapi `stable` exit + ground-truth count is the current signal.)
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

---

## Incident: agentapi `stable` ≠ done — the OR-gate false-pass (#75)

**The trap.** `agentapi`'s `stable` status means the agent is **idle**, not that the review finished. A run that stalled at an unmatched interactive prompt (e.g. a Web-Search approval gate with a non-numeric menu, which the invoker's numbered-menu filter correctly skipped) went idle and reached `stable` with no review posted. The old post-run gate was an OR: pass if the **review count** rose OR the **comment count** rose. Because the overview comment is posted at the start of the pipeline (before the verdict), comment count always rose on a stalled run — so the gate accepted it with zero formal review posted. The run reported success; GitHub had only an overview comment and no verdict.

**Three-leg fix (all three must hold):**
1. **Opt-in done-marker gating on `stable`.** `ci-run.sh` passes `--done-marker '<<<CC_REVIEW_COMPLETE>>>'` to `agentapi-claude.sh`. The invoker treats `stable` as done ONLY after that exact string has appeared in the conversation — a stalled run never emits it. Backfill and local callers omit the flag and keep the legacy bare-`stable` behaviour. Auto-approval requires a real numbered selection menu (a locale-safe `^\s*[0-9][.)]` line), capped at `AGENTAPI_MAX_APPROVALS` (default 40, a runaway backstop), so prose quoting the phrase no longer misfires.
2. **Written completion sentinel.** The review prompt instructs the orchestrator to write the brain's return JSON to `.cc-run/cc-result.json` immediately after the Workflow returns, then print `<<<CC_REVIEW_COMPLETE>>>`. The sentinel is proof the Workflow actually returned; its absence means the run ended before the brain finished regardless of what `stable` reported.
3. **Mode-aware gate in `scripts/gate.mjs`.** The post-run verdict is delegated to this pure module: a normal review (`first`/`rerun`) must raise the **formal review count** (a `POST /pulls/N/reviews` — an overview comment is not a review); `answer`/`rerun-blocked` accept comment growth; a missing sentinel fails even on `stable`; an unknown mode passes through (forward-compatible). The OR-gate is gone — overview comment alone never passes.

---

## Incident: `--dangerously-skip-permissions` refused under root — CI stalls (#75, root cause)

**The trap.** "The `--dangerously-skip-permissions` flag silences per-tool prompts on the CI runner" is FALSE. On a root CI runner, bypass-permissions mode is blocked by **THREE independent gates** — peeling one reveals the next, so each fix looks complete until the next live run. All verified against the claude 2.1.x binary (`~/.local/share/claude/versions/2.1.185`); the symptom each time is the per-command `"Do you want to proceed?"` storm → auto-approver can't keep up → 40-min agentapi timeout, marker never emitted. (The #75 completion gate correctly red-failed every stalled run — no false-green; that part works.)

1. **Root refusal.** Binary: `if (uid===0 && IS_SANDBOX!=="1" && !CLAUDE_CODE_BUBBLEWRAP) → "cannot be used with root/sudo privileges" → exit`. GitHub Actions runs as root. **Fixed:** `ci-run.sh` exports `IS_SANDBOX=1` (the CI entry point asserts the isolated-runner sandbox — NOT inferred from uid in the shared invoker, so a stray root call doesn't auto-bypass). After this, claude runs but still prompts.

2. **Disabled-by-settings (the real blocker).** Even running, claude shows `"Bypass permissions mode was disabled by settings"` (transcript line 995, run `27918717499`). Binary: `permissions.disableBypassPermissionsMode: enum(["disable"])` → "Cannot set permission mode to bypassPermissions because it is disabled by settings or configuration". Web-confirmed: admins disable bypass via **managed settings**, and **`permissions.defaultMode:"bypassPermissions"` from settings files is silently ignored in CI/cloud contexts** — so seeding `defaultMode` does NOT fix it (don't try it). The exact disabling source on the runner is unpinpointed (not in the consumer's `.claude/settings.json` nor the seed `ci-claude-settings.json` — likely a managed-settings layer / claude CI default; `AGENTAPI_DIAG=1` dumps it).

3. **"Run a dynamic workflow?" consent.** Separate one-time gate; auto-answered `1`.

**The fix for gate 2 (chosen, in progress): AUTO MODE, not bypass.** The interactive menu always offers `3. Yes, and switch to auto mode · workflows run best with it on` — Anthropic's [auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode), a separate mechanism NOT blocked by `disableBypassPermissionsMode` (the option is present in the menu → available). Switch the auto-approver to send `3` (auto mode) once on a `"Do you want to proceed?"` prompt instead of `1` (Yes-once, which re-prompts every command). Keep `1` for the dynamic-workflow consent.

**Meta-lesson:** a permission "fix" verified only against the binary's *first* gate (or only on a non-root dev machine, where every gate is pre-cleared) looks done but isn't — the runner has its own settings/managed layer. Reproduce on the actual root runner (or `AGENTAPI_DIAG=1`) before claiming a permission fix works. Each live re-test burns ~40 min of the shared 5-hour quota; research the exact binary/error string before iterating.

**Also shipped with #75:** the brain now post-verifies after posting: runs the deterministic `verify-posted` adapter verb (counts the bot's reviews + inline comments whose `commit_id` equals the reviewed head SHA — run-scoped, not fooled by a prior run's review on the same PR) and retries the post up to 3× before failing red at `gate.mjs` + status comment.
