# CLAUDE.md — cc-review (agent notes)

A PR/MR review bot powered by Claude Code. The "brain" is one self-contained Workflow
script that a consumer repo's GitHub Action clones at runtime and runs headless via
`claude -p`. Read `SPEC.md` for the full design; this file is what an agent needs to
*work on it* — the load-bearing constraints, the branch model, how to test, and the
open TODOs.

## Layout

- `.claude/workflows/strict-review.mjs` — the brain: the entire review pipeline as one Workflow script (phases below).
- `.claude/workflows/backfill-memory.mjs` — learning-loop Phase 3 cold-start primer (sibling Workflow). On a repo's **first-ever** review, harvests the last N merged PRs (one agent each) and synthesizes **additive** priors (conventions, recurring-issue themes, culture notes) into the memory slice. **Additive-only** — never writes `known-patterns.md` / suppression rules (a wrong suppression silences true findings). Sentinel-gated by `.cc-memory/.backfilled`; `ci-run.sh` invokes it before the review.
- `scripts/review-platform.ts` — platform adapter: `detect | context | threads | get-overview | post-overview | edit-overview | post-review | resolve | reply` (GitHub via `gh`, GitLab local).
- `scripts/analysis-tools.ts` — semgrep/lizard runner used by the gather phase.
- `scripts/run-local.sh` — local DRY-RUN harness (lays down `/tmp` scaffolding, runs the brain via `claude -p`, `post=false` always — never touches a real PR/MR).
- `scripts/ci-run.sh` — the **GitHub** CI pipeline (prefetch → install → `claude -p` → push log+memory). Consumer workflows clone cc-review at runtime (App token) and run this; replaces the #18 composite action, which can't be referenced cross-repo from a private repo on a personal account.
- `scripts/memory-slice.sh` — shared `fetch_slice`/`push_slice` for the `claude-reviewer/memory` branch slice. Sourced by **both** `ci-run.sh` and `cc-review-cleanup.yml`'s harvest step, so the review pipeline and the Phase-1 harvest read/write the slice identically (one impl, no drift).
- `scripts/harvest-outcomes.mjs` — learning-loop Phase 1. On PR **merge** (a `cc-review-cleanup.yml` job, `merged==true`-gated), classifies each posted finding's fate **deterministically** against GitHub ground truth (thread state + `isOutdated`) → appends `learnings/outcomes.jsonl` (`fixed/dismissed/ignored/open-but-acted/gone`; idempotent by `id+pr`; 180-day window). No LLM reads comment text. Plain Node ESM (a runner step, not a sandboxed agent), unit-tested via `harvest-outcomes.test.mjs`.
- `scripts/run-gitlab.sh` — the **GitLab** entry point: run a real MR review **locally** and post via `glab` (your creds; no App, no CI, no branch pushes). Refuses to run on a GitHub repo (that's the CI path). This is the platform split: GitHub = CI/App, GitLab = local.
- `scripts/verify-gate.test.mjs` — contract spec for the fetch identity gate (`node scripts/verify-gate.test.mjs`).
- `lang-refs/` — per-language checklists reviewers pull with `cat`.
- `.github/workflows/cc-review*.yml` — the GHA templates installed into consumer repos (review, interactive ping, cleanup).
- `SPEC.md` / `README.md` — at the repo root (spec + human guide).
- `docs/` — `overview-diagram-standard.md` (render-verified mermaid standard), `pipeline-diagram.html` (engine-internals viewer), `lessons-learned.md`, `github-review-api.md`, `learning-loop-plan.md` (honest assessment of the memory + the executable plan to make it actually learn — read before touching memory/gather; tracking #54/#24).

## Branch model — IMPORTANT

- Consumers' GHA clones cc-review with `git clone --depth 1` (the **default branch `main` is the live brain**) — push brain changes to `main`; consumers pick them up on the next run.
- The shallow single-branch clone means **there are no `origin/<other-branch>` tracking refs in CI** — fetch explicitly and use `FETCH_HEAD`.

## Pipeline (strict-review.mjs) — see SPEC.md for the exact contract

Two entry paths, decided by whether **our overview comment** (marker `<!-- cc-review:overview -->`) exists on the PR:

- **First review** (marker absent): **Fetch** → **Holistic review** (opus·medium; reads the diff, emits overview + difficulty + `answer`-intent; **posts the overview first**) → **Gather** (2 web-backed research agents — ai-slop / general, via `WebSearch`/`WebFetch` — + memories/docs + haiku tool-runner; gated d≥2) → **Squad** (difficulty-scaled) → **Dedup + Check** (JS dedup + **one** opus false-positive-filter agent) → **Decide** → **Post** (gated; stamps the per-PR review-state marker + appends `pr-<N>/findings.jsonl`, one row per posted inline finding, each carrying a hidden `<!-- cc-review:finding <id> -->` marker — learning-loop Phase 0) → **Memory**.
- **Re-run** (marker present): **Fetch** → prior threads **all replied?** (no & auto-run → post `first finish prev review`, stop; ping → override) → **Comment-mgmt** (resolve/reply/keep + update memories) → **significant-change check** (JS prefilter + agent confirm) → the **squad re-reviews either way**; if significant it also re-runs gather + redraws the overview **in place**, else it reviews research-less and leaves the overview untouched.

### Agent ladder (`PATH` table) — opus anchor always xhigh, scale by ADDING reviewers
- d1: 1 opus (no gather, no check) · d2: 1 opus + 1 sonnet · d3: 2 opus · d4: 2 opus + 1 sonnet · d5: 2 opus + 2 sonnet
- gather ≥ d2, dedup+check ≥ d2. **The old separate Grade (opus) + Verify (sonnet skeptics) passes are GONE — folded into the one check agent.**
- **Model-by-feature:** `LOW_STAKES_CATEGORY` (docs/chore) runs the opus slots on sonnet.
- The squad gets the (minimized + sanitized) overview AND the gather observations; `pickSquad` ranks domains by relevance.
- New findings are **deduped against existing open threads** (`dropAlreadyThreaded`) so a re-run never double-posts.
- Comment-mgmt validates the author's reply **against the code first**, then resolves with a `Fixed:`/`Dismissed:` message, replies if still wrong, or keeps; intentional dismissals become `known_patterns` → memory.

## Hard CI constraints (each cost a debugging cycle — see lessons-learned)

1. **GHA `claude -p` sub-agents are filesystem-sandboxed to `$GITHUB_WORKSPACE`** — `/tmp` *writes* are blocked (the agent reports an explicit sandbox error or silently fails). Reads from `/tmp` are fine. Anything an agent must WRITE goes under the workspace. Memory → `$GITHUB_WORKSPACE/.cc-memory` (GHA pre-fetch stages it; push step reads it).
2. **`--allowedTools` restricts Bash** to `gh/glab/git/tsx/npx/node/cat`. Agents write files with `cat` heredoc only — no `mkdir/printf/tee`. Directories must be pre-created by a GHA step.
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

## State of the world (2026-06-05) — rebuild done, audit cleanup done, App auth FIXED + actions modernized

The rebuild to `SPEC.md` is **complete and live on `main`** (the shipped brain == the target spec).
The post-rebuild audit (tracking issue **#24**) was then worked end-to-end. `SPEC.md` is the exact
source of truth and now matches the code (§15 OPEN decisions resolved → "Settled defaults").

### ✅ RESOLVED — the GitHub App auth is fixed; the bot is LIVE

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

### Open / outstanding

- **#18 — composite action: REVERTED → runtime-cloned `scripts/ci-run.sh`.** The composite
  (`uses: …/cc-review-run@main`) could NOT be referenced cross-repo from a **private** repo on a
  **personal** account — `uses:` resolves at "Set up job" with the consumer's own `GITHUB_TOKEN`,
  which can't read the private bot repo (the `access_level` sharing setting is org-only; setting it
  to `user` did not help). It only ever worked for cc-review reviewing **itself** (same repo). Now
  both entry workflows clone cc-review at runtime via the **App token** (which CAN read the private
  repo) and run `scripts/ci-run.sh` — leaner (one clone, not uses-fetch + clone), still DRY +
  runtime-updated. Verified live on cc-review (#40) and consumer `feats`.
- **#21 — clean install (live):** code-side done; still needs a fresh install on a throwaway repo →
  real review, end-to-end, following only `scripts/` + README.
- **#11 — GitLab mode (live):** the entry point now EXISTS — `scripts/run-gitlab.sh` (detect→gitlab gate,
  fetch the MR via `glab`, run the brain with `post:true`, post via the `gl.*` adapter; no branch pushes;
  refuses on a GitHub repo). Plumbing + the github-refusal gate are verified locally. **Still needs one
  live run** against a real MR with `glab` authed (e.g. a self-hosted GitLab instance over VPN, on a throwaway MR):
  confirm post-overview / positioned inline findings / resolve / reply / edit-overview. The known risk is
  `gl.postReview` inline-comment positioning (needs the MR `diff_refs`) — flagged at review-platform.ts:250.
- Minor: old stray branch `claude/add-review-logging-xcGnC`; the `pr-12-cc-review-output` orphan log branch.

### Reference

- `docs/overview-diagram-standard.md` is render-verified (mermaid v11); `docs/pipeline-diagram.html` is
  the engine-internals viewer. `docs/lessons-learned.md` has the CI constraints + this session's traps.
- Memory branch `claude-reviewer/memory` is live and useful (read into every review); test-repo
  research leftovers were pruned this session.
