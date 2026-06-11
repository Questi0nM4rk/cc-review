// Unit tests for the deterministic JS helpers in .claude/workflows/backfill-memory.mjs
// (learning-loop Phase 3 cold-start backfill).
//
// Same constraint + extraction trick as helpers.test.mjs: the workflow script can't be imported
// (top-level await/return + injected globals like agent()/phase() crash on import). So we slice the
// REAL declaration region — everything above the "=== END PURE HELPERS ===" sentinel, which is pure
// const/function declarations (the ARGS IIFE is import-safe via its `typeof args` guard) — strip the
// one `export`, append a named export block, and dynamic-import it. The tests run the actual shipped
// bytes, not a second copy that could drift.
//
// Run: node --test scripts/backfill-helpers.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../.claude/workflows/backfill-memory.mjs", import.meta.url));
const SENTINEL = "// === END PURE HELPERS (test-extraction boundary) ===";
const EXPORTS = ["sanitizeContext", "parsePrs", "mergeField", "PRIORS_SCHEMA"];

const raw = readFileSync(SCRIPT, "utf8");
const cut = raw.indexOf(SENTINEL);
assert.ok(cut > 0, "extraction sentinel not found in backfill-memory.mjs — did the marker move or change?");
const region = raw.slice(0, cut).replace(/^export const meta/m, "const meta");
const synthesized = `${region}\nexport { ${EXPORTS.join(", ")} };\n`;
const file = join(mkdtempSync(join(tmpdir(), "ccr-backfill-")), "helpers.mjs");
writeFileSync(file, synthesized, "utf8");
const H = await import(pathToFileURL(file).href);

// ---------------------------------------------------------------------------
// parsePrs — only positive integers survive; anything malformed → []

test("parsePrs keeps positive integers in order", () => {
  assert.deepEqual(H.parsePrs([55, 53, 52, 50, 47]), [55, 53, 52, 50, 47]);
});

test("parsePrs drops zero, negatives, non-integers, and stringified numbers", () => {
  assert.deepEqual(H.parsePrs([0, -1, 1.5, NaN, "5", null, undefined, 12]), [12]);
});

test("parsePrs returns [] for any non-array (null, undefined, string, object, number)", () => {
  for (const bad of [null, undefined, "[]", "55", 55, {}, { prs: [1] }]) {
    assert.deepEqual(H.parsePrs(bad), [], `expected [] for ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// sanitizeContext — control bytes → space, whitespace collapsed, trimmed, capped

test("sanitizeContext collapses control chars + whitespace and trims", () => {
  assert.equal(H.sanitizeContext("  a\tb\n\nc\x00d  "), "a b c d");
});

test("sanitizeContext caps to max and returns '' for empty/null", () => {
  assert.equal(H.sanitizeContext("abcdef", 3), "abc");
  assert.equal(H.sanitizeContext(""), "");
  assert.equal(H.sanitizeContext(null), "");
  assert.equal(H.sanitizeContext(undefined), "");
});

// ---------------------------------------------------------------------------
// mergeField — flatten one field across harvested PRs: sanitize, drop blanks,
// case-insensitive dedup (keep first casing), cap.

test("mergeField flattens, sanitizes, and preserves first-seen order", () => {
  const harvested = [
    { conventions: ["Use DI", "Thin controllers"] },
    { conventions: ["Keep tests deterministic"] },
  ];
  assert.deepEqual(H.mergeField(harvested, "conventions", 20), ["Use DI", "Thin controllers", "Keep tests deterministic"]);
});

test("mergeField dedups case-insensitively, keeping the first casing seen", () => {
  const harvested = [{ conventions: ["Use DI"] }, { conventions: ["use di", "USE DI", "New one"] }];
  assert.deepEqual(H.mergeField(harvested, "conventions", 20), ["Use DI", "New one"]);
});

test("mergeField caps the output length", () => {
  const harvested = [{ recurring_issues: ["a", "b", "c", "d", "e"] }];
  assert.deepEqual(H.mergeField(harvested, "recurring_issues", 2), ["a", "b"]);
});

test("mergeField drops blanks/whitespace-only items", () => {
  const harvested = [{ culture_notes: ["", "   ", "\t\n", "real note"] }];
  assert.deepEqual(H.mergeField(harvested, "culture_notes", 20), ["real note"]);
});

test("mergeField tolerates null harvested, missing field, and null entries", () => {
  assert.deepEqual(H.mergeField(null, "conventions", 20), []);
  assert.deepEqual(H.mergeField([{}, { conventions: null }], "conventions", 20), []);
  assert.deepEqual(H.mergeField([null, { conventions: ["ok"] }], "conventions", 20), ["ok"]);
});

// ---------------------------------------------------------------------------
// PRIORS_SCHEMA — shape guard (the agent's structured-output contract)

test("PRIORS_SCHEMA requires exactly the three additive prior arrays, no extras", () => {
  assert.equal(H.PRIORS_SCHEMA.type, "object");
  assert.equal(H.PRIORS_SCHEMA.additionalProperties, false);
  assert.deepEqual(H.PRIORS_SCHEMA.required, ["conventions", "recurring_issues", "culture_notes"]);
  for (const k of ["conventions", "recurring_issues", "culture_notes"]) {
    assert.equal(H.PRIORS_SCHEMA.properties[k].type, "array");
    assert.equal(H.PRIORS_SCHEMA.properties[k].items.type, "string");
  }
  // It must NOT carry a known_patterns / suppression field — additive-only is the safety contract.
  assert.equal("known_patterns" in H.PRIORS_SCHEMA.properties, false);
});
