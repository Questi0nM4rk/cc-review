<p align="center">
  <h1 align="center">cc-review</h1>
  <p align="center">
    Automated PR code review powered by Claude Code + GitHub Actions
    <br />
    <em>Inline comments on exact diff lines. Requests changes or approves. Learns from your codebase.</em>
  </p>
</p>

<p align="center">
  <strong>No API billing</strong> &mdash; Claude Max subscription via OAuth token
  &nbsp;&bull;&nbsp;
  <strong>Bot identity</strong> &mdash; reviews from a GitHub App, not your account
  &nbsp;&bull;&nbsp;
  <strong>Full Claude session</strong> &mdash; subagents, skills, memory, slop detection
</p>

---

## How It Works

```
PR opened / @cc-review ping
         │
         ▼
  ┌─────────────────────────┐
  │   GitHub Actions         │
  │                          │
  │  Clone bot repo          │
  │  Copy .claude/ into repo │
  │  Pre-fetch PR diff       │
  └──────────┬──────────────┘
             │
             ▼
  ┌─────────────────────────┐
  │   Claude Code Session    │
  │                          │
  │  Load .cc-review.yaml    │
  │  Load persistent memory  │
  │  Deploy slop-researcher  │
  │  Analyze diff + patterns │
  └──────────┬──────────────┘
             │
             ▼
  ┌─────────────────────────┐
  │   review-cli.ts post     │
  │                          │
  │  Findings JSON in        │
  │  → Resolve line numbers  │
  │  → Build review payload  │
  │  → Post APPROVE or       │
  │    REQUEST_CHANGES       │
  └─────────────────────────┘
```

## Architecture

```
Bot repo (this)                     Target repo (yours)

├── .claude/                        ├── .cc-review.yaml      ← customize this
│   ├── CLAUDE.md                   └── .github/workflows/
│   │                                   ├── cc-review.yml
│   ├── commands/                       └── cc-review-interactive.yml
│   │   ├── review-pr.md
│   │   ├── bug-hunt.md            Only 3 files. Everything else
│   │   ├── simplify-review.md     is fetched from the bot repo
│   │   ├── memory-load.md         at CI runtime.
│   │   └── memory-save.md
│   │
│   ├── agents/
│   │   ├── slop-researcher.md
│   │   ├── logic-bug-scanner.md
│   │   ├── edge-case-scanner.md
│   │   ├── integration-bug-scanner.md
│   │   ├── code-quality-scanner.md
│   │   ├── code-reuse-scanner.md
│   │   └── efficiency-scanner.md
│   │
│   ├── skills/review-guidelines/
│   │   ├── scripts/
│   │   │   ├── review-cli.ts      ← review lifecycle CLI
│   │   │   └── diff-lines.ts      ← diff parser
│   │   └── references/
│   │       ├── python-patterns.md
│   │       ├── typescript-patterns.md
│   │       └── csharp-patterns.md
│   │
│   └── hooks/
│       └── scripts/
│           └── enforce-review-cli.ts
│
└── scripts/
    ├── setup.sh / setup.cmd
    └── install-to-repo.sh
```

---

## Review CLI

> **Principle: Walls > Instructions.** Everything deterministic is enforced outside the model.

The model never calls `gh pr review` or raw GitHub API endpoints. All review operations go through `review-cli.ts` — a PreToolUse hook blocks any attempt to bypass it.

```
review-cli.ts <command> --repo owner/repo --pr N [options]
```

| Command | What it does |
|---------|-------------|
| **`post`** | Resolve findings to diff lines, build payload, post review |
| **`approve`** | Approve PR (refuses if unresolved threads exist) |
| **`status`** | Latest review state + unresolved thread count |
| **`list`** | List all reviews on a PR |
| **`resolve`** | Resolve a review thread via GraphQL |

<details>
<summary><strong>Why not let the model call the API directly?</strong></summary>

<br />

Models hallucinate line numbers, post multiple partial reviews, and skip safety checks before approving. The CLI makes these mistakes structurally impossible:

- **Line resolution** — Model writes a search string, CLI finds the exact diff line
- **Single review** — CLI bundles all inline comments into one payload
- **Approval guard** — CLI queries GraphQL for unresolved threads first
- **Enforcement** — `enforce-review-cli.ts` hook blocks `gh pr review`, direct API `POST`s to the reviews endpoint, and raw GraphQL review mutations

</details>

---

## Quick Setup

### Prerequisites

