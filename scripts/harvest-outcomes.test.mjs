// Unit tests for the deterministic helpers in scripts/harvest-outcomes.mjs (learning-loop Phase 1).
// harvest-outcomes.mjs is a plain ESM runner script, so its pure functions import directly — no
// extraction trick needed (unlike the brain, which has top-level return).
//
// Run: node --test scripts/harvest-outcomes.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractFindingId, classifyOutcome, indexThreads, trimOutcomes, mergeOutcomes, readJsonl, OUTCOME_MAX_DAYS,
  detectFixPr, findMisses,
} from "./harvest-outcomes.mjs";

// --- extractFindingId -------------------------------------------------------
test("extractFindingId pulls the 8-hex id out of a comment marker", () => {
  assert.equal(extractFindingId("Fix the thing\n\n<!-- cc-review:finding a1b2c3d4 -->"), "a1b2c3d4");
  assert.equal(extractFindingId("<!--cc-review:finding deadbeef-->"), "deadbeef");
});
test("extractFindingId returns null when there is no (valid) marker", () => {
  assert.equal(extractFindingId("just a comment"), null);
  assert.equal(extractFindingId("<!-- cc-review:review fnv1a32:a1b2c3d4 -->"), null); // review marker, not finding
  assert.equal(extractFindingId("<!-- cc-review:finding XYZ -->"), null);             // not 8 hex
  assert.equal(extractFindingId(""), null);
  assert.equal(extractFindingId(null), null);
});

// --- classifyOutcome (the verdict ladder) -----------------------------------
test("classifyOutcome: no thread -> gone", () => {
  assert.equal(classifyOutcome(null), "gone");
});
test("classifyOutcome: resolved + Dismissed reply -> dismissed", () => {
  assert.equal(classifyOutcome({ isResolved: true, isOutdated: false, authorReplied: true, dismissed: true }), "dismissed");
});
test("classifyOutcome: resolved (not dismissed) -> fixed", () => {
  assert.equal(classifyOutcome({ isResolved: true, isOutdated: true, authorReplied: false, dismissed: false }), "fixed");
});
test("classifyOutcome: open but region changed -> fixed", () => {
  assert.equal(classifyOutcome({ isResolved: false, isOutdated: true, authorReplied: false, dismissed: false }), "fixed");
});
test("classifyOutcome: open, unchanged, author replied -> open-but-acted (NOT ignored)", () => {
  assert.equal(classifyOutcome({ isResolved: false, isOutdated: false, authorReplied: true, dismissed: false }), "open-but-acted");
});
test("classifyOutcome: open, unchanged, no reply -> ignored (the only weak noise signal)", () => {
  assert.equal(classifyOutcome({ isResolved: false, isOutdated: false, authorReplied: false, dismissed: false }), "ignored");
});

// --- indexThreads -----------------------------------------------------------
test("indexThreads keys only the bot's marker-bearing threads and reads their state", () => {
  const nodes = [
    { isResolved: true, isOutdated: false, comments: { nodes: [
      { author: { login: "cc-review[bot]" }, body: "Fix A\n<!-- cc-review:finding aaaaaaaa -->" },
      { author: { login: "cc-review[bot]" }, body: "Fixed: done" },
    ] } },
    { isResolved: false, isOutdated: false, comments: { nodes: [
      { author: { login: "cc-review[bot]" }, body: "Fix B\n<!-- cc-review:finding bbbbbbbb -->" },
      { author: { login: "alice" }, body: "intentional, leaving it" },
    ] } },
    { isResolved: false, isOutdated: false, comments: { nodes: [   // a human-started thread, no marker
      { author: { login: "bob" }, body: "unrelated discussion" },
    ] } },
  ];
  const m = indexThreads(nodes);
  assert.deepEqual([...m.keys()].sort(), ["aaaaaaaa", "bbbbbbbb"]);
  assert.deepEqual(m.get("aaaaaaaa"), { isResolved: true, isOutdated: false, authorReplied: false, dismissed: false, truncated: false });
  assert.equal(m.get("bbbbbbbb").authorReplied, true);  // alice replied
});
test("indexThreads detects a Dismissed: resolution", () => {
  const m = indexThreads([{ isResolved: true, isOutdated: false, comments: { nodes: [
    { author: { login: "cc-review[bot]" }, body: "Flag C\n<!-- cc-review:finding cccccccc -->" },
    { author: { login: "cc-review[bot]" }, body: "Dismissed: used via reflection" },
  ] } }]);
  assert.equal(m.get("cccccccc").dismissed, true);
});
test("indexThreads: authorReplied stays true when a bot reply FOLLOWS the human reply (longer list)", () => {
  const m = indexThreads([{ isResolved: false, isOutdated: false, comments: { nodes: [
    { author: { login: "cc-review[bot]" }, body: "Flag E\n<!-- cc-review:finding eeeeeeee -->" },
    { author: { login: "alice" }, body: "I disagree" },
    { author: { login: "cc-review[bot]" }, body: "Still wrong because X" },
  ] } }]);
  assert.equal(m.get("eeeeeeee").authorReplied, true);  // the slice(1).some(login!=BOT) over 3 comments
});
test("indexThreads: a truncated comment list fails SAFE to open-but-acted, never 'ignored'", () => {
  const m = indexThreads([{ isResolved: false, isOutdated: false, comments: {
    pageInfo: { hasNextPage: true },  // more than 100 comments — we can't confirm 'no engagement'
    nodes: [{ author: { login: "cc-review[bot]" }, body: "Flag F\n<!-- cc-review:finding ffffffff -->" }],
  } }]);
  assert.equal(m.get("ffffffff").truncated, true);
  assert.equal(classifyOutcome(m.get("ffffffff")), "open-but-acted");  // NOT 'ignored' — no manufactured noise
});
test("indexThreads end-to-end with classifyOutcome: alice's open reply is open-but-acted", () => {
  const m = indexThreads([{ isResolved: false, isOutdated: false, comments: { nodes: [
    { author: { login: "cc-review[bot]" }, body: "Flag D\n<!-- cc-review:finding dddddddd -->" },
    { author: { login: "alice" }, body: "won't fix" },
  ] } }]);
  assert.equal(classifyOutcome(m.get("dddddddd")), "open-but-acted");
});

