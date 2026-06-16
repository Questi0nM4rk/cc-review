// Unit + end-to-end tests for scripts/memory-maintenance.mjs (deterministic memory-branch maintenance).
// Plain ESM runner, so the pure helpers import directly. The e2e tests run the script as a subprocess
// against a temp fixture memory tree.
//
// Run: node --test scripts/memory-maintenance.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prDirNum, prDirsToPrune, tallyVerdicts, silentDomains, formatReport } from "./memory-maintenance.mjs";

const SCRIPT = fileURLToPath(new URL("./memory-maintenance.mjs", import.meta.url));

// --- prDirNum ---------------------------------------------------------------
test("prDirNum parses pr-<N>, rejects everything else", () => {
  assert.equal(prDirNum("pr-7"), 7);
  assert.equal(prDirNum("pr-123"), 123);
  assert.equal(prDirNum("learnings"), null);
  assert.equal(prDirNum("pr-"), null);
  assert.equal(prDirNum("pr-1x"), null);
  assert.equal(prDirNum(""), null);
  assert.equal(prDirNum(null), null);
});

// --- prDirsToPrune ----------------------------------------------------------
test("prDirsToPrune keeps the K most-recent (highest N), prunes the rest", () => {
  assert.deepEqual(prDirsToPrune([1, 2, 3, 4, 5], 3), [2, 1]); // keep 5,4,3 -> prune 2,1
  assert.deepEqual(prDirsToPrune([5, 1, 3, 2, 4], 3), [2, 1]); // order-independent
  assert.deepEqual(prDirsToPrune([1, 2], 3), []);              // fewer than K -> prune none
  assert.deepEqual(prDirsToPrune([], 3), []);
});
test("prDirsToPrune dedups and drops non-finite", () => {
  assert.deepEqual(prDirsToPrune([3, 3, 2, 1], 2), [1]);      // dedup 3 -> keep 3,2 -> prune 1
});

// --- tallyVerdicts ----------------------------------------------------------
test("tallyVerdicts counts verdicts per domain, missing domain -> 'unknown'", () => {
  const rows = [
    { domain: "security", verdict: "fixed" }, { domain: "security", verdict: "fixed" }, { domain: "security", verdict: "ignored" },
    { domain: "perf", verdict: "open-but-acted" }, { verdict: "fixed" },
  ];
  const t = tallyVerdicts(rows);
  assert.deepEqual(t.security, { fixed: 2, ignored: 1 });
  assert.deepEqual(t.perf, { "open-but-acted": 1 });
  assert.deepEqual(t.unknown, { fixed: 1 });
});

// --- silentDomains (the recall RED signal) ----------------------------------
test("silentDomains flags a domain with a real sample but zero fixed/dismissed", () => {
  const tally = {
    security: { ignored: 5, "open-but-acted": 4 }, // 9 >= 8, 0 fixed -> flagged
    perf: { fixed: 1, ignored: 9 },                // has a fixed -> not flagged
    api: { ignored: 3 },                           // 3 < 8 -> below sample
    unknown: { ignored: 20 },                      // 'unknown' excluded
  };
  assert.deepEqual(silentDomains(tally), ["security"]);
});

// --- formatReport -----------------------------------------------------------
test("formatReport renders slices + warnings, handles empty", () => {
  assert.match(formatReport([], "2026-06-15T00:00:00Z"), /No slices found/);
  const rec = [{
    owner: "o", repo: "r", applied: false, prKept: 25, prPruned: 3, outcomesTotal: 10, outcomesTrimmed: 2,
    byDomain: { security: { ignored: 9 } }, silent: ["security"], misses: 2, knownPatterns: 4, memoryBytes: 512,
  }];
  const md = formatReport(rec, "2026-06-15T00:00:00Z");
  assert.match(md, /## o\/r/);
  assert.match(md, /3 prunable/);
  assert.match(md, /trending to silence.*security/);
  assert.match(md, /misses: 2 ⚠/);
});

// --- end-to-end (subprocess against a fixture tree) -------------------------
test("e2e --apply: prunes old pr dirs, trims ancient outcomes, _global is NOT a slice", () => {
  const root = mkdtempSync(join(tmpdir(), "ccr-mm-"));
  const slice = join(root, "acme", "widgets");
  mkdirSync(join(slice, "learnings"), { recursive: true });
  for (const n of [1, 2, 3, 4]) { mkdirSync(join(slice, `pr-${n}`)); writeFileSync(join(slice, `pr-${n}`, "review-state.json"), "{}"); }
  writeFileSync(join(slice, "learnings", "outcomes.jsonl"),
    `{"id":"a","pr":4,"domain":"security","verdict":"fixed","at":"${new Date().toISOString()}"}\n` +
    `{"id":"b","pr":1,"domain":"security","verdict":"ignored","at":"2020-01-01T00:00:00Z"}\n`);
  writeFileSync(join(slice, "MEMORY.md"), "# repo\n");
  // a cross-repo _global layer that must NOT be pruned/trimmed like a slice
  mkdirSync(join(root, "_global", "learnings"), { recursive: true });
  writeFileSync(join(root, "_global", "learnings", "lessons.md"), "- a global lesson\n");

  const r = spawnSync("node", [SCRIPT, "--root", root, "--keep-pr", "2", "--apply"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(slice, "pr-4")) && existsSync(join(slice, "pr-3")), "recent pr dirs kept");
  assert.ok(!existsSync(join(slice, "pr-2")) && !existsSync(join(slice, "pr-1")), "old pr dirs pruned");
  const oc = readFileSync(join(slice, "learnings", "outcomes.jsonl"), "utf8");
  assert.match(oc, /"id":"a"/); assert.doesNotMatch(oc, /"id":"b"/); // ancient row trimmed
  assert.ok(existsSync(join(root, "_global", "learnings", "lessons.md")), "_global untouched");
  const report = readFileSync(join(root, "MAINTENANCE.md"), "utf8");
  assert.match(report, /## acme\/widgets/);
  assert.doesNotMatch(report, /_global/); // _global excluded from the slice list
});
test("e2e dry-run (no --apply): writes the report but prunes nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "ccr-mm-dry-"));
  const slice = join(root, "acme", "w2");
  mkdirSync(join(slice, "learnings"), { recursive: true });
  for (const n of [1, 2, 3]) mkdirSync(join(slice, `pr-${n}`));
  writeFileSync(join(slice, "MEMORY.md"), "# x\n");
  const r = spawnSync("node", [SCRIPT, "--root", root, "--keep-pr", "1"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(slice, "pr-1")) && existsSync(join(slice, "pr-2")) && existsSync(join(slice, "pr-3")), "dry-run prunes nothing");
  assert.match(readFileSync(join(root, "MAINTENANCE.md"), "utf8"), /2 prunable/);
});
