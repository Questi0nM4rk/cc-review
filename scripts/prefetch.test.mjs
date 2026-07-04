// Unit tests for the PURE context-assembly module scripts/prefetch.mjs (reshape plan Phase 1).
//
// The `prefetch` adapter verb (review-platform.ts) does the I/O — reads /tmp/cc-input.json,
// /tmp/cc-user-msg.txt, .cc-review.yaml, <mem>/pr-<N>/review-state.json, and calls the existing
// context/threads/get-overview internals — then hands the raw pieces to `assembleCtx`, which is the
// tested unit that shapes them into the FETCH_SCHEMA JSON the brain's relay agent returns verbatim.
// `parseReviewConfig` is the hand-rolled YAML-subset parser for the documented flat .cc-review.yaml.
//
// Run: node --test scripts/prefetch.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleCtx, parseReviewConfig, abortCtx, diffFiles, addedLines, DIFF_EXCERPT_MAX, DIFF_PATH } from "./prefetch.mjs";

// The FETCH_SCHEMA required keys the brain validates against (kept in sync with strict-review.mjs).
const REQUIRED = ["diff", "pr_number", "repo", "platform", "threads"];
const hasRequired = (o) => REQUIRED.every((k) => k in o);

// ---------------------------------------------------------------------------
// parseReviewConfig — the documented flat .cc-review.yaml subset
// ---------------------------------------------------------------------------
test("parseReviewConfig: empty / whitespace / non-string → {}", () => {
  assert.deepEqual(parseReviewConfig(""), {});
  assert.deepEqual(parseReviewConfig("   \n\t\n"), {});
  assert.deepEqual(parseReviewConfig(null), {});
  assert.deepEqual(parseReviewConfig(undefined), {});
  assert.deepEqual(parseReviewConfig(42), {});
});

test("parseReviewConfig: flow-style string arrays", () => {
  assert.deepEqual(parseReviewConfig("languages: [csharp, typescript]").languages, ["csharp", "typescript"]);
});

test("parseReviewConfig: empty flow array → []", () => {
  assert.deepEqual(parseReviewConfig("languages: []").languages, []);
});

test("parseReviewConfig: quoted flow items keep glob/quote content", () => {
  assert.deepEqual(parseReviewConfig(`ignore_paths: ["docs/**", "**/*.md"]`).ignore_paths, ["docs/**", "**/*.md"]);
});

test("parseReviewConfig: block-style list items (quoted + bare)", () => {
  const yaml = [
    "known_patterns:",
    `  - "Broad exception handlers in middleware are intentional."`,
    "  - Another intentional pattern",
  ].join("\n");
  assert.deepEqual(parseReviewConfig(yaml).known_patterns, [
    "Broad exception handlers in middleware are intentional.",
    "Another intentional pattern",
  ]);
});

test("parseReviewConfig: quoted scalar and empty scalar", () => {
  assert.equal(parseReviewConfig(`instructions: "Wolverine handles messaging."`).instructions, "Wolverine handles messaging.");
  assert.equal(parseReviewConfig(`instructions: ""`).instructions, "");
});

test("parseReviewConfig: an inline comment after a scalar is stripped", () => {
  assert.equal(parseReviewConfig("trigger: disabled  # PAUSED to let quota recover").trigger, "disabled");
});

test("parseReviewConfig: a '#' inside a quoted value is NOT a comment", () => {
  assert.equal(parseReviewConfig(`instructions: "count is #1"`).instructions, "count is #1");
});

test("parseReviewConfig: comment-only and blank lines are skipped", () => {
  const yaml = ["# a header comment", "", "  # indented comment", "trigger: pr_open", ""].join("\n");
  assert.deepEqual(parseReviewConfig(yaml), { trigger: "pr_open" });
});

test("parseReviewConfig: nested significant_change object with numeric values", () => {
  const yaml = ["significant_change:", "  files_pct: 0.25", "  added_lines: 150"].join("\n");
  assert.deepEqual(parseReviewConfig(yaml).significant_change, { files_pct: 0.25, added_lines: 150 });
});

test("parseReviewConfig: numbers and booleans coerce", () => {
  assert.equal(parseReviewConfig("version: 1").version, 1);
});

