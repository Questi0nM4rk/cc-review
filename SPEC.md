# cc-review — Source-of-Truth Specification

The canonical description of the cc-review review workflow. Derived from the agreed target
design (2026-06-04). Implementation files (`.github/workflows/`, `.claude/workflows/`,
`scripts/`, `lang-refs/`) must match this document; **if they drift, this wins.** Where the
currently-shipped `strict-review.mjs` disagrees with this spec, the code is what changes.

Companion docs: `docs/overview-diagram-standard.md` (the overview mermaid standard),
`docs/pipeline-diagram.html` (engine-internals viewer), `docs/lessons-learned.md` (CI
constraints), `docs/github-review-api.md` (platform API notes).

---

## 1. What it is

An automated, zero-tolerance PR/MR reviewer powered by Claude Code. The entire review brain
is **one self-contained workflow** (`.claude/workflows/strict-review.mjs`) — no marketplace,
no submodule. Two modes:

- **GitHub bot mode** — headless, in a consumer repo's GitHub Actions, from a GitHub App identity.
- **GitLab local mode** — run interactively on your machine against a MR. **Posts to the MR but never pushes a branch.**

Review philosophy: **one tier — every finding is a required change; approve only when there are zero findings and zero unresolved threads.** No severity labels, no "nits".

---

## 2. Runtime

Invoked through the Claude Code **Workflow tool by `scriptPath`** (empirically verified — not
a `/slash` command, not the Agent SDK):

```bash
claude -p "Use the Workflow tool with scriptPath '$CC_REVIEW_BOT_DIR/.claude/workflows/strict-review.mjs'. Report its return value." \
  --allowedTools "Workflow,Bash,Read,Write,Grep,Glob,WebSearch,WebFetch" \
  --permission-mode bypassPermissions \
  --output-format stream-json | tee "$RUN_DIR/session.jsonl"
```

- Sub-agents do **not** inherit env vars and are **filesystem-sandboxed to `$GITHUB_WORKSPACE`**
  (no `/tmp` writes). Inputs arrive via files the GHA stages (`/tmp/cc-input.json`,
  `/tmp/cc-user-msg.txt`, `/tmp/pr-diff.txt` — reads from `/tmp` are fine); anything an agent
  must **write** goes under the workspace (`.cc-memory/`, `.cc-run/`). Dirs are pre-created by
  a GHA step; agents append with `cat` heredoc only (`mkdir/printf/tee` are not on the Bash
  allowlist). See `docs/lessons-learned.md`.

---

## 3. Triggers & modes

Per-consumer `.cc-review.yaml`:

```yaml
trigger: pr_open    # pr_open (default) | every_push | disabled
```

| `trigger` | Auto-reviews on |
|-----------|-----------------|
| `pr_open` (default) | PR opened / reopened only |
| `every_push` | PR opened **and** every push (`synchronize`) |
| `disabled` | never auto-reviews |

- The **`@cc-review` ping is ALWAYS available**, even when `disabled`, and is the only way to
  **override the re-review hard-stop gate** (§5.B). The `cc-review` label and
  `workflow_dispatch` are manual overrides; the `no-review` label suppresses an auto-run.
- **`answer` mode** is the only intent mode: if the `@cc-review` prompt is a **question**, the
  holistic-review pass answers it as a single reply comment and the run **stops** — no review,
  no overview, no squad. (Focused/recheck modes are removed; the re-run path subsumes recheck.)

---

## 4. First-review vs re-run detection

Decided **deterministically** by the presence of the bot's **overview comment** on the PR,
identified by a hidden marker `<!-- cc-review:overview -->`:

- **marker absent → FIRST REVIEW** (§5.A)
- **marker present → RE-RUN** (§5.B)

The overview comment thus doubles as the per-PR "have I reviewed this before" state flag.
(Consequence: if a user deletes the overview comment, the next run is treated as a first
review. Accepted.)

---

## 5. The pipeline

### 5.A First review

| # | Phase | Model · effort | Gate | Output |
|---|-------|----------------|------|--------|
| 1 | **Fetch** — diff + PR meta + prior threads via `review-platform.ts` | sonnet | always | context |
| 2 | **Holistic review** — reads the **diff only**; emits overview walkthrough (prose + one mermaid diagram to `docs/overview-diagram-standard.md`), **difficulty 1–5**, and detects `answer`-intent. **Posts the overview first** (with the marker). | opus · medium | always | overview, difficulty |
| 3 | **Gather** (parallel) — see §6 | sonnet ×2 + haiku | difficulty ≥ 2 | observations + signals |
| 4 | **Cache** the gather output for this PR (§7) | JS | difficulty ≥ 2 | persisted research |
| 5 | **Squad** — difficulty-scaled count + model + domain (§8); each reviewer gets overview + routed observations + tool signals + memories | opus·xhigh + sonnet | reviewing | findings |
| 6 | **Dedup + check** — JS dedup by `file:line`, then **one** agent filters false positives ("review if true") | JS + opus · high | findings>0, difficulty ≥ 2 | confirmed findings |
| 7 | **Decide** — `APPROVE` iff **0 findings AND 0 unresolved threads**, else `REQUEST_CHANGES` | JS | always | verdict |
| 8 | **Post** — review + inline findings + verdict via adapter | sonnet | `post===true` | posted |
| 9 | **Memory** — learnings to the memory branch (§7) | sonnet | something to record |

