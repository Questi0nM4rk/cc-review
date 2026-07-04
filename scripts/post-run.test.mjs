// Contract spec for executePostRun — the PURE Post-phase sequencer (reshape plan Phase 2).
// Everything the brain's Post phase does via agents lives here as deterministic code: replies-once →
// resolves → post-review + verify with retry (≤3 total) → write review-state.json + append findings.jsonl.
// The ONLY platform touch is the injected `adapter(verb, args)`; the ONLY disk touch is `writeFile`.
// Run: node --test scripts/post-run.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { executePostRun } from "./post-run.mjs";

// --- fakes ---------------------------------------------------------------- //

// A scripted adapter: `plan` maps a verb to either a static result or a per-call queue of results.
// Every call is recorded in `calls` (order-preserving), so a test can assert the exact sequence.
function fakeAdapter(plan = {}) {
  const calls = [];
  const queues = {};
  for (const [verb, val] of Object.entries(plan)) {
    if (Array.isArray(val)) queues[verb] = val.slice();
  }
  const fn = async (verb, args) => {
    calls.push({ verb, args });
    const p = plan[verb];
    if (Array.isArray(p)) {
      const q = queues[verb];
      const next = q.length > 1 ? q.shift() : q[0];
      if (next instanceof Error) throw next;
      return next;
    }
    if (typeof p === "function") return p(args, calls);
    if (p instanceof Error) throw p;
    return p;
  };
  fn.calls = calls;
  return fn;
}

function fakeWriteFile() {
  const writes = [];
  const fn = async (path, content) => { writes.push({ path, content }); };
  fn.writes = writes;
  return fn;
}

// A fake appendFile: like fakeWriteFile but records via .appends so a test can distinguish an
// OVERWRITE (writeFile) from an APPEND (appendFile) on the SAME path.
function fakeAppendFile() {
  const appends = [];
  const fn = async (path, content) => { appends.push({ path, content }); };
  fn.appends = appends;
  return fn;
}

// A minimal happy-path ctx builder (override fields per test).
function ctx(over = {}) {
  return {
    pr_number: 42,
    repo: "o/r",
    platform: "github",
    head_sha: "abc123",
    bot_login: "cc-review[bot]",
    payload: { event: "REQUEST_CHANGES", body: "b", comments: [] },
    replies: [],
    resolve_ids: [],
    review_state: '{"reviewed_head_sha":"abc123"}',
    finding_rows: [],
    mem_dir: "/mem",
    ...over,
  };
}

const posted = { posted: true, event: "REQUEST_CHANGES" };
const landedTrue = { reviews: 1, actionItems: 0, landed: true };
const landedFalse = { reviews: 0, actionItems: 0, landed: false };

// --- happy path: reply → resolve → post → verify, in ORDER ---------------- //

test("Should_CallRepliesThenResolvesThenPost_When_HappyPath", async () => {
  const adapter = fakeAdapter({
    reply: { replied: true },
    resolve: { resolved: true },
    "post-review": posted,
    "verify-posted": landedTrue,
  });
  const write = fakeWriteFile();
  const c = ctx({
    replies: [{ thread: "t1", comment_id: "c1", body: "r1" }],
    resolve_ids: ["t1"],
  });

  const res = await executePostRun(c, adapter, write);

  const verbs = adapter.calls.map((x) => x.verb);
  assert.deepEqual(verbs, ["reply", "resolve", "post-review", "verify-posted"]);
  assert.equal(res.landed, true);
  assert.equal(res.posted, true);
  assert.equal(res.attempts, 1);
});

test("Should_ReplyEachThreadOnce_When_MultipleReplies", async () => {
  const adapter = fakeAdapter({
    reply: { replied: true },
    "post-review": posted,
    "verify-posted": landedTrue,
  });
  const c = ctx({ replies: [{ thread: "t1", comment_id: "c1", body: "a" }, { thread: "t2", comment_id: "c2", body: "b" }] });

  await executePostRun(c, adapter, fakeWriteFile());

  const replyCalls = adapter.calls.filter((x) => x.verb === "reply");
  assert.equal(replyCalls.length, 2);
});

// --- reply failure: logged, NEVER retried, does not abort ------------------ //

test("Should_LogReplyFailureAndContinue_When_ReplyThrows", async () => {
  const adapter = fakeAdapter({
    reply: new Error("gh reply failed"),
    "post-review": posted,
    "verify-posted": landedTrue,
  });
  const c = ctx({ replies: [{ thread: "t1", comment_id: "c1", body: "a" }] });

  const res = await executePostRun(c, adapter, fakeWriteFile());

  // exactly one reply attempt — no retry of a non-idempotent op
  assert.equal(adapter.calls.filter((x) => x.verb === "reply").length, 1);
  assert.equal(res.replyFailures.length, 1);
  // sequence still reached post + verify + landed
  assert.equal(res.landed, true);
});

