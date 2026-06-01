# SPEC-ADAPTIVE: Adaptive cc-review Roadmap

> **Status:** Draft
> **Author:** @Questi0nM4rk
> **Date:** 2026-04-10 (updated 2026-04-13)
> **Inspired by:** CodeRabbit's learnings engine, context engineering pipeline, and verification agents
> **Baseline:** strict-review plugin v1.0.0 (9 Apr 2026 — 5 new pattern files, framework contracts, caveat-aware review)

---

## Problem Statement

cc-review posts useful PR reviews but doesn't learn. Every review starts from scratch — the same false positives recur, developer pushback is forgotten, project conventions are re-discovered. The bot can't respond to developer replies on its review threads, and the review methodology is static (changes require a PR to cc-review itself).

CodeRabbit achieves ~72% finding relevance through retrieval-augmented learning, thread-based feedback capture, and verification agents. cc-review currently has none of these.

## Goals

1. **Dynamic methodology** — review skills loaded from qsm-marketplace at CI runtime, evolving independently from cc-review enforcement layer
2. **Continuous learning** — every PR interaction teaches the bot (accepted findings, false positives, conventions, developer explanations)
3. **Thread response** — bot reads and responds to developer comments on its review findings
4. **Init wrapper** — single entry point that loads context, memory, learnings, and routes to the right review mode
5. **Full memory persistence** — review output, conversation log, and structured learnings saved to memory branch after every review

## Non-Goals

