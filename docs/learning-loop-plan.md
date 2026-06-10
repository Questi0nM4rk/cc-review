# Learning loop — assessment + executable plan

> Reference doc for anyone (human or agent) working on cc-review's "memory." Discussion history:
> issue #54. Tracking: #24. **TL;DR: today the memory is a noise-suppressor + a log, not a learner.
> This doc says so honestly, then lays out the build to make it actually learn.**

Distribution tags used throughout (the load-bearing lesson — see `docs/lessons-learned.md`):
- **[RC] runtime-cloned** — the brain (`.claude/workflows/strict-review.mjs`) + `scripts/*` are cloned
  fresh from cc-review `main` every consumer run → a change lands on all consumers on their next run,
  no re-install.
- **[CI] consumer-installed** — `.github/workflows/*.yml` are copies inside each consumer repo → a
  change needs a per-repo PR to take effect (like the timeout / author-guard rounds).

---

## 1. Honest current state

cc-review's memory (`claude-reviewer/memory` → `<owner>/<repo>/` → `MEMORY.md`,
`learnings/{found-issues,lessons,known-patterns,decisions}.md`, `pr-<N>/review-state.json`) is read
into every review, but it does **not** improve the bot's ability to find bugs over time.

**The one real closed loop (genuine, narrow):** a reviewer flags X → author replies "intentional" /
fixes it → `commentMgmtPrompt` validates the reply **against the code** → if genuinely intentional it
records a `known_pattern` (the bot's own words, code-verified) → `memDocsPrompt` loads it → `checkPrompt`
treats matches as false-positive. Effect: it stops re-flagging the same dismissed thing on the same
repo. Real — but it learns *what not to say*, not how to find bugs.

**Logging dressed as learning:** `found-issues.md` / `lessons.md` / `decisions.md` are injected as soft
context; nothing measures whether they improve the next review. A weak prior, not a signal.

**Not learning at all:** the gather-phase web searches are per-review and *not* cached across runs (the
cache was cut in #8); the core capability is the model + static prompts (a fixed ceiling).

**The core gap:** there is **no ground-truth signal on review quality.** The bot discards every outcome
except a code-verified intentional dismissal — it never learns "this finding was ignored as noise" or
"I approved a PR that was hotfixed two days later." Calling this "learning" would be overselling it.

---

## 2. Executable plan

Sequenced so each phase ships and verifies independently.

### Phase 0 — Instrument findings (foundation) · [RC] · S
Make every posted finding addressable.
- The Post phase already stamps `pr-<N>/review-state.json`. **Also emit `pr-<N>/findings.json`:**
  `[{id, file, line, domain, event, posted_head_sha, posted_at}]`, `id` = the existing `fnv1a32`
  finding hash. Write it via `cat` heredoc into `.cc-memory/pr-<N>/` (the slice path already used).
- **Verify:** a posted review leaves a `findings.json` with one entry per inline finding; ids match the
  `<!-- cc-review:review … -->` markers.
- **Depends on:** nothing. Ship first.

### Phase 1 — Harvest outcomes on PR close (the smallest real loop) · [RC] script + [CI] trigger · M
Record each finding's fate — the data the bot throws away today.
- **New [RC] `scripts/harvest-outcomes.ts`** (`repo`, `pr`): read `pr-<N>/findings.json`, classify each:
  - **fixed** — thread resolved AND the `file:line` region changed between `posted_head_sha` and the
    merge SHA (`git diff posted_head_sha..MERGE -- file`);
  - **dismissed** — resolved with a `Dismissed:` reply / `known_pattern` exists;
  - **ignored** — thread still open at merge (strong "noise" signal).
  Append to `learnings/outcomes.jsonl` (`{id, pr, domain, verdict, at}`) and push the slice.
- **[CI] `cc-review-cleanup.yml`** already fires on `pull_request: closed` and mints the App token →
  clone cc-review (as the other workflows do) and run `harvest-outcomes.ts` **before** deleting the log
  branch. *This is the one consumer-workflow change → distribute via per-repo PR.*
- **Verify:** close a test PR with findings → `outcomes.jsonl` gains a sane row per finding, confirmed
  against GitHub ground truth (not the harvester's word).
- **Depends on:** Phase 0.

### Phase 2 — Feed calibration back into reviews (close the loop) · [RC] · M
The recalled signal must **change behavior**, not be soft context.
- `buildProjectContext()` gains a **calibration block**: read `outcomes.jsonl` (rolling window),
  compute per-domain `ignored_rate` / `fixed_rate`, inject explicit numbers — e.g. *"Calibration (this
  repo, last N): performance 82% ignored → raise the bar; security 90% fixed → keep flagging."* Thread
  into `checkPrompt` (bias skepticism on high-ignored domains) and optionally `pickSquad` / difficulty floor.
- **Guardrails (non-negotiable):** **floor** the suppression (down-weight, never silence a domain);
  **decay** old outcomes; keep the calibration text **visible** in `projectContext` (auditable).
- **Verify:** seeded high-ignored `performance` history → calibration line appears → check pass is
  stricter on perf, unchanged on security. Add a `helpers.test.mjs` case for the rate math + flooring.
- **Depends on:** Phase 1.

### Phase 3 — Cold-start backfill from recent PRs (warm start) · [RC] · M
A new repo's first review should start with priors, not cold. **Ship this first — it's independent and
the fastest visible win.**
- **New [RC] `backfill-memory` step:** fetch last **N=5** (configurable) merged PRs
  (`gh pr list --state merged --limit 5`); per PR read diff + review threads + resolutions + follow-up
  commits; an agent synthesizes into the slice: conventions, recurring issues, **code-verified**
  known_patterns (from human dismissals), review-culture notes.
- **Trigger [RC]:** in `ci-run.sh`, detect "no memory slice for this repo" (staged `.cc-memory` empty)
  → run backfill once before the review. Plus a manual/scheduled refresh.
- **Bound cost:** N configurable; once per repo + occasional refresh; cap synthesized output.
- **Verify:** point at a repo with no slice → slice gains conventions + ≥1 code-verified known_pattern
  from a real prior dismissal; first review cites repo-specific context it couldn't have had cold.
- **Depends on:** nothing (learns from **humans**, not the bot's own outcomes — complements Phases 1–2).

### Phase 4 — Miss capture / false negatives · [RC] · L · lowest confidence
The only path to learning what the bot *missed*.
- Heuristic in `harvest-outcomes.ts`: a later **fix/revert/hotfix PR** touching lines in a file the bot
  reviewed **clean/APPROVED** → record a `miss` candidate `{file, area, ref_pr}` → feeds Phase 2.
- **Verify:** a contrived fix-PR over a previously-clean file produces a `miss` row; calibration nudges
  that area's scrutiny up.
- **Depends on:** Phases 1–2.

---

## 3. Safety rails (all phases)
- **Untrusted history** (old comments/diffs) → fence with `untrustedBlock` + verify against code; never
  trust comment text (same posture as the live author reply).
- **Overfit / feedback collapse** → code-verify suppressions; **decay**; **floor** so no domain goes
  silent; **alert** when a domain's flag-rate hits zero.
- **Bounded slice** → keep the curation cap; `outcomes.jsonl` rolls/decays.

## 4. "It's working" = measurable
- `learnings/calibration.md`, maintained by the memory agent: per-domain precision (fixed/flagged) +
  ignored-rate, trended over a window.
- **Acceptance:** ignored-rate / false-positive-rate **decline** over time on a repo; a new repo's first
  review is demonstrably better-grounded than cold; suppression never zeroes a domain.

## 5. Sequencing
`Phase 0 → 1 → 2` is the critical path (the real quality loop — learns from **reality**). **Phase 3
(backfill) is independent — ship first** for the fastest felt win (learns from **humans**). Phase 4 last.
Only **Phase 1's `cc-review-cleanup.yml` edit needs per-repo distribution**; everything else is [RC] and
reaches all consumers on next run.

The spine of the whole plan is the principle that fixed this codebase's incidents: **don't trust a
self-report — verify against ground truth.** Phase 1 classifies outcomes against what actually happened
on GitHub, which is what turns "memory" from a log into a loop.