test("parseReviewConfig: the full documented sample parses every field", () => {
  const yaml = [
    "# cc-review — per-project configuration",
    "version: 1",
    "",
    "trigger: pr_open    # every_push | pr_open | disabled",
    "languages: [csharp, typescript]",
    `ignore_paths: ["docs/**", "**/*.md"]`,
    `instructions: "Wolverine handles durable messaging — do not flag the queue indirection."`,
    `known_patterns: ["Broad exception handlers in middleware are intentional."]`,
    "significant_change:",
    "  files_pct: 0.25",
    "  added_lines: 150",
  ].join("\n");
  const c = parseReviewConfig(yaml);
  assert.equal(c.trigger, "pr_open");
  assert.deepEqual(c.languages, ["csharp", "typescript"]);
  assert.deepEqual(c.ignore_paths, ["docs/**", "**/*.md"]);
  assert.equal(c.instructions, "Wolverine handles durable messaging — do not flag the queue indirection.");
  assert.deepEqual(c.known_patterns, ["Broad exception handlers in middleware are intentional."]);
  assert.deepEqual(c.significant_change, { files_pct: 0.25, added_lines: 150 });
});

test("parseReviewConfig: never throws on malformed input → returns an object", () => {
  const r = parseReviewConfig(":::\n\t- [unbalanced\n{{{");
  assert.equal(typeof r, "object");
  assert.notEqual(r, null);
});

// ---------------------------------------------------------------------------
// assembleCtx — platform mode
// ---------------------------------------------------------------------------
test("assembleCtx: platform mode maps the adapter pieces into the FETCH_SCHEMA shape", () => {
  const ctx = assembleCtx({
    input: { pr_number: 42, repo: "o/r", platform: "github", post: true, ping_override: false },
    config: { languages: ["typescript"] },
    userMessage: "focus on auth",
    context: { diff: "DIFF-BYTES", head: "abc123", repo: "o/r", platform: "github" },
    threads: [{ id: "T1", path: "a.ts", line: 1, original_body: "x", author_replied: false }],
    overview: { id: 999 },
    reviewState: { reviewed_head_sha: "oldsha", reviewed_file_count: 3 },
  });
  assert.equal(ctx.diff, "DIFF-BYTES");
  assert.equal(ctx.pr_number, 42);
  assert.equal(ctx.repo, "o/r");
  assert.equal(ctx.platform, "github");
  assert.equal(ctx.head_sha, "abc123");
  assert.equal(ctx.post, true);
  assert.equal(ctx.ping_override, false);
  assert.equal(ctx.user_message, "focus on auth");
  assert.deepEqual(ctx.config, { languages: ["typescript"] });
  assert.equal(ctx.threads.length, 1);
  assert.equal(ctx.overview_id, 999);
  assert.equal(ctx.reviewed_file_count, 3);
  assert.equal(ctx.reviewed_head_sha, "oldsha");
  assert.ok(hasRequired(ctx));
});

test("assembleCtx: platform mode — absent overview → overview_id null", () => {
  const ctx = assembleCtx({ input: { pr_number: 7, repo: "o/r", platform: "github" }, context: { diff: "d", head: "h" }, threads: [], overview: { id: null }, reviewState: null });
  assert.equal(ctx.overview_id, null);
});

test("assembleCtx: platform mode — absent review-state → null count and empty sha", () => {
  const ctx = assembleCtx({ input: { pr_number: 7, repo: "o/r", platform: "github" }, context: { diff: "d", head: "h" }, threads: [], overview: { id: null }, reviewState: null });
  assert.equal(ctx.reviewed_file_count, null);
  assert.equal(ctx.reviewed_head_sha, "");
});

test("assembleCtx: platform mode passes post + ping_override through from input", () => {
  const ctx = assembleCtx({ input: { pr_number: 7, repo: "o/r", platform: "github", post: false, ping_override: true }, context: { diff: "d", head: "h" }, threads: [], overview: { id: null } });
  assert.equal(ctx.post, false);
  assert.equal(ctx.ping_override, true);
});

test("assembleCtx: platform mode prefers input.repo over context.repo", () => {
  const ctx = assembleCtx({ input: { pr_number: 7, repo: "want/this", platform: "github" }, context: { diff: "d", head: "h", repo: "not/this" }, threads: [], overview: { id: null } });
  assert.equal(ctx.repo, "want/this");
});

test("assembleCtx: platform mode normalizes the platform to the schema enum", () => {
  const gl = assembleCtx({ input: { pr_number: 7, repo: "o/r", platform: "gitlab" }, context: { diff: "d", head: "h" }, threads: [], overview: { id: null } });
  assert.equal(gl.platform, "gitlab");
  const bad = assembleCtx({ input: { pr_number: 7, repo: "o/r", platform: "bitbucket" }, context: { diff: "d", head: "h" }, threads: [], overview: { id: null } });
  assert.equal(bad.platform, "github");
});

