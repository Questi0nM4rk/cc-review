# Learning loop — assessment + executable plan

> Reference doc for anyone (human or agent) working on cc-review's "memory." Discussion history:
> issue #54. Tracking: #24. **TL;DR: today the memory is a noise-suppressor + a log, not a learner.
> This doc says so honestly, then lays out the build to make it actually learn.**
>
> **Pressure-tested against the code on 2026-06-11** (4-agent adversarial pass; see §6 for the
> verified corrections). The first draft of this plan described several things that do not exist or
> cannot run as written — Phase 0's "reuse the existing finding hash" (there is no per-finding hash),
> Phase 1's local `git diff` in a workflow that has no checkout, a success metric that improves when
> the bot goes silent. Those are now fixed inline and itemized in §6. **Read §6 before implementing.**

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

**The trap inside the gap (verified §6):** the obvious ground-truth signal — "was the thread resolved?"
— is **bot-gated**. A thread is `resolved` only when the bot itself calls the resolve mutation, which
happens **only on a re-run**, and the re-run is hard-gated behind an author ping (`strict-review.mjs:702`).
The default `pr_open` trigger fires once. So on a typical PR, **every thread is still open at merge
regardless of whether the finding was right** — the author read it, fixed-or-merged, and never triggered
the re-run that would resolve it. Any "learning" that reads "open at merge" as "noise" will train the
bot to stop flagging true issues in domains the author tends to merge without engaging. This is the
single most dangerous mistake the plan can make, and it shapes Phases 1–2 below.

---

## 2. Executable plan

Sequenced so each phase ships and verifies independently. **The spine principle — "don't trust a
self-report, verify against ground truth" — applies to the harvester's own verdicts too: every
classification must be DETERMINISTIC (thread state + a code/region diff via the GitHub API), never an
LLM reading the old comment text.** When the LLM output *is* the classification, there is no
deterministic verdict gate behind it the way there is in the live review path (`lessons-learned.md`),
so an injection or a merely-wrong old comment poisons the signal directly.

### Phase 0 — Instrument findings (foundation) · [RC] · S→M

> **Status (2026-06-12): SHIPPED.** `findingId` + the `<!-- cc-review:finding <id> -->` per-inline-comment
> marker + `pr-<N>/findings.jsonl` are live in the brain. **As-built deviations** (forced by real
> constraints, faithful to the §6 corrections): `findings.JSONL` (append via `cat >>`) not a `.json`
> array — the cat-heredoc rules out a read-merge-rewrite; **no `posted_at`** — the Workflow runtime
> can't `Date.now()`, recency lives in Phase 1's runner-side `outcomes.jsonl`; only **threaded
> (inline)** findings are logged (1:1 with markers + threads). `findingId` excludes line and uses the
> first 10 normalized description tokens; `JSON.stringify([file, sig])` key is injective.

Make every posted finding addressable. **There is no per-finding id today** — `stampHash()`
(`strict-review.mjs:458`) is one digest over the *whole* payload, stamped as a single
`<!-- cc-review:review <hash> -->` marker on the summary body for whole-review dedup; inline comments
carry only `{path, line, side, body}` (`buildPayload`, ~:472). So Phase 0 must *introduce* a finding id,
not reuse one.
- **Define a stable finding id:** `fnv1a32` over `file` + a **normalized, line-independent description
  signature** (lowercased, whitespace-collapsed, first N significant tokens). **Exclude `line`** — lines
  drift across re-runs (the codebase already concedes this: `dropAlreadyThreaded` matches on a fuzzy
  ±5-line window, `dedup` falls back to a description-prefix overlap, precisely because exact line/desc
  equality is unreliable). `line` is recorded as a *field* for the harvester's region diff, never as
  part of the id. Accept that correlation at merge time is fuzzy, not exact.
- **Emit the id twice:** into `pr-<N>/findings.json`
  (`[{id, file, line, domain, event, posted_head_sha, posted_at}]`) **and** as a hidden per-inline-comment
  marker (extend `buildPayload` so each comment body carries `<!-- cc-review:finding <id> -->`) so a
  harvester can correlate a posted comment back to a finding. Write `findings.json` via `cat` heredoc
  into `.cc-memory/pr-<N>/` (the slice path `ci-run.sh` already stages and the marker step already
  writes `review-state.json` into).
- **Verify:** a posted review leaves a `findings.json` with one entry per inline finding; each posted
  inline comment carries a `cc-review:finding` marker whose id matches a `findings.json` row.
- **Depends on:** nothing. Ship after Phase 3 (Phase 3 is the faster felt win); Phase 0 unblocks Phase 1.

