// Contract spec for the post-run completion gate (issue #75). gate.mjs is a plain ESM
// runner module (no top-level await), so its pure function imports directly — no
// extraction trick needed.
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
  const v = decideGate(null, counts("0", "0", "0", "1"), { runRc: 0, post: true });
  assert.equal(v.pass, false);
  assert.match(v.reason, /no completion result|did not finish|stalled/i);
});

test("3. sentinel present but ok!==true (no reason) → FAIL with the generic stalled message", () => {
  const v = decideGate({ ok: false, mode: "first" }, counts("0", "1", "0", "1"), { runRc: 0, post: true });
  assert.equal(v.pass, false);
  assert.match(v.reason, /no completion result|did not finish|stalled/i);
});

test("3b. sentinel ok:false WITH a reason (intentional abort: empty diff / unresolved PR) → FAIL surfacing that reason", () => {
  const v = decideGate({ ok: false, reason: "empty diff — the fetch returned no changes to review" }, counts("0", "0", "0", "0"), { runRc: 0, post: true });
  assert.equal(v.pass, false);
  assert.match(v.reason, /empty diff/);
});

test("4. first review, formal review count rose → PASS", () => {
  const v = decideGate(ok("first"), counts("0", "1", "0", "1"), { runRc: 0, post: true });
  assert.equal(v.pass, true);
  assert.equal(v.reason, "");
});

test("5. OVERVIEW-ONLY: first review finished but only a comment rose, review flat → FAIL", () => {
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
