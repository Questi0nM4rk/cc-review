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

On a PR it posts a **pre-review walkthrough** (business + technical summary, a mermaid diagram, and a `Difficulty: N/5` rating), then runs a strict review and posts **one atomic review**. It re-checks its own prior comments on every run — verifying fixes against the actual code — and **approves only when there are zero findings and zero unresolved threads**.

```
PR event / @cc-review ping
        │
  GitHub Actions: clone bot, generate App token, run the workflow headless
        │
  strict-review.mjs  (the whole brain)
   Triage (opus) ─ posts walkthrough + difficulty ─┐ rating scales the rest
   Recon (haiku) → Review (2 opus·xhigh + 0/2/4 sonnet) → Grade → Verify
   Comment-Mgmt (re-check prior threads) → Decide → Post → Memory
        │
  One review (APPROVE / REQUEST_CHANGES) · threads resolved · memory + log branches updated
```

## How review depth scales (token-efficient + pedantic)

The triage difficulty rating (1–5) deterministically picks the path:

| Difficulty | Squad | Extra passes |
|---|---|---|
| 1 (trivial) | 2 opus | — |
| 2–3 (normal) | 2 opus + 2 sonnet | recon, grade |
| 4–5 (hard) | 2 opus + 4 sonnet | recon, grade, per-finding verify |

The 2 opus reviewers are the top-2 domains by a deterministic relevance score for the diff.

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
@cc-review                                    full review
@cc-review re-check the auth path             focused review
@cc-review just verify my fixes and approve   recheck + conditional approve
@cc-review what does this change do?          answer-only, no review
```
The message steers the run within fixed, safe bounds — it can never force an approval (the approval gate verifies fixes against the code).

**Manual** — add the `cc-review` label, or `workflow_dispatch` with a PR number. The `no-review` label suppresses auto-runs.

## Setup

1. **Create the GitHub App** (`./scripts/setup.sh`) with permissions: Contents R/W, Pull requests R/W, Issues R/W, Metadata R; events: PR, Issue comment, PR review comment.
2. **Install the App on two repos**: your target repo, and `Questi0nM4rk/cc-review` (so CI can clone the brain). *(No marketplace install — the bot is self-contained.)*
3. **Add secrets** to the target repo: `CLAUDE_CODE_OAUTH_TOKEN`, `REVIEWER_APP_ID`, `REVIEWER_APP_PRIVATE_KEY`.
4. **Copy the workflow files + config** into the target repo:
   ```bash
   ./scripts/install-to-repo.sh /path/to/your-repo
   ```
   That places `.github/workflows/cc-review.yml`, `cc-review-interactive.yml`, `cc-review-cleanup.yml`, and `.cc-review.yaml`.

## Debugging — branches the bot writes

| Branch | Where | Contents |
|---|---|---|
| `claude-reviewer/memory` | bot repo | per-project palace: `MEMORY.md` + `learnings/{lessons,found-issues,known-patterns,decisions}.md` |
| `<source-branch>-cc-review-output` | your repo | **ephemeral** per-PR run log (diff, session, result); auto-deleted when the PR closes |
| `claude-reviewer/transcripts` | your repo | per-PR last-run `session.jsonl` |

## GitLab / local mode

Where a CI bot app isn't allowed (e.g. corporate GitLab), run it **locally** against an MR. The platform adapter auto-detects GitLab and uses `glab`; the review and walkthrough post to the MR, but **no branches are pushed** — memory and run output stay in local files. Workflows run natively in your interactive session (and you can watch live via Remote Control).

## Troubleshooting

| Symptom | Check |
|---|---|
| Not reviewing | `trigger:` value; the 3 secrets; App installed on target **and** `cc-review` |
| Can't approve | Unresolved threads remain — the gate refuses to approve until every thread is resolved |
| Too noisy / missed something | Add to `known_patterns` / `instructions` in `.cc-review.yaml` |
| Why did it flag X? | The `<branch>-cc-review-output` log branch (while the PR is open) or the transcripts branch |

---

<p align="center"><sub>Built on <a href="https://claude.ai/code">Claude Code</a> — see <a href="SPEC.md">SPEC.md</a> for the full contract.</sub></p>
