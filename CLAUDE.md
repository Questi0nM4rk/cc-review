# CLAUDE.md — cc-review (agent notes)

A PR/MR review bot powered by Claude Code. The "brain" is one self-contained Workflow
script that a consumer repo's GitHub Action clones at runtime and runs headless via
`claude -p`. Read `SPEC.md` for the full design; this file is what an agent needs to
*work on it* — the load-bearing constraints, the branch model, how to test, and the
open TODOs.

## Layout

- `.claude/workflows/strict-review.mjs` — the brain: the entire review pipeline as one Workflow script (phases below).
- `scripts/review-platform.ts` — platform adapter: `detect | context | threads | post-overview | post-review | resolve | reply` (GitHub via `gh`, GitLab local).
- `scripts/analysis-tools.ts` — semgrep/lizard runner used by Recon.
- `scripts/run-local.sh` — local harness (lays down `/tmp` scaffolding, runs the brain via `claude -p`, `post=false`).
- `scripts/verify-gate.test.mjs` — contract spec for the fetch identity gate (`node scripts/verify-gate.test.mjs`).
- `lang-refs/` — per-language checklists reviewers pull with `cat`.
- `.github/workflows/cc-review*.yml` — the GHA templates installed into consumer repos (review, interactive ping, cleanup).
- `docs/` — `SPEC.md` (design), `lessons-learned.md`, `github-review-api.md`, `overview-diagram-standard.md`.

## Branch model — IMPORTANT

- Consumers' GHA clones cc-review with `git clone --depth 1 -b rewrite`. **`rewrite` is the live brain branch** — push brain changes there; consumers pick them up on the next run.
- `main` lags. The workflow is develop-on-`rewrite`, then PR `rewrite → main`.
- The shallow single-branch clone means **there are no `origin/<other-branch>` tracking refs in CI** — fetch explicitly and use `FETCH_HEAD`.

## Pipeline (strict-review.mjs)

Fetch → **Triage** (opus·medium; posts the overview comment) → **Recon** (sonnet scanners + haiku tool-runner, gated) → **Review** (difficulty-scaled squad) → **Grade** (opus; false-positive filter, gated) → **Verify** (sonnet skeptic per finding, gated) → **Comment-mgmt** (one agent per prior open thread) → Decide → **Post** (gated on `args.post`/`CC_POST`) → **Memory**.

### Agent ladder (`PATH` table) — opus anchor always xhigh, scale by ADDING reviewers
- d1: 1 opus · d2: 1 opus + 1 sonnet · d3: 2 opus · d4: 2 opus + 1 sonnet · d5: 2 opus + 2 sonnet
- recon ≥ d2, grade ≥ d2, verify ≥ d4.
- **Model-by-feature:** `LOW_STAKES_CATEGORY` (docs/chore) runs the deep slots on sonnet, not opus.
- Triage passes the (minimized + sanitized) overview AND recon observations into the reviewers.
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

## Open TODOs (handoff — 2026-06-03)

1. **Merge feats PR #14** (GHA fixes → feats `main`) so *auto-review on PR-open* uses them. Verified working via `--ref` dispatch; safety classifier blocks an agent from self-merging CI to a shared default branch — a human merges it.
2. **Overview = post-once, edit-in-place.** The overview/diagram comment must be posted on PR-open then EDITED in place as the PR evolves. Make the overview agent conditional: on start, read PR state (existing bot overview comment? new commits since it was written? does the diagram still match the code?) → decide create / edit-in-place / leave. Today it re-posts every run (the feats#12 "multiple overviews" bug). Architecture: **one** edited-in-place overview comment + stacking inline review comments that are checked against user replies.
3. **Bake the diagram 1.0 standard into `triagePrompt`** — see `docs/overview-diagram-standard.md` and the studio at `~/.claude/work/cc-review/overview-diagram-studio.html`. Calls + decisions are mandatory; render-safe (quoted labels); type chosen per change; emphasize changed nodes; 5–12 nodes.
4. **Confirm/ship default `trigger: pr_open`** (on-create + ping, never every-push) and document it as user-overridable per project.
5. Minor: the overview agent, blocked from `/tmp`, wrote `cc-overview.md` into `.cc-memory` (swept into the memory slice). Point `overviewPostPrompt` at a non-memory workspace path.
6. Eventually PR `rewrite → main`.

## State of the world (as of handoff)

- Brain `rewrite` carries all fixes (identity gate, validator-layer removed, agent ladder, model-by-category, overview+recon passdown+sanitize, cross-run dedup, resolve-with-message, memory→workspace `.cc-memory`, memory gets real findings).
- Full pipeline **verified live** on `Questi0nM4rk/feats` (#12/#13): overview, inline findings, re-run resolve/reply/dedup, log branch, cleanup-on-close, memory branch with correct content, gitleaks gate.
- 7 bugs found + fixed this session — see `docs/lessons-learned.md`.