// ---------------------------------------------------------------------------
// assembleCtx — local mode
// ---------------------------------------------------------------------------
test("assembleCtx: local mode uses the prefetched diff, pr_number 0, empty threads/overview", () => {
  const ctx = assembleCtx({ local: true, input: { pr_number: 0, repo: "", platform: "github", post: false }, config: {}, userMessage: "", diff: "LOCAL-DIFF", repo: "detected/repo", reviewState: null });
  assert.equal(ctx.diff, "LOCAL-DIFF");
  assert.equal(ctx.pr_number, 0);
  assert.equal(ctx.repo, "detected/repo");
  assert.equal(ctx.head_sha, "");
  assert.deepEqual(ctx.threads, []);
  assert.equal(ctx.overview_id, null);
  assert.ok(hasRequired(ctx));
});

test("assembleCtx: local mode forces post=false even if the input says post=true", () => {
  const ctx = assembleCtx({ local: true, input: { pr_number: 0, post: true, ping_override: true }, config: {}, diff: "d", repo: "r" });
  assert.equal(ctx.post, false);
  assert.equal(ctx.ping_override, false);
});

test("assembleCtx: local mode tolerates a missing diff → empty string", () => {
  const ctx = assembleCtx({ local: true, input: {}, config: {}, repo: "" });
  assert.equal(ctx.diff, "");
});

// ---------------------------------------------------------------------------
// assembleCtx — abort shape (platform failure / missing pieces)
// ---------------------------------------------------------------------------
test("assembleCtx: abort flag → the abort shape (empty diff, pr 0, no threads)", () => {
  const ctx = assembleCtx({ abort: true });
  assert.equal(ctx.diff, "");
  assert.equal(ctx.pr_number, 0);
  assert.equal(ctx.repo, "");
  assert.equal(ctx.platform, "github");
  assert.deepEqual(ctx.threads, []);
  assert.equal(ctx.overview_id, null);
  assert.ok(hasRequired(ctx));
});

test("assembleCtx: null / undefined pieces → the abort shape (never throws)", () => {
  assert.equal(assembleCtx(null).pr_number, 0);
  assert.equal(assembleCtx(undefined).diff, "");
  assert.ok(hasRequired(assembleCtx(null)));
});

// ---------------------------------------------------------------------------
// abortCtx — the named abort-shape helper the prefetch verb emits on platform failure
// ---------------------------------------------------------------------------
test("abortCtx: returns the documented abort shape (empty diff, pr 0, empty repo, no threads, null overview)", () => {
  const a = abortCtx();
  assert.equal(a.diff, "");
  assert.equal(a.pr_number, 0);
  assert.equal(a.repo, "");
  assert.equal(a.platform, "github");
  assert.equal(a.post, false);
  assert.deepEqual(a.threads, []);
  assert.equal(a.overview_id, null);
  assert.equal(a.reviewed_file_count, null);
  assert.equal(a.reviewed_head_sha, "");
  assert.ok(hasRequired(a));
});

test("abortCtx: an optional reason is accepted and never leaks into the schema shape", () => {
  assert.deepEqual(abortCtx("platform failure: 404 not found"), abortCtx());
});

test("abortCtx: assembleCtx's abort/null/undefined paths produce the identical shape", () => {
  assert.deepEqual(assembleCtx({ abort: true }), abortCtx());
  assert.deepEqual(assembleCtx(null), abortCtx());
  assert.deepEqual(assembleCtx(undefined), abortCtx());
});

// ---------------------------------------------------------------------------
// diffFiles — ported from the brain's changedFiles (see helpers.test.mjs fixtures).
// The diff no longer flows through an LLM; the file list is precomputed here so the
// brain reads ctx.diff_files instead of re-parsing a (possibly truncated) excerpt.
// ---------------------------------------------------------------------------
test("diffFiles: parses +++ and diff --git, dedupes (parity with the brain's changedFiles)", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1 @@",
    "+x",
    "diff --git a/src/b.ts b/src/b.ts",
    "+++ b/src/b.ts",
  ].join("\n");
  assert.deepEqual(diffFiles(diff).sort(), ["src/a.ts", "src/b.ts"]);
});

test("diffFiles: captures the new path on a rename (parity with changedFiles)", () => {
  const diff = "diff --git a/old/name.ts b/new/name.ts\nrename from old/name.ts\nrename to new/name.ts\n";
  assert.deepEqual(diffFiles(diff), ["new/name.ts"]);
});

