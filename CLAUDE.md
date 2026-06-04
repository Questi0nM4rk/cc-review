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

- Consumers' GHA clones cc-review with `git clone --depth 1 -b rewrite`. **`rewrite` is the live brain branch** — push brain changes there; consumers pick them up on the next run.
- `main` lags. The workflow is develop-on-`rewrite`, then PR `rewrite → main`.
- The shallow single-branch clone means **there are no `origin/<other-branch>` tracking refs in CI** — fetch explicitly and use `FETCH_HEAD`.

## Pipeline (strict-review.mjs) — see SPEC.md for the exact contract

Two entry paths, decided by whether **our overview comment** (marker `<!-- cc-review:overview -->`) exists on the PR:

- **First review** (marker absent): **Fetch** → **Holistic review** (opus·medium; reads the diff, emits overview + difficulty + `answer`-intent; **posts the overview first**) → **Gather** (2 web-backed research agents — ai-slop / general, via `WebSearch`/`WebFetch` — + memories/docs + haiku tool-runner; gated d≥2; **output cached per-PR**) → **Squad** (difficulty-scaled) → **Dedup + Check** (JS dedup + **one** opus false-positive-filter agent) → **Decide** → **Post** (gated) → **Memory**.
- **Re-run** (marker present): **Fetch** → prior threads **all replied?** (no & auto-run → post `first finish prev review`, stop; ping → override) → **Comment-mgmt** (resolve/reply/keep + update memories) → **significant-change check** (JS prefilter + agent confirm) → if significant: redraw the overview **in place** + re-run gather → squad → … ; else reuse the cached research and end.

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

## Rebuild in progress (2026-06-04) — target = SPEC.md

The brain is being rebuilt to the target workflow in `SPEC.md` (agreed from the hand-drawn
design). The exact delta-vs-shipped **build list is SPEC.md §14**; the open prefs are **§15**.
Headline changes: web-backed gatherers, a single **dedup+check** agent (grade+verify removed),
a **per-PR research cache** (`pr-<N>/research/` on the memory branch, as *output* not memory),
**marker-based** first-vs-re-run detection, **overview edit-in-place**, the **re-review
hard-stop gate** with ping override, **`answer`-only** intent, and the **significant-change check**.

CI mechanics (sandbox, `--allowedTools`, `FETCH_HEAD`, log/memory branches, gitleaks) are
**unchanged** and still apply — see Hard CI constraints + lessons-learned. The brain rewrite
also needs the GHA to stage/push the new research cache (a `.cc-run/` scratch dir + the
`pr-<N>/research/` slice) the same way it stages `.cc-memory`.

Still outstanding from before the rebuild:
- **Merge feats PR #14** (GHA fixes → feats `main`) — a human merges (classifier blocks self-merge).
- Eventually PR `rewrite → main`.

## State of the world (2026-06-04)

- `SPEC.md` is the **exact target spec**; `docs/overview-diagram-standard.md` is render-verified
  (mermaid v11 via headless Chrome); `docs/pipeline-diagram.html` is the engine-internals viewer.
- The brain on `rewrite` still reflects the **pre-rebuild** pipeline (triage/recon/grade/verify).
  The rebuild to SPEC is **underway** — do not treat the currently-shipped phases as the target.
- Pre-rebuild pipeline was verified live on `Questi0nM4rk/feats` (#12/#13); 7 bugs fixed that
  session — see `docs/lessons-learned.md`.