// --- trimOutcomes -----------------------------------------------------------
test("trimOutcomes drops rows older than the window, keeps recent + undateable", () => {
  const now = "2026-06-12T00:00:00.000Z";
  const old = "2025-01-01T00:00:00.000Z";  // >180d ago
  const recent = "2026-06-01T00:00:00.000Z";
  const rows = [{ id: "old", at: old }, { id: "recent", at: recent }, { id: "nodate" }];
  const kept = trimOutcomes(rows, now, OUTCOME_MAX_DAYS).map((r) => r.id);
  assert.deepEqual(kept.sort(), ["nodate", "recent"]);  // 'old' dropped, undateable kept (fail-safe)
});

// --- mergeOutcomes (idempotent re-harvest) ----------------------------------
test("mergeOutcomes REPLACES an existing PR's rows on re-harvest (no dup id+pr)", () => {
  const now = "2026-06-12T00:00:00.000Z";
  const existing = [
    { id: "aaaaaaaa", pr: 7, verdict: "ignored", at: now },   // stale verdict for PR 7
    { id: "bbbbbbbb", pr: 9, verdict: "fixed", at: now },     // a different PR — must survive
  ];
  const newRows = [{ id: "aaaaaaaa", pr: 7, verdict: "fixed", at: now }]; // re-harvest of PR 7
  const merged = mergeOutcomes(existing, newRows, now);
  // PR 7's old 'ignored' row is gone, replaced by the new 'fixed'; PR 9 untouched.
  assert.equal(merged.filter((r) => r.id === "aaaaaaaa" && r.pr === 7).length, 1);
  assert.equal(merged.find((r) => r.id === "aaaaaaaa").verdict, "fixed");
  assert.ok(merged.some((r) => r.id === "bbbbbbbb" && r.pr === 9));
});
test("mergeOutcomes keeps a same id on a DIFFERENT pr (id+pr is the key, not id)", () => {
  const now = "2026-06-12T00:00:00.000Z";
  const existing = [{ id: "aaaaaaaa", pr: 7, verdict: "fixed", at: now }];
  const newRows = [{ id: "aaaaaaaa", pr: 8, verdict: "ignored", at: now }]; // same finding text, other PR
  const merged = mergeOutcomes(existing, newRows, now);
  assert.equal(merged.length, 2);
});

// --- detectFixPr (Phase 4 miss capture) -------------------------------------
test("detectFixPr matches fix/revert/hotfix titles + conventional-commit prefixes, not features", () => {
  for (const t of ["fix: handle null", "Fix the login bug", "revert: bad change",
    'Revert "feat: add X"', "hotfix prod outage", "patch the regression", "bugfix: off-by-one"]) {
    assert.equal(detectFixPr(t), true, `expected fix for: ${t}`);
  }
  // 'patch' alone is excluded (semver bumps); a real patch still matches via regression/bug above.
  for (const t of ["feat: add calibration", "docs: update readme", "chore: bump deps", "refactor naming",
    "chore: patch release 1.2.3", "patch version bump", ""]) {
    assert.equal(detectFixPr(t), false, `expected NOT-fix for: ${t}`);
  }
});

// --- findMisses -------------------------------------------------------------
test("findMisses flags a fix PR's file that an EARLIER PR was reviewed clean on", () => {
  const clean = [{ pr: 1, files: ["a.ts", "c.ts"] }, { pr: 2, files: ["d.ts"] }];
  const misses = findMisses(["a.ts", "b.ts"], clean, 5);
  assert.deepEqual(misses, [{ file: "a.ts", ref_pr: 5, clean_pr: 1 }]); // b not clean-reviewed; c/d not touched
});
test("findMisses ignores clean reviews at or after the fix PR (only EARLIER ones count)", () => {
  assert.deepEqual(findMisses(["a.ts"], [{ pr: 9, files: ["a.ts"] }], 5), []); // pr 9 >= 5
});
test("findMisses attributes the MOST RECENT prior clean review of a file, one miss per file", () => {
  const clean = [{ pr: 1, files: ["a.ts"] }, { pr: 3, files: ["a.ts"] }];
  assert.deepEqual(findMisses(["a.ts"], clean, 5), [{ file: "a.ts", ref_pr: 5, clean_pr: 3 }]);
});
test("findMisses is empty/null safe", () => {
  assert.deepEqual(findMisses([], [{ pr: 1, files: ["a.ts"] }], 5), []);
  assert.deepEqual(findMisses(["a.ts"], null, 5), []);
  assert.deepEqual(findMisses(null, null, 5), []);
});

// --- readJsonl --------------------------------------------------------------
test("readJsonl parses valid lines and skips blanks + malformed", () => {
  const f = join(mkdtempSync(join(tmpdir(), "ccr-harvest-")), "x.jsonl");
  writeFileSync(f, `{"id":"a"}\n\n  \nnot json\n{"id":"b"}\n`, "utf8");
  assert.deepEqual(readJsonl(f), [{ id: "a" }, { id: "b" }]);
});
test("readJsonl on a missing file is []", () => {
  assert.deepEqual(readJsonl(join(tmpdir(), "does-not-exist-ccr.jsonl")), []);
});
