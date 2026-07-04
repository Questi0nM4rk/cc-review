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

const baseFetch = (o = {}) => ({
  diff: SMALL_DIFF,
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
});

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
  intent: { is_question: false },
  holistic: { category: "other", difficulty: 3, overview_markdown: "## Overview\n\nDoes stuff.\n" },
  "research:": { source: "web", observations: [] },
  "memories+docs": { notes: [] },
  tools: { available: [], findings: [], outcomes: [] },
  "review:": { findings: [] },
  check: { graded: [] },
  "thread:": { thread_id: "T1", action: "keep", reason: "still valid" },
  "sig-change": { significant: false, reason: "minor" },
  "post-answer": null,
  "post-overview": null,
  "edit-overview": null,
  "post-gate": null,
  "thread-ops": null,
  "post-review": { posted: true },
  "verify-posted": { landed: true },
  "post-ops": null,
  memory: "memory written",
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
  assert.equal(has(calls, "post-review"), false, "must not post when post=false");
  assert.equal(has(calls, "post-overview"), false, "must not post the overview when post=false");
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
test("scenario 6: a maintainer question is answered and stops (post=false -> no post-answer)", async () => {
  const { result, calls } = await run({
    fetch: baseFetch({ pr_number: 0, repo: "", post: false, user_message: "Why did you rename foo?" }),
    agents: {
      intent: { is_question: true, answer: "Because foo shadowed a builtin." },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "answer");
  assert.equal(result.answer, "Because foo shadowed a builtin.");
  assert.equal(result.posted, false);
  assert.equal(has(calls, "post-answer"), false, "no post-answer when post=false");
  assert.equal(has(calls, "review:"), false, "answer mode never runs the squad");
});

// ---------------------------------------------------------------------------
// Scenario 7 — re-run blocked: prior threads unanswered, no ping
// ---------------------------------------------------------------------------
test("scenario 7: a re-run with unanswered threads and no ping is blocked before the squad", async () => {
  const { result, calls } = await run({
    fetch: baseFetch({
      pr_number: 0, repo: "", post: false,
      overview_id: 123, // marker present -> re-run path
      ping_override: false,
      threads: [baseThread({ id: "T1", author_replied: false })],
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "rerun-blocked");
  assert.equal(result.openThreads, 1);
  assert.equal(has(calls, "review:"), false, "the squad must not run while the review is blocked");
  assert.equal(has(calls, "holistic"), false, "holistic must not run while blocked");
  assert.equal(has(calls, "post-gate"), false, "no gate comment posted when post=false");
});

// ---------------------------------------------------------------------------
// Scenario 8 — re-run happy path: all threads answered
// ---------------------------------------------------------------------------
test("scenario 8: a re-run with all threads answered runs comment-mgmt, holistic-rerun and the squad", async () => {
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
      "thread:": { thread_id: "T1", action: "keep", reason: "still open" },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "rerun");
  assert.equal(count(calls, "thread:"), 2, "one comment-mgmt agent per prior thread");
  assert.equal(has(calls, "holistic-rerun"), true, "the re-run re-orients via holistic-rerun");
  assert.equal(has(calls, "review:"), true, "the squad re-reviews on a re-run");
});

// ---------------------------------------------------------------------------
// Scenario 9 — posted first review with a verify retry
// ---------------------------------------------------------------------------
test("scenario 9: a posted first review retries post-review until verify lands", async () => {
  const { result, calls } = await run({
    fetch: baseFetch({ pr_number: 42, repo: "o/r", platform: "github", post: true }),
    agents: {
      holistic: { category: "other", difficulty: 3, overview_markdown: "## Overview\n\nAdds y.\n" },
      "review:": { findings: [finding()] },
      check: { graded: [graded(finding())] },
      "post-review": { posted: true },
      // first verify (attempt 1) reports nothing landed; the retry's verify (attempt 2) lands.
      "verify-posted": (_p, o) => ({ landed: o.label !== "verify-posted:1" }),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.postLanded, true);
  assert.equal(count(calls, "post-review"), 2, "initial post + exactly one retry");
  assert.ok(count(calls, "thread-ops") <= 1, "thread-ops runs at most once");
  assert.equal(count(calls, "thread-ops"), 0, "no thread-ops on a first review with no prior threads");
  assert.equal(count(calls, "post-ops"), 1, "post-ops writes the run-output files once after verify success");
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
test("scenario 12: an empty holistic overview is never posted, but the run still completes", async () => {
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
  assert.equal(result.postLanded, true, "the (empty-overview) run still posts its verdict");
});