test("diffFiles: empty / non-string diff → []", () => {
  assert.deepEqual(diffFiles(""), []);
  assert.deepEqual(diffFiles(null), []);
  assert.deepEqual(diffFiles(undefined), []);
});

// ---------------------------------------------------------------------------
// addedLines — ported from the brain's addedLineCount.
// ---------------------------------------------------------------------------
test("addedLines: counts + lines but not the +++ header (parity with addedLineCount)", () => {
  const diff = "+++ b/x.ts\n+const a = 1;\n+const b = 2;\n-removed\n context\n+const c = 3;\n";
  assert.equal(addedLines(diff), 3);
});

test("addedLines: empty / non-string diff → 0", () => {
  assert.equal(addedLines(""), 0);
  assert.equal(addedLines(null), 0);
  assert.equal(addedLines(undefined), 0);
});

// ---------------------------------------------------------------------------
// assembleCtx — bounded-diff excerpt + precomputed fields (the fix: the diff never
// rides through the relay LLM; the full diff is on disk at DIFF_PATH, the ctx carries
// only a bounded excerpt plus exact precomputed file-list + added-line count).
// ---------------------------------------------------------------------------
test("assembleCtx: a small diff is NOT truncated and diff_truncated is false", () => {
  const diff = "diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n+const y = 1;\n";
  const ctx = assembleCtx({ input: { pr_number: 7, repo: "o/r", platform: "github" }, context: { diff, head: "h" }, threads: [], overview: { id: null } });
  assert.equal(ctx.diff, diff, "full small diff rides in the excerpt");
  assert.equal(ctx.diff_truncated, false);
  assert.equal(ctx.diff_path, DIFF_PATH);
  assert.deepEqual(ctx.diff_files, ["src/a.ts"]);
  assert.equal(ctx.added_line_count, 1);
});

test("assembleCtx: a diff over the excerpt cap is bounded and diff_truncated is true", () => {
  const header = "diff --git a/big.ts b/big.ts\n+++ b/big.ts\n";
  const big = header + "+x\n".repeat(DIFF_EXCERPT_MAX); // far over the cap
  const ctx = assembleCtx({ input: { pr_number: 7, repo: "o/r", platform: "github" }, context: { diff: big, head: "h" }, threads: [], overview: { id: null } });
  assert.equal(ctx.diff.length, DIFF_EXCERPT_MAX, "excerpt is exactly the first DIFF_EXCERPT_MAX chars");
  assert.equal(ctx.diff, big.slice(0, DIFF_EXCERPT_MAX));
  assert.equal(ctx.diff_truncated, true);
  assert.equal(ctx.diff_path, DIFF_PATH);
  // file list + counts come from the FULL diff, not the excerpt
  assert.deepEqual(ctx.diff_files, ["big.ts"]);
  assert.equal(ctx.added_line_count, DIFF_EXCERPT_MAX, "count is over the FULL diff, not the excerpt");
});

test("assembleCtx: a diff exactly at the cap is not marked truncated", () => {
  const diff = "x".repeat(DIFF_EXCERPT_MAX);
  const ctx = assembleCtx({ input: { pr_number: 7, repo: "o/r", platform: "github" }, context: { diff, head: "h" }, threads: [], overview: { id: null } });
  assert.equal(ctx.diff.length, DIFF_EXCERPT_MAX);
  assert.equal(ctx.diff_truncated, false);
});

test("assembleCtx: local mode also carries diff_path, diff_files, added_line_count, diff_truncated", () => {
  const diff = "diff --git a/local.ts b/local.ts\n+++ b/local.ts\n+a\n+b\n";
  const ctx = assembleCtx({ local: true, input: { pr_number: 0, repo: "", platform: "github", post: false }, config: {}, userMessage: "", diff, repo: "detected/repo", reviewState: null });
  assert.equal(ctx.diff_path, DIFF_PATH);
  assert.equal(ctx.diff_truncated, false);
  assert.deepEqual(ctx.diff_files, ["local.ts"]);
  assert.equal(ctx.added_line_count, 2);
});

test("assembleCtx: the abort shape carries the new fields with safe empties", () => {
  const a = assembleCtx({ abort: true });
  assert.equal(a.diff_path, DIFF_PATH);
  assert.equal(a.diff_truncated, false);
  assert.deepEqual(a.diff_files, []);
  assert.equal(a.added_line_count, 0);
});