### Phase 1 — Harvest outcomes on PR close (the smallest real loop) · [RC] script + [CI] trigger · L
Record each finding's fate — the data the bot throws away today. **Classification is deterministic;
no LLM reads the comment text.**
- **New [RC] `scripts/harvest-outcomes.ts`** (`repo`, `pr`): read `pr-<N>/findings.json`, and classify
  each finding against **GitHub ground truth**, not the bot's self-report:
  - **fixed** — thread resolved **OR** the posted `file:line` region changed between `posted_head_sha`
    and the merge commit. **Compute the region diff via the GitHub API** (`gh api
    repos/{repo}/compare/{base}...{head}` or the PR-files endpoint), **not** a local `git diff` — see §6:
    `cc-review-cleanup.yml` has no working tree, and on a squash/rebase merge `posted_head_sha` is not
    an ancestor of the merge commit and may be unreachable. Also consume GitHub's `isOutdated` thread bit
    (already fetched at `review-platform.ts:159`, currently **dropped** at ~:178 — surface it) as the
    cheap "code under this thread changed" signal.
  - **dismissed** — resolved with a `Dismissed:` reply / a `known_pattern` exists for it.
  - **ignored (NARROW, weak prior — not "strong noise"):** thread still open at merge **AND** the
    posted region **unchanged** (`!isOutdated` / no compare hunk) **AND** no author engagement on the
    thread. Everything else that is merely "open at merge" is **`open-but-acted`** and is **excluded from
    suppression** — on a low-PR-volume same-owner repo, "open at merge" is dominated by the author simply
    not clicking resolve and by the re-run gate parking threads, *not* by the finding being noise. Treat
    even the narrow bucket as a **weak** prior.
  - Record the **resolved-sample size N** alongside, so Phase 2 can down-weight a near-zero-resolution repo
    (where the signal is structurally untrustworthy).
  - Append to `learnings/outcomes.jsonl` (`{id, pr, domain, verdict, n_resolved, at}`).
