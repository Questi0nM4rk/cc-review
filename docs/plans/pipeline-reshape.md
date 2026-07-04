# Plan: pipeline reshape — judgment-only brain, code-side I/O, in-session parity

> Status: Draft (plan spec — updates SPEC.md section-by-section as phases land)
> Scope: restructure the review pipeline so the brain spends agents ONLY on judgment,
> all GitHub/GitLab I/O moves to tested runner code, and an in-session run is a
> first-class entry path. Follow-up to the flow-hardening PR (#82).

## Why (the census)

A posted d3 first review today = ~14 agent calls. 8 of them are LLM-as-RPC — run a
command and transcribe its JSON verbatim, or cat-heredoc exact bytes the orchestrator
already holds: fetch, post-overview, edit-overview, post-answer, post-gate/error,
thread-ops, post-review, verify-posted, post-ops. Every one is a place an LLM can
mangle deterministic work, and each grew its own defense (identity gate, verify-retry
loop, verbatim-transcription prompts). Moving them to code deletes the defenses along
with the cost. The judgment calls (holistic, research, memDocs, squad, check,
comment-mgmt, sig-change, memory) stay agents.

Accepted trade-off (user, 2026-07-03): the brain stops being a fully self-contained
clone-and-run artifact. It already isn't — both entry scripts lay /tmp + dir
scaffolding the brain can't live without.

## Target shape

- **Brain (Workflow script, judgment only):** Holistic(+intent) → Gather (1 research +
  memDocs + tools) → Squad (correctness anchor + specialists) → Check → [rerun:
  batched comment-mgmt, sig-change confirm] → Decide → RETURN {payload, threadActions,
  findingRows, overview} — no posting, no marker writes.
- **Runner (bash + tested .mjs modules):** prefetch context/threads/get-overview →
  invoke brain with everything in args → post (replies once, resolves, review with
  idempotency+retry, verify via posted.mjs) → write review-state.json + findings.jsonl
  → memory slice push → gate.mjs verdict. GitHub=ci-run.sh, GitLab=run-gitlab.sh,
  session=new run-session.sh; all three share the same post module.

## Phases (one PR each; docs updated in the same PR)

### Phase 0 — mock-agent flow harness (lands first, enables everything)

Stub `agent()`/`parallel()`/`phase()`/`log()` with canned schema-shaped results and
drive the ORCHESTRATION half of the brain (below the test-extraction sentinel) in
node --test. Assert: path taken (first vs rerun vs blocked vs answer), fail-closed
aborts on null squad/check, post gating, return shape. ~100-line harness (wrap the
body like check-brain.mjs does, inject the globals). Converts "flow changes need live
quota" into unit tests. AC: the #82 fail-closed paths and rerun gate covered.

### Phase 1 — runner prefetch, delete the fetch agent

Entry scripts call the adapter themselves (context/threads/get-overview + config +
review-state read) and pass ONE JSON via args (`args.ctx`). Brain: when `args.ctx`
present, skip the fetch agent entirely; keep the fetch agent as fallback for one
release, then delete it + the identity gate (data now comes from code, not an LLM).
AC: CI + local + gitlab entry all pass ctx; mock-harness tests for both branches;
one live --ref dispatch green.

**Amended (as-built):** the Workflow runtime has no filesystem access, so the context can't be
`cat`-ed by the brain nor ride in `args.ctx` (the whole diff) — assembly moved entirely to the
runner. A `prefetch` verb in `review-platform.ts` writes the FETCH_SCHEMA-shaped context to
`/tmp/cc-ctx.json` (`args.ctx_path`) and ONE verbatim-relay fetch agent returns it. What's deleted
is the 7-step LLM assembly + the LLM YAML parsing of `.cc-review.yaml`, NOT the agent itself; the
downstream identity/abort gate stays (it now guards the relayed abort shape).

### Phase 2 — runner-side post module

New `scripts/post-review.mjs` (pure core + thin CLI): replies-once → resolves →
post-review (integrity-marker idempotency) → verify (posted.mjs) with retry → writes
review-state.json + findings.jsonl. Brain returns the payload instead of posting;
overview/answer/nag posting also moves out (nag gets an existing-comment dedup here).
gate.mjs unchanged (it already reads counts + sentinel). AC: unit tests for the module
(mock gh via injected run()); dogfood dry-run; live --ref dispatch; duplicate-reply
scenario covered by a test instead of a prompt warning.

### Phase 3 — squad reshape (quality + cost)

- `correctness` becomes a standing anchor domain (always the first opus slot):
  logic bugs get a dedicated finder; d1 = anchor only, d5 = 2 independent anchors +
  top-2 specialists.
- Check pass at EVERY depth (sonnet at d1, opus d2+; second opus vote at d5).
- Merge the two web-research agents into one (scan lists overlap ~50%).
- Fold intent detection into the holistic schema (drop the separate agent).
- Batch comment-mgmt threads into one agent call (array schema).
- Persist difficulty/category in review-state; run the sig-change JS prefilter BEFORE
  holistic on reruns and skip holistic when not significant.
AC: mock-harness path tests; dogfood on a real diff at d1/d3; PATH table + SPEC §5
updated; observed agent count for a posted d3 first review ≤ 8.

### Phase 4 — in-session entry (run-session.sh) + memory glue

- Bootstrap: mkdir .cc-run scratch + mem dirs; `bun x tsx` runner; `--bot-login` =
  `gh api user` login.
- Memory: EPHEMERAL memory-branch clone (never the dev checkout — push_slice
  checkouts/git-config would trash it); fetch_slice → mem_dir → push_slice after.
  Guard memory-slice.sh: distinguish branch-absent (ls-remote empty → orphan-init ok)
  from fetch-failed (abort, local-only this run).
- Dry-runs stay in ~/.claude/cc-review-memory/<slug>/ (never pushed, #73 stance).
- Run harvest-outcomes.mjs at review-start for recently merged PRs (idempotent) so
  calibration fires in-session.
- Own-PR fallback: when bot login == PR author, post event COMMENT instead of
  REQUEST_CHANGES/APPROVE (GitHub 422s self-reviews); gate stays CI-only.
AC: full posted in-session review on a real PR of another repo; memory slice shows
the run; second run takes the rerun path.

## Verification ladder (every phase)

npm test (incl. mock harness) → in-session dogfood dry-run of the brain on the
phase's own diff → merge to main (the live brain).

**Live verification is deferred (user decision, 2026-07-04): NO live runs — no consumer
dispatches, no `@cc-review` pings — until the whole reshape has landed and been reviewed
end-to-end. Then ONE live pass validates the full pipeline before the bot is considered
current again. Until that pass, treat main's CI path as unverified-live; failures there
are loud (abort shapes + gate red), never silent wrong verdicts.**

## Non-goals

Diff chunking for >200k-char PRs, committable suggestion blocks, drift monitoring,
CLAUDE.md-in-gather — tracked as later candidates, not this reshape.

## Open questions

- COMMENT-fallback verdict semantics: does gate.mjs need a `session` mode, or does
  the gate simply not run outside CI? (leaning: gate is CI-only, session reports
  inline)
- Does backfill-memory.mjs adopt the same runner-prefetch split in Phase 1 or stay
  as-is until it hurts?

## Campaign tracker (single action-item list; updated by the orchestrator, not agents)

- [x] Phase 0 — mock-agent flow harness (#83, merged)
- [x] Phase 1 — runner prefetch + verbatim relay (#84, merged; as-built amendment above)
- [x] Phase 2 — runner-side post module (#85, merged f3519f2, 2026-07-04)
  - as-built (docs frozen until the end-of-campaign pass; recorded here so nothing is lost):
    overview post STAYS in the brain (mid-run walkthrough UX); brain returns a post_run
    block, runner executes it (post-run.mjs + post-run verb); findings.jsonl is APPEND
    (Codex P2 fix); nag dedup writes nag:"skipped-duplicate" and gate.mjs accepts it
    (Codex P2 fix); the diff NEVER flows through an LLM — prefetch writes it to disk,
    ctx carries a 20k excerpt + exact diff_files/added_line_count, prompts point agents
    at the file (dogfood-caught truncation bug, pre-dated the reshape)
  - [x] minimal dogfood smoke green (ok:true / mode:first / post_run:null, d3)
  - [x] final review (Claude multi-angle pass, brain-scoped fixes landed in #85:
        sigChangePrefilter exact ctx count; a.diff fallback removed; dead diff param
        dropped from 7 prompt builders; fail-closed diff_path-mismatch abort).
        Wrapper-layer findings PARKED for a later pass (user scoped the review to the
        brain only): post-run.mjs retry loop lacks try/catch around post/verify (a
        transient gh throw aborts instead of counting as a failed attempt); gitlab
        rerun-nag has no dedup; ci-run.sh doesn't rm -f stale .cc-run/*.json;
        postRun().catch re-throw = unhandled rejection; reply comment_id null guard.
  - [x] PR + merge (#85, admin-squash)
- [ ] Implementer-subagent improvement pass in qsm-marketplace2 (brain/subagent/implementer;
      evidence file: /tmp/cc-review-implementer-observations.md)
- [x] Phase 3 — squad reshape (#86, merged 47818a2, 2026-07-04): correctness anchor
      (2 independent at d5); check at every depth (sonnet d1, opus d2+, 2 intersecting
      votes at d5, fail-closed); websearch agents merged; intent folded into holistic
      (answer mode still precedes the blocked gate); comment-mgmt batched (hallucinated-id
      guard); review-state persists difficulty/category, prefilter-before-holistic skips
      holistic on non-significant message-less re-runs (blocked = zero agents after fetch).
      Verified: 258 tests, dogfood smoke d3 first = 8 agent calls dry-run (~10 posted,
      census was ~14). Implemented via 3 sequential implementer subagents + orchestrator
      review (1 spec deviation caught+reverted in P3.1-adjacent work; meta block updated).
- [ ] Phase 4 — in-session entry + memory glue (per plan section above)
- [ ] End-of-campaign docs overhaul: prune/rewrite SPEC.md, CLAUDE.md, README, docs/* to
      the as-built reality (most docs expected to shrink or go); fold plan amendments into
      SPEC; then close this plan
- [ ] ONE live verification pass (user gate — nothing live before this)

## Operating notes (what this campaign established — keep applying)

- **Verification tiers catch disjoint bug classes.** The mock harness (flow logic), the
  in-session dogfood (runtime physics: tool-result caps, real file reads), and an external
  review pass (integration regressions across module seams) each caught bugs the other two
  could not. Never collapse the ladder; DO scope it — plumbing changes get a one-file smoke
  (small diff → low difficulty → few agents), only behavior changes warrant full-size dogfoods.
- **Nothing large may flow through an agent verbatim.** Tool results truncate (~25k tokens);
  an LLM cannot relay bytes it cannot see. Big payloads go on disk; agents get the path;
  exact facts (file lists, counts) are precomputed in runner code.
- **Abort-shape examples in prompts leak into behavior.** If an example value (pr_number:0)
  can be confused with a legitimate value, say explicitly which is which.
- **Dispatch discipline:** unnamed background subagents (result returns structurally,
  self-terminating); one bounded deliverable per dispatch (split big tasks); a 5-minute
  worktree watchdog; first-file-edit-early working contract in every prompt; >3 fixes go
  to an implementer, fewer are orchestrator-inline.
- **Smoke recipe (local, posts nothing):** write a small diff to /tmp/pr-diff.txt, write
  /tmp/cc-input.json with pr_number 0 / post false, run
  `bun x tsx scripts/review-platform.ts prefetch --local > /tmp/cc-ctx.json`, then invoke
  the Workflow tool on .claude/workflows/strict-review.mjs with
  args {bot_dir: <worktree>, runner: "bun x tsx"}. Gate: `npm test` + `bash -n` entry scripts.