// --- resolve failure: logged, sequence continues -------------------------- //

test("Should_LogResolveFailureAndContinue_When_ResolveThrows", async () => {
  const adapter = fakeAdapter({
    resolve: new Error("resolve failed"),
    "post-review": posted,
    "verify-posted": landedTrue,
  });
  const c = ctx({ resolve_ids: ["t1", "t2"] });

  const res = await executePostRun(c, adapter, fakeWriteFile());

  assert.equal(res.resolveFailures.length, 2);
  assert.equal(res.landed, true);
});

// --- verify false → exactly ONE retry post → landed on second ------------- //

test("Should_RetryPostOnce_When_FirstVerifyFalse", async () => {
  const adapter = fakeAdapter({
    "post-review": posted,
    "verify-posted": [landedFalse, landedTrue],
  });

  const res = await executePostRun(ctx(), adapter, fakeWriteFile());

  assert.equal(adapter.calls.filter((x) => x.verb === "post-review").length, 2);
  assert.equal(adapter.calls.filter((x) => x.verb === "verify-posted").length, 2);
  assert.equal(res.landed, true);
  assert.equal(res.attempts, 2);
});

// --- 3-attempt exhaustion → landed:false, NO writes ----------------------- //

test("Should_StopAtThreeAttemptsWithNoWrites_When_VerifyNeverLands", async () => {
  const adapter = fakeAdapter({
    "post-review": posted,
    "verify-posted": landedFalse,
  });
  const write = fakeWriteFile();
  const append = fakeAppendFile();
  const c = ctx({ finding_rows: [{ id: "f1" }] });

  const res = await executePostRun(c, adapter, write, append);

  assert.equal(res.landed, false);
  assert.equal(res.attempts, 3);
  assert.equal(adapter.calls.filter((x) => x.verb === "post-review").length, 3);
  assert.equal(write.writes.length, 0);
  assert.equal(append.appends.length, 0);
});

// --- GitLab: skip verify, one post, landed = posted ----------------------- //

test("Should_SkipVerifyAndLandOnPost_When_Gitlab", async () => {
  const adapter = fakeAdapter({
    "post-review": { posted: true, event: "comment" },
  });
  const write = fakeWriteFile();
  const c = ctx({ platform: "gitlab" });

  const res = await executePostRun(c, adapter, write);

  assert.equal(adapter.calls.filter((x) => x.verb === "verify-posted").length, 0);
  assert.equal(adapter.calls.filter((x) => x.verb === "post-review").length, 1);
  assert.equal(res.landed, true);
  assert.equal(res.attempts, 1);
});

// --- landed → writes review-state (overwrite) + appends findings.jsonl ----- //

test("Should_WriteReviewStateAndFindings_When_Landed", async () => {
  const adapter = fakeAdapter({
    "post-review": posted,
    "verify-posted": landedTrue,
  });
  const write = fakeWriteFile();
  const append = fakeAppendFile();
  const c = ctx({
    review_state: '{"reviewed_head_sha":"abc123","reviewed_file_count":3}',
    finding_rows: [{ id: "f1", path: "a.ts" }, { id: "f2", path: "b.ts" }],
  });

  const res = await executePostRun(c, adapter, write, append);

  // review-state is an OVERWRITE — routed through writeFile with the EXACT bytes of ctx.review_state.
  const stateWrite = write.writes.find((w) => w.path.endsWith("review-state.json"));
  assert.ok(stateWrite, "review-state.json written via writeFile (overwrite)");
  assert.equal(stateWrite.content, c.review_state);

  // findings.jsonl is an APPEND — routed through appendFile, NOT writeFile.
  assert.equal(write.writes.filter((w) => w.path.endsWith("findings.jsonl")).length, 0, "findings.jsonl NOT overwritten via writeFile");
  const findAppend = append.appends.find((w) => w.path.endsWith("findings.jsonl"));
  assert.ok(findAppend, "findings.jsonl written via appendFile (append)");
  // JSONL: one row per line, trailing newline
  assert.equal(findAppend.content, JSON.stringify({ id: "f1", path: "a.ts" }) + "\n" + JSON.stringify({ id: "f2", path: "b.ts" }) + "\n");

  // both writes are under mem_dir/pr-<N>/
  assert.ok(stateWrite.path.includes("/mem/pr-42/"));
  assert.ok(findAppend.path.includes("/mem/pr-42/"));
  assert.equal(res.writes.length, 2);
});

// --- the P2 regression: findings.jsonl must APPEND across re-runs, review-state OVERWRITES -------- //

