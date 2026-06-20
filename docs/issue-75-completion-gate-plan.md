# Issue #75 — Completion Gate Implementation Plan

> **Status: Draft.** Scope: make a cc-review run report success only when the strict-review
> workflow actually finished AND posted the right artifact for its mode. Closes
> [#75](https://github.com/Questi0nM4rk/cc-review/issues/75).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Work in a worktree off `main`; TDD; commit per task.

**Goal:** A run is "successful" only if the brain emitted an explicit completion result AND the
mode-correct GitHub artifact appeared — an overview comment alone can never pass a normal review.

**Architecture (chosen fork: C — Hybrid, three legs):**
1. **Marker (invoker):** `agentapi-claude.sh` accepts `stable` as "done" only after seeing an
   opt-in `--done-marker` string in the conversation. Bare `stable` (idle mid-run, or stuck at an
   unrecognized prompt) no longer counts as completion. Backward-compatible: callers that pass no
   marker (backfill, selftest, local) keep the old bare-`stable` behaviour.
2. **Sentinel (orchestrator → file):** the orchestrator writes the brain's return JSON to
   `.cc-run/cc-result.json` then prints the marker. A frozen run never reaches this → no file.
3. **Mode-aware ground-truth cross-check (gate):** a pure, unit-tested decision
   (`scripts/gate.mjs`) reads the sentinel + before/after GitHub counts. Normal review (`first` /
   `rerun`) requires the **formal review count** to rise; `answer` / `rerun-blocked` accept comment
   growth; missing sentinel or `ok!==true` fails even when agentapi reported `stable`.

**Tech stack:** Bash (`agentapi-claude.sh`, `ci-run.sh`), Node ESM (`scripts/gate.mjs`),
`node:test` + `node:assert/strict` (the repo's test idiom — see `scripts/harvest-outcomes.test.mjs`).
Decision logic lives in a pure function; the shell stays thin (matches the maintainer's
"decision logic in pure tool functions, agents/shell thin" rule).

---

## Acceptance criteria → task map (from #75)

| # | Acceptance criterion | Task |
|---|---|---|
| 1 | Normal review successful only after an explicit completion result/sentinel | T2 (marker), T3 (sentinel), T4 (gate) |
| 2 | Missing final JSON/sentinel fails even if agentapi reports `stable` | T2 (marker gate), T1 (`ok!==true`→fail) |
| 3 | First/rerun requires the formal review count to rise (or recognized idempotent dup) | T1 (`REVIEW_MODES`), T4 |
| 4 | An overview comment alone cannot satisfy the gate | T1 (case 5 test), T4 |
| 5 | Answer / rerun-blocked may use issue-comment growth | T1 (`COMMENT_MODES`), T4 |
| 6 | Regression test: overview posted, stops before Decide/Post, status `stable` → job fails | T1 (case 2 test) |
| 7 | Reduce/scope the generic auto-approval loop (57 approvals; "Parser did not consume trailing input") | T2 (cap + numbered-menu match) |

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `scripts/gate.mjs` | **New.** Pure `decideGate()` + thin env-driven CLI. The whole verdict. | Create |
| `scripts/gate.test.mjs` | **New.** Contract matrix incl. the #75 regression. | Create |
| `scripts/agentapi-claude.sh` | Invoker. Add `--done-marker` gate on `stable`; scope auto-approval. | Modify |
| `scripts/ci-run.sh` | GitHub pipeline. Emit sentinel + marker; replace the mode-blind gate with `gate.mjs`. | Modify |
| `.github/workflows/ci.yml` | Run the new unit test. | Modify (`:34`) |
| `CLAUDE.md` / `SPEC.md` | Document the completion contract (same PR as the code). | Modify |

---

## Task 1: Pure completion-gate decision + tests (the TDD anchor)

**Files:**
- Create: `scripts/gate.mjs`
- Test: `scripts/gate.test.mjs`
- Modify: `.github/workflows/ci.yml:34`

- [ ] **Step 1: Write the failing test** — `scripts/gate.test.mjs`

```js
// Contract spec for the post-run completion gate (issue #75). gate.mjs is a plain ESM
// runner module (no top-level await), so its pure function imports directly — the brain's
// extraction trick (helpers.test.mjs) is not needed here.
//
// The scenarios ARE the spec. Above all: case 2 — the #75 repro — an overview posted, the
// workflow froze before Decide/Post, agentapi went 'stable' → the gate MUST fail the run.
//
// Run: node --test scripts/gate.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { decideGate } from "./gate.mjs";

const counts = (br, ar, bc, ac) => ({ beforeReviews: br, afterReviews: ar, beforeComments: bc, afterComments: ac });
const ok = (mode, extra = {}) => ({ ok: true, mode, ...extra });

test("1. agentapi exited non-zero (timed out / died) → FAIL regardless of sentinel", () => {
  const v = decideGate(ok("first"), counts("0", "1", "0", "1"), { runRc: 1, post: true });
  assert.equal(v.pass, false);
  assert.match(v.reason, /did not signal completion/i);
});

test("2. #75 REPRO: overview posted, workflow froze before Decide, status stable, no sentinel → FAIL", () => {
  // runRc 0 (agentapi reported 'stable'); sentinel absent (orchestrator never reached the write);
  // comments rose by the overview, reviews flat. This is the exact bug.
  const v = decideGate(null, counts("0", "0", "0", "1"), { runRc: 0, post: true });
  assert.equal(v.pass, false);
  assert.match(v.reason, /no completion result|did not finish|stalled/i);
});

test("3. sentinel present but ok!==true → FAIL", () => {
  const v = decideGate({ ok: false, mode: "first" }, counts("0", "1", "0", "1"), { runRc: 0, post: true });
  assert.equal(v.pass, false);
});

test("4. first review, formal review count rose → PASS", () => {
  const v = decideGate(ok("first"), counts("0", "1", "0", "1"), { runRc: 0, post: true });
  assert.equal(v.pass, true);
  assert.equal(v.reason, "");
});

test("5. OVERVIEW-ONLY: first review finished but only a comment rose, review flat → FAIL", () => {
  // Sentinel says ok+first, but GitHub shows no new formal review — an overview alone must not pass.
  const v = decideGate(ok("first"), counts("0", "0", "0", "1"), { runRc: 0, post: true });
  assert.equal(v.pass, false);
  assert.match(v.reason, /no new formal cc-review review|verdict was not posted/i);
});

test("6. rerun, review count rose → PASS", () => {
  assert.equal(decideGate(ok("rerun"), counts("2", "3", "5", "5"), { runRc: 0, post: true }).pass, true);
});

test("7. answer mode, comment rose → PASS", () => {
  assert.equal(decideGate(ok("answer"), counts("0", "0", "1", "2"), { runRc: 0, post: true }).pass, true);
});

test("8. answer mode, nothing rose → FAIL", () => {
  assert.equal(decideGate(ok("answer"), counts("0", "0", "1", "1"), { runRc: 0, post: true }).pass, false);
});

test("9. rerun-blocked (gate comment), comment rose → PASS", () => {
  assert.equal(decideGate(ok("rerun-blocked"), counts("0", "0", "0", "1"), { runRc: 0, post: true }).pass, true);
});

test("10. post=false (local/dry-run dispatch) → PASS, no gate", () => {
  assert.equal(decideGate(ok("first"), counts("0", "0", "0", "0"), { runRc: 0, post: false }).pass, true);
});

test("11. localDryRun sentinel even with post=true → PASS, no gate", () => {
  assert.equal(decideGate(ok("first", { localDryRun: true }), counts("0", "0", "0", "0"), { runRc: 0, post: true }).pass, true);
});

test("12. DEGRADE: review snapshot unreadable ('ERR') → trust the sentinel, PASS", () => {
  assert.equal(decideGate(ok("first"), counts("ERR", "ERR", "0", "1"), { runRc: 0, post: true }).pass, true);
});

test("13. unknown future mode → don't fail on the gate's ignorance, PASS", () => {
  assert.equal(decideGate(ok("some-future-mode"), counts("0", "0", "0", "0"), { runRc: 0, post: true }).pass, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/gate.test.mjs`
Expected: FAIL — `Cannot find module './gate.mjs'` (or "decideGate is not a function").

- [ ] **Step 3: Write minimal implementation** — `scripts/gate.mjs`

```js
// Pure post-run completion-gate decision for ci-run.sh (issue #75).
// ci-run.sh is thin shell; the verdict logic lives HERE (unit-tested in gate.test.mjs) so it
// can't silently drift the way the old inline OR-rule did. Three inputs:
//   1) the brain's completion sentinel (.cc-run/cc-result.json) — proves the workflow FINISHED
//      and in which mode; absent => it froze (e.g. stalled at an interactive prompt while
//      agentapi reported 'stable'), which must FAIL even on a clean agentapi exit.
//   2) the agentapi exit code (non-zero = never went stable / died / quota).
//   3) before/after GitHub bot-artifact counts — the ground-truth cross-check, per mode.
//
// Run as CLI (ci-run.sh): env-driven, prints the failure reason to stdout (empty = pass), exit 0.
//   SENTINEL=.cc-run/cc-result.json RUN_RC=$? CC_POST=1 \
//   BEFORE_REVIEWS=.. AFTER_REVIEWS=.. BEFORE_COMMENTS=.. AFTER_COMMENTS=.. node scripts/gate.mjs

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Modes that post a FORMAL review (POST /pulls/N/reviews → review count rises) vs comment-only modes.
const REVIEW_MODES = new Set(["first", "rerun"]);
const COMMENT_MODES = new Set(["answer", "rerun-blocked"]);

// A count snapshot is a stringified integer, or "ERR"/"" when the GitHub query failed.
const readable = (n) => n !== "ERR" && n !== "" && n != null && Number.isFinite(Number(n));
const rose = (before, after) => readable(before) && readable(after) && Number(after) > Number(before);
const unreadable = (before, after) => !readable(before) || !readable(after);

// result: parsed sentinel object (brain return) or null if absent/unparseable.
// counts: { beforeReviews, afterReviews, beforeComments, afterComments } (strings).
// opts:   { runRc:number, post:boolean }
// Returns { pass:boolean, reason:string } — reason "" on pass.
export function decideGate(result, counts, opts) {
  // 1) agentapi exit code: non-zero = the turn never completed (timed out / auth / quota / died).
  if (opts.runRc !== 0) {
    return { pass: false, reason: "the review did not signal completion (timed out or died mid-review — often a usage/quota limit)" };
  }
  // 2) Completion sentinel: the orchestrator writes the brain's return JSON LAST. Absent or not
  //    ok => the workflow did not finish, even though agentapi reported 'stable' (idle ≠ done).
  if (!result || result.ok !== true) {
    return { pass: false, reason: "the run reported no completion result — the strict-review workflow did not finish (it may have stalled at an interactive prompt while agentapi reported 'stable')" };
  }
  // 3) Nothing to verify: posting wasn't requested, or the brain ran a local dry-run.
  if (!opts.post || result.localDryRun === true) return { pass: true, reason: "" };

  // 4) Mode-aware GitHub ground-truth cross-check. An overview comment NEVER satisfies a normal
  //    review — that mode must raise the formal review count. Unreadable snapshot => degrade to
  //    trusting the (present, ok) sentinel rather than false-failing on a transient API error.
  const mode = String(result.mode || "");
  if (REVIEW_MODES.has(mode)) {
    if (rose(counts.beforeReviews, counts.afterReviews)) return { pass: true, reason: "" };
    if (unreadable(counts.beforeReviews, counts.afterReviews)) return { pass: true, reason: "" };
    return { pass: false, reason: `the run finished in '${mode}' mode but no new formal cc-review review appeared on the PR — the verdict was not posted (an overview comment alone does not count)` };
  }
  if (COMMENT_MODES.has(mode)) {
    if (rose(counts.beforeComments, counts.afterComments)) return { pass: true, reason: "" };
    if (unreadable(counts.beforeComments, counts.afterComments)) return { pass: true, reason: "" };
    return { pass: false, reason: `the run finished in '${mode}' mode but no new cc-review comment appeared on the PR — the response was not posted` };
  }
  // 5) Unknown mode (a future brain): don't hard-fail on the gate's ignorance — trust the sentinel.
  return { pass: true, reason: "" };
}

// --- CLI entry (ci-run.sh) — thin: read env + sentinel file, print reason, always exit 0. --------
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const e = process.env;
  let result = null;
  try { result = JSON.parse(readFileSync(e.SENTINEL || ".cc-run/cc-result.json", "utf8")); } catch { result = null; }
  const { reason } = decideGate(
    result,
    { beforeReviews: e.BEFORE_REVIEWS, afterReviews: e.AFTER_REVIEWS, beforeComments: e.BEFORE_COMMENTS, afterComments: e.AFTER_COMMENTS },
    { runRc: Number(e.RUN_RC || 0), post: e.CC_POST === "1" },
  );
  if (reason) process.stdout.write(reason);
  process.exit(0);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/gate.test.mjs`
Expected: PASS — `# pass 13  # fail 0`.

- [ ] **Step 5: Wire the test into CI** — `.github/workflows/ci.yml:34`

Change the existing line:
```yaml
        run: node --test scripts/helpers.test.mjs scripts/backfill-helpers.test.mjs scripts/harvest-outcomes.test.mjs
```
to:
```yaml
        run: node --test scripts/helpers.test.mjs scripts/backfill-helpers.test.mjs scripts/harvest-outcomes.test.mjs scripts/gate.test.mjs
```

- [ ] **Step 6: Commit**

```bash
git add scripts/gate.mjs scripts/gate.test.mjs .github/workflows/ci.yml
git commit -m "test+feat(#75): pure mode-aware completion gate (decideGate) + contract matrix"
```

---

## Task 2: `agentapi-claude.sh` — gate `stable` on a done-marker; scope auto-approval

Bare `stable` means "idle", indistinguishable from "finished" — it fires both mid-run and when the
agent is stuck at a prompt the auto-approver didn't match (the #75 Web-Search-approval case). Gate
completion on an explicit marker. Opt-in via `--done-marker` so existing callers (backfill, selftest,
local) keep bare-`stable` behaviour.

**Files:**
- Modify: `scripts/agentapi-claude.sh` (arg parse `:30-39`; auto-approval `:195-211`; success `:209,:218-224`)

- [ ] **Step 1: Add the `--done-marker` arg + approval-cap tunable** — `scripts/agentapi-claude.sh`

In the arg-parse block (currently `:30-39`), add the default and a case:
```bash
PROMPT_FILE=""; OUT_FILE="/dev/stdout"; SELFTEST=0; CLAUDE_ARGS=(); DONE_MARKER=""
```
```bash
    --done-marker) DONE_MARKER="$2"; shift 2 ;;
```
In the tunables line (`:27`), add a named approval cap (replaces the hardcoded `40`):
```bash
MAXAPP="${AGENTAPI_MAX_APPROVALS:-12}"
```

- [ ] **Step 2: Add a conversation-marker helper** (near `last_msg()`, `:193`)

```bash
# True iff the marker string appears anywhere in the conversation (the orchestrator prints it
# only AFTER writing the completion sentinel — so it means the workflow returned, not merely idle).
convo_has() { curl -s --max-time 8 "${BASE}/messages" 2>/dev/null | jq -r '(.messages // [])[].content' 2>/dev/null | grep -qF "$1"; }
```

- [ ] **Step 3: Scope the auto-approval + gate the `stable` exit** — replace the completion loop (`:195-211`)

```bash
elapsed=0; done=0; approvals=0
while [ "$elapsed" -lt "$MAX" ]; do
  st="$(status)"
  msg="$(last_msg)"
  # Auto-approve only a REAL numbered selection menu (a "1." / "❯ 1" line present), not any message
  # whose prose happens to contain the question — that mis-send produced the "Parser did not consume
  # trailing input" warning (#75 AC7). Capped (AGENTAPI_MAX_APPROVALS) — a legit review hits very few.
  case "$msg" in
    *"Run a dynamic workflow?"*|*"Do you want to proceed?"*)
      if printf '%s' "$msg" | grep -qE '(^|\n)[[:space:]]*[❯>]?[[:space:]]*1[.)]' && [ "$approvals" -lt "$MAXAPP" ]; then
        jq -n '{content:"1", type:"user"}' \
          | curl -s --max-time 15 -X POST "${BASE}/message" -H 'Content-Type: application/json' -d @- >/dev/null
        approvals=$((approvals + 1))
        echo "agentapi-claude: auto-approved an interactive prompt (#${approvals}/${MAXAPP})" >&2
        sleep "$POLL"; elapsed=$((elapsed + POLL)); continue
      fi
      ;;
  esac
  # COMPLETION: 'stable' counts as done ONLY when a done-marker was requested AND it has appeared.
  # With no marker (backfill/selftest/local), fall back to bare 'stable' (legacy behaviour).
  if [ "$st" = "stable" ]; then
    if [ -z "$DONE_MARKER" ] || convo_has "$DONE_MARKER"; then done=1; break; fi
    # stable but the marker hasn't been emitted → mid-run or stuck at an unanswered prompt; keep waiting.
  fi
  sleep "$POLL"; elapsed=$((elapsed + POLL))
done
```

- [ ] **Step 4: Clarify the timeout message** — in the tail (`:221-224`)

```bash
else
  if [ -n "$DONE_MARKER" ]; then
    echo "agentapi-claude: TIMED OUT after ${MAX}s — completion marker '${DONE_MARKER}' never appeared (workflow stalled or never finished)" >&2
  else
    echo "agentapi-claude: TIMED OUT after ${MAX}s (status never returned to 'stable')" >&2
  fi
  exit 1
fi
```

- [ ] **Step 5: Verify backward compatibility (no marker = legacy path)**

Run: `bash scripts/agentapi-claude.sh --selftest`
Expected: `selftest OK — agentapi installed, server up ... /messages parsed`. (No `--done-marker` → bare-`stable` path unchanged; the selftest never regresses.)

- [ ] **Step 6: Commit**

```bash
git add scripts/agentapi-claude.sh
git commit -m "fix(#75): gate agentapi 'stable' on an opt-in done-marker; scope auto-approval to real menus"
```

---

## Task 3: `ci-run.sh` — emit the sentinel + print the done-marker

**Files:**
- Modify: `scripts/ci-run.sh` (orchestrator prompt `:117`; agentapi invocation `:147-151`)

- [ ] **Step 1: Instruct the orchestrator to write the sentinel + print the marker** — replace the `PROMPT=` assignment (`:117`)

```bash
PROMPT="Use the Workflow tool with scriptPath '${CC_REVIEW_BOT_DIR}/.claude/workflows/strict-review.mjs' and args { bot_dir: '${CC_REVIEW_BOT_DIR}' }. Run it to completion. The workflow reads PR number, repo, post-flag, and project config from /tmp/cc-input.json, /tmp, and .cc-review.yaml${MSG_CLAUSE}. When the Workflow tool RETURNS, write its return value verbatim as JSON to ${WS}/.cc-run/cc-result.json using a bash cat-heredoc (NOT the Write tool) — this file is the run's completion sentinel. Write it ONLY if the Workflow returned; if it did not return, write nothing. Then, as your final output, print this exact line on its own and nothing after it: <<<CC_REVIEW_COMPLETE>>>"
```
(`.cc-run` is already pre-created at `:39`; the orchestrator's cwd is `$WS`, which is always writable — no `--add-dir` needed for it.)

- [ ] **Step 2: Pass the done-marker to the invoker** — the review call (`:147-151`)

```bash
"$CC_REVIEW_BOT_DIR/scripts/agentapi-claude.sh" --prompt-file /tmp/run/prompt.txt --out /tmp/run/transcript.txt \
  --done-marker '<<<CC_REVIEW_COMPLETE>>>' \
  --claude-arg --model --claude-arg claude-sonnet-4-6 \
  --claude-arg --dangerously-skip-permissions \
  --claude-arg --add-dir --claude-arg "$CC_REVIEW_BOT_DIR" \
  --claude-arg --add-dir --claude-arg /tmp
```
(Leave the **backfill** call at `:98-103` untouched — no `--done-marker`, so it keeps the legacy bare-`stable` path. Backfill is best-effort and writes no sentinel.)

- [ ] **Step 3: Syntax-check**

Run: `bash -n scripts/ci-run.sh`
Expected: no output (exit 0).

- [ ] **Step 4: Commit**

```bash
git add scripts/ci-run.sh
git commit -m "feat(#75): emit completion sentinel (.cc-run/cc-result.json) + done-marker from the orchestrator"
```

---

## Task 4: `ci-run.sh` — replace the mode-blind gate with `gate.mjs`

The old gate (`:170-179`) failed only when **both** counts stayed flat → the early overview comment
passed it alone. Replace with: always snapshot AFTER counts (when posting), surface the sentinel into
the log dir, and delegate the verdict to `gate.mjs`. The existing failure-comment block (`:181-193`)
is reused verbatim — it already keys off a non-empty `$REASON`.

**Files:**
- Modify: `scripts/ci-run.sh` (replace `:155-179`; keep `:181-193`)

- [ ] **Step 1: Replace the completion + ground-truth block** — everything from `# ── Everything below` (`:155`) down to the end of section 4b (`:179`)

```bash
# ── Everything below ALWAYS runs (even if the review died mid-way) ───────────
RUN_FAILED=0

# 4) Completion + ground-truth gate (#75). The verdict lives in scripts/gate.mjs (pure, unit-tested);
# this shell only gathers inputs and acts on the result. Surface the sentinel into the log dir first
# so a post-mortem can read what the brain returned.
cp .cc-run/cc-result.json /tmp/run/cc-result.json 2>/dev/null || true
AFTER_REVIEWS="ERR"; AFTER_COMMENTS="ERR"
if [ "$CC_POST" = "1" ]; then
  AFTER_REVIEWS=$(bot_count "pulls/${PR_NUMBER}/reviews?per_page=100")
  AFTER_COMMENTS=$(bot_count "issues/${PR_NUMBER}/comments?per_page=100")
fi
# gate.mjs: non-empty stdout = the failure reason; empty = verified success. Always exits 0.
REASON="$(SENTINEL="$WS/.cc-run/cc-result.json" RUN_RC="$RUN_RC" CC_POST="$CC_POST" \
  BEFORE_REVIEWS="$BEFORE_REVIEWS" AFTER_REVIEWS="$AFTER_REVIEWS" \
  BEFORE_COMMENTS="$BEFORE_COMMENTS" AFTER_COMMENTS="$AFTER_COMMENTS" \
  node "$CC_REVIEW_BOT_DIR/scripts/gate.mjs" 2>/dev/null)"
```

(The `if [ -n "$REASON" ] … else echo "run completed cleanly" fi` block at `:181-193` stays exactly as-is.)

- [ ] **Step 2: Syntax-check**

Run: `bash -n scripts/ci-run.sh`
Expected: no output (exit 0).

- [ ] **Step 3: Re-run the gate unit test (no regression from the wiring)**

Run: `node --test scripts/gate.test.mjs`
Expected: PASS — `# pass 13  # fail 0`.

- [ ] **Step 4: Commit**

```bash
git add scripts/ci-run.sh
git commit -m "fix(#75): mode-aware post-run gate via gate.mjs — overview comment alone no longer passes a review"
```

---

## Task 5: Document the completion contract (same PR as the code)

**Files:**
- Modify: `CLAUDE.md` (the `agentapi-claude.sh` + `ci-run.sh` bullets; "State of the world")
- Modify: `SPEC.md` (the completion/idempotency section)
- Modify: `docs/lessons-learned.md` (add the #75 trap)

- [ ] **Step 1:** In `CLAUDE.md`, update the `agentapi-claude.sh` bullet to state that completion is
  `stable` **+ the `--done-marker`**, not bare `stable`; and the `ci-run.sh` bullet to state the gate
  is **mode-aware** (normal review → formal-review-count rise; answer/rerun-blocked → comment rise;
  missing sentinel → fail) and lives in `scripts/gate.mjs`.
- [ ] **Step 2:** In `SPEC.md`, record the three-leg completion contract (marker → sentinel file →
  mode-aware ground-truth cross-check) as the definition of a successful run.
- [ ] **Step 3:** In `docs/lessons-learned.md`, add the trap: *"agentapi `stable` == idle, not done;
  an idle-at-an-unmatched-prompt run looked complete and the overview comment alone satisfied the old
  OR-gate (#75)."*
- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md SPEC.md docs/lessons-learned.md
git commit -m "docs(#75): document the three-leg completion contract (marker + sentinel + mode-aware gate)"
```

---

## Task 6: Live end-to-end verification + self-review

Unit tests cover `gate.mjs`. The bash glue (sentinel write, marker gating, gate wiring) is only truly
exercised on a real runner — verify per `CLAUDE.md` → Testing, **without merging to a consumer's main**.

- [ ] **Step 1: Positive path** — dispatch the workflow from the branch against a real PR:

Run: `gh workflow run cc-review.yml --repo <consumer> --ref <this-branch> -f pr_number=<N>`
Expected: job **success**; PR shows a formal review (`gh api repos/<consumer>/pulls/<N>/reviews` non-empty);
the log branch `pr-<N>-cc-review-output` contains `run/cc-result.json` with `ok:true` + the run's `mode`.

- [ ] **Step 2: Negative path (the #75 repro)** — force an incomplete run and confirm it FAILS.
  Simplest forcing function: temporarily set `AGENTAPI_MAX_APPROVALS=0` (env on the dispatch) so the
  consent is never auto-answered → the workflow stalls → no marker → no sentinel.
  Expected: job **fails**; the PR gets the `<!-- cc-review:status -->` "did not finish" comment
  (which must NOT contain the literal `@cc-review` — preserves the #51 self-loop guard); the formal
  review count did **not** rise. Revert the env after.

- [ ] **Step 3: Self-review against the spec** — re-read #75's acceptance criteria and confirm each row
  of the task-map table is satisfied by a landed change. Confirm the backfill call still uses the
  legacy path (no `--done-marker`) and that `--selftest` is green.

- [ ] **Step 4:** Run `/simplify` on the diff (maintainer pre-push rule), then open the PR targeting
  `main` (the live brain branch), linking #75 and pasting the two run URLs from Steps 1–2.

---

## Self-Review (plan author)

- **Spec coverage:** all 7 acceptance criteria mapped in the table; each maps to a concrete task/step. ✓
- **Placeholder scan:** every code step shows complete code; commands have expected output. ✓
- **Type/identifier consistency:** `decideGate` signature `(result, counts, opts)` is identical across
  `gate.mjs`, the CLI entry, and every `gate.test.mjs` case; the marker string `<<<CC_REVIEW_COMPLETE>>>`
  is identical in the orchestrator prompt (T3.1), the invoker arg (T3.2), and is matched by `convo_has`
  (T2.2); the sentinel path `.cc-run/cc-result.json` is identical in T3.1, the `cp` (T4.1), and the
  `SENTINEL=` env (T4.1). ✓
- **Known residual risk:** the orchestrator (an LLM) must reliably write the sentinel file. If the live
  test (T6) shows it skipping the write on a genuinely-complete run (false-fail), the hardening fallback
  is leg "C1" — move the sentinel write into the brain's final agent turn on every return path
  (`strict-review.mjs:771,897,990`); the marker-print stays in the orchestrator. Not implemented now to
  keep the diff minimal; flagged for T6 follow-up.