- [GitHub CLI](https://cli.github.com/) (`gh`) — installed and authenticated
- [Claude Code](https://claude.ai/code) — logged into your Max account
- Admin access to the target repository

### One-liner

```bash
git clone https://github.com/Questi0nM4rk/cc-review.git && cd cc-review && ./scripts/setup.sh
```

<details>
<summary><strong>Manual setup steps</strong></summary>

#### 1. Generate Claude OAuth Token
```bash
claude setup-token
```
Copy the `sk-ant-oat01-...` token. Valid for 1 year.

#### 2. Create a GitHub App

Go to [github.com/settings/apps/new](https://github.com/settings/apps/new):

| Setting | Value |
|---------|-------|
| Name | `your-team-reviewer` |
| Webhooks | Uncheck "Active" |
| Permissions | Contents (R/W), Issues (R/W), Pull requests (R/W) |
| Install scope | Only on this account |

After creating: note the **App ID**, generate a **private key** (`.pem`), and **install** on your repo.

#### 3. Add Secrets

| Secret | Value |
|--------|-------|
| `CLAUDE_CODE_OAUTH_TOKEN` | The `sk-ant-oat01-...` token |
| `REVIEWER_APP_ID` | Numeric App ID |
| `REVIEWER_APP_PRIVATE_KEY` | Full `.pem` file contents |

#### 4. Install

```bash
./scripts/install-to-repo.sh /path/to/your/repo
cd /path/to/your/repo
git add -A && git commit -m "Add cc-review bot" && git push
```

</details>

---

## Configuration

Create `.cc-review.yaml` in your repo root:

```yaml
version: 1
mode: standard            # standard | strict | bug-hunt | simplify
auto_review: true         # Review on PR open

languages:
  - python
  - typescript

ignore_paths:
  - "docs/**"
  - "**/*.md"

instructions: |
  FastAPI project using SQLAlchemy.
  All subprocess calls must use `uv run`.

known_patterns:
  - "We use broad exception handlers in middleware intentionally"

slop_detection: true      # AI-generated code detection
memory: true              # Learn from past reviews
```

---

## Review Modes

| Mode | Trigger | Focus |
|:-----|:--------|:------|
| **standard** | PR open *(default)* | Bugs, security, logic errors |
| **strict** | Label `strict` / manual | Zero-tolerance — every finding is a required change |
| **bug-hunt** | Label `bug-hunt` / manual | Logic errors, edge cases, integration bugs |
| **simplify** | Label `simplify` / manual | Code reuse, quality, efficiency |

### Interactive

Comment on any PR to talk to the bot:

```
@cc-review                          # standard review
@cc-review bug-hunt this            # deep bug hunting
@cc-review what does this change?   # explain the PR
```

---

## Agents

Specialized subagents are deployed depending on the review mode:

| Agent | Mode | Focus |
|:------|:-----|:------|
| **slop-researcher** | *all* | AI-generated code patterns |
| **logic-bug-scanner** | bug-hunt | Deep logic error analysis |
| **edge-case-scanner** | bug-hunt | Boundaries, off-by-one, null handling |
| **integration-bug-scanner** | bug-hunt | Cross-component interaction bugs |
| **code-quality-scanner** | simplify | Dead code, complexity, naming |
| **code-reuse-scanner** | simplify | Duplication and abstraction |
| **efficiency-scanner** | simplify | Performance and resource usage |

---

## Memory

The bot maintains a persistent memory branch (`claude-reviewer/memory`) in the target repo when `memory: true`. It learns:

- **False positives** specific to your codebase
- **Bug patterns** your code is prone to
- **Conventions** and architectural decisions

Memory is loaded before every review and updated when the bot learns something new.

---

## Troubleshooting

<details>
<summary>Bot not reviewing</summary>

- Check the Actions tab — is the workflow running?
- Verify all 3 secrets are set correctly
- Check the GitHub App is installed on the repo
</details>

<details>
<summary>Bot can't approve</summary>

- The GitHub App must be a different identity from the PR author
- Verify the App has `pull-requests: write` permission
</details>

<details>
<summary>OAuth token expired</summary>

Tokens last 1 year. Regenerate with `claude setup-token`.
</details>

<details>
<summary>Review is too strict / too lenient</summary>

- Change `mode` in `.cc-review.yaml`
- Add project-specific `instructions` and `known_patterns`
</details>

---

<p align="center">
  <sub>Built with <a href="https://claude.ai/code">Claude Code</a></sub>
</p>
