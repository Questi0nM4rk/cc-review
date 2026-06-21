# Issue #75 Follow-up — root-sandbox fix + post-verify retry loop

> **Status: Draft.** Proper (TDD, reviewed) follow-up to the shipped #75 gate, prompted by the
> live re-test on hook-kit #39, which **correctly red-failed** an incomplete run (no false-green)
> but revealed the review could not *complete*. Supersedes the rushed PR #77 (held, not merged).

**Goal:** (1) make a CI review actually complete (fix the root-user permission refusal), and
(2) add a deterministic post-verification retry loop so a posted verdict is confirmed against GitHub
ground truth — retrying the post, then failing red if nothing landed.

**Architecture:** Three layers of completion assurance, innermost first:
1. **No prompt storm** — `IS_SANDBOX=1` (asserted by the CI pipeline) lets `--dangerously-skip-permissions` engage under the runner's root uid, so the review runs without per-command approval prompts.
2. **Post-verify retry (NEW)** — after the post agent, a deterministic `verify-posted` adapter check (run-scoped by `commit_id == head_sha`) confirms a review/approve OR action items landed; if not, retry the post up to 3×.
3. **Runner gate (existing, #75)** — `gate.mjs` backstops at the runner: a normal review whose formal review count didn't rise → fail red + status comment.

---

## Root cause (verified against the claude 2.1.x binary, not inferred)

`--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons` — a
literal guard in the binary. GitHub Actions runs as **root**, so the flag is refused → bypass mode
never engages → **every** tool command prompts `"Do you want to proceed?"`. The auto-approver answered
6 prompts then a later one didn't match → stall → 40-min timeout, marker never emitted (transcript on
`pr-39-cc-review-output` confirms: roles are `user`/`agent`, marker only in the `user` prompt). The
binary also exposes the escape hatch: env `IS_SANDBOX` (and `CLAUDE_CODE_FORCE_SANDBOX`).

This is the long-standing cc-review "gate 4" (per-tool prompts); the CLAUDE.md claim that
`--dangerously-skip-permissions` "silences them on the runner" is **false under root** and is corrected
in Task P4.

---

## Task P1: `verify-posted` adapter verb + pure classifier + test

**Files:** Modify `scripts/review-platform.ts`; Test `scripts/review-platform.test.mjs` (new).

Contract: `tsx review-platform.ts verify-posted --pr N --head-sha SHA` →
`{ reviews: <int>, actionItems: <int>, landed: <bool> }` where, **scoped to this run** (the bot's
reviews/inline-comments whose `commit_id === head_sha`): `reviews` = count of bot formal reviews on
this head (covers APPROVE and REQUEST_CHANGES), `actionItems` = count of bot inline review comments on
this head, `landed = reviews > 0 || actionItems > 0`.

- [ ] **Step 1 — pure classifier (test first).** Add to `review-platform.ts` an exported pure fn:

```ts
// Run-scoped post verification (issue #75 retry loop). Given the bot's reviews + inline review
// comments on a PR, count those that belong to THIS run — same bot login AND submitted against the
// reviewed head SHA (commit_id) — and decide whether a verdict actually landed. Deterministic; the
// `verify-posted` verb wires gh queries to it, the brain's post loop retries until landed===true.
export function classifyPosted(
  reviews: Array<{ commit_id?: string; user?: { login?: string } }>,
  inlineComments: Array<{ commit_id?: string; user?: { login?: string } }>,
  headSha: string,
  botLogin: string,
): { reviews: number; actionItems: number; landed: boolean } {
  const mine = (x: { commit_id?: string; user?: { login?: string } }) =>
    (x.user?.login ?? "") === botLogin && (x.commit_id ?? "") === headSha;
  const r = reviews.filter(mine).length;
  const a = inlineComments.filter(mine).length;
  return { reviews: r, actionItems: a, landed: r > 0 || a > 0 };
}
```

- [ ] **Step 2 — test it** (`scripts/review-platform.test.mjs`, `node --test`):

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPosted } from "./review-platform.ts";

const BOT = "cc-review[bot]";
const HEAD = "abc123";
const rev = (login, commit) => ({ user: { login }, commit_id: commit });

