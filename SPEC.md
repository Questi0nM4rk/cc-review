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

- **GitHub bot mode** — in a consumer repo's GitHub Actions, from a GitHub App identity. The brain runs
  through an **interactive `claude` session via coder/agentapi** (not headless `claude -p`) — see §2 for why.
- **GitLab local mode** — run interactively on your machine against a MR. **Posts to the MR but never pushes a branch.**

Review philosophy: **one tier — every finding is a required change; approve only when there are zero findings and zero unresolved threads.** No severity labels, no "nits".

---

## 2. Runtime

Invoked through the Claude Code **Workflow tool by `scriptPath`** (empirically verified — not a `/slash`
command, not the Agent SDK), driven through an **INTERACTIVE `claude` session via
[coder/agentapi](https://github.com/coder/agentapi)** (`scripts/agentapi-claude.sh`), **not `claude -p`**:

```bash
# agentapi-claude.sh runs `agentapi server -- claude`, POSTs the prompt, polls GET /status until
# "stable" (turn complete), then GETs /messages. It installs agentapi (single binary) if missing.
printf '%s' "$PROMPT" > "$RUN_DIR/prompt.txt"
scripts/agentapi-claude.sh --prompt-file "$RUN_DIR/prompt.txt" --out "$RUN_DIR/transcript.txt" \
  --claude-arg --model --claude-arg claude-sonnet-4-6 \
  --claude-arg --dangerously-skip-permissions \
  --claude-arg --add-dir --claude-arg "$CC_REVIEW_BOT_DIR" --claude-arg --add-dir --claude-arg /tmp
```

> **Why interactive, not `claude -p`:** `claude -p` (headless/print) bills the headless/SDK pool —
> empirically it moves the **weekly** `/usage` ~3% per run while the **5-hour** session window doesn't
> budge. An interactive session draws from the abundant 5-hour bucket. **agentapi** wraps interactive
> `claude` as a clean HTTP API — `POST /message`, `GET /status` (`running`|`stable`), `GET /messages` —
> so we get the cheap bucket without hand-scraping a TUI.
>
> **Completion = the official `stable` status** (poll `GET /status`), not transcript parsing — the captured
> conversation is a best-effort log; correctness is verified against **GitHub ground truth**, never by
> parsing it. Validate the plumbing with `scripts/agentapi-claude.sh --selftest` (a `bash` stand-in — no
> claude, no quota; reachability only, since a generic command can't reach `stable`).
>
> **Fresh-runner boot (RESOLVED — CI is live):** `CLAUDE_CODE_OAUTH_TOKEN` (an `sk-ant-oat01` subscription
> token) **does** authenticate interactive `claude` on a CI runner. The real fresh-runner work was clearing
> the first-run TUI gates a logged-in dev machine has pre-cleared: the invoker seeds onboarding+trust state
> (`ci-claude.json`) and behaviour settings (`ci-claude-settings.json`), and **auto-answers the one
> "Run a dynamic workflow?" consent** (`POST "1"`) — no setting suppresses that gate in interactive mode.
>
> Use the **`--dangerously-skip-permissions` flag** so the agent's tools run without prompts — NOT
> `--permission-mode bypassPermissions`, which is silently downgraded on the runner. Do not set
> `permissions.defaultMode` in the settings seed (it conflicts with the flag).

- Sub-agents do **not** inherit env vars, so inputs arrive via files the runner stages
  (`/tmp/cc-input.json`, `/tmp/cc-user-msg.txt`, `/tmp/pr-diff.txt`). The brain **writes under the
  workspace** (`.cc-memory/`, `.cc-run/`; the read-only `.cc-global/` is staged there too) with `cat`
  heredocs into **pre-created** dirs — a convention proven in the old headless/allowlist era and
  **retained across the interactive/agentapi switch** (harmless and robust; interactive + `--dangerously-skip-permissions`
  no longer passes a Bash allowlist). See `docs/lessons-learned.md`.

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

The overview comment is the **primary** per-PR "have I reviewed this before" flag, but not the
only one: if a user deletes it, the **review-state marker** (§7) still proves the PR was reviewed,
so the bot takes the re-run path rather than silently redoing a from-scratch first review (#19). A
significant re-run then re-posts the overview.

---

## 5. The pipeline

### 5.A First review

| # | Phase | Model · effort | Gate | Output |
|---|-------|----------------|------|--------|
| 1 | **Fetch** — diff + PR meta + prior threads via `review-platform.ts` | sonnet | always | context |
| 2 | **Holistic review** — reads the **diff only**; emits overview walkthrough (prose + one mermaid diagram to `docs/overview-diagram-standard.md`), **difficulty 1–5**, and detects `answer`-intent. **Posts the overview first** (with the marker). | opus · medium (sonnet on doc-only) | always | overview, difficulty |
| 3 | **Gather** (parallel) — see §6 | sonnet ×2 + haiku | difficulty ≥ 2 (web ×2 skipped on small, non-risky diffs) | observations + signals |
| 4 | **Squad** — difficulty-scaled count + model + domain (§8); each reviewer gets overview + routed observations + tool signals + memories | opus·xhigh + sonnet | reviewing | findings |
| 5 | **Dedup + check** — JS dedup by `file:line`, then **one** agent filters false positives ("review if true") | JS + opus · high | findings>0, difficulty ≥ 2 | confirmed findings |
| 6 | **Decide** — `APPROVE` iff **0 findings AND 0 unresolved threads**, else `REQUEST_CHANGES` | JS | always | verdict |
| 7 | **Post** — review + inline findings + verdict via adapter; then stamp the per-PR **review-state marker** (head sha + file count, §7) | sonnet | `post===true` | posted |
| 8 | **Memory** — learnings to the memory branch (§7) | sonnet | something to record |

### 5.B Re-run (marker present)

1. **Fetch** + load prior open threads.
2. **All prior threads replied-to by the user?**
   - **No** → *auto-run*: post `first finish prev review` and **stop**. *Ping*: **override** → continue.
   - **Yes** → continue.
3. **Comment management** (one agent per thread, sonnet): validate against the **current code first**,
   then `resolve` (with a `Fixed:`/`Dismissed:` message) / `reply` / `keep`. Intentional
   dismissals become `known_patterns` → memory. **Update/save memories.**
4. **Significant-change check** (§9): **JS prefilter → agent confirms** borderline cases. The squad
   **re-reviews on every re-run** regardless; the check gates only the *expensive extras*:
   - **Not significant** → leave the overview comment untouched and **skip web research** (the squad
     reviews research-less) → dedup+check → decide → post.
   - **Significant** → **redraw the overview IN PLACE** (edit the existing comment, never re-post)
     + **run gather** (fresh web research) → squad → dedup+check → decide → post.

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
- **Deterministic floor:** the holistic agent's difficulty is one stochastic integer, so it is
  floored by a deterministic JS function (`difficultyFloor`): `difficulty = max(rated, floor)`.
  The floor reads the diff's risk + size signals — a security-sensitive path, an injection/exec/
  deserialization sink, a migration/schema change, or a sizable diff each raise a minimum (≥3 for
  risk, up to 4 for large diffs). It only ever **raises** depth, so a risky-but-small change can't
  roll a thin review; the rating + floor + reasons are logged for audit. (Thresholds are tunable.)
- **Model-by-category:** `LOW_STAKES_CATEGORY` (docs/chore) runs the opus slots on **sonnet** —
  **unless** `difficultyFloor` flagged a risk signal (security path / injection sink / SQL building /
  migration), which vetoes the downgrade so a "chore" touching dangerous code is still reviewed on
  opus (#12: floor-vs-category interaction).
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
   leads, not verdicts. It also surfaces, read DETERMINISTICALLY (not relayed through the synthesis
   agent): the learning-loop **outcome rows** (`outcomes.jsonl`) for Phase-2 calibration, and the
   **prior file-keyed signals** (`misses.jsonl` + `found-issues.md` matched against the changed files)
   that the brain turns into scrutiny-raising routed observations — the recall lever.

The two web researchers replace the old offline recon scanners; they are the same two roles
(ai-slop / general) but **web-backed**.

---

## 7. State & persistence (GitHub bot mode; GitLab is local-only)

All on the bot repo's orphan branch `claude-reviewer/memory`, segregated by `<owner>/<repo>/`.

- **Learnings** (durable, cross-PR): `MEMORY.md` + `learnings/{found-issues,lessons,known-patterns,decisions}.md`.
- **Per-PR review-state marker** — `<owner>/<repo>/pr-<N>/review-state.json`, a small stamp
  (`reviewed_head_sha` — the real head commit SHA, for audit/traceability — `reviewed_file_count`, plus
  `event` (the verdict) and the reviewed `files` list, which feed learning-loop Phase 4 miss-capture)
  written as **run output, not learned memory** on every posted review. The significant-change check
  (§9) compares the current PR's file/line counts against `reviewed_file_count`; it is
  **not** review context and is never fed back to a reviewer. (Gather observations are deliberately
  **not** persisted — an earlier "research cache" stored them but nothing ever read them back, so it
  was dropped.)
- **Per-finding instrumentation log** (learning-loop Phase 0) — `<owner>/<repo>/pr-<N>/findings.jsonl`,
  appended on every posted review: one row `{id, file, line, domain, event, posted_head_sha}` per
  posted **inline** finding. `id = fnv1a32(JSON.stringify([file, normalized-description]))` (line
  EXCLUDED — lines drift; first 10 description tokens, so minor re-wording doesn't fork it), and each
  posted inline comment carries a hidden `<!-- cc-review:finding <id> -->` marker so a later phase can
  correlate the comment (→ its review thread) back to its row. Append-only (`cat >>`), so it
  accumulates the union across re-runs (`dropAlreadyThreaded` suppresses re-posts). Run OUTPUT, not
  review context. No `posted_at` — the workflow runtime can't timestamp; recency is recorded
  runner-side when outcomes are harvested.
- **Outcome log** (learning-loop Phase 1) — `<owner>/<repo>/learnings/outcomes.jsonl`, appended on PR
  **merge** by `scripts/harvest-outcomes.mjs` (run from `cc-review-cleanup.yml`'s harvest job): one row
  `{id, pr, domain, verdict, at}` per posted finding, classifying its fate **against GitHub
  ground truth** — `fixed` (thread resolved, or `isOutdated` says the region changed), `dismissed`
  (resolved with a `Dismissed:` reply), `open-but-acted` (open but the author engaged — NOT noise),
  `ignored` (open, region unchanged, no engagement — the only, weak, noise signal), `gone` (no thread
  carries the id). **Deterministic** (no LLM reads comment text — an injected old comment can't steer a
  verdict) and **idempotent** (a re-harvest replaces a PR's rows by `id+pr`; trimmed to a rolling
  window). The slice fetch/push is shared with the review pipeline via `scripts/memory-slice.sh`.
  **Read back (learning-loop Phase 2):** the gather **tool-runner** (`analysis-tools.ts`) reads these rows
  DETERMINISTICALLY — not relayed through the synthesis LLM agent (the spine principle) — and the brain
  computes per-domain **calibration** from them (Laplace-smoothed rates, min-sample gate `n≥8`,
  `gone`/unknown excluded; `dismissed` counts toward the sample but neither rate — a concession, not a
  precision win) — injected as a visible block into `projectContext` (→ squad + check). The
  signal is asymmetric (`fixed` acts at a lower bar than `ignored`) and floored (it never instructs
  silence; the check still confirms every provable finding). This is the loop closing: outcomes →
  calibration → next review.
- **Miss log** (learning-loop Phase 4) — `<owner>/<repo>/learnings/misses.jsonl`, appended by the same
  harvester: when a merged **fix/revert/hotfix** PR touches a file an **earlier** PR was reviewed
  **clean** on, a row `{file, ref_pr, clean_pr, at}` records a candidate false-negative — the **recall**
  counterweight to the precision signal (so "fewer findings" can't masquerade as "better"). A
  deliberately weak prior (most fix PRs aren't fixing a bot miss). **It is now fed back (the recall
  lever):** on a later review, a changed file present in `misses.jsonl` — or recorded in
  `found-issues.md` — becomes a **routed observation** (via the deterministic tool-runner →
  `domainForFile` routing) that re-scrutinizes that file in its domain reviewer. **Additive only** — it
  raises scrutiny, never suppresses.
- **Cross-repo `_global/` layer (additive).** A single `_global/learnings/{lessons,watch-patterns}.md`
  subtree shared by ALL slices: general, repo-agnostic review lessons + recurring patterns to WATCH FOR.
  Every review reads it (staged read-only into `.cc-global/` via `fetch_global`, in a dir SEPARATE from
  the repo slice so `push_slice` can't copy it into a per-repo subtree) IN ADDITION to its own slice, so
  a lesson learned on repo A can inform repo B. **Additive-only — never a global suppression** (a wrong
  one would silence true findings in *every* repo, with no backstop). Written ONLY by the maintenance
  job's opt-in consolidation pass, never by a review.
- **Overview comment** — user-facing walkthrough + the first-vs-re-run marker; **edited in place** on
  re-runs. It is the **primary** first-vs-re-run signal, but **not the only one**: if a user deletes
  it, the review-state marker still proves the PR was reviewed, so the bot takes the re-run path
  rather than silently re-doing a from-scratch first review (#19). A significant re-run then re-posts
  the overview.
- **Log branch** — `pr-<N>-cc-review-output` in the **consumer** repo; per-PR run artifacts;
  **deleted on PR close** by `cc-review-cleanup.yml`. A gitleaks gate scans run output before push.

The workflow only writes the files; the GHA pushes (3-attempt retry; `git fetch origin <branch>`
then `git checkout -B <branch> FETCH_HEAD` — no `origin/<branch>` tracking ref exists under the
shallow single-branch clone). **GitLab local mode pushes none of these.**

**Per-environment config (one injected object, not scattered constants).** The one value that genuinely
differs between GitHub-CI and GitLab-local *inside the brain* is the memory dir, so it is externalized
rather than hardcoded: the brain reads `MEM` from `args.mem_dir`, defaulting to `.cc-memory` (the
GitHub-CI workspace slice — behavior unchanged). `analysis-tools.ts` takes a matching `--mem-dir` flag
(same default). **GitLab-local memory lives OUT of the product repo**, at
`~/.claude/cc-review-memory/<repo-slug>/`, injected via `args.mem_dir` and made writable by the sandbox
via `--add-dir` (`run-gitlab.sh`). It is purely local/per-machine — **local and CI memory never cross**
(no `fetch_slice`/`push_slice`/`_global/` of the CI branch from a local run). The other env differences
(slice fetch/push, `_global/` staging, identity) are already separated at the *runner* layer
(`ci-run.sh` does them; `run-gitlab.sh` does not), not in the brain.

**Bounded size (self-curating).** The memory branch is kept small two ways: (1) gather observations
are **not** persisted (only the tiny per-PR `review-state.json` marker is), so the per-PR footprint
is ~bytes, not the multi-KB research dumps an earlier design wrote; and (2) the memory agent
**curates rather than appends blindly** — on each write it reads the existing file and either appends
a genuinely-new entry or **rewrites it consolidated** (merging near-duplicates, folding run-by-run
status into standing themes, dropping superseded entries), with a rough ~25-bullet cap per file. It
**never drops a still-valid `known_pattern`** (that would cause re-flagging). Memory is read back into
every review (gather phase) — the project treats it as load-bearing, not disposable.

**Periodic maintenance (`.github/workflows/cc-review-memory-maintenance.yml`, runs IN cc-review).** A
scheduled + manually-dispatchable job maintains **every slice at once** on a checkout of the memory
branch (one job, no per-consumer install): (1) **deterministic, zero-quota cleanup**
(`scripts/memory-maintenance.mjs`) — prunes old `pr-<N>/` dirs beyond a retention cap (dead weight after
merge; never deleted on PR close → unbounded growth), trims the jsonl logs to their window, and writes a
`MAINTENANCE.md` health report (per-slice sizes, per-domain verdict tallies, a ⚠ for any domain trending
to silence or unread miss candidates); and (2) an **opt-in** single-agent pass (`consolidate=true`) that
merges per-repo lessons into the additive `_global/` layer (generalised, deduped, capped, never a
suppression). The **cron runs only part (1)** (no quota); consolidation is a manual dispatch (it spends
Claude quota, so it stays off by default). Defaults to a dry run unless `apply=true`.

**Cold-start backfill (learning-loop Phase 3, `.claude/workflows/backfill-memory.mjs`).** On a repo's
**first-ever** review the slice is empty, so `ci-run.sh` invokes the backfill workflow *before* the
review: it harvests the last `N` merged PRs (default 3, `BACKFILL_N`; one agent per PR) and synthesises
**additive** priors — conventions, recurring-issue themes, review-culture notes — into `MEMORY.md` +
`learnings/{lessons,found-issues}.md`, so the first review isn't cold. It is **additive-only**: it
**never** writes `known-patterns.md` or any suppression rule, because a wrong suppression silences true
findings with no backstop (code-verified backfilled `known_patterns` are deferred to a later phase).
Idempotency: the synth agent writes a `.cc-memory/.backfilled` sentinel **last** (proof of completion);
`ci-run.sh` decides "needs backfill" by that sentinel's absence in the fetched slice — checked **before**
the placeholder `MEMORY.md` write, which would otherwise mask an empty slice. Best-effort: a failed/
incomplete backfill leaves the sentinel unwritten (reviews cold — the prior baseline) and retries next
run. It never posts.

---

## 8. Squad selection (`pickSquad`, deterministic)

Domains: `security, architecture, testing, performance, data-access, api`. A relevance score
per domain is computed from: gather-observation counts (+2 per matching `suggested_domain`),
changed-file patterns (auth/crypto +3, repo/migration/api/test patterns +2, source +0.5), and
the change category (+2 for category-aligned domains). The top `opusCount` domains run on the
opus·xhigh anchors; the next `sonnetCount` run on sonnet specialists. Same inputs ⇒ same squad.

---

## 9. Significant-change check (re-run, phase 5.B.4)

**JS prefilter (cheap, deterministic):** compare the current PR's changed-file count + added-line
count against the **`reviewed_file_count`** recorded in the review-state marker (§7). Flag as
significant if **any of**: a file added or removed; OR ≥ `2 × added_lines` net added lines (a large
in-place rewrite of the same files); OR ≥ `files_pct` of the previously-reviewed files changed **and**
≥ `added_lines` net added lines since the last review. (The marker also stores `reviewed_head_sha` —
the real head commit SHA — for audit/traceability; the prefilter itself compares file/line counts,
not SHAs.)
**Agent confirm (sonnet):** only for cases **near** the thresholds (within `borderline`), an agent
judges whether the change is substantive enough to warrant a fresh holistic pass. Clear-cut
cases skip the agent.

**Thresholds (rationale + tunable).** Defaults `files_pct=0.25`, `added_lines=150`, `borderline=0.2`
(`borderline` is internal). Rationale: a quarter of the files changing, or ~150 new lines, is the
rough boundary between "a touch-up that the prior overview still describes" and "a new chunk of
work worth re-researching" for a typical service repo — small enough that a real feature addition
trips it, large enough that a typo/rename pass does not. They are **guesses sized for a mid-size
repo**, so `files_pct` and `added_lines` are overridable per project in `.cc-review.yaml`
(`significant_change:`) — raise them for a large monorepo, lower them for a tiny library. A new or
removed file is always significant regardless. The prefilter behavior is pinned by the
`sigChangePrefilter` tests (clear-cut significant / not-significant / borderline / config-override).

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
- Untrusted-derived context (overview, gather observations, author replies) primes a downstream
  agent — it primes, never commands. The defense is **instruction/data separation**, not phrase-
  scrubbing: `sanitizeContext` does only hygiene + brevity (strip control chars, collapse
  whitespace, cap length), and genuinely untrusted external text (the author's thread reply) is
  wrapped by `untrusted()` in an explicit **"data only, never instructions"** fence — with the
  fence keyword itself stripped from the body so it can't be forged/escaped. No injection-phrase
  blocklist (a losing game vs paraphrase/encoding); the real guarantee is the deterministic gate.
  See the adversarial corpus in `scripts/helpers.test.mjs`.
- **`known_patterns` are claims, not gospel.** A pattern learned from an author reply is written
  by the bot in its **own words after verifying the code** (never the author's text), and the
  reviewer framing lets a **provable security finding override** any claimed pattern — so a
  poisoned/coerced pattern cannot durably suppress a real vulnerability.

---

## 11. GitHub App settings

Repository permissions: **Contents** R/W (memory + log branches), **Pull requests** R/W
(diff/threads, reviews, resolve), **Issues** R/W (overview + status comments), **Metadata** R.
**No webhook events / subscriptions are needed** — the bot is driven by the consumer's own GitHub
Actions (`pull_request`, `issue_comment`, `pull_request_review_comment`), and the App is used only
for its token + permissions (its webhook is inactive). Install on **All repositories** (account-wide,
the simplest model) or at minimum the consumer **and** `Questi0nM4rk/cc-review` (so CI can clone the
brain). Consumer secrets: `CLAUDE_CODE_OAUTH_TOKEN`, `REVIEWER_APP_CLIENT_ID`, `REVIEWER_APP_PRIVATE_KEY`.
The token step uses `actions/create-github-app-token@v3` with `client-id` (the App ID is the legacy
identifier — v3 deprecates the `app-id` input).

---

## 12. Repository layout (bot repo)

```
cc-review/
├── SPEC.md                          ← this file (source of truth)
├── README.md                        ← human guide
├── .cc-review.yaml                  ← config template (copied to consumers)
├── .github/workflows/{cc-review,cc-review-interactive,cc-review-cleanup}.yml
├── .claude/workflows/strict-review.mjs   ← the entire review brain
├── scripts/{review-platform,analysis-tools,setup}.ts, {setup,install-to-repo,ci-run}.sh
├── scripts/{check-brain,helpers.test,verify-gate.test}.mjs   ← CI: brain syntax gate + helper tests
├── .github/workflows/ci.yml             ← runs the syntax gate + node --test on push/PR
├── docs/{overview-diagram-standard.md, pipeline-diagram.html, lessons-learned.md, github-review-api.md}
└── lang-refs/{dotnet,typescript,python,shell}.md
```

Consumers get three workflow files + one config; their CI clones this repo's **default branch `main`**
at runtime (with the App token) and runs `scripts/ci-run.sh` + the brain (§13). It does NOT use a
cross-repo `uses:` composite action — a private repo's action can't be resolved cross-repo from a
personal account, so the runtime clone (which the App token can read) is the delivery mechanism.

---

## 13. Branch model

Consumers clone with `git clone --depth 1` — the repo's **default branch `main` is the live
brain**; push brain changes to `main` and consumers pick them up on the next run. The shallow
single-branch clone means there are **no `origin/<other-branch>` tracking refs** in CI — fetch explicitly and key
off `FETCH_HEAD`.

---

## 14. Delta vs the currently-shipped pipeline (build list)

1. **Web-backed gatherers** — recon scanners become two `WebSearch`/`WebFetch` agents (ai-slop / general).
2. **Single dedup+check agent** — replace the separate `grade` (opus) and `verify` (sonnet skeptics) phases with JS dedup + one false-positive-filter agent.
3. **Per-PR review-state marker** — a tiny `pr-<N>/review-state.json` stamp (`reviewed_head_sha`, `reviewed_file_count`) for the significant-change check. (A broader "research cache" was considered but cut — its observations were written and never read back.)
4. **Overview edit-in-place + marker-based first-vs-re-run detection.**
5. **Re-review hard-stop gate** (`first finish prev review`) with ping override.
6. **`answer` mode retained; focused/recheck removed.**
7. **Significant-change check** (JS prefilter + agent confirm) on re-runs.
8. **Diff-first overview** (post before gather; research feeds the squad, not the overview).

---

## 15. Settled defaults (rationale)

The rebuild's open calls, now settled:

- **Check-agent model — `opus·high`.** It is the *sole* quality gate (the one false-positive filter
  that replaced the old grade + verify passes), so it stays on the strongest tier; cost is one call,
  gated to difficulty ≥ 2. Not dropped to sonnet.
- **Gather difficulty gate — difficulty ≥ 2.** Trivial PRs (d1) skip web research; the deterministic
  difficulty floor (§5) guarantees a risky-but-small change lands ≥ 3 and *does* get gather. Not always-on.
- **Significant-change thresholds (§9) — documented + per-project configurable** (`.cc-review.yaml`
  `significant_change`). No longer bare guesses (resolved in #17).
- **`answer` mode — reply-only.** A question gets a single reply comment and the run stops — no overview,
  no squad. Confirmed.
- **Memory-save split — confirmed.** A first review records found-issues + lessons + decisions; a re-run
  additionally records known-patterns + resolutions. The memory agent runs only when there is something
  to record.
