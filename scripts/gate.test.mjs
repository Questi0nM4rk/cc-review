// Contract spec for the post-run completion gate (issue #75; reshape Phase 2).
// gate.mjs is a plain ESM runner module (no top-level await), so its pure function imports
// directly — no extraction trick needed.
//
// The scenarios ARE the spec. Above all: case 2 — the #75 repro — an overview posted, the
// workflow froze before Decide/Post, agentapi went 'stable' → the gate MUST fail the run.
//
// Reshape Phase 2 change: the brain no longer posts. The runner's post-run step (post-run.mjs,
// via the post-run adapter verb) posts and writes .cc-run/cc-postrun-result.json. For a normal
// review (first/rerun) with post==true the gate now reads THAT file — { landed, posted, attempts } —
// as the authoritative "did the verdict land" signal (duplicate-as-posted is already folded into
// landed inside post-run.mjs). A MISSING postrun-result on a review mode with post==true is a FAIL
// (the post step never ran). answer/rerun-blocked still key off comment growth (posted runner-side
// via the overview verb, no postrun-result written).
//
// Run: node --test scripts/gate.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { decideGate } from "./gate.mjs";

const counts = (br, ar, bc, ac) => ({ beforeReviews: br, afterReviews: ar, beforeComments: bc, afterComments: ac });
const ok = (mode, extra = {}) => ({ ok: true, mode, ...extra });
// The 4th arg to decideGate: the parsed .cc-run/cc-postrun-result.json, or null when absent.
const pr = (o) => o;

test("1. agentapi exited non-zero (timed out / died) → FAIL regardless of sentinel", () => {
  const v = decideGate(ok("first"), counts("0", "1", "0", "1"), { runRc: 1, post: true }, pr({ landed: true }));
  assert.equal(v.pass, false);
  assert.match(v.reason, /did not signal completion/i);
});

test("2. #75 REPRO: overview posted, workflow froze before Decide, status stable, no sentinel → FAIL", () => {
  const v = decideGate(null, counts("0", "0", "0", "1"), { runRc: 0, post: true }, null);
  assert.equal(v.pass, false);
  assert.match(v.reason, /no completion result|did not finish|stalled/i);
});

test("3. sentinel present but ok!==true (no reason) → FAIL with the generic stalled message", () => {
  const v = decideGate({ ok: false, mode: "first" }, counts("0", "1", "0", "1"), { runRc: 0, post: true }, null);
  assert.equal(v.pass, false);
  assert.match(v.reason, /no completion result|did not finish|stalled/i);
});

test("3b. sentinel ok:false WITH a reason (intentional abort: empty diff / unresolved PR) → FAIL surfacing that reason", () => {
  const v = decideGate({ ok: false, reason: "empty diff — the fetch returned no changes to review" }, counts("0", "0", "0", "0"), { runRc: 0, post: true }, null);
  assert.equal(v.pass, false);
  assert.match(v.reason, /empty diff/);
});

test("4. first review, postrun-result landed:true → PASS", () => {
  const v = decideGate(ok("first"), counts("0", "1", "0", "1"), { runRc: 0, post: true }, pr({ landed: true, posted: true, attempts: 1 }));
  assert.equal(v.pass, true);
  assert.equal(v.reason, "");
});

test("5. review mode, postrun-result MISSING is FAIL even if the review count rose (postrun-result is authoritative)", () => {
  // The count rising is not enough — the post step must have written its result. A missing file means
  // the runner's post-run step never completed (froze), so the run must fail even on a stale count bump.
  const v = decideGate(ok("first"), counts("0", "1", "0", "1"), { runRc: 0, post: true }, null);
  assert.equal(v.pass, false);
  assert.match(v.reason, /post-run|did not post|verdict was not posted|no post-run result/i);
});

test("5b. review mode, postrun-result present but landed:false is FAIL even if the count rose", () => {
  const v = decideGate(ok("first"), counts("0", "1", "0", "1"), { runRc: 0, post: true }, pr({ landed: false, posted: false, attempts: 3 }));
  assert.equal(v.pass, false);
  assert.match(v.reason, /did not land|verdict was not posted|no.*review/i);
});