### 5.B Re-run (marker present)

1. **Fetch** + load prior open threads.
2. **All prior threads replied-to by the user?**
   - **No** → *auto-run*: post `first finish prev review` and **stop**. *Ping*: **override** → continue.
   - **Yes** → continue.
3. **Comment management** (one agent per thread, sonnet): validate against the **current code first**,
   then `resolve` (with a `Fixed:`/`Dismissed:` message) / `reply` / `keep`. Intentional
   dismissals become `known_patterns` → memory. **Update/save memories.**
4. **Significant-change check** (§9): **JS prefilter → agent confirms** borderline cases.
   - **Not significant** → **reuse the cached research/docs** (§7); end after comment handling — no fresh deep review.
   - **Significant** → **redraw the overview IN PLACE** (edit the existing comment, never re-post)
     + **re-run gather** (fresh research) → squad → dedup+check → decide → post.

### Difficulty → PATH (deterministic JS table)

| difficulty | gather | squad | dedup+check |
|---|---|---|---|
| 1 | – | 1 opus | – (trust the reviewer) |
| 2 | ✓ | 1 opus + 1 sonnet | ✓ |
| 3 | ✓ | 2 opus | ✓ |
| 4 | ✓ | 2 opus + 1 sonnet | ✓ |
| 5 | ✓ | 2 opus + 2 sonnet | ✓ |

- The opus anchors always run at **xhigh** effort. Depth scales by **adding reviewers**, never
  by weakening the anchor.
- **Model-by-category:** `LOW_STAKES_CATEGORY` (docs/chore) runs the opus slots on **sonnet**.
- The **2 opus slots** go to the top-2 domains by deterministic relevance (`pickSquad`, §8).

---

## 6. Gatherers (phase 3)

Run in parallel after the overview is posted; their observations feed the squad and `pickSquad`.

1. **Web research — AI-code mistakes** (sonnet, `WebSearch`/`WebFetch`). Researches the diff's
   libraries/APIs/patterns against the web for AI-generated-code failure modes (over-generic
   names, swallowed exceptions, happy-path-only tests, hallucinated APIs, etc.). Returns
   observations `{pattern, location, note, suggested_domain}` — **not findings**.
2. **Web research — general mistakes** (sonnet, `WebSearch`/`WebFetch`). Researches against the
   web for the concerns an experienced human reviewer raises (missing tests/migrations,
   unproven behavior-preservation, stale references, contract drift). Returns observations.
3. **Memories & docs lookup** — reads this repo's memory slice + the repo's `./docs` to inform
   the squad.
4. **Static tools** (haiku tool-runner) — `analysis-tools.ts` (semgrep / lizard); signals are
   leads, not verdicts.

The two web researchers replace the old offline recon scanners; they are the same two roles
(ai-slop / general) but **web-backed**.

---

## 7. State & persistence (GitHub bot mode; GitLab is local-only)

All on the bot repo's orphan branch `claude-reviewer/memory`, segregated by `<owner>/<repo>/`.

- **Learnings** (durable, cross-PR): `MEMORY.md` + `learnings/{found-issues,lessons,known-patterns,decisions}.md`.
- **Per-PR research cache (NEW)** — `<owner>/<repo>/pr-<N>/research/` holding the gather output
  as **run output, not learned memory**: `ai-slop.json`, `general.json`, `docs.json`,
  `tools.json`, and `meta.json` with `reviewed_head_sha`. **Reused** on a re-run; **refreshed**
  only when the significant-change check fires (§9).
- **Overview comment** — user-facing walkthrough + the first-vs-re-run marker; **edited in place** on re-runs.
- **Log branch** — `pr-<N>-cc-review-output` in the **consumer** repo; per-PR run artifacts;
  **deleted on PR close** by `cc-review-cleanup.yml`. A gitleaks gate scans run output before push.

The workflow only writes the files; the GHA pushes (3-attempt retry; `git fetch origin <branch>`
then `git checkout -B <branch> FETCH_HEAD` — no `origin/<branch>` tracking ref exists under the
shallow single-branch clone). **GitLab local mode pushes none of these.**

---

## 8. Squad selection (`pickSquad`, deterministic)

