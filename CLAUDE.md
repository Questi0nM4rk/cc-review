# CLAUDE.md — cc-review (agent notes)

A PR/MR review bot powered by Claude Code. The "brain" is one self-contained Workflow
script that a consumer repo's GitHub Action clones at runtime and drives through an
**interactive `claude` session via coder/agentapi** (`scripts/agentapi-claude.sh`) — **NOT `claude -p`**
(empirically `-p` bills the scarce weekly/SDK pool ~3%/run; an interactive session draws
the abundant 5-hour bucket — SPEC §2). Read `SPEC.md` for the full design; this file is
what an agent needs to *work on it* — the load-bearing constraints, the branch model,
how to test, and the open TODOs.

## Layout

- `.claude/workflows/strict-review.mjs` — the brain: the entire review pipeline as one Workflow script (phases below).
- `.claude/workflows/backfill-memory.mjs` — learning-loop Phase 3 cold-start primer (sibling Workflow). On a repo's **first-ever** review, harvests the last N merged PRs (one agent each) and synthesizes **additive** priors (conventions, recurring-issue themes, culture notes) into the memory slice. **Additive-only** — never writes `known-patterns.md` / suppression rules (a wrong suppression silences true findings). Sentinel-gated by `.cc-memory/.backfilled`; `ci-run.sh` invokes it before the review.
- `scripts/review-platform.ts` — platform adapter: `detect | context | threads | get-overview | post-overview | edit-overview | post-review | resolve | reply` (GitHub via `gh`, GitLab local).
- `scripts/analysis-tools.ts` — gather-phase deterministic runner: semgrep/lizard signals, plus it surfaces `outcomes.jsonl` (Phase-2 calibration) and the file-keyed `priorSignals` (misses/found-issues matched against the changed files — the recall lever) so neither is laundered through an LLM.
- `scripts/agentapi-claude.sh` — **the invoker**: drives the brain through an INTERACTIVE `claude` session via [coder/agentapi](https://github.com/coder/agentapi) (5-hour bucket) instead of `claude -p` (weekly/SDK pool). Runs `agentapi server -- claude`, POSTs the prompt, polls `GET /status` until `stable` (turn complete — the official signal, no TUI scraping), GETs `/messages` (best-effort log; correctness is GitHub ground truth). Self-installs the agentapi binary. On a **fresh CI runner** it clears every first-run gate so interactive claude boots headlessly (see "Interactive claude on CI" below): seeds onboarding+trust state (`ci-claude.json`) and behaviour settings (`ci-claude-settings.json`) when claude isn't already onboarded, then in the completion loop **auto-approves the one "Run a dynamic workflow?" consent** by POSTing `1` (nothing in interactive mode suppresses that gate). Auth rides on the `CLAUDE_CODE_OAUTH_TOKEN` env secret. On the not-ready failure it captures the stuck screen to `--out` (self-diagnosing). `--selftest` = reachability check (bash stand-in, no quota). `AGENTAPI_DIAG=1` re-enables a one-shot config dump. **`--done-marker STRING` (opt-in):** `stable` counts as done ONLY when that marker has appeared in the conversation — callers that pass it (i.e. the `ci-run.sh` review call) require the marker before declaring completion; callers without it (backfill, selftest, local) keep the bare-`stable` behaviour. Auto-approval is scoped to real numbered selection menus and capped by `AGENTAPI_MAX_APPROVALS` (default 12, was a hardcoded 40), avoiding spurious approvals on other interactive prompts (#75). Used by every entry script.
- `scripts/ci-claude.json` — sanitized Claude Code **state** seed (`hasCompletedOnboarding`, dark theme, hint/migration suppressors). The invoker merges it into `$HOME/.claude.json` on an un-onboarded runner and jq-injects per-project `hasTrustDialogAccepted` for `$PWD` + each `--add-dir` path. **No secrets/PII** — auth is the env token, never a committed credential.
- `scripts/ci-claude-settings.json` — sanitized **settings** seed (`skipAutoPermissionPrompt`, `skipWorkflowUsageWarning`). Merged into `$HOME/.claude/settings.json`. Deliberately does NOT set `permissions.defaultMode` — it conflicts with the `--dangerously-skip-permissions` flag the entry scripts pass (which is what actually silences per-tool prompts; `--permission-mode bypassPermissions` does NOT engage on CI).
- `scripts/run-local.sh` — local DRY-RUN harness (lays down `/tmp` scaffolding, drives the brain via `agentapi-claude.sh`, `post=false` always — never touches a real PR/MR).
- `scripts/ci-run.sh` — the **GitHub** CI pipeline (prefetch → install → **interactive claude via `agentapi-claude.sh`** → push log+memory). Completion = agentapi `stable` gated on the `<<<CC_REVIEW_COMPLETE>>>` done-marker + the brain having written its return JSON to `.cc-run/cc-result.json` (the completion sentinel). The post-run gate lives in `scripts/gate.mjs` and is **mode-aware**: a normal review (`first`/`rerun`) must raise the **formal review count**; `answer`/`rerun-blocked` accept comment growth; a missing or `ok:false` sentinel fails the run even on `stable`; an overview comment alone never passes (#75). Consumer workflows clone cc-review at runtime (App token) and run this; replaces the #18 composite action, which can't be referenced cross-repo from a private repo on a personal account.
- `scripts/memory-slice.sh` — shared `fetch_slice`/`push_slice` for the `claude-reviewer/memory` branch slice. Sourced by **both** `ci-run.sh` and `cc-review-cleanup.yml`'s harvest step, so the review pipeline and the Phase-1 harvest read/write the slice identically (one impl, no drift).
- `scripts/harvest-outcomes.mjs` — learning-loop Phase 1 + 4. On PR **merge** (a `cc-review-cleanup.yml` job, `merged==true`-gated): **(1)** classifies each posted finding's fate **deterministically** against GitHub ground truth (thread state + `isOutdated`) → appends `learnings/outcomes.jsonl` (`fixed/dismissed/ignored/open-but-acted/gone`; idempotent by `id+pr`; 180-day window); **(2)** Phase 4 miss-capture — a fix/revert PR touching a file an earlier PR was reviewed **clean** on → `learnings/misses.jsonl` (the recall signal). No LLM reads comment text. Plain Node ESM (a runner step, not a sandboxed agent), unit-tested via `harvest-outcomes.test.mjs`.
- `scripts/memory-maintenance.mjs` — periodic DETERMINISTIC memory-branch maintenance (a runner step, **zero Claude quota**). Prunes old `pr-<N>/` dirs beyond a retention cap (the unbounded-growth leak — they're never deleted on PR close), trims the jsonl logs to their window, writes a `MAINTENANCE.md` health report (per-slice verdict tallies + ⚠ for domains trending to silence / unread miss candidates). **Dry-run by default; `--apply` writes.** Skips the `_global/` layer (not a slice). Unit + e2e tested via `memory-maintenance.test.mjs`.
- `scripts/run-gitlab.sh` — the **GitLab** entry point: run a real MR review **locally** and post via `glab` (your creds; no App, no CI, no branch pushes). Refuses to run on a GitHub repo (that's the CI path). This is the platform split: GitHub = CI/App, GitLab = local. Local review memory lives **out of the product repo**, at `~/.claude/cc-review-memory/<repo-slug>/` (injected via `args.mem_dir`, writable via `--add-dir`; never the CI memory branch — local and CI never cross).
- `scripts/gate.mjs` — the post-run completion gate decision (pure, env-driven CLI). `ci-run.sh` delegates the verdict here: reads the `.cc-run/cc-result.json` sentinel + before/after GitHub counts, returns a failure reason or passes. Mode-aware (#75). Unit-tested in `scripts/gate.test.mjs`.
- `scripts/verify-gate.test.mjs` — contract spec for the fetch identity gate (`node scripts/verify-gate.test.mjs`).
- `lang-refs/` — per-language checklists reviewers pull with `cat`.
- `.github/workflows/cc-review*.yml` — the GHA templates installed into consumer repos (review, interactive ping, cleanup). **Exception: `cc-review-memory-maintenance.yml` runs IN cc-review** (the memory branch lives here, so one job maintains every slice) — scheduled deterministic cleanup (no quota) + opt-in cross-repo `_global/` consolidation (one agent, `consolidate=true`, spends quota).
- **Cross-repo `_global/` additive layer** — `_global/learnings/{lessons,watch-patterns}.md` on the memory branch, read by EVERY review (staged read-only into `.cc-global/` via `fetch_global`, never under `.cc-memory` so `push_slice` can't pollute a repo slice) so a lesson from repo A informs repo B. **Additive-only, never a global suppression** (one wrong suppression silences true findings in every repo). Written only by the maintenance job's consolidation pass.
- `SPEC.md` / `README.md` — at the repo root (spec + human guide).
- `docs/` — `overview-diagram-standard.md` (render-verified mermaid standard), `pipeline-diagram.html` (engine-internals viewer), `lessons-learned.md`, `github-review-api.md`, `learning-loop-plan.md` (honest assessment of the memory + the executable plan to make it actually learn — read before touching memory/gather; tracking #54/#24).

## Branch model — IMPORTANT

- Consumers' GHA clones cc-review with `git clone --depth 1` (the **default branch `main` is the live brain**) — push brain changes to `main`; consumers pick them up on the next run.
- The shallow single-branch clone means **there are no `origin/<other-branch>` tracking refs in CI** — fetch explicitly and use `FETCH_HEAD`.

## Pipeline (strict-review.mjs) — see SPEC.md for the exact contract

Two entry paths, decided by whether **our overview comment** (marker `<!-- cc-review:overview -->`) exists on the PR:

- **First review** (marker absent): **Fetch** → **Holistic review** (opus·medium, sonnet on doc-only PRs; reads the diff, emits overview + difficulty + `answer`-intent; **posts the overview first**) → **Gather** (2 web-backed research agents — ai-slop / general, via `WebSearch`/`WebFetch` — + memories/docs + haiku tool-runner; gated d≥2, web research also skipped on small non-risky diffs; the haiku tool-runner also reads `outcomes.jsonl` **deterministically** — not via the memDocs synthesis agent — → per-domain **calibration** (Phase 2): Laplace-smoothed, min-sample-gated, asymmetric+floored, `dismissed` denominator-only, injected into `projectContext` → squad + check; AND emits **prior file-keyed signals** — changed files in `misses.jsonl`/`found-issues.md` become scrutiny-raising **routed observations** (`domainForFile` routing), the **recall lever**, additive-only) → **Squad** (difficulty-scaled) → **Dedup + Check** (JS dedup + **one** opus false-positive-filter agent) → **Decide** → **Post** (gated; one merged agent stamps the per-PR review-state marker + appends `pr-<N>/findings.jsonl`, one row per posted inline finding, each carrying a hidden `<!-- cc-review:finding <id> -->` marker — learning-loop Phase 0) → **Memory**.
- **Re-run** (marker present): **Fetch** → prior threads **all replied?** (no & auto-run → post `first finish prev review`, stop; ping → override) → **Comment-mgmt** (resolve/reply/keep + update memories) → **significant-change check** (JS prefilter + agent confirm) → the **squad re-reviews either way**; if significant it also re-runs gather + redraws the overview **in place**, else it reviews research-less and leaves the overview untouched.

### Agent ladder (`PATH` table) — opus anchor always xhigh, scale by ADDING reviewers
- d1: 1 opus (no gather, no check) · d2: 1 opus + 1 sonnet · d3: 2 opus · d4: 2 opus + 1 sonnet · d5: 2 opus + 2 sonnet
- gather ≥ d2, dedup+check ≥ d2. **The old separate Grade (opus) + Verify (sonnet skeptics) passes are GONE — folded into the one check agent.**
- **Model-by-feature:** `LOW_STAKES_CATEGORY` (docs/chore) runs the opus slots on sonnet.
- The squad gets the (minimized + sanitized) overview AND the gather observations; `pickSquad` ranks domains by relevance.
- New findings are **deduped against existing open threads** (`dropAlreadyThreaded`) so a re-run never double-posts.
- Comment-mgmt validates the author's reply **against the code first**, then resolves with a `Fixed:`/`Dismissed:` message, replies if still wrong, or keeps; intentional dismissals become `known_patterns` → memory.

## Hard CI constraints (each cost a debugging cycle — see lessons-learned)

1. **The review agent writes under `$GITHUB_WORKSPACE`, not `/tmp`** — a convention proven in the headless era and **retained across the interactive/agentapi switch** (robust regardless of the exact sandbox). Anything an agent must WRITE goes under the workspace. Memory → `$GITHUB_WORKSPACE/.cc-memory` (the runner pre-fetch stages it; push step reads it). Reads from `/tmp` are fine (inputs live there).
2. **The brain's prompts write files with `cat` heredoc into pre-created dirs** — also a retained convention (the old `--allowedTools` Bash allowlist is no longer passed in interactive mode, so `mkdir/printf/tee` would work now, but cat-heredoc + pre-created dirs stays — harmless and battle-tested). Directories are pre-created by a runner step.
3. **Shallow single-branch clone** → no `origin/<branch>` refs → `git fetch origin <branch>` then key off `FETCH_HEAD` (e.g. memory push: `git checkout -B claude-reviewer/memory FETCH_HEAD`).
4. **Sub-agents don't inherit env vars** → inputs arrive via `/tmp/cc-input.json` (GHA writes it; agent reads it).

## Memory

- Branch `claude-reviewer/memory` **in this repo**, per-consumer slices `<owner>/<repo>/` → `MEMORY.md` + `learnings/{found-issues,lessons,known-patterns,decisions}.md`.
- The memory agent receives the **actual confirmed findings** (not just counts) so `found-issues` records real issues; it only runs when there's something to record.
- It **curates** rather than appends blindly: it reads each file first and either appends a new entry or **rewrites it consolidated** (`cat >`) — merging near-duplicates, folding per-run status into standing themes, dropping stale entries (~25-bullet cap) — but never drops a still-valid `known_pattern`. Memory is load-bearing: it's read back into every review.
- Survives PR close (cleanup deletes only the log branch).

## Log branches

- `pr-<N>-cc-review-output` in the **consumer** repo — stable name on every trigger (was head-ref-named on `pull_request` but `pr-N` on dispatch → cleanup orphaned one).
- Deleted on PR close by `cc-review-cleanup.yml` (matches `pr-<N>`).
- **gitleaks gate** scans the run output before pushing the log branch (the step git-inits in `/tmp`, bypassing the repo's `hooks/pre-commit`); skips the push on a hit.

## Triggers

`.cc-review.yaml` `trigger:` — `pr_open` (**default**: on open/reopen; the `@cc-review` ping always works; NOT every push), `every_push`, `disabled`. Per-project, user-set.

## Testing

- **Local engine:** `scripts/run-local.sh [--diff FILE | --pr N --repo O/R | --base REF | --staged]` (always `post=false`).
- **Live, WITHOUT merging a consumer's main:** `gh workflow run cc-review.yml --repo <consumer> --ref <branch> -f pr_number=N` — runs the workflow *from a branch* on real Actions. This is how GHA changes get verified before merge.
- **Memory write** can't be reproduced locally (no sandbox locally) — verify it via the `--ref` dispatch and check the `claude-reviewer/memory` branch.
- **Syntax:** the brain uses top-level `return` (the Workflow runtime wraps the body), so `node --check` rejects it raw — wrap in `async function __wf(){ … }` first, then `node --check`.

## State of the world (2026-06-18) — bot is LIVE on CI via interactive claude (agentapi)

The rebuild to `SPEC.md` is **complete and live on `main`** (the shipped brain == the target spec).
The post-rebuild audit (tracking issue **#24**) was worked end-to-end. `SPEC.md` is the exact
source of truth and matches the code (§15 OPEN decisions resolved → "Settled defaults").

### ✅ RESOLVED — interactive claude on CI (the five gates), bot LIVE

The invoker moved off `claude -p` (weekly pool) to **coder/agentapi driving interactive `claude`** (5-hour
bucket) — first a hand-rolled tmux driver (#62, broke on GHA), then `coder/agentapi` (#63). Getting
interactive claude to run **headlessly on a fresh GitHub runner** meant clearing five first-run gates that
`claude -p` never had (official actions are headless, so this path was undocumented — each gate cost a CI
round, and the last is **unreproducible on a logged-in dev machine** where every gate is pre-cleared):
1. **onboarding/theme** → seed `hasCompletedOnboarding` (`ci-claude.json`), gate on the SEMANTIC state not file-absence (the installer leaves a stub), merge over it (#64, #65).
2. **trust dialog** → per-project `hasTrustDialogAccepted` injected at runtime for `$PWD` + `--add-dir` paths (#64).
3. **auth** → `CLAUDE_CODE_OAUTH_TOKEN` (an `sk-ant-oat01` subscription token in the `add-cc-review` skill's `.secrets.env`); shows as "Claude API" (token-auth label, not an API key — billing premise holds). Never the real blocker.
4. **per-tool prompts** → the `--dangerously-skip-permissions` FLAG silences them on the runner; `--permission-mode bypassPermissions` does NOT engage (#68 wrong → #69 reverted). Do not set `permissions.defaultMode` in settings (conflicts with the flag).
5. **"Run a dynamic workflow?" consent** → the real wall; NO settings/flag suppresses it in interactive mode (only `claude -p`/SDK skip it). The invoker **auto-answers it** (`POST "1"`) in its poll loop (#70).

Verified live: consumer **shell-ast #3** got a real `<!-- cc-review:overview -->` review, run = success
(ground-truth gate passed). The verdict stays deterministic — auto-approve only clears the launch gate;
correctness is still GitHub ground truth, never the parsed transcript.

### ✅ RESOLVED (earlier) — the GitHub App auth is fixed

Root cause of the long-standing failure (`run 26985091589` → `404 Integration not found`): the
`REVIEWER_APP_ID` secret pointed at a **deleted** App's id, so `actions/create-github-app-token`
couldn't resolve an integration. A `404` is an *App-ID* error — the private key was valid the whole
time (a bad key gives `401`). Fixed by migrating auth to the App **Client ID**:
- App `cc-review` — App ID `3045790`, Client ID `Iv23li5vyhPbOhwtOGZM`, installed **account-wide**
  (All repositories) on `Questi0nM4rk`; one canonical key at `~/.claude/cc-review-app.pem`.
- Secrets are now `CLAUDE_CODE_OAUTH_TOKEN`, **`REVIEWER_APP_CLIENT_ID`**, `REVIEWER_APP_PRIVATE_KEY`.
- The token step is `actions/create-github-app-token@v3` with the `client-id` input (v3 deprecates
  `app-id`).
Verified live: PR **#38** (first review → **APPROVED**) and **#39** (the modernization PR, reviewed by
the bot itself). Recovery runbook: the tail of `docs/lessons-learned.md` + the `add-cc-review` skill's
`references/app-recovery.md`.

### Closed this session (14 issues, one PR each → squash-merged to `main`)

#7 gitleaks gate · #8 research-cache cut (→ tiny `pr-<N>/review-state.json` marker only) · #9+#13+#16
completion/idempotency contract · #10 prompt-injection (data/instruction **fence**, not phrase
regexes) · #12 edge-case diffs + non-ASCII `core.quotepath` fix · #14 deterministic difficulty floor ·
#15 unit tests + CI + brain syntax gate (the repo now has CI: `.github/workflows/ci.yml`, 57 tests in
`scripts/helpers.test.mjs`) · #17 configurable sig-change thresholds · #19 overview-state fallback (reuses
the marker) · #20 self-curating memory (consolidate, don't append) · #21 (code-side: setup deploys the
cleanup workflow + stale refs fixed) · #22 README quickstart+sample · #23 SPEC §15 resolved.
Also fixed: two invisible control-byte corruptions in the brain (sanitizeContext / globToRe).

### GitLab path landed + tracker hygiene (2026-06-18)

The GitLab-local path was exercised end-to-end this session; two issues' worth of work merged to `main`,
two stale issues closed:
- **#74 — GitLab inline positioning (merged `90327e2`).** GitLab silently drops the bracketed
  `position[...]` form (POST 201 → a floating `DiscussionNote`, not an inline `DiffNote`) — a silent
  failure (`inline_fallbacks=0`, no error to detect). `gl.postReview` now sends `position` as a nested
  JSON body via `--input -`, verifies the created note is a `DiffNote`, and on a non-positioned result
  deletes the stray note and falls back to the summary list. GitLab-only path (never runs in CI) → no
  GitHub-consumer risk. **Live non-dry-run verify still pending** (the core AC).
- **#73 — per-env config + local-memory relocation (merged `9b33048`).** The brain reads `MEM` from
  `args.mem_dir` (default `.cc-memory` → **GitHub CI unchanged**); `analysis-tools.ts` gained a matching
  `--mem-dir`; `run-gitlab.sh` puts local memory at `~/.claude/cc-review-memory/<repo-slug>/` (out of the
  product repo, via `--add-dir`). Only `mem_dir` actually leaked into the brain — the other env knobs were
  already runner-layer-separated (`ci-run.sh` does slice fetch/push + `_global/`, `run-gitlab.sh` doesn't;
  `post` rides `cc-input.json`), documented in SPEC §7. Also fixed two latent path bugs (a hardcoded
  `.cc-memory` in the fetch prompt + a `./${MEM}` prefix that breaks an absolute path). Verified: brain
  syntax gate + 125 helper tests green.
- **Closed as already-done:** **#18** (composite reverted → runtime-clone; dedup achieved via `ci-run.sh`,
  which both entry workflows delegate to) and **#54** (learning-loop v1 shipped across Phases 0–4; only
  drift-monitoring deferred — see `docs/learning-loop-plan.md`).

### Open / outstanding

- **#21 — clean install (live):** code-side done; still needs a fresh install on a throwaway repo →
  real review, end-to-end, following only `scripts/` + README.
- **#11 / #74 / #73 — GitLab mode (live verify pending).** The entry point exists (`scripts/run-gitlab.sh`)
  and the review **engine** ran end-to-end live this session (holistic → gather → squad → check →
  `REQUEST_CHANGES`, the check pass refuted a false-positive). The inline-positioning bug it surfaced is
  **fixed** (#74 — the former `review-platform.ts:250` risk, now nested-JSON `position` + `DiffNote`
  verify) and local memory moved out of the product repo (#73). **Still needs one full non-dry-run run**
  against a real MR with `glab` authed (e.g. a self-hosted GitLab instance over VPN, throwaway MR): confirm
  post-overview / inline `DiffNote`s (0 floating) / resolve / reply / edit-overview-in-place. #74 + #73
  stay open until that run; #11 is the umbrella.
- Minor: old stray branch `claude/add-review-logging-xcGnC`; the `pr-12-cc-review-output` orphan log branch.

### Reference

- `docs/overview-diagram-standard.md` is render-verified (mermaid v11); `docs/pipeline-diagram.html` is
  the engine-internals viewer. `docs/lessons-learned.md` has the CI constraints + this session's traps.
- Memory branch `claude-reviewer/memory` is live and useful (read into every review); test-repo
  research leftovers were pruned this session.