test("Should_AppendFindingsAfterExistingRows_When_SecondRun", async () => {
  // A SHARED append seam that carries rows over from a first run to a second — the learning loop reads
  // the UNION of finding rows, so a re-run's rows must land AFTER (not replace) the earlier rows.
  const store = { "/mem/pr-42/findings.jsonl": "" };
  const appendLog = [];
  const appendFile = async (path, content) => {
    appendLog.push({ path, content });
    store[path] = (store[path] ?? "") + content;
  };
  const write = fakeWriteFile();
  const adapter = () => Promise.resolve(null); // rebuilt per run below

  const run1 = fakeAdapter({ "post-review": posted, "verify-posted": landedTrue });
  await executePostRun(ctx({ finding_rows: [{ id: "f1" }] }), run1, fakeWriteFile(), appendFile);

  const run2 = fakeAdapter({ "post-review": posted, "verify-posted": landedTrue });
  await executePostRun(ctx({ finding_rows: [{ id: "f2" }] }), run2, write, appendFile);

  // The second run's row is AFTER the first run's row in the accumulated file — never overwritten.
  const lines = store["/mem/pr-42/findings.jsonl"].split("\n").filter(Boolean);
  assert.deepEqual(lines, [JSON.stringify({ id: "f1" }), JSON.stringify({ id: "f2" })]);
  // findings went ONLY through appendFile across both runs (never the overwrite seam).
  assert.equal(write.writes.filter((w) => w.path.endsWith("findings.jsonl")).length, 0);
  assert.equal(appendLog.length, 2);
});

test("Should_OverwriteReviewStateViaWriteFile_When_Landed", async () => {
  // review-state.json stays an OVERWRITE (writeFile) even as findings APPEND — a re-run's state marker
  // fully replaces the prior one; it is never accumulated.
  const adapter = fakeAdapter({ "post-review": posted, "verify-posted": landedTrue });
  const write = fakeWriteFile();
  const append = fakeAppendFile();
  const c = ctx({ review_state: '{"reviewed_head_sha":"deadbeef"}', finding_rows: [{ id: "f1" }] });

  await executePostRun(c, adapter, write, append);

  // review-state routed to writeFile only; never appended.
  assert.equal(write.writes.filter((w) => w.path.endsWith("review-state.json")).length, 1);
  assert.equal(append.appends.filter((w) => w.path.endsWith("review-state.json")).length, 0);
});

// --- no finding_rows → NO findings.jsonl write ---------------------------- //

test("Should_NotWriteFindings_When_NoFindingRows", async () => {
  const adapter = fakeAdapter({
    "post-review": posted,
    "verify-posted": landedTrue,
  });
  const write = fakeWriteFile();
  const append = fakeAppendFile();

  await executePostRun(ctx({ finding_rows: [] }), adapter, write, append);

  assert.equal(write.writes.filter((w) => w.path.endsWith("findings.jsonl")).length, 0);
  assert.equal(append.appends.filter((w) => w.path.endsWith("findings.jsonl")).length, 0);
  // review-state still written on landed
  assert.equal(write.writes.filter((w) => w.path.endsWith("review-state.json")).length, 1);
});

// --- no mem_dir → NO findings.jsonl write (dir path required) -------------- //

test("Should_NotWriteFindings_When_MemDirAbsent", async () => {
  const adapter = fakeAdapter({
    "post-review": posted,
    "verify-posted": landedTrue,
  });
  const write = fakeWriteFile();
  const append = fakeAppendFile();

  await executePostRun(ctx({ mem_dir: "", finding_rows: [{ id: "f1" }] }), adapter, write, append);

  assert.equal(write.writes.filter((w) => w.path.endsWith("findings.jsonl")).length, 0);
  assert.equal(append.appends.filter((w) => w.path.endsWith("findings.jsonl")).length, 0);
});

// --- duplicate-review (posted:false, duplicate:true) counts as posted ------ //

test("Should_TreatDuplicateAsPosted_When_IdempotentRepost", async () => {
  const adapter = fakeAdapter({
    "post-review": { posted: false, duplicate: true, event: "REQUEST_CHANGES" },
    "verify-posted": landedTrue,
  });
  const write = fakeWriteFile();
  const append = fakeAppendFile();

  const res = await executePostRun(ctx({ finding_rows: [{ id: "f1" }] }), adapter, write, append);

  assert.equal(res.posted, true);
  assert.equal(res.landed, true);
  // idempotent duplicate still verifies + writes on landed
  assert.equal(adapter.calls.filter((x) => x.verb === "verify-posted").length, 1);
  // review-state overwrite (writeFile) + findings append (appendFile) = 2 total writes recorded.
  assert.equal(write.writes.length, 1);
  assert.equal(append.appends.length, 1);
  assert.equal(res.writes.length, 2);
});
