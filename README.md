# cc-review

Automated PR code review using Claude Code + GitHub Actions. Reviews every PR for bugs, security issues, and logic errors. Auto-approves clean PRs, requests changes when problems are found.

**No API billing** — uses Claude Max subscription via OAuth token.
**Separate bot identity** — reviews appear from a GitHub App, not your personal account.
**Full Claude Code session** — subagents, skills, memory, slop detection, and `gh` CLI.

## Architecture

```
Bot repo (this repo)              Target repo (your project)
├── .claude/                      ├── .cc-review.yaml  ← you customize this
│   ├── CLAUDE.md                 └── .github/workflows/
│   ├── commands/                     ├── cc-review.yml
│   ├── agents/ (7 agents)            └── cc-review-interactive.yml
│   ├── skills/
│   └── hooks/                   At CI runtime:
└── scripts/                     workflow clones this repo → copies .claude/ → runs Claude
```

Target repos are clean — only 3 files installed. All bot intelligence lives here and is fetched at CI runtime.

## Quick Setup

### Prerequisites
- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated
- [Claude Code](https://claude.ai/code) installed and logged into your Max account
- Admin access to the target GitHub repository

### Automated Setup

```bash
git clone https://github.com/Questi0nM4rk/cc-review.git
cd cc-review
./scripts/setup.sh
```

### Manual Setup

#### 1. Generate Claude OAuth Token
```bash
claude setup-token
```
Copy the `sk-ant-oat01-...` token. Valid for 1 year.

#### 2. Create a GitHub App (bot identity)

1. Go to https://github.com/settings/apps/new
2. **Name**: `your-team-reviewer`
3. **Homepage URL**: your repo URL
4. **Webhooks**: uncheck "Active"
5. **Repository permissions**: Contents (R/W), Issues (R/W), Pull requests (R/W)
6. **Where can this be installed?**: Only on this account
7. Click **Create GitHub App** → note the **App ID**
8. **Private keys** → Generate a private key → save the `.pem` file
9. Click **Install App** → select your repository

#### 3. Add Secrets to Your Repo

| Secret | Value |
|--------|-------|
| `CLAUDE_CODE_OAUTH_TOKEN` | The `sk-ant-oat01-...` token |
| `REVIEWER_APP_ID` | Numeric App ID |
| `REVIEWER_APP_PRIVATE_KEY` | Full `.pem` file contents |

#### 4. Install to Your Repo

```bash
./scripts/install-to-repo.sh /path/to/your/repo
cd /path/to/your/repo
git add -A && git commit -m "Add cc-review bot" && git push
```

## What Gets Installed in Target Repos

Only 3 files — no `.claude/` directory pollution:

```
your-repo/
  .cc-review.yaml                    # Project config (you customize this)
  .github/workflows/
    cc-review.yml                    # Auto + labeled + manual reviews
    cc-review-interactive.yml        # @cc-review mentions
```

The workflows fetch bot intelligence from this repo at CI runtime:
- Commands (review-pr, bug-hunt, simplify-review, memory)
- Agents (slop-researcher, 3 bug scanners, 3 quality scanners)
- Skills (review guidelines + language-specific patterns)
- Hooks (blocks `gh pr review`, enforces single `gh api` call)

## Configuration (.cc-review.yaml)

The only file you customize per project.

```yaml
version: 1
mode: standard          # standard | strict | bug-hunt | simplify
auto_review: true       # Review on PR open
languages:              # Focus review patterns
  - python
  - typescript
ignore_paths:           # Skip these files
  - "docs/**"
  - "*.md"
instructions: |         # Project-specific context
  This is a FastAPI project using SQLAlchemy.
known_patterns:         # False positives to skip
  - "We use broad exception handlers in middleware intentionally"
slop_detection: true    # AI-generated code detection
memory: true            # Persistent memory across reviews
```

## Review Modes

| Mode | Trigger | Focus |
|------|---------|-------|
| **standard** | PR open (default) | Bugs, security, logic errors |
| **strict** | Label `strict` or manual | Zero-tolerance — every finding = required change |
| **bug-hunt** | Label `bug-hunt` or manual | Logic errors, edge cases, integration bugs |
| **simplify** | Label `simplify` or manual | Code reuse, quality, efficiency |

### Interactive Mode
Comment `@cc-review <request>` on any PR:
- `@cc-review` — standard review
- `@cc-review bug-hunt this` — deep bug hunting
- `@cc-review what does this change do?` — explain the PR

## Troubleshooting

### Bot not reviewing
- Check Actions tab → is the workflow running?
- Verify all 3 secrets are set correctly
- Check the GitHub App is installed on the repo

### Bot can't approve
- The GitHub App must be a different identity from the PR author
- Verify the App has `pull-requests: write` permission

### OAuth token expired
- Tokens last 1 year. Regenerate with `claude setup-token`

### Review is too strict / too lenient
- Change `mode` in `.cc-review.yaml`
- Add project-specific `instructions` and `known_patterns`
