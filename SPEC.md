# cc-review — Source-of-Truth Specification

The canonical description of what cc-review is, how it runs, and how a project adopts it. Implementation files (`.github/workflows/`, `.claude/workflows/`, `scripts/`, `lang-refs/`) must match this document; if they drift, this wins.

---

## 1. What it is

An automated, zero-tolerance PR/MR reviewer powered by Claude Code. The entire review brain is **one self-contained workflow** (`.claude/workflows/strict-review.mjs`) — no plugin marketplace, no submodule. It runs in two modes:

- **GitHub bot mode** — headless, in a consumer repo's GitHub Actions, reviewing from a GitHub App identity.
- **GitLab local mode** — you run it interactively on your own machine against a GitLab MR (for environments where a CI bot app is not allowed). It **posts to the MR but never pushes any branch**.

Review philosophy: **one tier — every finding is a required change; approve only when there are zero findings and zero unresolved threads.**

---

## 2. Runtime

The workflow is invoked through the Claude Code **Workflow tool by `scriptPath`** (empirically verified). It is *not* a `/slash` command (those are interactive-only headless) and *not* the Agent SDK.

```bash
claude -p "Use the Workflow tool with scriptPath '$CC_REVIEW_BOT_DIR/.claude/workflows/strict-review.mjs' \
  and args { post:true, prNumber:<N>, repo:'<owner/name>', userMessage:'<@cc-review text or empty>' }. \
  Report its return value." \
  --allowedTools "Workflow,Bash,Read,Write,Grep,Glob,WebSearch,WebFetch" \
  --output-format stream-json | tee "$RUN_DIR/session.jsonl"
```

- `--output-format stream-json | tee` streams the live reasoning to a file — the real-time observability path (tail it). The pretty live UI (remote control) is only for GitLab-local interactive runs.
- `CC_REVIEW_BOT_DIR` points at the cloned bot repo so the workflow's helper scripts and lang-refs resolve regardless of the agent cwd.

---

## 3. Pipeline

| # | Phase | Model | Gate |
|---|-------|-------|------|
| 1 | **Fetch** — diff + PR meta + prior open threads via `review-platform.ts` | haiku | always |
| 2 | **Triage** — parse `@cc-review` intent → run-plan; rate **difficulty 1–5**; write the pre-review walkthrough (mermaid + `Difficulty: N/5`), posted first | **opus · medium** | always |
| 3 | **Recon + tools** — 2 haiku scanners (observations) + `analysis-tools.ts` signals | haiku | difficulty ≥ 2 |
| 4 | **Review** — **2 opus·xhigh** (top-2 relevant domains) + **0/2/4 sonnet** specialists; each reads matching lang-refs + tool signals | opus·xhigh + sonnet | reviewing |
| 5 | **Grade** — confirmed / false-positive / reframe-higher + call-stacks | opus · high | difficulty ≥ 2 |
| 6 | **Verify** — one sonnet skeptic per finding | sonnet | difficulty 4–5 |
| 7 | **Comment-Mgmt** — per prior thread: replied? fixed? correct? → resolve / keep / reply | sonnet | always |
| 8 | **Decide** — `APPROVE` iff **0 findings AND 0 threads open**, else `REQUEST_CHANGES` | JS | always |
| 9 | **Post** — review + resolve/reply threads via adapter | sonnet | `args.post===true` |
| 10 | **Memory** — palace-structured learnings to `/tmp/memory` | haiku | always |

### Difficulty → path (deterministic JS table)

| rating | recon | squad | grade | verify |
|--------|-------|-------|-------|--------|
| 1 | – | 2 opus | – | – |
| 2–3 | ✓ | 2 opus + 2 sonnet | ✓ | – |
| 4–5 | ✓ | 2 opus + 4 sonnet | ✓ | ✓ |

The **2 opus slots** go to the top-2 domains by a deterministic relevance score (recon-observation counts + changed-file patterns + change category). "Dynamic" never means non-deterministic — same inputs, same squad.

### Intent run-plan (from the `@cc-review` message)

| mode | effect |
|------|--------|
| `full` | default / auto-trigger: full difficulty-scaled review |
| `recheck` | skip new findings; only re-verify prior threads; approve if all resolved |
| `focused` | review with a stated focus area passed to all reviewers |
| `answer` | answer a question as a comment; no review |

The message is **untrusted**: it selects only these fixed knobs. It can steer within the safety envelope but can never force an approve — approval still requires the deterministic "zero open threads," where "resolved" is decided by an agent reading the actual code.

---

## 4. Trigger configuration

Each consumer repo controls *when auto-review fires* via `.cc-review.yaml`:

```yaml
trigger: pr_open    # every_push | pr_open | disabled
```

| `trigger` | Auto-reviews on |
|-----------|-----------------|
| `every_push` | PR opened **and** every push to the PR branch (`synchronize`) |
| `pr_open` | PR opened / reopened only |
| `disabled` | never auto-reviews |

**`@cc-review` ping is ALWAYS available**, regardless of `trigger` — even when `disabled`. The `cc-review` label and `workflow_dispatch` are always-available manual overrides; the `no-review` label always suppresses an auto-run.

---

## 5. Repository layout (bot repo)

