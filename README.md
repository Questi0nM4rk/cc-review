<p align="center">
  <h1 align="center">cc-review</h1>
  <p align="center">
    Automated, zero-tolerance PR/MR review powered by Claude Code.
    <br />
    <em>One self-contained workflow. Cost-tiered agents, dynamic depth, strict by construction.</em>
  </p>
</p>

<p align="center">
  <strong>No API billing</strong> — Claude Max OAuth token
  &nbsp;&bull;&nbsp;
  <strong>Bot identity</strong> — reviews from a GitHub App
  &nbsp;&bull;&nbsp;
  <strong>Self-contained</strong> — one workflow file, no marketplace/submodule
</p>

> The canonical, exhaustive description lives in **[SPEC.md](SPEC.md)**. This README is the practical guide.

---

## What it does

On a **first review** it posts a **pre-review walkthrough** (business + technical summary, a mermaid diagram, a `Difficulty: N/5`), researches the web + its own memories/docs, runs a strict review, and posts **one atomic review**. On a **re-run** it re-checks its prior comments against the actual code, resolves what's genuinely fixed, and only re-reviews if the code changed significantly. It **approves only when there are zero findings and zero unresolved threads**.

```
PR event / @cc-review ping
        │
  GitHub Actions: clone bot, generate App token, run the workflow headless
        │
  strict-review.mjs  (the whole brain) — first review vs re-run by the overview-comment marker
   FIRST REVIEW
     Holistic review (opus) ─ posts overview + difficulty ─┐ difficulty scales the rest
     Gather (2 web-research agents + memories/docs + static tools)
       → Squad (difficulty-scaled) → Dedup + Check (false-positive filter)
       → Decide → Post → Memory
   RE-RUN
     all prior threads replied?  ─ no → "first finish prev review" (a @cc-review ping overrides)
     yes → Comment-mgmt (resolve/reply) → significant change? → redraw overview in place + re-review · else done
        │
  One review (APPROVE / REQUEST_CHANGES) · threads resolved · memory + log branches updated
```

## What a review looks like

**1 — the overview comment** (posted first, edited in place on significant re-runs):

> <sub>`<!-- cc-review:overview -->`</sub>
> **Difficulty: 3/5** — Adds a `/orders` endpoint that creates an order in Draft and submits it through the outbox dispatch chain.
> ```mermaid
> flowchart LR
>   A["POST /orders"] -->|"create"| B["OrderService"]
>   B -->|"enqueue"| C{"outbox dispatched?"}
>   C -->|"yes"| D["pricing-calculator"]
> ```
> Riskiest area: the synthetic `HttpContext` restoration in the outbox handler.

**2 — inline findings** (every finding is a required change — no severity labels, no "nits"):

> **`src/OrdersController.cs:42`** — Validate `request.CustomerId > 0` before the lookup; an unset id currently reaches the repository and returns the first row.

**3 — the verdict** — `REQUEST_CHANGES` until every thread is resolved and there are zero findings; otherwise `APPROVE`. On a re-run it replies `Fixed: …` / `Dismissed: …` on each prior thread first.

## How review depth scales (token-efficient + pedantic)

The holistic-review difficulty rating (1–5) deterministically picks the path:

| Difficulty | Squad (opus·xhigh anchors + sonnet specialists) | Extra passes |
|---|---|---|
| 1 (trivial) | 1 opus | — |
| 2 | 1 opus + 1 sonnet | gather, dedup + check |
| 3 | 2 opus | gather, dedup + check |
| 4 | 2 opus + 1 sonnet | gather, dedup + check |
| 5 (hard) | 2 opus + 2 sonnet | gather, dedup + check |

The opus reviewers are the top domains by a deterministic relevance score for the diff. "Gather" = the two web-research agents + memories/docs + static tools; "check" = the single false-positive-filter agent (it replaces the older separate grade + verify passes).

## Configuration — `.cc-review.yaml`

```yaml
trigger: pr_open    # every_push | pr_open | disabled
languages: [csharp, typescript]
ignore_paths: ["docs/**", "**/*.md"]
instructions: "Wolverine handles durable messaging — don't flag the queue indirection."
known_patterns: ["Broad exception handlers in middleware are intentional."]
```

| `trigger` | Auto-reviews on |
|---|---|
| `every_push` | PR open **and** every push to the branch |
| `pr_open` | PR open / reopen only (default) |
| `disabled` | never — only the `@cc-review` ping |