- **Deterministic trim, runner-side:** `harvest-outcomes.ts` itself trims `outcomes.jsonl` to the last
  **N PRs / D days** (by the `at` field) and rewrites it atomically. The **prose-curating memory agent
  must never touch `outcomes.jsonl`** — it is machine-owned structured data; consolidating it as prose
  would corrupt the rate math (this is how we avoid repeating #8's unbounded write-only growth).
- **[CI] `cc-review-cleanup.yml` needs real new plumbing (not "run a script before delete").** Today it
  is two steps: mint the App token, `gh api -X DELETE` the log branch — **no checkout, no clone, no git
  tree.** To run the harvester it must additionally: (a) `actions/checkout` (fetch-depth:0) of the
  consumer repo + clone cc-review (as `cc-review.yml` does, which cleanup does **not** today); (b) fetch
  + archive-extract the repo's memory slice (`ci-run.sh`'s `git archive FETCH_HEAD | tar -x -C .cc-memory`
  pattern); (c) run `harvest-outcomes.ts` as a plain `tsx` runner step — **the `--allowedTools` Bash
  allowlist + filesystem sandbox bind the `claude -p` sub-agents, not GHA steps, so the harvester runs
  unrestricted** (this was a false worry in the first draft); (d) commit + push the updated slice back
  (`ci-run.sh`'s `push_mem` pattern). **Factor (b)+(d) into a shared `scripts/memory-slice.sh` that both
  `ci-run.sh` and cleanup call**, or the harvest output lands in a tree that is never pushed and is lost.
  *This is the one consumer-workflow change → distribute via per-repo PR.*
- **Verify:** close a test PR with findings → `outcomes.jsonl` gains a sane row per finding, **confirmed
  against GitHub ground truth** (the compare API + thread state, not the harvester's word); a
  squash-merged PR still classifies correctly (no reliance on a reachable head SHA); the updated slice is
  actually pushed to `claude-reviewer/memory`.
- **Depends on:** Phase 0.

### Phase 2 — Feed calibration back into reviews (close the loop) · [RC] · M
The recalled signal must **change behavior**, not be soft context — but it must be a *calibrated,
sample-aware* signal, computed deterministically before it reaches any prompt.
- `buildProjectContext()` gains a **calibration block**: read `outcomes.jsonl` (rolling window),
  compute per-domain rates, inject explicit numbers — e.g. *"Calibration (this repo, last N): security
  90% fixed → keep flagging; performance fixed-rate low on small N → unchanged."* Thread the result into
  `checkPrompt` and optionally `pickSquad` / difficulty floor — but only **after** the gates below.
- **Minimum-sample gate (the fix for the missing guardrail):** emit **no** calibration line for a domain
  until it has at least `MIN_OUTCOMES` decay-weighted findings in the window (start `effective N ≥ 8`;
  name it as a constant alongside `SIG`). Below threshold → neutral/cold, not a rate. Note decay *lowers*
  effective N, so the gate must be checked on the **decay-weighted** count.
- **Confidence-aware estimator, not a raw ratio:** shrink the nudge toward neutral on small N — Laplace
  smoothing `(k+1)/(N+2)` at minimum, a Wilson lower bound if we want it sharper — so "2 of 3 ignored"
  produces a near-neutral nudge, not "67% — raise the bar."
- **Asymmetric weighting (the fix for the biased `ignored` signal):** the `ignored` down-weight ceiling
  must be **strictly smaller** than the `fixed` up-weight, and `ignored` must **never** drive a domain
  near the suppression floor on its own. `ignored` is a friction-contaminated weak prior; `fixed`/
  `dismissed` are code-verified.
- **Guardrails (non-negotiable):**
  - **Floor = a minimum flag *rate*, not a down-weight cap.** A down-weight cap only sets how fast a
    domain asymptotes toward silence; it does not break the suppress→fewer-flags→fewer-fixed→suppress-more
    loop. Keep measuring: always let a fixed fraction of borderline findings through **unbiased** (A/B
    style) so the loop has fresh ground truth and a suppressed domain can recover.
  - **Decay** old outcomes — in the **deterministic rate-math in `buildProjectContext`**, not in a prompt.
  - **Keep the calibration text visible** in `projectContext` (auditable) — but note visibility is
    *forensic*, applied after the run already used the number; it is **not** a substitute for the
    pre-injection gate, especially for a headless/unsupervised bot.
- **Verify:** seeded high-`fixed` `security` history (≥ `MIN_OUTCOMES`) → calibration line appears → check
  pass keeps flagging security; a domain below `MIN_OUTCOMES` → **no** line; a small-N high-`ignored`
  `performance` history → smoothed near-neutral nudge, **never** silences perf. Add `helpers.test.mjs`
  cases for: rate math + Laplace smoothing; sub-threshold suppression of the line; decay not letting
  effective N slip under the gate unnoticed; **and a correct-but-merged-as-known-debt finding must NOT
  depress its domain's flag rate.**
- **Depends on:** Phase 1 (and Phase 1's `ignored` taxonomy being the narrow, code-verified one).

### Phase 3 — Cold-start backfill from recent PRs (warm start) · [RC] · M
A new repo's first review should start with priors, not cold. **Ship this first — it's independent,
pure [RC], learns from *humans* (high-quality signal), and pays off on the very first review.**

> **Status (2026-06-11): v1 SHIPPED.** `.claude/workflows/backfill-memory.mjs` + the `ci-run.sh`
> sentinel gate are live. v1 writes **additive-only** priors (conventions, recurring-issue themes,
> culture notes) → `MEMORY.md` + `learnings/{lessons,found-issues}.md`, idempotency via the
> `.cc-memory/.backfilled` sentinel. **Deliberately deferred to v2:** code-verified `known_patterns`
> from human dismissals (the suppressive part — needs the re-verification gate below before it's safe).
> So the "≥1 code-verified known_pattern" acceptance criterion is **not yet met** — v1 intentionally
> trades it away for a safe, simple first cut.
- **New [RC] `backfill-memory` step:** fetch last **N=5** (configurable) merged PRs
  (`gh pr list --state merged --limit 5`); per PR read diff + review threads + resolutions + follow-up
  commits; an agent synthesizes into the slice: conventions, recurring issues, **code-verified**
  known_patterns (from human dismissals), review-culture notes.
- **Backfilled suppressions are untrusted until re-verified:** a `known_pattern` synthesized from an old
  human comment is a standing "do-NOT-flag" rule (`buildProjectContext`, ~:405) — a wrong one silences
  future true findings. So each backfilled pattern must be **re-verified against current code** by the
  same `commentMgmt` code-first rule before it enters the slice, and tagged `provenance: backfill` so it
  can be distrusted/expired. **Never** accept a suppression from old comment text alone.
- **Reliable idempotency (the fix for the broken detector):** "no slice → run backfill" cannot key off an
  empty `.cc-memory` — `ci-run.sh:53-54` *unconditionally* writes a placeholder `MEMORY.md` + `mkdir`s
  `learnings/` + `pr-N/`, so `.cc-memory` is **never** empty at check time. Instead persist an explicit
  `.cc-memory/.backfilled` sentinel (timestamp + N) written by the backfill step and pushed with the
  slice; gate backfill on the sentinel being **absent in the FETCHED archive** (checked *before* the
  placeholder write), not on the post-placeholder working tree. Plus a manual/scheduled refresh.
- **Bound cost:** N configurable; once per repo (sentinel-gated) + occasional refresh; cap synthesized
  output.
- **Verify:** point at a repo with no slice → slice gains conventions + ≥1 code-verified, `provenance:
  backfill`-tagged known_pattern from a real prior dismissal; a `.backfilled` sentinel is written and
  pushed; a second run does **not** re-run backfill; first review cites repo-specific context it couldn't
  have had cold.
- **Depends on:** nothing (learns from **humans**, not the bot's own outcomes — complements Phases 1–2).

### Phase 4 — Miss capture / false negatives · [RC] · L · lowest confidence · **prerequisite for "working"**
The only path to learning what the bot *missed* — and the **only recall signal in the whole plan.**
Without it, Phases 0–2 have *no* counterweight to silence (see §4: the precision metric alone is
Goodhart-gameable by going quiet), so Phase 4 is **not** an optional last step — it is the gate on
declaring the loop successful.
- Heuristic in `harvest-outcomes.ts`: a later **fix/revert/hotfix PR** touching lines in a file the bot
  reviewed **clean/APPROVED** → record a `miss` candidate `{file, area, ref_pr}` → feeds Phase 2 (raises,
  never lowers, scrutiny). Expect this signal to be noisy (most later edits aren't fixing a missed bug) —
  treat as a weak prior, log what it dropped.
- **Verify:** a contrived fix-PR over a previously-clean file produces a `miss` row; calibration nudges
  that area's scrutiny up; the recall metric in §4 moves.
- **Depends on:** Phases 1–2.

---

## 3. Safety rails (all phases)
- **Untrusted history** (old comments/diffs) → the real defense is a **deterministic verdict**, not a
  prompt fence. Harvest classification (Phase 1) and any suppression synthesis (Phase 3) must be
  computed from thread-state + a code/region diff via the API, or re-verified against current code —
  never trusted from comment text. (In the live review path the fence works only *because* a
  deterministic gate sits behind it; the harvester has no such gate, so it cannot rely on a fence alone.)
- **Overfit / feedback collapse** → code-verify suppressions; **decay**; the floor is a **minimum flag
  *rate*** (let a fixed unbiased fraction through to keep measuring), not just a down-weight cap, because
  a cap does not reverse the loop's direction; `ignored`'s ceiling < `fixed`'s; alert when a domain
  trends toward silence — see below.
- **A real alert channel, not a TODO.** The bot has **no out-of-band channel** — it posts only to PRs, and
  a silenced domain posts nothing, so "alert when flag-rate hits zero" has nowhere to surface. Make it
  concrete: emit a calibration/health line **in the overview comment** (e.g. *"⚠ performance: 0 findings
  in last N — calibration may be over-suppressing"*) so a human sees it on the next PR. If we won't build a
  surfacing path, drop the word "alert."
- **Bounded slice** → keep the curation cap on the prose files; `outcomes.jsonl` is trimmed
  **deterministically by the harvester** (last N PRs / D days), never by the memory agent.

## 4. "It's working" = measurable (and not Goodhart-gameable)
A single declining `ignored-rate` is a **trap**: the Phase 2 suppressor lowers it by making the bot post
*less*, not by making it *more precise* — a domain that posts nothing has a perfect ignored-rate and is
useless. Use a **pair** that cannot both be gamed by silence:
- **Precision proxy:** `fixed / posted` per domain (code-verified numerator).
- **Recall / volume floor:** flag *volume* per domain must stay above a minimum, and `fixed`-**count**
  (not rate) must not collapse. A domain trending to zero posted findings is a **RED** signal, not a green
  one.
- **Maintained by the memory agent in `learnings/calibration.md`**, trended over a window; the raw rates
  come from the deterministic `outcomes.jsonl` math, the prose summary from the agent.
- **Acceptance:** precision rises (or holds) **while** per-domain volume stays above the floor; a new
  repo's first review is demonstrably better-grounded than cold; **Phase 4's recall signal is live** —
  without it, "precision up" is unverifiable as anything but "talked less."

## 5. Sequencing
**Phase 3 (backfill) ships first** — independent, pure [RC], fastest felt win, learns from **humans**.
Then **Phase 0 → 1 → 2** is the spine (the real quality loop — learns from **reality**), with **Phase 4
as the recall counterweight that gates "it's working."** Only **Phase 1's `cc-review-cleanup.yml` edit
needs per-repo distribution**; everything else is [RC] and reaches all consumers on next run.

**The weakest link is the `ignored` signal** — Phase 2 must not over-trust it (narrow definition,
asymmetric weighting, min-sample gate, flag-rate floor). The spine principle that fixed this codebase's
incidents holds here too: **don't trust a self-report — verify against ground truth.** Phase 1 classifies
outcomes against what *actually happened* on GitHub (compare API + thread state), which is what turns
"memory" from a log into a loop. The corollary the first draft missed: **the *absence* of a human action
is not ground truth** — on this bot, "thread open at merge" is mostly workflow friction, so it gets the
narrow, code-verified treatment above, not a "strong noise signal" label.

## 6. Feasibility corrections (verified against code, 2026-06-11)
The first draft of this plan described code that does not exist or cannot run. Each correction below is
folded into the phases above; this section is the audit trail so a future reader knows *why* the phase
text is shaped the way it is.

| # | First-draft claim | Reality (evidence) | Fix (in phase) |
|---|---|---|---|
| 1 | Phase 0: `id = the existing fnv1a32 finding hash`, matching the review markers | `stampHash()` is **one** digest over the whole payload (`strict-review.mjs:458`), stamped once on the summary body (~:480); inline comments have **no id** (~:472). No per-finding hash exists. | Phase 0 **introduces** an id (file + normalized desc, **excluding line**) and emits a per-comment marker. |
| 2 | Ids are stable enough to look up a finding's fate across runs | Lines and descriptions drift; the code already uses a fuzzy ±5-line window (`dropAlreadyThreaded`) + desc-prefix overlap (`dedup`) for exactly this reason. | Id excludes `line`; correlation is accepted as fuzzy, not exact. |
| 3 | Phase 1: classify `fixed` via local `git diff posted_head_sha..MERGE` in `cc-review-cleanup.yml` | Cleanup has **no checkout / no git tree** — only token + `gh api -X DELETE` (lines 22-44); squash/rebase merges make `posted_head_sha` unreachable. | Use the **GitHub compare API** + `isOutdated`; add a checkout + slice plumbing to cleanup. |
| 4 | Phase 1: `--allowedTools`/sandbox may block the harvester | The allowlist + filesystem sandbox bind the `claude -p` **sub-agents**, not GHA `tsx` steps — the harvester runs unrestricted. | Noted; the real gap is cleanup has no slice fetch/push (factor `scripts/memory-slice.sh`). |
| 5 | Phase 1: `ignored = thread still open at merge (strong noise signal)` | Resolution is **bot-gated on a re-run the default `pr_open` trigger rarely fires** (`strict-review.mjs:702`); `threads()` returns only unresolved (`review-platform.ts:164`). "Open at merge" is the **default terminal state**, not a noise signal. | `ignored` redefined **narrow + code-verified + weak**; `open-but-acted` excluded from suppression. |
| 6 | Phase 2: floor + decay suffice; calibration is "visible" | No **min-sample gate** exists; decay **worsens** small-N; visibility is forensic, not a pre-injection guard, on a headless bot. | Add `MIN_OUTCOMES` gate + Laplace/Wilson smoothing + asymmetric weighting **before** the prompt. |
| 7 | §3: floor "so no domain goes silent"; "alert when flag-rate hits zero" | A down-weight cap doesn't reverse the suppress-loop; the bot has **no out-of-band channel** for an alert to surface. | Floor = minimum flag **rate** (unbiased A/B fraction); alert = a line **in the overview comment**. |
| 8 | §3/§4: `outcomes.jsonl` "rolls/decays" | No owner/mechanism; the prose-curating memory agent (~25-bullet cap) cannot consolidate structured JSONL without corrupting it; risks #8's unbounded-growth anti-pattern. | **Deterministic** trim in the harvester; memory agent never touches it. |
| 9 | Phase 3: backfill when `.cc-memory` is empty | `ci-run.sh:53-54` **always** writes a placeholder `MEMORY.md` + dirs → `.cc-memory` is never empty at check time. | Explicit `.backfilled` sentinel, checked in the **fetched archive** before the placeholder write. |
| 10 | Phase 3: synthesize known_patterns from human dismissals | Backfilled suppressions feed `buildProjectContext` as standing "do-NOT-flag" rules; a wrong one silences true findings. | Re-verify against current code; tag `provenance: backfill`; never trust comment text alone. |
| 11 | §4: success = declining ignored-rate | The suppressor lowers ignored-rate by posting **less** (Goodhart); Phase 4 (recall) was last/optional. | Pair precision (`fixed/posted`) with a **recall/volume floor**; Phase 4 gates "working." |