Domains: `security, architecture, testing, performance, data-access, api`. A relevance score
per domain is computed from: gather-observation counts (+2 per matching `suggested_domain`),
changed-file patterns (auth/crypto +3, repo/migration/api/test patterns +2, source +0.5), and
the change category (+2 for category-aligned domains). The top `opusCount` domains run on the
opus·xhigh anchors; the next `sonnetCount` run on sonnet specialists. Same inputs ⇒ same squad.

---

## 9. Significant-change check (re-run, phase 5.B.4)

**JS prefilter (cheap, deterministic):** compare the current PR head against `reviewed_head_sha`
from the research cache. Flag as significant if **any of**: a file added or removed; OR
> 25% of the previously-reviewed files changed; OR > 150 net added lines since the last review.
**Agent confirm (sonnet):** only for cases **near** the thresholds (e.g. within 20%), an agent
judges whether the change is substantive enough to warrant a fresh holistic pass. Clear-cut
cases skip the agent. *(Thresholds are defaults — tunable.)*

---

## 10. Determinism & safety

- Orchestration (fetch → detect → holistic → gather → squad selection → dedup → decide →
  report) is **pure JS**; only agent calls are stochastic. Same model outputs ⇒ identical
  control flow.
- The approval verdict is deterministic and **cannot be overridden by a PR comment**. The
  `@cc-review` message can only select `answer` mode or override the re-review hard-stop — it
  can never force an approval.
- Finding format (no severity labels, no emoji, imperative mood) is enforced by the reviewer
  prompts (the STRICT block), not a separate JS validation pass.
- Posting is gated on explicit `post===true`; the engine is side-effect-free until then.
- Untrusted-derived context (overview, gather observations, author replies) is minimized +
  sanitized before it primes a downstream agent — it primes, never commands.

---

## 11. GitHub App settings

Repository permissions: **Contents** R/W (memory + log branches), **Pull requests** R/W
(diff/threads, reviews, resolve), **Issues** R/W (overview + status comments), **Metadata** R.
Subscribe to: Pull request, Issue comment, Pull request review comment. Install on **two** repos:
the consumer, and `Questi0nM4rk/cc-review` (so CI can clone the brain). Consumer secrets:
`CLAUDE_CODE_OAUTH_TOKEN`, `REVIEWER_APP_ID`, `REVIEWER_APP_PRIVATE_KEY`.

---

## 12. Repository layout (bot repo)

```
cc-review/
├── SPEC.md                          ← this file (source of truth)
├── README.md                        ← human guide
├── .cc-review.yaml                  ← config template (copied to consumers)
├── .github/workflows/{cc-review,cc-review-interactive,cc-review-cleanup}.yml
├── .claude/workflows/strict-review.mjs   ← the entire review brain
├── scripts/{review-platform,analysis-tools}.ts
├── docs/{overview-diagram-standard.md, pipeline-diagram.html, lessons-learned.md, github-review-api.md}
└── lang-refs/{dotnet,typescript,python,shell}.md
```

Consumers get three workflow files + one config; CI clones this repo (branch `rewrite`) at
runtime for the brain.

---

## 13. Branch model

Consumers clone with `git clone --depth 1 -b rewrite`. **`rewrite` is the live brain branch**;
`main` lags. Develop on `rewrite`, then PR `rewrite → main`. The shallow single-branch clone
means there are **no `origin/<other-branch>` tracking refs** in CI — fetch explicitly and key
off `FETCH_HEAD`.

---

## 14. Delta vs the currently-shipped pipeline (build list)

1. **Web-backed gatherers** — recon scanners become two `WebSearch`/`WebFetch` agents (ai-slop / general).
2. **Single dedup+check agent** — replace the separate `grade` (opus) and `verify` (sonnet skeptics) phases with JS dedup + one false-positive-filter agent.
3. **Per-PR research cache** — new persistence namespace (`pr-<N>/research/`) + reuse/refresh logic keyed on `reviewed_head_sha`.
4. **Overview edit-in-place + marker-based first-vs-re-run detection.**
5. **Re-review hard-stop gate** (`first finish prev review`) with ping override.
6. **`answer` mode retained; focused/recheck removed.**
7. **Significant-change check** (JS prefilter + agent confirm) on re-runs.
8. **Diff-first overview** (post before gather; research feeds the squad, not the overview).

---

## 15. OPEN — confirm or red-line

- [ ] **Check agent model** — defaulted to **opus·high** (it is now the sole quality gate). Drop to sonnet to cut cost?
- [ ] **Gather difficulty gate** — defaulted to **difficulty ≥ 2** (trivial PRs skip web research). Always run instead?
- [ ] **Significant-change thresholds** (§9) — the 25% / 150-line / new-file numbers are guesses.
- [ ] **`answer` mode** — strictly a reply (no overview), as specced. Confirm.
- [ ] **Memory-save contents** — first review records found-issues + lessons + decisions; re-run adds known-patterns + resolutions. Confirm the split.