## Using it

**Automatic** — per `trigger`.

**`@cc-review` ping — ALWAYS available**, even when `trigger: disabled`:
```
@cc-review                                    review now — and override the re-review gate
@cc-review what does this change do?          answer-only, no review
```
The only intent the message selects is **answer-only** (a question → a reply, no review). On a re-run it also **overrides** the "finish the previous review first" gate. It can never force an approval — the gate approves only on zero findings and zero unresolved threads, verified against the code.

**Manual** — add the `cc-review` label, or `workflow_dispatch` with a PR number. The `no-review` label suppresses auto-runs.

## Setup — GitHub (CI + App)

*(GitLab is local-only — see [GitLab — local mode](#gitlab--local-mode) below.)*

1. **Create the GitHub App** (`./scripts/setup.sh`) with permissions: Contents R/W, Pull requests R/W, Issues R/W, Metadata R. No webhook events are needed — the bot runs from your repo's own GitHub Actions (`pull_request` / `issue_comment`); the App only provides the review identity + token.
2. **Install the App on All repositories** (account-wide — current & future repos) or, at minimum, your target repo *and* `Questi0nM4rk/cc-review` (so CI can clone the brain). *(No marketplace install — the bot is self-contained.)*
3. **Add secrets** to the target repo: `CLAUDE_CODE_OAUTH_TOKEN`, `REVIEWER_APP_CLIENT_ID`, `REVIEWER_APP_PRIVATE_KEY`.
4. **Copy the workflow files + config** into the target repo:
   ```bash
   ./scripts/install-to-repo.sh /path/to/your-repo
   ```
   That places `.github/workflows/cc-review.yml`, `cc-review-interactive.yml`, `cc-review-cleanup.yml`, and `.cc-review.yaml`.

## Debugging — branches the bot writes

| Branch | Where | Contents |
|---|---|---|
| `claude-reviewer/memory` | bot repo | per-project learnings: `MEMORY.md` + `learnings/{lessons,found-issues,known-patterns,decisions}.md`; and a tiny per-PR `<owner>/<repo>/pr-<N>/review-state.json` marker (head sha + file count) the significant-change check diffs against |
| `pr-<N>-cc-review-output` | your repo | **ephemeral** per-PR run log (diff, session, result); gitleaks-scanned before push; auto-deleted when the PR closes |

## GitLab — local mode

The engine (brain + adapter) is shared; only the **entry point** differs by platform:

| | How it runs | Posts as |
|---|---|---|
| **GitHub** | **CI** — install the workflows ([Setup](#setup--github-ci--app)); the App reviews on `pull_request` / `@cc-review` | the `cc-review` App |
| **GitLab** | **local** — `scripts/run-gitlab.sh --mr <iid>`, from inside your repo clone | you (your `glab` creds) |

There is no GitLab App or CI install (so it works where a CI bot app isn't allowed — e.g. corporate GitLab). Run from inside a clone of the GitLab repo:

```bash
glab auth login --hostname gitlab.example.com   # once
scripts/run-gitlab.sh --mr 42                    # review MR !42 and post to it
scripts/run-gitlab.sh --mr 42 --dry-run          # review only, post nothing
scripts/run-gitlab.sh --mr 42 --message "focus on the auth change"
```

The adapter auto-detects GitLab and uses `glab`; the review + walkthrough post to the MR, but **no branches are pushed** — review memory stays in a local `.cc-memory/` (add it to `.gitignore`). The runner **refuses to run on a GitHub repo** — use the CI workflows there. For a quick no-post smoke test on any diff (either platform), `scripts/run-local.sh` is the dry-run harness.

## Troubleshooting

| Symptom | Check |
|---|---|
| Not reviewing | `trigger:` value; the 3 secrets; App installed on target **and** `cc-review` |
| Can't approve | Unresolved threads remain — the gate refuses to approve until every thread is resolved |
| Too noisy / missed something | Add to `known_patterns` / `instructions` in `.cc-review.yaml` |
| Why did it flag X? | The `pr-<N>-cc-review-output` log branch (while the PR is open) — it holds the diff, session, and result for that run |

---

<p align="center"><sub>Built on <a href="https://claude.ai/code">Claude Code</a> — see <a href="SPEC.md">SPEC.md</a> for the full contract.</sub></p>