test("6. rerun, postrun-result landed:true → PASS", () => {
  assert.equal(decideGate(ok("rerun"), counts("2", "3", "5", "5"), { runRc: 0, post: true }, pr({ landed: true, posted: true, attempts: 1 })).pass, true);
});

test("6b. rerun, byte-identical re-post (duplicate folded into landed:true by post-run.mjs) → PASS (#75 AC)", () => {
  // post-run.mjs treats duplicate:true as posted:true and landed:true — the gate just reads landed.
  assert.equal(decideGate(ok("rerun"), counts("1", "1", "5", "5"), { runRc: 0, post: true }, pr({ landed: true, posted: true, attempts: 1 })).pass, true);
});

test("6c. rerun, postrun-result landed:false → FAIL (a genuinely missing verdict)", () => {
  const v = decideGate(ok("rerun"), counts("1", "1", "5", "5"), { runRc: 0, post: true }, pr({ landed: false, posted: false, attempts: 3 }));
  assert.equal(v.pass, false);
  assert.match(v.reason, /did not land|verdict was not posted|no.*review/i);
});

test("7. answer mode, comment rose → PASS (posted runner-side, no postrun-result)", () => {
  assert.equal(decideGate(ok("answer"), counts("0", "0", "1", "2"), { runRc: 0, post: true }, null).pass, true);
});

test("8. answer mode, nothing rose → FAIL", () => {
  assert.equal(decideGate(ok("answer"), counts("0", "0", "1", "1"), { runRc: 0, post: true }, null).pass, false);
});

test("9. rerun-blocked (nag comment), comment rose → PASS", () => {
  assert.equal(decideGate(ok("rerun-blocked"), counts("0", "0", "0", "1"), { runRc: 0, post: true }, null).pass, true);
});

test("9b. rerun-blocked, NO comment growth but postrun-result nag=skipped-duplicate → PASS (dedup must not starve the gate)", () => {
  // The nag was skipped because a <!-- cc-review:nag --> comment already exists, so no NEW comment
  // appears. The runner records that skip in the postrun-result; the gate accepts it as completion —
  // mirroring the idempotent-duplicate-review precedent so a legitimate dedup can't be read as a failure.
  const v = decideGate(ok("rerun-blocked"), counts("0", "0", "1", "1"), { runRc: 0, post: true }, pr({ nag: "skipped-duplicate" }));
  assert.equal(v.pass, true);
  assert.equal(v.reason, "");
});

test("9c. rerun-blocked, NO comment growth AND no skip marker → still FAIL (a genuinely dropped nag)", () => {
  const v = decideGate(ok("rerun-blocked"), counts("0", "0", "1", "1"), { runRc: 0, post: true }, null);
  assert.equal(v.pass, false);
  assert.match(v.reason, /no new cc-review comment|was not posted/i);
});

test("10. post=false (local/dry-run dispatch) → PASS, no gate", () => {
  assert.equal(decideGate(ok("first"), counts("0", "0", "0", "0"), { runRc: 0, post: false }, null).pass, true);
});

test("11. localDryRun sentinel even with post=true → PASS, no gate", () => {
  assert.equal(decideGate(ok("first", { localDryRun: true }), counts("0", "0", "0", "0"), { runRc: 0, post: true }, null).pass, true);
});

test("12. DEGRADE: answer-mode comment snapshot unreadable ('ERR') → trust the sentinel, PASS", () => {
  assert.equal(decideGate(ok("answer"), counts("ERR", "ERR", "ERR", "ERR"), { runRc: 0, post: true }, null).pass, true);
});

test("13. unknown future mode → don't fail on the gate's ignorance, PASS", () => {
  assert.equal(decideGate(ok("some-future-mode"), counts("0", "0", "0", "0"), { runRc: 0, post: true }, null).pass, true);
});
