// Mock-agent FLOW harness for the ORCHESTRATION half of .claude/workflows/strict-review.mjs —
// everything BELOW the "=== END PURE HELPERS (test-extraction boundary) ===" sentinel, which today
// has zero test coverage. (The declarations ABOVE the sentinel are unit-tested in helpers.test.mjs.)
//
// The brain is a Workflow script: it can't be imported raw (top-level await/return + injected globals
// agent()/parallel()/phase()/log()/args execute on import and crash). This harness combines the two
// existing extraction tricks in the repo:
//   - helpers.test.mjs slices the file and dynamic-imports it, and
//   - check-brain.mjs proves the WHOLE brain parses when wrapped in an async function (the Workflow
//     runtime injects the globals + allows top-level await/return).
// We wrap the ENTIRE brain body in `export async function __run(__inj)`, bind the injected globals from
// __inj (so ARGS resolves from __inj.args — the brain reads `typeof args === "undefined"`), write it to
// a temp .mjs, dynamic-import it, and call __run per test with a per-test SCENARIO driving agent().
// The brain source is NEVER modified. Prompts are inert strings — only stub RESULTS matter, so the
// tests are deterministic + fast (no network, no git, no tsx, no adapter).
//
// Run: node --test scripts/flow-harness.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const BRAIN = fileURLToPath(new URL("../.claude/workflows/strict-review.mjs", import.meta.url));
const SENTINEL = "// === END PURE HELPERS (test-extraction boundary) ===";

const raw = readFileSync(BRAIN, "utf8");
assert.ok(raw.includes(SENTINEL), "extraction sentinel not found — did the marker move? this harness targets the region below it");
// Strip the single module-level export so it's legal inside a function, then wrap the FULL body.
// `const args = __inj.args` is declared FIRST so the ARGS IIFE (which reads `typeof args`) resolves
// from the injection instead of throwing a ReferenceError. `pipeline` is unused by this brain.
const body = raw.replace(/^export const meta/m, "const meta");
const wrapped = `export async function __run(__inj) {
  const { agent, parallel, phase, log } = __inj;
  const args = __inj.args;
${body}
}`;
const file = join(mkdtempSync(join(tmpdir(), "ccr-flow-")), "flow.mjs");
writeFileSync(file, wrapped, "utf8");
const { __run } = await import(pathToFileURL(file).href);

// ---------------------------------------------------------------------------
// Harness plumbing
// ---------------------------------------------------------------------------

// A small real diff touching one non-doc, non-risky source file: changedFiles -> ["src/a.ts"],
// addedLineCount -> 1, so the deterministic difficulty floor stays 1 and web research is skipped.
const SMALL_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,3 @@",
  " const x = 1;",
  "+const y = 2;",
  " export { x };",
].join("\n");

// Mirror the brain's changedFiles / addedLineCount so a fixture's precomputed ctx fields stay in parity
// with whatever `diff` a scenario supplies (the prefetch verb computes these over the FULL diff; here we
// compute them over the fixture diff, which is small enough to equal the excerpt).
const ctxFilesOf = (diff) => {
  const s = new Set();
  for (const m of String(diff).matchAll(/^\+\+\+ b\/(.+)$/gm)) s.add(m[1]);
  for (const m of String(diff).matchAll(/^diff --git a\/.+ b\/(.+)$/gm)) s.add(m[1]);
  return [...s];
};
const ctxAddedOf = (diff) => {
  let n = 0;
  for (const _m of String(diff).matchAll(/^\+(?!\+\+ )/gm)) n++;
  return n;
};

const baseFetch = (o = {}) => {
  const diff = o.diff !== undefined ? o.diff : SMALL_DIFF;
  return {
    diff,
    // Reshape Phase 2 fix: the ctx carries the FULL diff on disk + a bounded excerpt inline, plus these
    // exact precomputed fields. The brain reads diff_files / added_line_count instead of re-parsing the
    // (possibly truncated) excerpt. A scenario can override any of them via `o`.
    diff_path: "/tmp/pr-diff.txt",
    diff_truncated: false,
    diff_files: ctxFilesOf(diff),
    added_line_count: ctxAddedOf(diff),
    pr_number: 42,
    repo: "o/r",
    platform: "github",
    head_sha: "deadbeef",
    reviewed_file_count: null,
    reviewed_head_sha: "",
    user_message: "",
    post: false,
    ping_override: false,
    overview_id: null,
    config: {},
    threads: [],
    ...o,
  };
};

const baseThread = (o = {}) => ({
  id: "T1",
  path: "src/a.ts",
  line: 2,
  original_body: "Remove the unused variable",
  author_replied: true,
  ...o,
});

const finding = (o = {}) => ({ file: "src/a.ts", line: 2, description: "Remove the unused variable y", in_diff: true, ...o });
const graded = (f, verdict = "confirmed", confidence = "high") => ({ original: f, verdict, confidence });

// Schema-shaped defaults for every label the orchestration emits. A scenario's `agents` map overrides
// these (longest/most-specific key wins). A value may be a plain object/string/null, or a function
// of (prompt, opts) for stateful stubs (e.g. the verify-retry loop).
const DEFAULTS = {
  // Phase 3p2: intent folded into holistic — is_question/answer now required fields on holistic schema
  holistic: { category: "other", difficulty: 3, overview_markdown: "## Overview\n\nDoes stuff.\n", is_question: false, answer: "" },
  // Phase 3p2: merged single research agent (label: "research", not "research:ai-slop"/"research:general")
  "research": { source: "research", observations: [] },
  "memories+docs": { notes: [] },
  tools: { available: [], findings: [], outcomes: [] },
  "review:": { findings: [] },
  check: { graded: [] },
  // Phase 3p2: comment-mgmt is a single batch call (label: "comment-mgmt"); returns { actions: [] }
  "comment-mgmt": { actions: [] },
  "sig-change": { significant: false, reason: "minor" },
  // Reshape Phase 2: the ONLY posting agent left in the brain is the mid-run overview post/edit.
  // post-answer / post-gate(nag) / thread-ops / post-review / verify-posted / post-ops are GONE —
  // they moved to the runner's post-run step. A scenario asserting any of those labels fires MUST fail.
  "post-overview": null,
  "edit-overview": null,
  memory: "memory written",
};

