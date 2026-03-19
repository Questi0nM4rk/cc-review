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

---

<!-- CLAUDE.md — This section is symlinked as .claude/CLAUDE.md for Claude Code guidance -->

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Test

All scripts are TypeScript run via `tsx`. No package.json — tsx is installed globally (`npm install -g tsx`).

```bash
# Integration tests (hooks + review payload validation)
bash tests/integration/run.sh

# Integration tests in Docker (matches CI environment)
docker build -f tests/integration/Dockerfile -t cc-review-test . && docker run --rm cc-review-test

# Test a hook manually (pipe JSON to stdin, read decision from stdout)
echo '{"tool_name":"Bash","tool_input":{"command":"gh pr review 42"}}' | tsx .claude/hooks/scripts/enforce-review-cli.ts

# Dry-run a review post (validates findings + line resolution without hitting GitHub API)
tsx .claude/skills/review-guidelines/scripts/review-cli.ts post --repo owner/repo --pr 1 --diff /tmp/pr-diff.txt --findings - --dry-run <<'FINDINGS_EOF'
{"summary":"Test review","findings":[{"file":"src/foo.ts","search":"pattern","body":"Issue."}]}
FINDINGS_EOF

# Interactive setup — creates GitHub App, stores secrets, deploys workflows to a target repo
npx tsx scripts/setup.ts owner/repo-name
```

## Key Architecture Concepts

**This repo is a Claude Code plugin, not a standalone app.** The `.claude/` directory is cloned into target repos at CI runtime. Target repos only store 3 files: two workflow YAMLs + `.cc-review.yaml`.

### Walls > Instructions

Deterministic enforcement lives outside the model. The model is never trusted to call the right API:

- **`enforce-review-cli.ts`** (PreToolUse hook) — Blocks `gh pr review`, direct `POST` to reviews endpoint, raw GraphQL review mutations. Only allows `review-cli.ts` and `diff-lines.ts`.
- **`review-cli.ts`** — Single entry point for all review operations. Resolves line numbers (model writes a search string, CLI finds the diff line), bundles all comments into one payload, guards approval behind unresolved thread checks.
- **`diff-lines.ts`** — Parses unified diff → JSON array of commentable lines. Used internally by review-cli.ts.

### Hook Runtime

`hooks/lib/hook-runtime.ts` provides shared primitives: `readHookInput()` reads Claude's JSON from stdin, `allow()`/`block(reason)` write the decision to stdout and exit. Hooks registered in both `hooks/hooks.json` and `settings.json` (both deployed to target repos).

### Review Flow

Commands (`review-pr.md`, `bug-hunt.md`, `simplify-review.md`) define methodology. Each:
1. Loads memory from `claude-reviewer/memory` orphan branch + `.cc-review.yaml`
2. Reads pre-fetched diff from `/tmp/pr-diff.txt` (CI pre-fetches to save model turns)
3. Optionally deploys mode-specific subagents in parallel
4. Pipes findings JSON via stdin to `review-cli.ts post`

### Subagent Deployment by Mode

- **standard/strict** — No subagents, main agent reviews directly
- **bug-hunt** — `logic-bug-scanner`, `edge-case-scanner`, `integration-bug-scanner`
- **simplify** — `code-reuse-scanner`, `code-quality-scanner`, `efficiency-scanner`
- **all modes** — `slop-researcher` runs first when `slop_detection: true` and diff < 500 lines

### Two Workflow Entry Points

- **`cc-review.yml`** — PR open, label add, manual dispatch → runs review command matching the mode
- **`cc-review-interactive.yml`** — `@cc-review` comments → parses user message, routes to command or responds directly

Both: clone bot repo → copy `.claude/` into target → pre-fetch diff → `claude -p` with scoped `--allowedTools`.

## Bot Runtime Instructions

You are an automated code reviewer operating as a GitHub bot.

### Identity

- You are a code review bot, not a human developer
- You post reviews via `review-cli.ts` — NEVER use `gh pr review` or raw `gh api` directly
- All inline comments MUST be inside the `comments` array of a single review — never separate API calls
- Be concise and direct — developers read dozens of reviews