- Vector database or embedding-based RAG (file-based memory on git branch is sufficient at current scale)
- Fine-tuning or weight updates (retrieval-first approach, consistent with CodeRabbit's architecture)
- Multi-repo learning (learnings are per-repo on the memory branch)
- Real-time review (GitHub Actions latency is acceptable)

---

## Architecture

### Static/Dynamic Split

```text
STATIC (cc-review repo — immutable enforcement)     DYNAMIC (qsm-marketplace — evolving methodology)
─────────────────────────────────────────────────    ───────────────────────────────────────────────
hooks/                                               plugins/cc-review-methodology/
  enforce-review-cli.ts (PreToolUse)                   commands/review-pr.md, bug-hunt.md, simplify-review.md
  hook-runtime.ts                                      agents/ (slop-researcher, scanners, verifier)
  hooks.json                                           skills/review-guidelines/SKILL.md
skills/review-guidelines/scripts/                      skills/review-guidelines/references/ (language patterns)
  review-cli.ts (post, approve, status, list)          skills/language-patterns/ (from strict-review)
  diff-lines.ts
  learnings-cli.ts (Phase 3)                         plugins/pr-review/
settings.json                                          scripts/pr-review.ts (threads, resolve, reply, dismiss)
CLAUDE.md (bot identity + runtime instructions)        lib/github.ts (GraphQL operations)
commands/                                              hooks/ (blocks raw gh api for threads)
  cc-review-init.md (init wrapper)
  respond-to-threads.md (thread response)
  extract-learnings.md (learning extraction)
  memory-load.md, memory-save.md
```

### Workflow Assembly

At CI runtime, the workflow clones both repos and merges them:

```text
Target repo .claude/ (assembled at CI time)
├── hooks/
│   ├── hooks.json             ← cc-review (static) + marketplace hooks merged
│   ├── lib/
│   │   └── hook-runtime.ts    ← cc-review (shared hook I/O)
│   └── scripts/
│       ├── enforce-review-cli.ts    ← cc-review (blocks raw gh pr review)
│       └── enforce-review-format.ts ← marketplace (blocks severity labels, COMMENT event, standalone comments — uses shell-ast AST parsing)
├── shared/
│   └── severity-patterns.ts   ← marketplace (regex patterns for hooks + validation)
├── settings.json              ← cc-review
├── CLAUDE.md                  ← cc-review (bot identity)
├── commands/
│   ├── cc-review-init.md      ← cc-review (init wrapper)
│   ├── respond-to-threads.md  ← cc-review (thread response)
│   ├── extract-learnings.md   ← cc-review (learning extraction)
│   ├── memory-load.md         ← cc-review
│   ├── memory-save.md         ← cc-review
│   ├── review-pr.md           ← marketplace/cc-review-methodology
│   ├── bug-hunt.md            ← marketplace/cc-review-methodology
│   └── simplify-review.md     ← marketplace/cc-review-methodology
├── agents/                    ← marketplace/cc-review-methodology
│   ├── slop-researcher.md
│   ├── code-quality-scanner.md  (9 categories incl. framework contracts)
│   ├── security-scanner.md      (4 categories)
│   ├── dependency-tracer.md     (1-hop + serialization contracts)
│   ├── logic-bug-scanner.md     (bug-hunt mode)
│   ├── edge-case-scanner.md     (bug-hunt mode)
│   └── integration-bug-scanner.md (bug-hunt mode)
├── skills/
│   ├── review-guidelines/
│   │   ├── SKILL.md           ← marketplace (12 unified Iron Laws)
│   │   ├── scripts/
│   │   │   ├── review-cli.ts           ← cc-review (static — post, approve, status, list, resolve)
│   │   │   ├── diff-lines.ts           ← cc-review (static — unified diff parser)
│   │   │   ├── learnings-cli.ts        ← cc-review (Phase 3 — extract, query, stats, prune)
│   │   │   └── validate-review-format.ts ← marketplace (post-review format validation)
│   │   └── references/
│   │       ├── github-review-api.md       ← cc-review (review-cli.ts command reference)
│   │       ├── output-format.md           ← marketplace (inline + header format spec)
│   │       ├── strict-review-rules.md     ← marketplace (full methodology + WHY + DON'Ts)
│   │       ├── csharp-patterns.md         ← marketplace (C# + Npgsql/Dapper/EF Core)
│   │       ├── typescript-patterns.md     ← marketplace (TS/JS + React)
│   │       └── python-patterns.md         ← cc-review
│   ├── language-patterns/     ← marketplace (conditional loading)
│   │   ├── SKILL.md
│   │   └── references/
│   │       ├── language-patterns.md       (router/dispatcher)
│   │       ├── universal-patterns.md      (always load)
│   │       ├── error-handling-patterns.md  (always load)
│   │       ├── ai-slop-patterns.md        (always load)
│   │       ├── data-access-patterns.md    (conditional — DB code)
│   │       ├── concurrency-patterns.md    (conditional — async code)
│   │       └── input-validation-patterns.md (conditional — API endpoints)
│   └── pr-review/             ← marketplace/pr-review (thread management)
│       ├── scripts/
│       │   └── pr-review.ts   (threads, resolve, reply, dismiss, status, comments)
│       └── lib/
│           ├── github.ts      (GraphQL queries/mutations)
│           └── types.ts       (Thread, Comment, PrStatus, Review types)
```

**Workflow YAML assembly steps:**

```yaml
- name: Fetch enforcement (cc-review, static)
  run: |
    git clone --depth 1 $CC_REVIEW_REPO /tmp/cc-review-bot
    mkdir -p .claude/{hooks/scripts,hooks/lib,skills/review-guidelines/scripts,commands}
    cp -r /tmp/cc-review-bot/.claude/hooks/* .claude/hooks/
    cp /tmp/cc-review-bot/.claude/skills/review-guidelines/scripts/*.ts .claude/skills/review-guidelines/scripts/
    cp /tmp/cc-review-bot/.claude/settings.json .claude/settings.json
    cp /tmp/cc-review-bot/.claude/CLAUDE.md .claude/CLAUDE.md
    for f in memory-load memory-save extract-learnings respond-to-threads cc-review-init; do
      [ -f /tmp/cc-review-bot/.claude/commands/${f}.md ] && cp /tmp/cc-review-bot/.claude/commands/${f}.md .claude/commands/
    done

- name: Fetch methodology + thread management (qsm-marketplace, dynamic)
  run: |
    git clone --depth 1 $QSM_MARKETPLACE_REPO /tmp/qsm-marketplace
    METH=/tmp/qsm-marketplace/plugins/cc-review-methodology
    # Commands (review-pr, bug-hunt, simplify-review)
    cp $METH/commands/*.md .claude/commands/
    # Agents (7 scanners)
    cp -r $METH/agents .claude/
    # Skills (review-guidelines SKILL.md + references, language-patterns)
    cp $METH/skills/review-guidelines/SKILL.md .claude/skills/review-guidelines/
    mkdir -p .claude/skills/review-guidelines/references
    cp -r $METH/skills/review-guidelines/references/* .claude/skills/review-guidelines/references/
    cp -r $METH/skills/language-patterns .claude/skills/
    # Validation script
    cp $METH/scripts/validate-review-format.ts .claude/skills/review-guidelines/scripts/
    # Shared utilities (severity patterns)
    cp -r $METH/shared .claude/
    # Methodology hooks (enforce-review-format — defense in depth)
    cp $METH/hooks/scripts/*.ts .claude/hooks/scripts/
    # Thread management (pr-review plugin)
    PR=/tmp/qsm-marketplace/plugins/pr-review
    mkdir -p .claude/skills/pr-review/{scripts,lib}
    cp $PR/scripts/pr-review.ts .claude/skills/pr-review/scripts/
    cp $PR/lib/*.ts .claude/skills/pr-review/lib/
```

### Memory Branch Layout (End State)

```text
claude-reviewer/memory (orphan branch in target repo)
├── MEMORY.md                    — human-readable project knowledge (<200 lines)
├── LEARNINGS.json               — structured learnings store (Phase 3)
├── ACCEPTANCE_STATS.json        — finding acceptance rates by category (Phase 3)
├── LAST_REVIEW.json             — last review payload (Phase 0)
├── REVIEW_CONVERSATION.json     — last conversation log (Phase 0)
├── REVIEW_LOG.md                — last review summary
└── NOISE_REPORT.md              — auto-generated noise analysis (Phase 4B)
```

### Review Flow (End State)

```text
PR opened / @cc-review ping
         │
         ▼
  ┌──────────────────────────┐
  │  GitHub Actions           │
  │                           │
  │  Clone cc-review (static) │
  │  Clone marketplace (dyn)  │
  │  Merge .claude/           │
  │  Pre-fetch diff + meta    │
  └──────────┬───────────────┘
             │
             ▼
  ┌──────────────────────────┐
  │  cc-review-init.md        │
  │                           │
  │  Load .cc-review.yaml     │
  │  Load MEMORY.md           │
  │  Load LEARNINGS.json      │
  │  Load LAST_REVIEW.json    │
  │  Route to review command  │
  └──────────┬───────────────┘
             │
             ▼
  ┌──────────────────────────┐
  │  review-pr.md (dynamic)   │
  │                           │
  │  Triage → Slop research   │
  │  Deploy scanner agents    │
  │  [Phase 4A: verify]       │
  │  Filter vs LEARNINGS.json │
  │  Pipe to review-cli.ts    │
  └──────────┬───────────────┘
             │
             ▼
  ┌──────────────────────────┐
  │  Post-review (workflow)   │
  │                           │
  │  Save LAST_REVIEW.json    │
  │  Save REVIEW_LOG.md       │
  │  Extract learnings        │
  │  Push to memory branch    │
  └──────────────────────────┘
```

### Thread Response Flow

```text
Developer replies to bot's review comment
         │
         ▼
  ┌──────────────────────────┐
  │  cc-review-interactive.yml│
  │                           │
  │  Detect: reply to bot     │
  │  comment (not @cc-review) │
  └──────────┬───────────────┘
             │
             ▼
  ┌──────────────────────────┐
  │  respond-to-threads.md    │
  │                           │
  │  Load memory + learnings  │
  │  Load LAST_REVIEW.json    │
  │  Fetch unresolved threads │
  │  via pr-review threads    │
  │                           │
  │  For each new reply:      │
  │  - Classify response      │
  │  - Generate bot reply     │
  │  - pr-review reply        │
  │  - Note learning          │
  └──────────┬───────────────┘
             │
             ▼
  ┌──────────────────────────┐
  │  Extract learnings        │
  │                           │
  │  "this is intentional"    │
  │    → false_positive entry │
  │  "will fix"               │
  │    → accepted finding     │
  │  question                 │
  │    → elaborate, no learn  │
  └──────────────────────────┘
```

---

## Phases

### Phase 0: Foundation — Merge Logging + Cleanup

**Goal:** Establish the data substrate (review logs, conversation tracking) that all later phases depend on.

**Changes in cc-review:**

| File | Action | Detail |
|------|--------|--------|
| `claude/add-review-logging-xcGnC` branch | Merge into main | Adds log/log-dump subcommands to review-cli.ts, REVIEW_CONVERSATION.json, LAST_REVIEW.json |
| `.claude/commands/bug-hunt.md` | Modify | Add conversation log step tracking (parity with review-pr.md) |
| `.claude/commands/simplify-review.md` | Modify | Add conversation log step tracking |
| `.github/workflows/cc-review.yml` | Modify | Save LAST_REVIEW.json + REVIEW_CONVERSATION.json to memory branch |
| `.github/workflows/cc-review-interactive.yml` | Modify | Same |

**Dependencies:** None.

**Test:** `bash tests/integration/run.sh` passes. Dry-run review produces LAST_REVIEW.json and REVIEW_CONVERSATION.json at `/tmp/`.

---

### Phase 1: Dynamic Methodology — Extract to Marketplace

**Goal:** Move all review methodology to qsm-marketplace. cc-review becomes a thin enforcement shell.

**Changes in qsm-marketplace:**

Create `plugins/cc-review-methodology/` in qsm-marketplace. This merges cc-review's review commands with strict-review's agent architecture, all 9 pattern files, and format enforcement — adapted to post via `review-cli.ts` instead of raw `gh api`.

```text
cc-review-methodology/
├── build.yaml
├── commands/
│   ├── review-pr.md              ← merged cc-review flow + strict-review caveat-aware pre-scan
│   ├── bug-hunt.md               ← moved from cc-review
│   └── simplify-review.md        ← moved from cc-review
├── agents/
│   ├── slop-researcher.md        ← moved from cc-review (all modes when slop_detection: true)
│   ├── code-quality-scanner.md   ← from strict-review (9 categories: dead code, duplication,
│   │                                modularity, framework contracts, error handling, data access,
│   │                                concurrency, AI slop, input validation)
│   ├── security-scanner.md       ← from strict-review (injection, auth/crypto, data exposure, config)
│   ├── dependency-tracer.md      ← from strict-review (1-hop blast radius + serialization contracts)
│   ├── logic-bug-scanner.md      ← from cc-review (bug-hunt mode)
│   ├── edge-case-scanner.md      ← from cc-review (bug-hunt mode)
│   └── integration-bug-scanner.md← from cc-review (bug-hunt mode)
│   # NOTE: review-synthesizer.md is NOT included — review-cli.ts replaces it
├── shared/
│   └── severity-patterns.ts      ← from strict-review (regex patterns for hook + validation)
├── skills/
│   ├── review-guidelines/
│   │   ├── SKILL.md              ← merged Iron Laws (cc-review 7 + strict-review 10 → unified set)
│   │   └── references/
│   │       ├── github-review-api.md  ← cc-review (review-cli.ts commands)
│   │       ├── output-format.md      ← from strict-review (inline + header format spec)
│   │       ├── strict-review-rules.md← from strict-review (full methodology + WHY + DON'Ts)
│   │       ├── csharp-patterns.md    ← from strict-review (C# + Npgsql/Dapper/EF Core constraints)
│   │       ├── typescript-patterns.md← from strict-review (TS/JS + React patterns)
│   │       └── python-patterns.md    ← from cc-review
│   └── language-patterns/
│       ├── SKILL.md                  ← from strict-review (conditional loading rules)
│       └── references/
│           ├── language-patterns.md      ← from strict-review (router/dispatcher)
│           ├── universal-patterns.md     ← from strict-review (all-language patterns)
│           ├── error-handling-patterns.md ← from strict-review (exception handling)
│           ├── data-access-patterns.md   ← from strict-review (N+1, unbounded, transactions)
│           ├── concurrency-patterns.md   ← from strict-review (async, deadlocks, shared state)
│           ├── ai-slop-patterns.md       ← from strict-review (over-engineering, scope creep)
│           └── input-validation-patterns.md ← from strict-review (API boundaries, enum casting)
├── hooks/
│   ├── hooks.json                ← from strict-review (enforce-review-format PreToolUse)
│   └── scripts/
│       └── enforce-review-format.ts  ← from strict-review (uses @questi0nm4rk/shell-ast AST parsing)
├── lib/
│   └── hook-runtime.ts           ← from strict-review (shared hook I/O harness)
└── scripts/
    └── validate-review-format.ts ← from strict-review (post-review format validation)
```

#### Iron Laws (Unified Set — merged from cc-review + strict-review)

| # | Law | Source |
|---|-----|--------|
| 1 | Use review-cli.ts for all review operations | cc-review |
| 2 | One tier only — no severity labels, priorities, or rankings | strict-review |
| 3 | Zero findings = APPROVE, any findings = REQUEST_CHANGES | both |
| 4 | Inline on diff lines, header for out-of-diff | strict-review |
| 5 | Every finding needs a failure scenario | cc-review |
| 6 | No dead code, no duplicates, modular code | strict-review |
| 7 | Active dependency tracing (1 hop) | strict-review |
| 8 | Framework contract compliance | strict-review |
| 9 | Caveat-aware review — identify pitfalls BEFORE scanning | strict-review |
| 10 | All findings or none — never drop findings | cc-review |
| 11 | Verify before reporting — check if handled elsewhere | cc-review |
| 12 | No false positives from config — check known_patterns + memory | cc-review |

#### Agent Output Format

All scanner agents output `{file, line, description, in_diff}[]` (strict-review format). The review command converts to `{file, search, body}[]` for review-cli.ts:
- `description` → `body`
- `line` → read file at line, extract unique substring → `search`
- `in_diff: false` → `file: null` (goes to "Outside Diff" section)

**Key difference from strict-review:** No review-synthesizer agent. The review-synthesizer's responsibilities (deduplication, in-diff/out-of-diff separation, atomic posting) are handled by `review-cli.ts post`. This avoids the strict-review pattern of posting via raw `gh api`.

#### Pattern Loading Strategy (from strict-review language-patterns SKILL.md)

| Pattern File | Load When |
|-------------|-----------|
| universal-patterns.md | Always |
| error-handling-patterns.md | Always |
| ai-slop-patterns.md | Always |
| csharp-patterns.md | Diff contains .cs, .csproj, .sln |
| typescript-patterns.md | Diff contains .ts, .tsx, .js, .jsx |
| python-patterns.md | Diff contains .py |
| data-access-patterns.md | Diff touches DB/repository/query code |
| concurrency-patterns.md | Diff touches async, background services, shared state |
| input-validation-patterns.md | Diff touches controllers, handlers, API endpoints |

#### Hooks (self-enforcing)

The marketplace plugin includes its own hooks (from strict-review) that block:
1. **Standalone `gh pr comment`** — must use review API
2. **`gh pr review --comment`** — must be APPROVE or REQUEST_CHANGES
3. **Severity labels** in any review body (via shared/severity-patterns.ts regex)

These layer on top of cc-review's `enforce-review-cli.ts` (defense in depth). The marketplace hook uses `@questi0nm4rk/shell-ast` for AST-based command parsing (not regex).

#### Post-review Validation

After posting, the review command runs `validate-review-format.ts` (from strict-review) to triple-check:
- No severity labels in comments
- No emoji prefixes
- Imperative mood (blocks "Consider...", "This is...", "Maybe...")
- Out-of-diff findings use bold `**\`file:line\`**` format
- Review state matches finding count (APPROVED only if zero comments)
- No standalone PR comments outside the review

**Changes in cc-review:**

| File | Action | Detail |
|------|--------|--------|
| `.claude/commands/review-pr.md` | Remove | Moved to marketplace |
| `.claude/commands/bug-hunt.md` | Remove | Moved to marketplace |
| `.claude/commands/simplify-review.md` | Remove | Moved to marketplace |
| `.claude/skills/review-guidelines/SKILL.md` | Remove | Moved to marketplace |
| `.claude/skills/review-guidelines/references/*.md` | Remove | Moved to marketplace |
| `.claude/agents/*.md` | Remove | Moved to marketplace |
| `.github/workflows/cc-review.yml` | Modify | Two-clone assembly (see Architecture) |
| `.github/workflows/cc-review-interactive.yml` | Modify | Two-clone assembly |
| `.claude/commands/review-pr-fallback.md` | Create | Stripped-down fallback if marketplace unavailable |

**Fallback strategy:** If the marketplace clone fails, the workflow falls back to `review-pr-fallback.md` — a minimal review command that works without agents or language patterns. It loads memory, reads the diff, reviews directly, and posts via review-cli.ts.

**Dependencies:** Phase 0 (logging must be merged first so marketplace commands include log tracking).

**Test:**
1. Simulate CI assembly locally: clone both repos to /tmp, run merge script, verify all paths resolve
2. `tsx review-cli.ts post --dry-run` with assembled .claude/
3. Deploy to test repo, trigger PR review, verify findings post correctly

---

### Phase 2: Bot Init Wrapper + pr-review Integration

**Goal:** Single entry point (init wrapper) that loads all context and routes to the right mode. pr-review plugin provides thread management for developer feedback.

**Changes in cc-review:**

| File | Action | Detail |
|------|--------|--------|
| `.claude/commands/cc-review-init.md` | Create | Init wrapper (see below) |
| `.claude/commands/respond-to-threads.md` | Create | Thread response handler (see below) |
| `.github/workflows/cc-review.yml` | Modify | Add marketplace pr-review plugin to assembly, use init wrapper as entry point |
| `.github/workflows/cc-review-interactive.yml` | Modify | Route thread replies to respond-to-threads.md |
| `.claude/CLAUDE.md` | Modify | Document init wrapper and thread response behavior |

**cc-review-init.md** — The init wrapper:

```markdown
## Step 0: Load Project Config
Read .cc-review.yaml. Apply mode, languages, ignore_paths, instructions, known_patterns.

## Step 1: Load Memory
git show claude-reviewer/memory:MEMORY.md 2>/dev/null
git show claude-reviewer/memory:LEARNINGS.json 2>/dev/null  (Phase 3)
git show claude-reviewer/memory:LAST_REVIEW.json 2>/dev/null

## Step 2: Set Expectations
You are cc-review bot. Your review is posted via review-cli.ts.
Thread management uses pr-review CLI.
After posting, STOP. Memory save is automatic.
For thread responses, classify and reply via pr-review reply.

## Step 3: Route
Based on mode from config/label/dispatch:
- standard/strict → .claude/commands/review-pr.md
- bug-hunt → .claude/commands/bug-hunt.md
- simplify → .claude/commands/simplify-review.md
- thread-response → .claude/commands/respond-to-threads.md
```

**respond-to-threads.md** — Thread response handler:

```markdown
## Step 0: Load Context
Load MEMORY.md + LEARNINGS.json + LAST_REVIEW.json

## Step 1: Fetch Threads
npx tsx .claude/skills/pr-review/scripts/pr-review.ts threads <PR> --repo <REPO>

## Step 2: Identify New Developer Replies
For each unresolved thread, check if there's a reply AFTER the bot's last comment.

## Step 3: Classify and Respond
For each new developer reply:
- "this is intentional" / "by design" → Reply acknowledging, note as false_positive learning
- "will fix" / "good catch" → Reply "Thanks", thread will be resolved when fix is pushed
- Question / "why?" / "can you explain?" → Elaborate on the finding with more context
- Pushback / "I disagree" → Re-examine finding, either retract or provide stronger justification
- Information / "actually it works because..." → Acknowledge, note as convention learning

## Step 4: Post Replies
npx tsx .claude/skills/pr-review/scripts/pr-review.ts reply <PR> <comment-id> --message "..." --no-resolve

## Step 5: Note Learnings
Write learning entries to /tmp/new-learnings.json for the workflow to commit.
```

**Workflow routing logic** — the interactive workflow gets a new detection:

```bash
# Detect if this is a reply to a bot comment (not an @cc-review mention in a new comment)
IS_REPLY_TO_BOT=$(gh api repos/$REPO/pulls/$PR/comments/$COMMENT_ID \
  --jq '.in_reply_to_id // empty' 2>/dev/null)
if [ -n "$IS_REPLY_TO_BOT" ]; then
  # Check if parent comment is from the bot
  PARENT_AUTHOR=$(gh api repos/$REPO/pulls/comments/$IS_REPLY_TO_BOT \
    --jq '.user.login' 2>/dev/null)
  if [[ "$PARENT_AUTHOR" == *"[bot]" ]]; then
    COMMAND="respond-to-threads"
  fi
fi
```

**Dependencies:** Phase 1 (methodology must be in marketplace so init wrapper can route to marketplace commands).

**Test:**
1. Post a review on a test PR
2. Reply to a finding with "this is intentional" — verify bot responds and notes learning
3. Reply with "can you explain?" — verify bot elaborates
4. Reply with "will fix" — verify bot acknowledges

---

### Phase 3: Adaptive Memory — Continuous Learning

**Goal:** Every PR interaction teaches the bot. Structured learnings accumulate on the memory branch and are used to suppress false positives in future reviews.

**Changes in cc-review:**

| File | Action | Detail |
|------|--------|--------|
| `.claude/skills/review-guidelines/scripts/learnings-cli.ts` | Create | Learnings management CLI |
| `.claude/commands/extract-learnings.md` | Create | Post-review learning extraction |
| `.claude/commands/memory-save.md` | Modify | Also commit LEARNINGS.json + ACCEPTANCE_STATS.json |
| `.claude/hooks/scripts/enforce-review-cli.ts` | Modify | Add learnings-cli.ts to allow patterns |
| `.github/workflows/cc-review.yml` | Modify | Add learnings extraction step after review |
| `.github/workflows/cc-review-interactive.yml` | Modify | Same |

**Changes in qsm-marketplace:**

| File | Action | Detail |
|------|--------|--------|
| `plugins/cc-review-methodology/commands/review-pr.md` | Modify | Step 0 loads LEARNINGS.json, Step 5 filters against known false positives |
| `plugins/cc-review-methodology/commands/bug-hunt.md` | Modify | Same |
| `plugins/cc-review-methodology/commands/simplify-review.md` | Modify | Same |

**LEARNINGS.json schema:**

```json
{
  "version": 1,
  "learnings": [
    {
      "id": "L-001",
      "type": "false_positive",
      "pattern": "Broad exception handler in middleware",
      "context": "ASP.NET middleware uses intentional catch-all for global error handling",
      "file_pattern": "Middleware/**",
      "source_pr": 42,
      "developer_response": "This is intentional — middleware is the last line of defense",
      "confidence": 0.9,
      "times_seen": 3,
      "last_seen": "2026-04-01",
      "created": "2026-03-15"
    }
  ]
}
```

**Learning types:**

| Type | Trigger | Effect on future reviews |
|------|---------|--------------------------|
| `false_positive` | Developer says "intentional" / "by design" | Suppress similar findings |
| `accepted_pattern` | Developer says "will fix" / resolves thread after fix | Reinforce — keep flagging |
| `convention` | Developer explains project-specific pattern | Add to known patterns |
| `bug_pattern` | Finding led to actual bug fix | Prioritize in future reviews |

**learnings-cli.ts commands:**

```bash
# Extract learnings from a completed review
tsx learnings-cli.ts extract --repo owner/repo --pr N

# Query learnings by pattern
tsx learnings-cli.ts query --repo owner/repo --pattern "null check"

# Show acceptance stats
tsx learnings-cli.ts stats --repo owner/repo

# Prune stale learnings (>6 months, confidence < 0.5)
tsx learnings-cli.ts prune --repo owner/repo
```

**ACCEPTANCE_STATS.json schema:**

```json
{
  "version": 1,
  "total_findings": 47,
  "accepted": 38,
  "rejected": 9,
  "acceptance_rate": 0.808,
  "by_category": {
    "null_check": { "total": 12, "accepted": 10, "rate": 0.833 },
    "unused_import": { "total": 8, "accepted": 3, "rate": 0.375 }
  },
  "by_file_pattern": {
    "Middleware/**": { "total": 5, "accepted": 1, "rate": 0.2 }
  },
  "last_updated": "2026-04-10"
}
```

**Learning suppression logic** (in review commands):

```text
For each candidate finding:
  1. Check LEARNINGS.json for matching false_positive entries
  2. Match by: file_pattern (glob), pattern text (fuzzy), context similarity
  3. If match found with confidence > 0.8 and times_seen > 1 → suppress
  4. If match found with lower confidence → include but note in review body
  5. Log all suppression decisions for auditability
```

**Dependencies:** Phase 2 (thread responses generate the developer feedback that learnings are extracted from).

**Test:**
1. Complete full review cycle: review → developer responds → extract learnings → verify LEARNINGS.json
2. Next review: verify previously-rejected finding is suppressed
3. Verify acceptance stats accumulate across PRs
4. Edge cases: PR with no threads, only approvals, mixed responses

---

### Phase 4A: Verification Agent (False Positive Reduction)

**Goal:** Validate findings before posting to reduce false positives. CodeRabbit uses verification agents that check surrounding code context.

**Changes in qsm-marketplace:**

| File | Action | Detail |
|------|--------|--------|
| `plugins/cc-review-methodology/agents/finding-verifier.md` | Create | Verification agent |
| `plugins/cc-review-methodology/commands/review-pr.md` | Modify | Add verification step between finding collection and posting |

**finding-verifier.md:**
- Input: candidate findings + full diff + LEARNINGS.json
- For each finding:
  - Read surrounding code (not just diff line)
  - Check if issue is handled elsewhere (Grep for guards, handlers, try-catch)
  - Check against LEARNINGS.json false positive patterns
  - Assign: `confirmed`, `likely_false_positive`, `needs_context`
- Output: filtered findings list (only `confirmed` findings)
- `likely_false_positive` findings logged for learning but not posted

**Turn budget consideration:** Verifier costs 3-5 turns. Skip when diff > 300 lines or remaining turns < 20.

**Dependencies:** Phase 3 (needs LEARNINGS.json for false positive matching).

---

### Phase 4B: Noise Detection

**Goal:** Automatically detect and suppress finding categories with consistently low acceptance rates.

**Changes in cc-review:**

| File | Action | Detail |
|------|--------|--------|
| `.claude/skills/review-guidelines/scripts/learnings-cli.ts` | Modify | Add `noise-report` command |
| `.claude/commands/memory-cleanup.md` | Create | Consolidate learnings, prune stale entries |

**Noise detection rules:**
- Category with < 50% acceptance rate after 5+ findings → auto-suppress, generate warning in NOISE_REPORT.md
- File pattern with < 30% acceptance rate after 3+ findings → auto-suppress for that path
- Learnings older than 6 months with confidence < 0.5 → prune

**Dependencies:** Phase 3 (needs accumulated ACCEPTANCE_STATS.json data).

---

### Phase 4C: Incremental Re-review

**Goal:** When a developer pushes fixes to a PR with existing review, only review the new changes. Auto-resolve findings that were addressed.

**Changes in cc-review:**

| File | Action | Detail |
|------|--------|--------|
| `.github/workflows/cc-review.yml` | Modify | Add `synchronize` trigger, pre-fetch LAST_REVIEW.json |
| `.claude/commands/incremental-review.md` | Create | Incremental review command |
| `.claude/skills/review-guidelines/scripts/review-cli.ts` | Modify | Add `--incremental --prev-review <file>` to `post` subcommand |

**Incremental review logic:**
1. Load LAST_REVIEW.json (previous findings)
2. Compute diff between last-reviewed commit and current HEAD
3. For previous findings:
   - If file+line was modified → finding addressed → auto-resolve thread via pr-review resolve
   - If file+line unchanged → finding still applies → leave thread open
4. Review only new/changed files for new findings
5. Post only net-new findings (skip duplicates of existing unresolved threads)

**`--incremental` flag on review-cli.ts post:**
- Reads previous review payload from `--prev-review` file
- Compares new findings against previous findings (file + body similarity)
- Skips findings that already have an unresolved thread
- Returns list of auto-resolved threads and net-new findings

**Dependencies:** Phase 3 (learnings used during incremental review). Phase 2 (pr-review plugin needed for auto-resolve).

---

## Trade-offs

### Chose: File-based memory on git branch, NOT vector DB

**Why:** cc-review runs in GitHub Actions (ephemeral CI). There's no persistent infrastructure between runs. A git orphan branch survives without external services. LEARNINGS.json is small enough (hundreds of entries, not millions) that linear search with glob matching is fast enough.

**When to reconsider:** If a single repo accumulates > 5,000 learnings and search becomes the bottleneck, consider LanceDB (CodeRabbit's choice) in a container sidecar. The LEARNINGS.json schema is designed to be importable into a vector DB.

### Chose: pr-review plugin for thread management, NOT extending review-cli.ts

**Why:** pr-review already has GraphQL queries, pagination, thread resolution, reply protocol, and its own enforcement hooks. Duplicating this into review-cli.ts creates two implementations to maintain. The plugin is self-enforcing (blocks raw gh api for threads).

**When to reconsider:** If the pr-review plugin's thread response format doesn't match cc-review's needs (e.g., needs structured learning metadata in replies), extend the plugin rather than building a parallel system.

### Chose: Two-repo CI assembly, NOT monorepo

**Why:** The methodology evolves faster than enforcement. Language patterns, agents, and review commands can be updated without touching cc-review's hooks or CLI. Other projects can import the same methodology plugin.

**When to reconsider:** If CI clone failures exceed 1% of runs, merge the methodology back into cc-review and use git submodules instead.

### Chose: Confidence-based suppression with thresholds, NOT hard block

**Why:** Hard-blocking a finding category risks missing real bugs. Confidence scores with thresholds allow gradual learning — a single "this is intentional" reply creates a learning with confidence 0.5, but it takes 3+ consistent rejections to reach the 0.8 suppression threshold.

**When to reconsider:** If developers complain about persistent false positives that should have been suppressed faster, lower the threshold or add an explicit `@cc-review never flag this` command.

### Chose: Sonnet for reviews, NOT Opus

**Why:** 75-turn budget with sonnet handles most PRs. Opus would increase quality but doubles cost and latency. CodeRabbit uses smaller models for high-recall scanning and larger models only for synthesis.

**When to reconsider:** If acceptance rates plateau below 60% and verification agents can't close the gap, try Opus for the synthesis/posting step only (not the scanning agents).

---

## Change Triggers

| Assumption | If this changes | Do this |
|------------|----------------|---------|
| qsm-marketplace is a private repo accessible via PAT | Marketplace goes public or moves org | Update workflow clone URL, remove PAT requirement |
| LEARNINGS.json stays under 1,000 entries per repo | Repo with very active PR flow accumulates 5,000+ | Add TTL-based pruning to learnings-cli.ts, or switch to SQLite on the memory branch |
| Claude Code `--allowedTools` syntax stays stable | CC changes tool permission format | Update workflow `claude -p` invocation |
| pr-review plugin uses `npx tsx scripts/pr-review.ts` | Plugin changes CLI interface | Update respond-to-threads.md and workflow assembly paths |
| GitHub Actions supports 20-min timeout | Reviews need > 20 minutes | Increase timeout or split into two workflow runs (scan → post) |
| Memory branch push uses simple `git push` | Concurrent reviews cause conflicts | Add retry loop with `git pull --rebase` before push |
| strict-review agents output `{file, line, description, in_diff}[]` | Plugin changes output schema | Update agent-to-findings conversion in review commands |
| enforce-review-format.ts uses `@questi0nm4rk/shell-ast` | Package moves or breaks | CI must have shell-ast available; fallback to regex parsing or pin version |
| strict-review has 9 language pattern files (universal, error-handling, data-access, concurrency, ai-slop, input-validation, csharp, typescript + cc-review python) | New pattern files added (e.g., go-patterns, java-patterns) | Add to cc-review-methodology plugin, update language-patterns SKILL.md conditional loading |
| Claude Code hooks support `PreToolUse` with `Bash` matcher | Hook API changes | Update hooks.json registration format |

---

## Testing Strategy

### Phase 0 (Logging)
- **Unit:** `tsx review-cli.ts log --step test --message "hello"` → verify JSON at `/tmp/review-conversation.json`
- **Integration:** `bash tests/integration/run.sh` — existing tests still pass
- **Docker:** `docker build -f tests/integration/Dockerfile -t cc-review-test . && docker run --rm cc-review-test`

### Phase 1 (Marketplace extraction)
- **Assembly test:** Script that simulates CI merge of both repos, verifies all `.claude/` paths resolve
- **Dry-run:** `tsx review-cli.ts post --dry-run` with assembled .claude/ from both repos
- **Live test:** Deploy to test repo, open PR, verify review posts correctly
- **Fallback test:** Block marketplace clone, verify fallback review-pr-fallback.md activates

### Phase 2 (Init wrapper + thread response)
- **Init routing test:** Invoke cc-review-init.md with each mode, verify correct command is selected
- **Thread response test:** Post review on test PR → reply with "this is intentional" → verify bot responds → verify learning noted
- **pr-review integration test:** Verify all pr-review CLI commands work from assembled .claude/ path

### Phase 3 (Adaptive memory)
- **Learnings extraction test:** Complete review cycle → extract → verify LEARNINGS.json populated
- **Suppression test:** Add a false_positive learning → review same pattern → verify suppressed
- **Stats test:** Run multiple reviews → verify ACCEPTANCE_STATS.json accumulates correctly
- **Prune test:** Add stale learnings → run prune → verify removed

### Phase 4
- **4A:** Review PR with known false positive patterns → verify verifier catches them
- **4B:** After 10+ reviews → run noise-report → verify low-acceptance categories flagged
- **4C:** Push fix commit to reviewed PR → verify only new issues commented, fixed issues auto-resolved

---

## Operational Readiness

### Monitoring
- Workflow logs show assembly success/failure for each clone step
- REVIEW_LOG.md captures review status, turn count, and outcome for each run
- ACCEPTANCE_STATS.json provides long-term signal on review quality
- NOISE_REPORT.md (Phase 4B) flags categories needing attention

### Rollback
- **Phase 1 rollback:** Revert workflows to single-clone pattern, restore methodology to cc-review
- **Phase 3 rollback:** Delete LEARNINGS.json from memory branch, review commands fall back to MEMORY.md only
- **Phase 4 rollback:** Each sub-phase is independently removable (verification agent is optional, noise detection is additive, incremental review is a separate trigger)

### Access Requirements
- CI needs a token (PAT or GitHub App) that can read the private qsm-marketplace repo
- The `REVIEWER_APP_PRIVATE_KEY` GitHub App must have `contents: write` to push to memory branch
- pr-review plugin uses `gh` CLI which inherits the `GH_TOKEN` from the workflow

### Capacity
- Turn budget: 75 turns with sonnet. Verification agent (Phase 4A) costs ~5 turns. For diffs > 300 lines, skip verification.
- Memory branch: Single file writes, no concurrency issues for sequential reviews. For parallel reviews on the same repo, add retry logic (see Change Triggers).
- Marketplace clone: ~2s for depth-1 clone. Cached via GitHub Actions if on same runner.

---

## Phase Dependency Graph

```text
Phase 0 (merge logging)
    │
    ├──→ Phase 1 (extract methodology to marketplace)
    │        │
    │        └──→ Phase 2 (init wrapper + pr-review integration)
    │                 │
    │                 └──→ Phase 3 (adaptive memory + learnings)
    │                          │
    │                          ├──→ Phase 4A (verification agent)
    │                          ├──→ Phase 4B (noise detection)
    │                          └──→ Phase 4C (incremental re-review)
```

Each phase is independently deployable and testable. Phase 4 sub-phases can be implemented in any order.

---

## Appendix: CodeRabbit Feature Mapping

| CodeRabbit Feature | cc-review Equivalent | Phase |
|--------------------|----------------------|-------|
| Learnings Store + RAG | LEARNINGS.json on memory branch + confidence-based suppression | 3 |
| Thread-based feedback capture | respond-to-threads.md + pr-review plugin | 2 |
| Verification agents | finding-verifier.md agent | 4A |
| Acceptance rate tracking | ACCEPTANCE_STATS.json + noise detection | 3 + 4B |
| Incremental re-review | incremental-review.md + --incremental flag | 4C |
| Context engineering (1:1 code-to-context) | Pre-fetched diff + memory + learnings + language patterns | 1 + 3 |
| Multi-model agent architecture | Scanner agents (sonnet) + synthesis (sonnet) | 1 |
| Configuration inheritance | .cc-review.yaml per repo | Existing |
| Privacy controls (opt-out) | memory: false in .cc-review.yaml | Existing |