// Labels that must NEVER appear in the brain's agent calls after the Phase-2 reshape (posting moved to
// the runner). Any post-path scenario asserts this set stays empty.
const POST_AGENT_LABELS = ["post-answer", "post-gate", "thread-ops", "post-review", "verify-posted", "post-ops"];
const assertNoPostAgents = (calls) => {
  for (const l of POST_AGENT_LABELS) assert.equal(has(calls, l), false, `brain must not call the '${l}' agent — posting is runner-side now`);
};

// Resolve a value from a prefix-map: exact match or longest startsWith match wins.
function pick(map, label) {
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  for (const k of keys) if (label === k || label.startsWith(k)) return { hit: true, val: map[k] };
  return { hit: false };
}

// Drive one run of the brain against a scenario. Returns { result, calls, phases, logs }.
async function run(scenario) {
  const calls = [];
  const phases = [];
  const logs = [];
  const agent = async (prompt, opts = {}) => {
    const label = opts.label || "";
    calls.push({ label, prompt });
    if (label === "fetch") {
      const f = scenario.fetch === undefined ? baseFetch() : scenario.fetch;
      return typeof f === "function" ? f(prompt, opts) : f;
    }
    let r = pick(scenario.agents || {}, label);
    if (!r.hit) r = pick(DEFAULTS, label);
    const v = r.hit ? r.val : null;
    return typeof v === "function" ? v(prompt, opts) : v;
  };
  const inj = {
    agent,
    parallel: (thunks) => Promise.all(thunks.map((t) => t().catch(() => null))),
    phase: (name) => phases.push(name),
    log: (msg) => logs.push(String(msg)),
    args: scenario.args || {},
  };
  const result = await __run(inj);
  return { result, calls, phases, logs };
}

const has = (calls, prefix) => calls.some((c) => c.label === prefix || c.label.startsWith(prefix));
const count = (calls, prefix) => calls.filter((c) => c.label === prefix || c.label.startsWith(prefix)).length;

