# CLAUDE.md — cc-review (agent notes)

A PR/MR review bot powered by Claude Code. The "brain" is one self-contained Workflow
script that a consumer repo's GitHub Action clones at runtime and runs headless via
`claude -p`. Read `SPEC.md` for the full design; this file is what an agent needs to
*work on it* — the load-bearing constraints, the branch model, how to test, and the
open TODOs.

## Layout

- `.claude/workflows/strict-review.mjs` — the brain: the entire review pipeline as one Workflow script (phases below).
- `scripts/review-platform.ts` — platform adapter: `detect | context | threads | get-overview | post-overview | edit-overview | post-review | resolve | reply` (GitHub via `gh`, GitLab local).
- `scripts/analysis-tools.ts` — semgrep/lizard runner used by the gather phase.
- `scripts/run-local.sh` — local harness (lays down `/tmp` scaffolding, runs the brain via `claude -p`, `post=false`).
- `scripts/verify-gate.test.mjs` — contract spec for the fetch identity gate (`node scripts/verify-gate.test.mjs`).
- `lang-refs/` — per-language checklists reviewers pull with `cat`.
- `.github/workflows/cc-review*.yml` — the GHA templates installed into consumer repos (review, interactive ping, cleanup).
- `SPEC.md` / `README.md` — at the repo root (spec + human guide).
- `docs/` — `overview-diagram-standard.md` (render-verified mermaid standard), `pipeline-diagram.html` (engine-internals viewer), `lessons-learned.md`, `github-review-api.md`.

## Branch model — IMPORTANT

- Consumers' GHA clones cc-review with `git clone --depth 1` (the **default branch `main` is the live brain**) — push brain changes to `main`; consumers pick them up on the next run.
- The shallow single-branch clone means **there are no `origin/<other-branch>` tracking refs in CI** — fetch explicitly and use `FETCH_HEAD`.

## Pipeline (strict-review.mjs) — see SPEC.md for the exact contract

Two entry paths, decided by whether **our overview comment** (marker `<!-- cc-review:overview -->`) exists on the PR:

- **First review** (marker absent): **Fetch** → **Holistic review** (opus·medium; reads the diff, emits overview + difficulty + `answer`-intent; **posts the overview first**) → **Gather** (2 web-backed research agents — ai-slop / general, via `WebSearch`/`WebFetch` — + memories/docs + haiku tool-runner; gated d≥2) → **Squad** (difficulty-scaled) → **Dedup + Check** (JS dedup + **one** opus false-positive-filter agent) → **Decide** → **Post** (gated; also stamps the per-PR review-state marker) → **Memory**.
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

## State of the world (2026-06-05) — rebuild done, audit cleanup done, ONE blocker

The rebuild to `SPEC.md` is **complete and live on `main`** (the shipped brain == the target spec).
The post-rebuild audit (tracking issue **#24**) was then worked end-to-end. `SPEC.md` is the exact
source of truth and now matches the code (§15 OPEN decisions resolved → "Settled defaults").

### ⛔ TOP BLOCKER — the GitHub App is unreachable (the bot is DOWN)

A real `gh workflow run` dispatch (run 26985091589, against PR #36) failed at **"Generate GitHub App
token"**: **`Integration not found - failed to create token for "Questi0nM4rk"`**. The App that
`REVIEWER_APP_ID` points to is deleted/uninstalled or the secret is stale. **No review can run until
this is fixed.** It is NOT a code bug (the token step is unchanged; it failed before any new code).
Fix it FIRST — see the dedicated section at the end of `docs/lessons-learned.md`
(github.com/settings/apps → confirm the App exists + is installed; check `REVIEWER_APP_ID` /
`REVIEWER_APP_PRIVATE_KEY` on the cc-review repo; or `./scripts/setup.sh` to recreate).

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

- **#18 — composite action: MERGED (`096e46b`) but UNVERIFIED.** The shared pipeline now lives once in
  `.github/actions/cc-review-run/action.yml`; both workflows call it via
  `uses: Questi0nM4rk/cc-review/.github/actions/cc-review-run@main`. The verify dispatch couldn't reach
  it (died at the App-token step above). Re-dispatch once the App is fixed:
  `gh workflow run cc-review.yml --repo Questi0nM4rk/cc-review --ref main -f pr_number=<closed PR>`.
  (Reviews on cc-review itself need no access toggle; OTHER same-owner consumer repos may need the
  cc-review repo's Settings → Actions → Access toggled to allow them.)
- **#21 — clean install (live):** code-side done; still needs a fresh install on a throwaway repo →
  real review, end-to-end, following only `scripts/` + README.
- **#11 — GitLab mode (live):** never run live. Needs a real GitLab MR + `glab` authed; run the brain
  locally (`scripts/run-local.sh`), verify post-overview / positioned inline findings / resolve / reply /
  edit-overview, and fix inline-comment positioning against a real instance.
- Minor: old stray branch `claude/add-review-logging-xcGnC`; the `pr-12-cc-review-output` orphan log branch.

### Reference

- `docs/overview-diagram-standard.md` is render-verified (mermaid v11); `docs/pipeline-diagram.html` is
  the engine-internals viewer. `docs/lessons-learned.md` has the CI constraints + this session's traps.
- Memory branch `claude-reviewer/memory` is live and useful (read into every review); test-repo
  research leftovers were pruned this session.