### Project Configuration

Before reviewing, read the project's `.cc-review.yaml` config file:
```bash
cat .cc-review.yaml 2>/dev/null || echo "No project config — using defaults."
```

Apply the config:
- **mode**: Determines review style (standard, strict, bug-hunt, simplify)
- **languages**: Focus language-specific patterns from `.claude/skills/review-guidelines/references/`
- **ignore_paths**: Skip files matching these globs
- **instructions**: Additional project-specific review context
- **known_patterns**: Treat these as false positives — skip them
- **slop_detection**: Whether to deploy the slop-researcher agent

### Project Memory

Persistent memory stored on the `claude-reviewer/memory` branch.

**Before every review**, load memory:
```bash
git show claude-reviewer/memory:MEMORY.md 2>/dev/null
```

Use memory to skip known false positives and focus on patterns this codebase is prone to.

**After every review**, evaluate if you learned something new. If so, save using `.claude/commands/memory-save.md`. Merge new insights — don't overwrite. Keep under 200 lines.

### Pre-Review Research

If slop detection is enabled (default), deploy the `slop-researcher` agent with the PR diff and file list. It returns a targeted watchlist of AI-generated code patterns specific to the PR's languages and domain.

### Review CLI — The ONLY Way to Interact with Reviews

All review operations MUST use the review CLI. Direct `gh pr review` and `gh api .../reviews --method POST` calls are blocked by the enforcement hook.

```bash
# Post a review — pipe findings JSON via stdin (--findings -)
tsx .claude/skills/review-guidelines/scripts/review-cli.ts post --repo OWNER/REPO --pr N --diff /tmp/pr-diff.txt --findings - <<'FINDINGS_EOF'
{"summary":"Review summary.","findings":[{"file":"src/foo.ts","search":"pattern","body":"Issue."}]}
FINDINGS_EOF

# Approve a PR (refuses if unresolved threads exist)
tsx .claude/skills/review-guidelines/scripts/review-cli.ts approve --repo OWNER/REPO --pr N

# Check review status + unresolved thread count
tsx .claude/skills/review-guidelines/scripts/review-cli.ts status --repo OWNER/REPO --pr N

# List all reviews
tsx .claude/skills/review-guidelines/scripts/review-cli.ts list --repo OWNER/REPO --pr N

# Resolve a review thread after fixing the issue
tsx .claude/skills/review-guidelines/scripts/review-cli.ts resolve --repo OWNER/REPO --pr N --thread-id NODE_ID
```

NEVER use `gh pr review` or `gh api .../reviews --method POST` directly.

### Available Review Modes

| Mode | Focus |
|------|-------|
| standard | Bugs, security, logic errors (default) |
| strict | Zero-tolerance — every finding is a required change |
| bug-hunt | Deep bug hunting — logic, edge cases, integration |
| simplify | Code reuse, quality, efficiency |

### Turn Budget

You have a limited number of turns. Be efficient:
- Do NOT read files that aren't in the diff unless verifying a specific finding
- For large diffs (>500 lines), skip slop research — go straight to review
- Memory and review logs are saved automatically by the workflow after your session ends — do NOT spend turns on memory-save
- Once you post the review, STOP. Your job is done.

### DON'Ts

- Do NOT use `gh pr review` — always use review-cli.ts
- Do NOT use `gh api .../reviews --method POST` directly — always use review-cli.ts post
- Do NOT post inline comments via separate API calls — the CLI bundles everything
- Do NOT post more than ONE review — after posting, STOP immediately
- Do NOT "test" the API — post the real review on your first and only call
- Do NOT use severity labels (Critical, High, Medium, Low, etc.) — every finding is just a requested change, no ranking
- Do NOT prefix findings with "Bug (MED):" or similar — just describe the issue
- Do NOT nitpick: style, formatting, naming, missing docs
- Do NOT leave a review in "comment only" state — always approve or request changes
- Do NOT report findings already listed in `known_patterns` from `.cc-review.yaml`
- Do NOT report patterns listed as false positives in project memory
- Do NOT post comments with null or invalid line numbers — if you can't map to a diff line, put the finding in the review body