```
cc-review/
├── SPEC.md                          ← this file (source of truth)
├── README.md                        ← human guide
├── .cc-review.yaml                  ← config template (copied to consumers)
├── .github/workflows/
│   ├── cc-review.yml                ← auto-review (trigger-gated); copied to consumers
│   ├── cc-review-interactive.yml    ← @cc-review ping (always on); copied to consumers
│   └── cc-review-cleanup.yml        ← deletes the log branch on PR close; copied to consumers
├── .claude/workflows/
│   └── strict-review.mjs            ← the entire review brain (self-contained)
├── scripts/
│   ├── review-platform.ts           ← deterministic GitHub/GitLab I/O adapter
│   └── analysis-tools.ts            ← optional static-analysis tool-runner
└── lang-refs/{dotnet,typescript,python,shell}.md   ← strict checklists
```

No `vendor/`, no submodule. Consumers get **three workflow files + one config**; CI clones this bot repo at runtime to get the brain.

---

## 6. GitHub App settings

The bot reviews from a GitHub App (not a personal token), so reviews carry a bot identity and the OAuth token bills against Claude Max.

**Repository permissions:**
| Permission | Level | Why |
|------------|-------|-----|
| Contents | Read & write | push the memory + ephemeral log branches |
| Pull requests | Read & write | read the diff/threads; post reviews; resolve threads |
| Issues | Read & write | post the walkthrough + status comments |
| Metadata | Read | baseline |

**Subscribe to events:** Pull request, Issue comment, Pull request review comment.

**Install on TWO repos** (the marketplace install is no longer required — the bot is self-contained):
1. The target/consumer repo — read PRs, post reviews, push memory/log branches.
2. `Questi0nM4rk/cc-review` — so CI can clone the brain at runtime.

**Secrets on the consumer repo:** `CLAUDE_CODE_OAUTH_TOKEN`, `REVIEWER_APP_ID`, `REVIEWER_APP_PRIVATE_KEY`.

---

## 7. Branches (GitHub bot mode only — GitLab is local-only)

### Project memory — `cc-review:claude-reviewer/memory`
Orphan branch on the bot repo, segregated by `<owner>/<repo>/`, **palace-structured**:
```
<owner>/<repo>/
├── MEMORY.md                  overall index — what this repo is, recurring themes
└── learnings/
    ├── lessons.md             durable lessons for future reviews
    ├── found-issues.md        notable issues found (one bullet per run)
    ├── known-patterns.md      intentional patterns NOT to re-flag (from author replies)
    └── decisions.md           review decisions + rationale
```
Pre-fetched into `/tmp/memory/` before a run, pushed back after (3-attempt retry, per-repo concurrency group). The workflow only writes the files; the GHA pushes.

### Ephemeral log branch — `<source-branch>-cc-review-output` (consumer repo)
Created on PR open, holds every harvested artifact for that run (diff, triage, recon, findings, grades, thread actions, session jsonl) for debugging. **Deleted by `cc-review-cleanup.yml` when the PR state leaves `open`** (closed / merged). 

### Run transcript — `<consumer>:claude-reviewer/transcripts`
Per-PR, last-run-only `session.jsonl` + `meta.json`. Survives PR close (audit trail).

**GitLab local mode pushes NONE of these** — memory and run output stay in local files for you to inspect; only the review/overview is posted to the MR.

---

## 8. Usage

**Automatic** — per `trigger` (section 4).

**Interactive (`@cc-review` ping — always available):**
```
@cc-review                                   # full review of this PR
@cc-review re-check the auth path            # focused review
@cc-review do not review, just check I fixed everything, approve if so   # recheck + conditional approve
@cc-review what does this change do?         # answer-only, no review
```

**Manual:** add the `cc-review` label, or run the workflow via `workflow_dispatch` with a PR number.

---

## 9. Determinism & safety

- Orchestration (fetch → triage → squad selection → dedup → grade → verify → decide → report) is pure JS; only agent calls are stochastic. Same model outputs ⇒ identical control flow.
- Finding format (no severity labels, no emoji, imperative mood) is enforced by the reviewer prompts (the STRICT block) — there is no separate JS validation or rewrite pass.
- The approval gate is deterministic and cannot be overridden by a PR comment.
- Posting is gated on explicit `args.post===true`; the review *engine* is side-effect-free until then.

---

## 10. Build status

- [x] Workflow brain (`strict-review.mjs`) — all phases, intent, difficulty scaling, dynamic squad
- [x] Platform adapter (`review-platform.ts`) — GitHub + GitLab
- [x] Language references (dotnet, typescript/tsgo, python, shell)
- [x] Runtime proven (`claude -p` + Workflow scriptPath)
- [x] `.cc-review.yaml` trigger config (every_push / pr_open / disabled; ping always on)
- [x] `cc-review.yml` — trigger-gated auto-review + memory/log-branch push
- [x] `cc-review-cleanup.yml` — deletes the log branch on PR close
- [x] Adapter prefers the GHA's pre-fetched diff (large-diff robustness)
- [ ] `cc-review-interactive.yml` — the @cc-review ping (always on; passes userMessage)
- [ ] `analysis-tools.ts` tool-runner (semgrep/ast-grep/scc/lizard, graceful)
- [ ] Drop the submodule (`.gitmodules` + `vendor/`)
- [ ] README rewrite + `setup.ts` / `install-to-repo.sh` update
- [ ] Dry-run smoke test against a closed feats-repo PR