// ---------------------------------------------------------------------------
// Scenario 1 — local dry-run first review (post=false)
// ---------------------------------------------------------------------------
test("scenario 1: local dry-run first review runs fetch->holistic->gather->squad->check->decide, no posting", async () => {
  const { result, calls, logs } = await run({
    args: {}, // no prNumber, no post -> local dry-run
    fetch: baseFetch({ pr_number: 0, repo: "", post: false }),
    agents: {
      holistic: { category: "other", difficulty: 3, overview_markdown: "## Overview\n\nAdds y.\n" },
      "review:": { findings: [finding()] },
      check: { graded: [graded(finding())] },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "first");
  assert.equal(result.reviewed, true);
  assert.equal(result.localDryRun, true);
  assert.equal(result.event, "REQUEST_CHANGES");
  assert.equal(result.totals.confirmed, 1);
  assertNoPostAgents(calls); // posting is runner-side; a dry-run assembles nothing to post
  assert.equal(has(calls, "post-overview"), false, "must not post the overview when post=false");
  assert.equal(result.post_run, null, "post=false -> post_run is null (nothing for the runner to post)");
  assert.ok(logs.some((l) => /skipping web research/.test(l)), "small non-risky diff skips web research");
});

// ---------------------------------------------------------------------------
// Scenario 2 — fail-closed: one squad reviewer dies (null)
// ---------------------------------------------------------------------------
test("scenario 2: a null squad reviewer aborts fail-closed (ok:false), no post/memory", async () => {
  const { result, calls } = await run({
    fetch: baseFetch({ pr_number: 0, repo: "", post: false }),
    agents: {
      holistic: { category: "other", difficulty: 3, overview_markdown: "x" }, // d3 -> 2 opus reviewers
      "review:architecture": null, // agent death for one reviewer
      "review:security": { findings: [] },
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /squad reviewer/i);
  assert.equal(result.mode, "first");
  assert.equal(has(calls, "post-review"), false, "no verdict may be posted off a partial squad");
  assert.equal(has(calls, "memory"), false, "no memory write off a partial squad");
});

// ---------------------------------------------------------------------------
// Scenario 3 — fail-closed: the check agent dies (null)
// ---------------------------------------------------------------------------
test("scenario 3: a null check agent aborts fail-closed (ok:false), no post", async () => {
  const { result, calls } = await run({
    fetch: baseFetch({ pr_number: 0, repo: "", post: false }),
    agents: {
      holistic: { category: "other", difficulty: 3, overview_markdown: "x" },
      "review:": { findings: [finding()] }, // deduped>0 so the check branch runs
      check: null, // agent death
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /check agent/i);
  assert.equal(has(calls, "post-review"), false);
  assert.equal(has(calls, "memory"), false);
});

// ---------------------------------------------------------------------------
// Scenario 4 — empty diff
// ---------------------------------------------------------------------------
test("scenario 4: an empty diff aborts before any review", async () => {
  const { result, calls } = await run({
    fetch: baseFetch({ diff: "", pr_number: 0, repo: "", post: false }),
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /empty diff/i);
  assert.equal(has(calls, "holistic"), false, "no holistic pass on an empty diff");
  assert.equal(has(calls, "review:"), false);
});

// ---------------------------------------------------------------------------
// Scenario 5 — identity gate: fetch resolved the wrong PR
// ---------------------------------------------------------------------------
test("scenario 5: fetch resolving PR #9 when #7 was requested aborts", async () => {
  const { result, calls } = await run({
    args: { prNumber: 7 },
    fetch: baseFetch({ pr_number: 9, repo: "o/r" }),
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /#9/);
  assert.match(result.reason, /#7/);
  assert.equal(has(calls, "review:"), false, "never review a mis-resolved PR");
});

// ---------------------------------------------------------------------------
// Scenario 6 — answer mode (a maintainer question)
// ---------------------------------------------------------------------------
test("scenario 6: a maintainer question is answered and stops; NO posting agent, post_run null, answer carried", async () => {
  // Phase 3p2: intent detection folded into holistic — is_question/answer come from the holistic result.
  const { result, calls } = await run({
    fetch: baseFetch({ pr_number: 42, repo: "o/r", post: true, user_message: "Why did you rename foo?" }),
    agents: {
      holistic: { category: "other", difficulty: 3, overview_markdown: "## Overview\n\nAdds y.\n", is_question: true, answer: "Because foo shadowed a builtin." },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "answer");
  assert.equal(result.answer, "Because foo shadowed a builtin.");
  assert.equal(result.post, true, "the answer carries the post flag for the runner");
  assert.equal(result.post_run, null, "answer is comment-only — post_run is null");
  assertNoPostAgents(calls); // the runner posts the answer via post-overview, not a brain agent
  assert.equal(has(calls, "review:"), false, "answer mode never runs the squad");
  // The separate 'intent' agent must not appear — intent is now decided by holistic.
  assert.equal(has(calls, "intent"), false, "intent agent must not be called — intent is folded into holistic");
});

// ---------------------------------------------------------------------------
// Scenario 7 — re-run blocked: prior threads unanswered, no ping
// ---------------------------------------------------------------------------
test("scenario 7: a re-run with unanswered threads and no ping is blocked before the squad; block_reason set, no posting agent", async () => {
  const { result, calls } = await run({
    fetch: baseFetch({
      pr_number: 42, repo: "o/r", post: true,
      overview_id: 123, // marker present -> re-run path
      ping_override: false,
      threads: [baseThread({ id: "T1", author_replied: false })],
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "rerun-blocked");
  assert.equal(result.openThreads, 1);
  assert.match(result.block_reason, /finish the previous review/i, "the nag body the runner posts is carried");
  assert.equal(result.post, true, "the block carries the post flag for the runner");
  assert.equal(result.post_run, null, "rerun-blocked posts a nag comment, not a review — post_run is null");
  assert.equal(has(calls, "review:"), false, "the squad must not run while the review is blocked");
  // Phase 3p3: on a message-less blocked rerun, the blocked-gate fires FIRST — zero agent calls beyond
  // fetch (holistic must NOT run, spending zero quota on a blocked run).
  assert.equal(has(calls, "holistic-rerun"), false, "holistic-rerun must NOT run on a message-less blocked rerun (Phase 3p3: gate fires first)");
  assert.equal(has(calls, "comment-mgmt"), false, "comment-mgmt must not run while blocked");
  assertNoPostAgents(calls); // the runner posts the nag via post-overview (marker-deduped), not a brain agent
});

// ---------------------------------------------------------------------------
// Scenario 8 — re-run happy path: all threads answered
// ---------------------------------------------------------------------------
test("scenario 8: a re-run with all threads answered runs comment-mgmt, holistic-rerun and the squad", async () => {
  // Phase 3p2: comment-mgmt is now ONE batched call (label "comment-mgmt"), not one per thread.
  const { result, calls } = await run({
    fetch: baseFetch({
      pr_number: 0, repo: "", post: false,
      overview_id: 123,
      threads: [
        baseThread({ id: "T1", line: 2, author_replied: true }),
        baseThread({ id: "T2", line: 5, author_replied: true }),
      ],
    }),
    agents: {
      // Batch result: keep both threads
      "comment-mgmt": { actions: [
        { thread_id: "T1", action: "keep", reason: "still open" },
        { thread_id: "T2", action: "keep", reason: "still open" },
      ] },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "rerun");
  // Phase 3p2: ONE batch call, not N per-thread calls
  assert.equal(count(calls, "comment-mgmt"), 1, "exactly one batched comment-mgmt call for all threads");
  assert.equal(has(calls, "thread:"), false, "per-thread 'thread:' agents must NOT fire — batched now");
  assert.equal(has(calls, "holistic-rerun"), true, "the re-run re-orients via holistic-rerun");
  assert.equal(has(calls, "review:"), true, "the squad re-reviews on a re-run");
});

// ---------------------------------------------------------------------------
// Scenario 9 — posted first review: NO posting agents, overview posted mid-run,
// and the post_run handoff block carries the full deterministic contract.
// (This is the new load-bearing contract — the runner's post-run step consumes it.)
// ---------------------------------------------------------------------------
test("scenario 9: a posted first review posts NO review agent, posts the overview mid-run, and hands the runner a complete post_run block", async () => {
  const f = finding(); // in_diff:true -> becomes an inline finding -> a finding_row + a payload marker
  const { result, calls } = await run({
    fetch: baseFetch({ pr_number: 42, repo: "o/r", platform: "github", head_sha: "deadbeef", post: true }),
    args: { mem_dir: "/mem", bot_login: "cc-review[bot]" },
    agents: {
      holistic: { category: "other", difficulty: 3, overview_markdown: "## Overview\n\nAdds y.\n" },
      "review:": { findings: [f] },
      check: { graded: [graded(f)] },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "first");
  // The overview IS still posted mid-run (walkthrough-first UX; the deliberate Phase-2 deviation).
  assert.equal(has(calls, "post-overview"), true, "the overview is posted mid-run on a first review with post=true");
  assert.equal(has(calls, "edit-overview"), false, "a first review posts, never edits");
  // NO posting agents remain in the brain.
  assertNoPostAgents(calls);

  // The post_run block is shaped EXACTLY as executePostRun's ctx.
  const pr = result.post_run;
  assert.ok(pr && typeof pr === "object", "post_run is present when post=true");
  assert.equal(pr.pr_number, 42);
  assert.equal(pr.repo, "o/r");
  assert.equal(pr.platform, "github");
  assert.equal(pr.head_sha, "deadbeef");
  assert.equal(pr.bot_login, "cc-review[bot]");
  assert.equal(pr.mem_dir, "/mem");
  assert.deepEqual(pr.replies, [], "no prior threads on a first review -> no replies");
  assert.deepEqual(pr.resolve_ids, [], "no prior threads on a first review -> no resolves");
  // payload is the SAME object the result exposes (event + body + comments + integrity marker).
  assert.deepEqual(pr.payload, result.payload);
  assert.equal(pr.payload.event, "REQUEST_CHANGES");

  // review_state is the EXACT bytes post-run.mjs overwrites: { reviewed_head_sha, reviewed_file_count, event, files }.
  const state = JSON.parse(pr.review_state);
  assert.equal(state.reviewed_head_sha, "deadbeef");
  assert.equal(state.reviewed_file_count, 1, "one changed file in SMALL_DIFF");
  assert.equal(state.event, "REQUEST_CHANGES");
  assert.deepEqual(state.files, ["src/a.ts"]);

  // finding_rows: one row per inline finding, each id matching the hidden marker in the payload comment.
  assert.equal(pr.finding_rows.length, 1, "one inline finding -> one finding_row");
  const row = pr.finding_rows[0];
  assert.equal(row.file, "src/a.ts");
  assert.equal(row.posted_head_sha, "deadbeef");
  assert.equal(row.event, "REQUEST_CHANGES");
  // The load-bearing correlation: the finding_row id is embedded as the payload comment's marker id.
  const markerBodies = pr.payload.comments.map((c) => c.body).join("\n");
  assert.ok(markerBodies.includes(`<!-- cc-review:finding ${row.id} -->`), "the finding_row id matches the payload marker id");
});

// ---------------------------------------------------------------------------
// Scenario 9b — posted re-run: post_run carries replies + resolve_ids, mapped to
// post-run.mjs's { thread, comment_id, body } reply shape.
// ---------------------------------------------------------------------------
test("scenario 9b: a posted re-run maps comment-mgmt actions into the post_run replies + resolve_ids", async () => {
  // Phase 3p2: comment-mgmt is now a single batch call returning { actions: [...] }.
  const { result, calls } = await run({
    fetch: baseFetch({
      pr_number: 42, repo: "o/r", platform: "github", head_sha: "cafef00d", post: true,
      overview_id: 123,
      threads: [
        baseThread({ id: "T1", line: 2, author_replied: true, comment_db_id: 900 }),
        baseThread({ id: "T2", line: 5, author_replied: true, comment_db_id: 901 }),
      ],
    }),
    args: { mem_dir: "/mem" },
    agents: {
      // Batch: T1 -> resolve (Fixed: message); T2 -> reply (still wrong).
      "comment-mgmt": { actions: [
        { thread_id: "T1", action: "resolve", reason: "fixed", reply_body: "Fixed: removed y" },
        { thread_id: "T2", action: "reply", reason: "still wrong", reply_body: "Still unused" },
      ] },
      "review:": { findings: [] }, // APPROVE-able findings; the re-run still runs the squad
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "rerun");
  assertNoPostAgents(calls);
  // ONE batch call, not per-thread calls
  assert.equal(count(calls, "comment-mgmt"), 1, "exactly one batched comment-mgmt call");
  assert.equal(has(calls, "thread:"), false, "per-thread 'thread:' agents must NOT fire");

  const pr = result.post_run;
  assert.ok(pr, "post_run present on a posted re-run");
  assert.deepEqual(pr.resolve_ids, ["T1"], "the resolve action's thread id");
  // Both a resolve (with a message) and a reply become replies, mapped to post-run.mjs's shape.
  const byThread = Object.fromEntries(pr.replies.map((r) => [r.thread, r]));
  assert.deepEqual(byThread.T1, { thread: "T1", comment_id: 900, body: "Fixed: removed y" });
  assert.deepEqual(byThread.T2, { thread: "T2", comment_id: 901, body: "Still unused" });
  // With no prior review-state marker, the sig-change prefilter treats this re-run as significant, so the
  // overview is EDITED in place (not posted new). Either way the overview edit is the only posting agent.
  assert.equal(has(calls, "edit-overview"), true, "a significant re-run edits the overview in place");
  assert.equal(has(calls, "post-overview"), false, "an existing overview is edited, never re-posted");
});

// ---------------------------------------------------------------------------
// Scenario 10 — ignore_paths drops vendor findings end-to-end
// ---------------------------------------------------------------------------
const TWO_FILE_DIFF = [
  "diff --git a/vendor/x.js b/vendor/x.js",
  "--- a/vendor/x.js",
  "+++ b/vendor/x.js",
  "@@ -1 +1,2 @@",
  " var a = 1;",
  "+var b = 2;",
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1,2 @@",
  " const x = 1;",
  "+const y = 2;",
].join("\n");

test("scenario 10: config.ignore_paths drops findings under the ignored glob from the payload", async () => {
  const vendorF = finding({ file: "vendor/x.js", line: 2, description: "Remove the dead variable b" });
  const srcF = finding({ file: "src/a.ts", line: 2, description: "Remove the unused variable y" });
  const { result, logs } = await run({
    fetch: baseFetch({ pr_number: 0, repo: "", post: false, diff: TWO_FILE_DIFF, config: { ignore_paths: ["vendor/**"] } }),
    agents: {
      holistic: { category: "other", difficulty: 3, overview_markdown: "x" },
      "review:": { findings: [vendorF, srcF] },
      check: { graded: [graded(vendorF), graded(srcF)] },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.totals.confirmed, 1, "the vendor finding is dropped, leaving one");
  const payloadStr = JSON.stringify(result.payload);
  assert.equal(payloadStr.includes("vendor"), false, "ignored-path findings never reach the payload");
  assert.ok(payloadStr.includes("src/a.ts"), "the non-ignored finding survives");
  assert.ok(logs.some((l) => /ignore_paths/.test(l)), "the drop is logged");
});

// ---------------------------------------------------------------------------
// Scenario 11 — low-confidence findings are dropped
// ---------------------------------------------------------------------------
test("scenario 11: a confirmed-but-low-confidence finding is dropped from the payload", async () => {
  const highF = finding({ file: "src/high.ts", description: "Remove the proven unused import" });
  const lowF = finding({ file: "src/low.ts", description: "Maybe simplify this branch" });
  const { result, logs } = await run({
    fetch: baseFetch({ pr_number: 0, repo: "", post: false }),
    agents: {
      holistic: { category: "other", difficulty: 3, overview_markdown: "x" },
      "review:": { findings: [highF, lowF] },
      check: { graded: [graded(highF, "confirmed", "high"), graded(lowF, "confirmed", "low")] },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.totals.confirmed, 1, "only the high-confidence finding is kept");
  const payloadStr = JSON.stringify(result.payload);
  assert.ok(payloadStr.includes("src/high.ts"), "the high-confidence finding survives");
  assert.equal(payloadStr.includes("src/low.ts"), false, "the low-confidence finding is dropped");
  assert.ok(logs.some((l) => /low-confidence/.test(l)), "the drop is logged");
});

// ---------------------------------------------------------------------------
// Scenario 12 — empty overview guard: post=true but holistic returns ""
// ---------------------------------------------------------------------------
test("scenario 12: an empty holistic overview is never posted, but the run still completes with a post_run block", async () => {
  const { result, calls } = await run({
    fetch: baseFetch({ pr_number: 42, repo: "o/r", platform: "github", post: true }),
    agents: {
      holistic: { category: "other", difficulty: 3, overview_markdown: "" }, // dead/empty holistic
      "review:": { findings: [] }, // no findings -> APPROVE
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.overview, "", "the overview is empty");
  assert.equal(has(calls, "post-overview"), false, "an empty overview marker is never posted");
  assertNoPostAgents(calls);
  // The verdict still flows to the runner via post_run (APPROVE payload); the runner posts it.
  assert.ok(result.post_run, "the (empty-overview) run still hands the runner a post_run block");
  assert.equal(result.post_run.payload.event, "APPROVE", "no findings -> APPROVE verdict for the runner to post");
});

// ---------------------------------------------------------------------------
// Scenario 13 — the ctx's precomputed diff_files drives files (langs, squad) even when the
// inline `diff` is only a truncated excerpt that no longer contains the file headers.
// This is the core of the fix: the file list comes from the ctx, not from re-parsing the excerpt.
// ---------------------------------------------------------------------------
test("scenario 13: ctx.diff_files drives files/langs even when the diff is a header-less excerpt", async () => {
  // A mid-hunk excerpt: no `+++ b/…` or `diff --git` headers → changedFiles(excerpt) === [].
  const EXCERPT = "@@ -10,3 +10,4 @@\n const keep = 1;\n+const added = 2;\n export { keep };\n";
  const { result, logs } = await run({
    fetch: baseFetch({
      pr_number: 0, repo: "", post: false,
      diff: EXCERPT,
      diff_truncated: true,
      diff_files: ["src/a.ts", "src/b.ts", "src/c.ts"], // exact, from the FULL diff on disk
      added_line_count: 120, // over the FULL diff → enough that web research is NOT skipped
    }),
    agents: {
      holistic: { category: "other", difficulty: 3, overview_markdown: "x" },
      "review:": { findings: [] }, // clean → APPROVE
    },
  });

  assert.equal(result.ok, true);
  // The startup log reports the file count + langs derived from ctx.diff_files, not the empty excerpt.
  const startup = logs.find((l) => /files, langs=/.test(l));
  assert.ok(startup, "the startup log line is present");
  assert.match(startup, /3 files/, "files.length comes from ctx.diff_files (3), not the header-less excerpt (0)");
  assert.match(startup, /langs=\[typescript\]/, "langs are derived from the ctx file list");
  // added_line_count from the ctx (120 ≥ 50) means web research is NOT skipped despite the tiny excerpt.
  assert.equal(logs.some((l) => /skipping web research/.test(l)), false, "ctx.added_line_count keeps web research on");
});

// ---------------------------------------------------------------------------
// Scenario 14 — diff_path mismatch guard (fail-closed)
// If the ctx carries a diff_path that does not match the brain's DIFF_PATH constant,
// the run must abort before any squad is dispatched (second source of truth = split brain risk).
// ---------------------------------------------------------------------------
test("scenario 14: ctx.diff_path mismatch aborts the run before any squad is dispatched", async () => {
  const { result, calls } = await run({
    fetch: baseFetch({
      pr_number: 0, repo: "", post: false,
      diff_path: "/some/other/path/pr-diff.txt", // mismatches DIFF_PATH (/tmp/pr-diff.txt)
    }),
  });

  assert.equal(result.ok, false, "a diff_path mismatch must abort with ok:false");
  assert.match(result.reason, /diff_path/i, "the abort reason must name diff_path");
  assert.ok(result.reason.includes("/tmp/pr-diff.txt"), "the abort reason must name the expected path");
  assert.ok(result.reason.includes("/some/other/path/pr-diff.txt"), "the abort reason must name the ctx path");
  assert.equal(has(calls, "holistic"), false, "holistic must not run on a diff_path mismatch");
  assert.equal(has(calls, "review:"), false, "squad must not be dispatched on a diff_path mismatch");
});

test("scenario 14b: ctx.diff_path matching DIFF_PATH is accepted (normal path)", async () => {
  // diff_path == DIFF_PATH -> no abort; the run completes normally.
  const { result } = await run({
    fetch: baseFetch({
      pr_number: 0, repo: "", post: false,
      diff_path: "/tmp/pr-diff.txt", // matches DIFF_PATH exactly
    }),
  });

  assert.equal(result.ok, true, "a matching diff_path must not abort");
  assert.equal(result.mode, "first");
});

test("scenario 14c: ctx without diff_path (older ctx) is accepted (no abort)", async () => {
  // An older ctx that predates diff_path in the schema has no diff_path field — must not abort.
  const fetchData = baseFetch({ pr_number: 0, repo: "", post: false });
  delete fetchData.diff_path;
  const { result } = await run({ fetch: fetchData });

  assert.equal(result.ok, true, "a ctx without diff_path must not abort");
  assert.equal(result.mode, "first");
});

// ---------------------------------------------------------------------------
// Phase 3 — correctness anchor + PATH reshape scenarios
// ---------------------------------------------------------------------------

// Scenario 15 — d1 now runs the check agent (sonnet model)
test("scenario 15: d1 path runs the check agent (sonnet) — no passthrough bypass", async () => {
  const f = finding();
  const { result, calls } = await run({
    fetch: baseFetch({ pr_number: 0, repo: "", post: false }),
    agents: {
      holistic: { category: "other", difficulty: 1, overview_markdown: "x" },
      // correctness anchor returns a finding
      "review:correctness": { findings: [f] },
      // check agent (sonnet at d1) confirms it
      check: { graded: [graded(f)] },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.reviewed, true);
  // check must have been called at d1
  assert.equal(has(calls, "check"), true, "d1 must call the check agent");
  // the finding survived check
  assert.equal(result.totals.confirmed, 1, "the confirmed finding is kept");
});

test("scenario 15b: d1 check agent death aborts fail-closed", async () => {
  const f = finding();
  const { result, calls } = await run({
    fetch: baseFetch({ pr_number: 0, repo: "", post: false }),
    agents: {
      holistic: { category: "other", difficulty: 1, overview_markdown: "x" },
      "review:correctness": { findings: [f] },
      check: null, // agent death at d1
    },
  });

  assert.equal(result.ok, false, "a dead check agent at d1 must abort fail-closed");
  assert.match(result.reason, /check agent/i);
  assert.equal(has(calls, "post-review"), false);
  assert.equal(has(calls, "memory"), false);
});

// Scenario 16 — d3: 1 anchor + 1 opus specialist; shape unchanged otherwise
test("scenario 16: d3 path runs 1 correctness anchor + 1 opus specialist + 1 check vote", async () => {
  const f = finding();
  const { result, calls } = await run({
    fetch: baseFetch({ pr_number: 0, repo: "", post: false }),
    agents: {
      holistic: { category: "other", difficulty: 3, overview_markdown: "x" },
      "review:correctness": { findings: [f] },
      "review:": { findings: [] },
      // single check vote at d3
      check: { graded: [graded(f)] },
    },
  });

  assert.equal(result.ok, true);
  // correctness anchor fires (single label, not #1/#2)
  assert.equal(has(calls, "review:correctness"), true, "d3 must have a correctness anchor");
  assert.equal(has(calls, "review:correctness#1"), false, "d3: must use single anchor label, not #1");
  // one opus specialist fires (not correctness)
  const specialistCalls = calls.filter((c) => c.label.startsWith("review:") && !c.label.startsWith("review:correctness"));
  assert.equal(specialistCalls.length, 1, "d3: exactly 1 specialist besides the anchor");
  // exactly 1 check call (not #1/#2)
  assert.equal(count(calls, "check"), 1, "d3: exactly 1 check vote");
  assert.equal(has(calls, "check#1"), false, "d3: must not use the 2-vote check labels");
  assert.equal(result.totals.confirmed, 1);
});

// Scenario 17 — d5: 2 independent anchors + 2 check votes in parallel
test("scenario 17: d5 path runs 2 correctness anchors and 2 check votes in parallel", async () => {
  const f = finding();
  const { result, calls } = await run({
    fetch: baseFetch({ pr_number: 0, repo: "", post: false }),
    agents: {
      holistic: { category: "other", difficulty: 5, overview_markdown: "x" },
      "review:correctness#1": { findings: [f] },
      "review:correctness#2": { findings: [f] },
      // both check votes confirm the finding
      "check#1": { graded: [graded(f)] },
      "check#2": { graded: [graded(f)] },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(count(calls, "review:correctness"), 2, "d5: exactly 2 correctness anchors (#1 and #2)");
  assert.equal(has(calls, "check#1"), true, "d5: check#1 must fire");
  assert.equal(has(calls, "check#2"), true, "d5: check#2 must fire");
  assert.equal(result.totals.confirmed, 1, "finding confirmed by both votes survives");
});

test("scenario 17b: d5 — a finding kept by only vote1 does NOT post (must survive BOTH)", async () => {
  const fA = finding({ file: "src/a.ts", line: 2, description: "Remove the unused variable y" });
  const fB = finding({ file: "src/b.ts", line: 5, description: "Fix the null deref on entry" });
  const { result } = await run({
    fetch: baseFetch({ pr_number: 0, repo: "", post: false }),
    agents: {
      holistic: { category: "other", difficulty: 5, overview_markdown: "x" },
      "review:correctness#1": { findings: [fA, fB] },
      "review:correctness#2": { findings: [fA, fB] },
      // vote1 keeps both; vote2 keeps only fA (refutes fB)
      "check#1": { graded: [graded(fA), graded(fB)] },
      "check#2": { graded: [graded(fA), { original: fB, verdict: "false-positive", confidence: "high" }] },
    },
  });

  assert.equal(result.ok, true);
  // Only fA survived both votes
  assert.equal(result.totals.confirmed, 1, "only the finding confirmed by both votes survives");
  const payloadStr = JSON.stringify(result.payload);
  assert.ok(payloadStr.includes("src/a.ts"), "fA (survived both) is in the payload");
  assert.equal(payloadStr.includes("src/b.ts"), false, "fB (kept only by vote1) must NOT post");
});

test("scenario 17c: d5 — either dead check vote aborts fail-closed", async () => {
  const f = finding();
  // vote1 dead
  const { result: r1 } = await run({
    fetch: baseFetch({ pr_number: 0, repo: "", post: false }),
    agents: {
      holistic: { category: "other", difficulty: 5, overview_markdown: "x" },
      "review:": { findings: [f] },
      "check#1": null,
      "check#2": { graded: [graded(f)] },
    },
  });
  assert.equal(r1.ok, false, "dead check#1 must abort fail-closed");
  assert.match(r1.reason, /check agent/i);

  // vote2 dead
  const { result: r2 } = await run({
    fetch: baseFetch({ pr_number: 0, repo: "", post: false }),
    agents: {
      holistic: { category: "other", difficulty: 5, overview_markdown: "x" },
      "review:": { findings: [f] },
      "check#1": { graded: [graded(f)] },
      "check#2": null,
    },
  });
  assert.equal(r2.ok, false, "dead check#2 must abort fail-closed");
  assert.match(r2.reason, /check agent/i);
});

// ---------------------------------------------------------------------------
// Phase 3 part 2 — agent-call-cut scenarios
// ---------------------------------------------------------------------------

// Scenario 18 — answer mode via holistic on a first review (no separate intent agent)
test("scenario 18: answer mode fires from holistic.is_question on a first review, squad never runs", async () => {
  const { result, calls } = await run({
    fetch: baseFetch({ pr_number: 42, repo: "o/r", post: false, user_message: "What does this PR do?" }),
    agents: {
      holistic: { category: "other", difficulty: 3, overview_markdown: "x", is_question: true, answer: "It adds feature Y." },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "answer");
  assert.equal(result.answer, "It adds feature Y.");
  assert.equal(has(calls, "intent"), false, "no separate intent agent must fire");
  assert.equal(has(calls, "review:"), false, "squad must not run in answer mode");
  assert.equal(has(calls, "post-overview"), false, "overview must not be posted before answering");
});

// Scenario 18b — answer mode via holistic on a re-run, fires BEFORE the blocked-gate
test("scenario 18b: answer mode on a re-run fires before the rerun-blocked gate (question wins over nag)", async () => {
  const { result, calls } = await run({
    fetch: baseFetch({
      pr_number: 42, repo: "o/r", post: false,
      overview_id: 123,
      ping_override: false,
      user_message: "Why is this needed?",
      // unanswered thread — would normally trigger rerun-blocked
      threads: [baseThread({ id: "T1", author_replied: false })],
    }),
    agents: {
      holistic: { category: "other", difficulty: 3, overview_markdown: "x", is_question: true, answer: "Because of X." },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "answer", "a question wins over the rerun-blocked gate");
  assert.equal(result.answer, "Because of X.");
  assert.equal(has(calls, "comment-mgmt"), false, "comment-mgmt must not run in answer mode");
  assert.equal(has(calls, "review:"), false, "squad must not run in answer mode");
});

// Scenario 19 — single research agent at d3 (not two separate agents)
test("scenario 19: d3 gather fires exactly one 'research' agent (merged), not two separate ones", async () => {
  // Use a diff large enough to skip the web-research skip gate (added >= 50 lines).
  const LARGE_DIFF = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,52 @@\n` +
    Array.from({ length: 51 }, (_, i) => `+const x${i} = ${i};`).join("\n");
  const { calls } = await run({
    fetch: baseFetch({
      pr_number: 0, repo: "", post: false,
      diff: LARGE_DIFF,
      diff_files: ["src/a.ts"],
      added_line_count: 51,
    }),
    agents: {
      holistic: { category: "other", difficulty: 3, overview_markdown: "x", is_question: false, answer: "" },
    },
  });

  // Exactly one research call with the merged label
  assert.equal(count(calls, "research"), 1, "exactly one merged research agent at d3");
  assert.equal(has(calls, "research:ai-slop"), false, "old research:ai-slop label must not fire");
  assert.equal(has(calls, "research:general"), false, "old research:general label must not fire");
});

// Scenario 20 — batched comment-mgmt: N threads → one agent call, threadActions map correctly
test("scenario 20: N threads produce exactly one comment-mgmt call; resolve/reply/keep map to threadActions", async () => {
  const threads = [
    baseThread({ id: "T1", line: 2, author_replied: true, comment_db_id: 900 }),
    baseThread({ id: "T2", line: 5, author_replied: true, comment_db_id: 901 }),
    // T3 has bot_replied_last=true: author hasn't replied but bot already has the last word,
    // so author_replied=true (the blocking gate checks author_replied only)
    baseThread({ id: "T3", line: 8, author_replied: true, bot_replied_last: true, comment_db_id: 902 }),
  ];
  const { result, calls } = await run({
    fetch: baseFetch({ pr_number: 0, repo: "", post: false, overview_id: 123, threads }),
    agents: {
      "comment-mgmt": { actions: [
        { thread_id: "T1", action: "resolve", reason: "fixed", reply_body: "Fixed: removed y" },
        { thread_id: "T2", action: "reply", reason: "still wrong", reply_body: "Still unused" },
        // T3 -> keep (no reply because bot_replied_last)
        { thread_id: "T3", action: "keep", reason: "unchanged" },
      ] },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(count(calls, "comment-mgmt"), 1, "one batch call regardless of thread count");
  assert.equal(has(calls, "thread:"), false, "no per-thread calls must fire");
  // T1 resolved → not in stillOpen; T2+T3 open → stillOpen = 2
  assert.equal(result.threadActions.filter((a) => a.action === "resolve").length, 1, "one resolve action");
  assert.equal(result.threadActions.filter((a) => a.action === "reply").length, 1, "one reply action");
});

// Scenario 21 — hallucinated thread_id guard: unknown ids in batch response are dropped
test("scenario 21: batch comment-mgmt actions with unknown thread_ids are dropped (hallucination guard)", async () => {
  const { result, logs } = await run({
    fetch: baseFetch({
      pr_number: 0, repo: "", post: false, overview_id: 123,
      threads: [baseThread({ id: "T1", author_replied: true })],
    }),
    agents: {
      "comment-mgmt": { actions: [
        { thread_id: "T1", action: "keep", reason: "ok" },
        { thread_id: "HALLUCINATED-99", action: "resolve", reason: "phantom" },
      ] },
    },
  });

  assert.equal(result.ok, true);
  // Only T1 survives; HALLUCINATED-99 is dropped
  assert.equal(result.threadActions.length, 1, "hallucinated thread_id must be dropped");
  assert.equal(result.threadActions[0].thread_id, "T1");
  assert.ok(logs.some((l) => /hallucinated/i.test(l)), "the drop must be logged");
});

// Scenario 22 — null batch result treated as empty actions (non-fail-closed)
test("scenario 22: a null comment-mgmt batch result is treated as no actions (keep all) — non-fail-closed", async () => {
  const { result, logs } = await run({
    fetch: baseFetch({
      pr_number: 0, repo: "", post: false, overview_id: 123,
      threads: [baseThread({ id: "T1", author_replied: true })],
    }),
    agents: {
      "comment-mgmt": null, // agent death
    },
  });

  assert.equal(result.ok, true, "null batch result must not abort the run");
  assert.equal(result.threadActions.length, 0, "null batch → no actions (all threads kept)");
  assert.ok(logs.some((l) => /null|comment-mgmt.*null/i.test(l)), "null batch must be logged");
});

// ---------------------------------------------------------------------------
// Phase 3 part 3 — cheap re-run / persisted difficulty+category
// ---------------------------------------------------------------------------

// Helper: a baseFetch for re-runs with prev marker having the new fields.
const rerunFetch = (o = {}) => baseFetch({
  overview_id: 123,
  reviewed_file_count: 1,
  reviewed_head_sha: "prevsha",
  reviewed_difficulty: 3,
  reviewed_category: "feature",
  threads: [],
  ...o,
});

// Scenario 23 (a) — message-less non-significant rerun with persisted fields → NO holistic call.
// The prefilter sees the same 1-file/1-added-line diff as the prev run (not significant), and the
// marker carries difficulty/category, so holistic is skipped entirely.
test("scenario 23a: message-less non-significant rerun with persisted marker fields skips holistic, uses marker difficulty/category", async () => {
  const { result, calls, logs } = await run({
    fetch: rerunFetch({ post: false }),
    agents: {
      // holistic must NOT be called — if it were called, we'd still route it via DEFAULTS but we want to
      // assert the label never fires.
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "rerun");
  assert.equal(has(calls, "holistic-rerun"), false, "holistic-rerun must not be called on a non-significant rerun with persisted fields");
  // difficulty = max(marker.reviewed_difficulty, difficultyFloor().floor); SMALL_DIFF has floor=1, marker=3 → 3
  assert.equal(result.difficulty, 3, "difficulty comes from the marker reviewed_difficulty (floored to max)");
  assert.equal(result.event, "APPROVE", "no findings → APPROVE");
  assert.ok(logs.some((l) => /holistic.*skip/i.test(l)), "must log that holistic was skipped");
  assert.equal(has(calls, "sig-change"), false, "no sig-change agent on a prefilter-decided non-significant run");
  assert.equal(has(calls, "review:"), true, "squad still runs even on a non-significant rerun");
});

// Scenario 23 (b) — rerun without persisted fields (old marker) → holistic runs as today.
test("scenario 23b: rerun without persisted marker fields falls back to holistic as today", async () => {
  const { result, calls } = await run({
    fetch: baseFetch({
      overview_id: 123,
      reviewed_file_count: 1,
      reviewed_head_sha: "prevsha",
      // no reviewed_difficulty / reviewed_category
      threads: [],
      post: false,
    }),
    agents: {
      "holistic-rerun": { category: "bugfix", difficulty: 2, overview_markdown: "x", is_question: false, answer: "" },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "rerun");
  assert.equal(has(calls, "holistic-rerun"), true, "holistic-rerun must run when marker lacks persisted fields");
  assert.equal(result.difficulty, 2, "difficulty comes from holistic when marker lacks fields");
});

// Scenario 23 (c) — blocked message-less rerun → zero agent calls after fetch, NO holistic.
// On message-less reruns the blocked-gate fires FIRST (before any agent call beyond fetch).
test("scenario 23c: blocked message-less rerun fires the gate before any agent call — zero holistic/squad calls", async () => {
  const { result, calls } = await run({
    fetch: rerunFetch({
      post: true,
      ping_override: false,
      threads: [baseThread({ id: "T1", author_replied: false })],
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "rerun-blocked");
  assert.equal(has(calls, "holistic-rerun"), false, "holistic must NOT fire before the blocked gate on a message-less rerun");
  assert.equal(has(calls, "comment-mgmt"), false, "comment-mgmt must not run while blocked");
  assert.equal(has(calls, "review:"), false, "squad must not run while blocked");
});

// Scenario 23 (d) — significant rerun (diff grew big) with persisted fields → holistic runs + overview edited.
test("scenario 23d: significant rerun runs holistic and edits the overview in place", async () => {
  // Use a diff with >= 2× addedLines (300 >= 150*2) so bigAbsoluteAdd fires → decided:true, significant:true.
  // This avoids the borderline (160 added lines with 1 file vs 1 prev file only hits nearLines, not decided).
  const BIG_DIFF = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,300 @@\n`
    + Array.from({ length: 300 }, (_, i) => `+const x${i} = ${i};`).join("\n");
  const { result, calls } = await run({
    fetch: rerunFetch({
      post: true,
      diff: BIG_DIFF,
      diff_files: ["src/a.ts"],
      added_line_count: 300, // >= 150*2 → bigAbsoluteAdd → decided:true, significant:true
    }),
    agents: {
      "holistic-rerun": { category: "feature", difficulty: 4, overview_markdown: "## Overview\n\nBig change.\n", is_question: false, answer: "" },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "rerun");
  assert.equal(has(calls, "holistic-rerun"), true, "holistic-rerun must run on a significant rerun");
  assert.equal(has(calls, "edit-overview"), true, "overview must be edited in place on a significant rerun");
});

// Scenario 23 (e) — borderline rerun: sig-change confirm runs FIRST, then skips holistic on not-significant with persisted fields.
test("scenario 23e: borderline rerun runs sig-change confirm before holistic; skips holistic when confirmed not-significant + marker has fields", async () => {
  // A diff that is borderline: near the files/lines threshold but not clearly over.
  // SMALL_DIFF has 1 file, 1 added line vs prev 1 file. We need near-threshold. Let's set
  // reviewed_file_count high enough that pct is borderline, and added lines near the line floor.
  // With SIG = { filesPct: 0.25, addedLines: 150, borderline: 0.2 }:
  // nearLines = added >= 150 * (1-0.2) = 120 → use 125 added lines.
  const BORDERLINE_DIFF = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,126 @@\n`
    + Array.from({ length: 125 }, (_, i) => `+const x${i} = ${i};`).join("\n");
  const { result, calls, logs } = await run({
    fetch: rerunFetch({
      post: false,
      diff: BORDERLINE_DIFF,
      diff_files: ["src/a.ts"],
      added_line_count: 125, // nearLines (>= 120) -> borderline -> decided:false
    }),
    agents: {
      // sig-change confirm: not significant
      "sig-change": { significant: false, reason: "minor tweak" },
      // holistic-rerun must NOT be called when sig-change says not-significant and marker has fields
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "rerun");
  assert.equal(has(calls, "sig-change"), true, "sig-change confirm must run on a borderline diff");
  assert.equal(has(calls, "holistic-rerun"), false, "holistic-rerun must not run when confirm says not-significant + marker has persisted fields");
  assert.ok(logs.some((l) => /holistic.*skip/i.test(l)), "must log that holistic was skipped");
  assert.equal(result.difficulty, 3, "difficulty from marker when holistic skipped");
});

// Scenario 23 (e2) — borderline but sig-change confirms significant → holistic runs.
test("scenario 23e2: borderline rerun where confirm says significant runs holistic normally", async () => {
  const BORDERLINE_DIFF = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,126 @@\n`
    + Array.from({ length: 125 }, (_, i) => `+const x${i} = ${i};`).join("\n");
  const { result, calls } = await run({
    fetch: rerunFetch({
      post: false,
      diff: BORDERLINE_DIFF,
      diff_files: ["src/a.ts"],
      added_line_count: 125,
    }),
    agents: {
      "sig-change": { significant: true, reason: "substantial" },
      "holistic-rerun": { category: "refactor", difficulty: 3, overview_markdown: "x", is_question: false, answer: "" },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "rerun");
  assert.equal(has(calls, "sig-change"), true, "sig-change confirm runs for borderline");
  assert.equal(has(calls, "holistic-rerun"), true, "holistic-rerun runs when confirm says significant");
});

// Scenario 24 — review_state includes reviewed_difficulty and reviewed_category on a first review.
test("scenario 24: a posted first review includes reviewed_difficulty and reviewed_category in post_run.review_state", async () => {
  const { result } = await run({
    fetch: baseFetch({ pr_number: 42, repo: "o/r", platform: "github", post: true }),
    agents: {
      holistic: { category: "bugfix", difficulty: 4, overview_markdown: "## Overview\n\nFixes bug.\n", is_question: false, answer: "" },
      "review:": { findings: [] },
    },
  });

  assert.equal(result.ok, true);
  assert.ok(result.post_run, "post_run present");
  const state = JSON.parse(result.post_run.review_state);
  assert.ok("reviewed_difficulty" in state, "review_state must include reviewed_difficulty");
  assert.ok("reviewed_category" in state, "review_state must include reviewed_category");
  // difficulty = max(holistic.difficulty=4, floor=1) = 4
  assert.equal(state.reviewed_difficulty, 4, "reviewed_difficulty matches the run's difficulty");
  assert.equal(state.reviewed_category, "bugfix", "reviewed_category matches the holistic category");
});