test("APPROVE on this head by the bot → landed", () => {
  const v = classifyPosted([rev(BOT, HEAD)], [], HEAD, BOT);
  assert.deepEqual(v, { reviews: 1, actionItems: 0, landed: true });
});
test("inline action items on this head → landed", () => {
  const v = classifyPosted([], [rev(BOT, HEAD), rev(BOT, HEAD)], HEAD, BOT);
  assert.equal(v.landed, true);
  assert.equal(v.actionItems, 2);
});
test("only a PRIOR run's review (older commit) → NOT landed (run-scoped)", () => {
  const v = classifyPosted([rev(BOT, "oldsha")], [], HEAD, BOT);
  assert.equal(v.landed, false);
});
test("a human review on this head → NOT landed (bot-scoped)", () => {
  const v = classifyPosted([rev("alice", HEAD)], [], HEAD, BOT);
  assert.equal(v.landed, false);
});
test("nothing posted → NOT landed", () => {
  assert.equal(classifyPosted([], [], HEAD, BOT).landed, false);
});
```

Run: `node --test scripts/review-platform.test.mjs` → first FAIL (no export), then PASS after Step 1.
Note: `node --test` runs `.ts` via the same loader the repo's other tests use; if `import ... .ts`
fails under plain node, mirror `helpers.test.mjs`'s loader approach or run via `tsx --test`. Confirm the
chosen runner is what `.github/workflows/ci.yml` invokes; wire this file in alongside `gate.test.mjs`.

- [ ] **Step 3 — the verb.** Add `case "verify-posted":` to `main()`'s dispatch and a handler that:
  reads `--pr` (requireFlag) + `--head-sha` (requireFlag); `const { repo } = detect()`;
  `reviews = JSON.parse(run("gh", ["api", \`repos/${repo}/pulls/${pr}/reviews\`, "--paginate"]).stdout)`;
  `comments = JSON.parse(run("gh", ["api", \`repos/${repo}/pulls/${pr}/comments\`, "--paginate"]).stdout)`;
  `out(classifyPosted(reviews, comments, headSha, "cc-review[bot]"))`. Handle gh failure via `die`.
  Add `verify-posted` to the verbs usage line.

- [ ] **Step 4 — commit:** `git add scripts/review-platform.ts scripts/review-platform.test.mjs .github/workflows/ci.yml && git commit -m "feat(#75): verify-posted adapter verb + run-scoped classifier (post-verify retry support)"`

---

## Task P2: brain Post-phase retry loop

**Files:** Modify `.claude/workflows/strict-review.mjs`.

- [ ] **Step 1 — schema + prompt.** Add near the other schemas:
```js
const VERIFY_SCHEMA = { type: "object", required: ["landed"], additionalProperties: true, properties: { landed: { type: "boolean" }, reviews: { type: "integer" }, actionItems: { type: "integer" } } };
```
Add a prompt that makes an agent run the deterministic verb and report its JSON verbatim:
```js
const verifyPostedPrompt = (prNumber, headSha) =>
  `Run exactly: tsx ${ADAPTER} verify-posted --pr ${prNumber} --head-sha ${headSha}\nReport its JSON result verbatim — { reviews, actionItems, landed }. Do not interpret; relay the adapter's output.`;
```

- [ ] **Step 2 — the loop.** Replace the current Post block (`if (post) { posted = await agent(reviewPostPrompt...); await agent(postOpsPrompt...); }`) with:
```js
let posted = null, postLanded = false;
if (post) {
  phase("Post");
  const MAX_POST_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_POST_ATTEMPTS && !postLanded; attempt++) {
    posted = await agent(reviewPostPrompt({ repo, pr_number: prNumber, resolve_ids: resolveIds, replies, payload }), { schema: POST_RESULT_SCHEMA, model: "sonnet", label: `post-review${attempt > 1 ? `:retry${attempt - 1}` : ""}`, phase: "Post" });
    const v = await agent(verifyPostedPrompt(prNumber, headSha), { schema: VERIFY_SCHEMA, model: "sonnet", label: `verify-posted:${attempt}`, phase: "Post" });
    postLanded = v?.landed === true;
    if (!postLanded) log(`post attempt ${attempt}/${MAX_POST_ATTEMPTS}: no review/approve or action items landed on ${headSha} — retrying`);
  }
  if (postLanded) {
    await agent(postOpsPrompt(prNumber, headSha, files, event, findingRows), { model: "sonnet", label: "post-ops", phase: "Post" });
  } else {
    log(`POST FAILED: nothing landed after ${MAX_POST_ATTEMPTS} attempts — the run will fail at the gate`);
  }
}
```

- [ ] **Step 3 — surface in the sentinel.** Add `postLanded` to the final return so the runner can see it:
  `return { ok: true, ..., posted, idempotent: posted?.duplicate === true, postLanded, memory };`
  (gate.mjs already fails when the formal review count didn't rise; `postLanded:false` makes the failure
  explicit in the sentinel/log for diagnosis. The fail-red + status-comment outcome is delivered by the
  existing gate.mjs + ci-run.sh REASON path — no new comment logic in the brain.)

- [ ] **Step 4 — validate + commit:** `node scripts/check-brain.mjs` (syntax OK) → `git add .claude/workflows/strict-review.mjs && git commit -m "feat(#75): post-verify retry loop in the brain Post phase (3 attempts, ground-truth verify-posted)"`

---

## Task P3: root-sandbox fix + security-review hardening

**Files:** Modify `scripts/ci-run.sh`, `scripts/agentapi-claude.sh`. (Revises the held PR #77 commit.)

- [ ] **Step 1 — assert the sandbox in the CI pipeline (not uid-inferred).** In `ci-run.sh`, after
  `export GITHUB_TOKEN="${GH_TOKEN}"`, add `export IS_SANDBOX=1` with a comment that this pipeline runs
  only inside an isolated CI runner (the trust boundary), so Claude's `--dangerously-skip-permissions`
  engages under root. Addresses security finding 1 (explicit, in the verified-CI entry point).
- [ ] **Step 2 — remove the uid-inferred export** from `agentapi-claude.sh` (the `if [ "$(id -u)" = "0" ]` block added in the held commit); replace with a comment noting the caller (ci-run.sh) asserts the sandbox.
- [ ] **Step 3 — robust auto-approve guard** in `agentapi-claude.sh`: restore a structural menu check that is locale-safe — `grep -qE '^[[:space:]]*[0-9][.)]'` (matches a non-cursor numbered option, no multibyte `❯` dependency) — instead of the brittle anchored regex. Addresses security finding 2 without the stall failure mode.
- [ ] **Step 4 — validate + commit:** `bash -n` both → commit.

---

## Task P4: docs (same PR)

- [ ] Correct `CLAUDE.md`: the `--dangerously-skip-permissions` flag is **refused under root**; bypass is engaged via `IS_SANDBOX=1` asserted by `ci-run.sh`. Note the post-verify retry loop in the `strict-review.mjs` pipeline description.
- [ ] `docs/lessons-learned.md`: add the root-refusal + IS_SANDBOX root cause and the live-#39 diagnosis.
- [ ] `SPEC.md`: document the post-verify retry contract (verify-posted, run-scoped by commit_id, 3 attempts, fail-red on exhaustion) as part of §2a.

---

## Task P5: validate + ship

- [ ] Full suite green (`node --test` incl. gate + review-platform), `bash -n` clean, brain syntax OK, sentrux no regression.
- [ ] Final adversarial review of the whole branch.
- [ ] Update PR #77 (retitle/rebody to the full proper scope) — or close it and open a fresh PR — targeting `main`.
- [ ] **Acceptance gate:** because the root bug only reproduces on a root CI runner and consumers clone `main`, this can only be verified post-merge. Merge (main is already safe-red), then re-trigger hook-kit #39; require **job success + a formal review posted on the PR head**. If red, iterate; main is no worse than its current stalled state.

## Self-review (author)

- Spec coverage: root fix (P3), retry feature (P1+P2), security findings (P3 steps 1-3), docs (P4). ✓
- Run-scoping: `commit_id === head_sha` prevents a prior run's review from masking a failed post. ✓
- No false-green: verify-posted is deterministic (adapter code); the brain relays it; gate.mjs backstops. ✓
- Residual: `verify-posted` relays via an agent turn (the brain can't shell out) — same trust level as every other schema'd agent; the runner-level gate.mjs remains the non-agent backstop.
