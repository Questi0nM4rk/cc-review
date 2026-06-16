#!/usr/bin/env node
// ============================================================================
//  memory-maintenance.mjs — periodic DETERMINISTIC maintenance of the cc-review
//  memory branch (`claude-reviewer/memory`).
//
//  Runs as a GHA runner step (scheduled / workflow_dispatch) or locally — NEVER
//  an LLM agent, so it costs ZERO Claude quota. It operates on a CHECKOUT of the
//  memory branch and maintains every consumer slice <owner>/<repo>/ at once.
//
//  What it does, per slice:
//    1. PRUNE pr-<N>/ dirs beyond a retention cap. These are never deleted on PR
//       close (only the consumer's log branch is) → unbounded growth. They are
//       dead weight after merge: review-state.json only matters while a PR is
//       open (the re-run sig-change check), findings.jsonl only until the merge
//       harvest scores it. Keep the most recent KEEP_PR by number; prune the rest.
//    2. TRIM outcomes.jsonl / misses.jsonl to the rolling window. The merge
//       harvester already trims outcomes, but a slice with no recent merges never
//       re-trims — this is the catch-all so old rows can't accumulate forever.
//    3. REPORT health to MAINTENANCE.md at the branch root: slice sizes, pr-dir
//       counts, per-domain verdict tallies, miss counts, known_patterns counts —
//       so a human can SEE whether a domain is trending to silence (the recall
//       counterweight) or misses.jsonl is piling up unread.
//
//  It NEVER edits known-patterns.md content: dropping a suppression line makes the
//  next review re-flag it (see the brain's memoryPrompt). Suppressions are sacred;
//  this only COUNTS them.
//
//  Best-effort + DRY-RUN BY DEFAULT: it reports what it WOULD prune/trim and exits
//  0; pass --apply to actually write. A maintenance hiccup must never be fatal.
//
//  Usage: node memory-maintenance.mjs --root <memory-branch-checkout> [--keep-pr 25] [--apply]
// ============================================================================

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { trimOutcomes, readJsonl, OUTCOME_MAX_DAYS } from "./harvest-outcomes.mjs";

// Retention: keep this many most-recent pr-<N> dirs per slice; prune older ones. Generous on purpose —
// each dir is two tiny files, and pruning a still-open OLD PR's review-state only costs that PR a
// full re-review next time (the SAFE direction). Tunable via --keep-pr.
export const KEEP_PR_DEFAULT = 25;

// --- pure helpers (unit-tested in memory-maintenance.test.mjs) --------------

// "pr-7" -> 7; anything else -> null.
export function prDirNum(name) {
  const m = /^pr-(\d+)$/.exec(String(name || ""));
  return m ? Number(m[1]) : null;
}

// Given the PR numbers present in a slice, return those to PRUNE: every one EXCEPT the `keep` most
// recent (highest N). Deterministic; N is unique so the sort is stable. keep<=0 prunes nothing extra
// only if there are <=0 to keep — guard keep>=1 at the call site if you ever want "keep none".
export function prDirsToPrune(prNums, keep = KEEP_PR_DEFAULT) {
  const sorted = [...new Set((prNums || []).filter((n) => Number.isFinite(n)))].sort((a, b) => b - a);
  return sorted.slice(Math.max(0, keep));
}

// Per-domain RAW verdict tally for the health report — deliberately NOT the calibration rate, to stay
// decoupled from the brain's bucketing. { domain: { fixed: n, ignored: n, ... } }.
export function tallyVerdicts(rows) {
  const t = {};
  for (const r of (rows || [])) {
    const d = (r && r.domain) || "unknown";
    const v = (r && r.verdict) || "unknown";
    if (!t[d]) t[d] = {};
    t[d][v] = (t[d][v] || 0) + 1;
  }
  return t;
}

// A domain is "trending to silence" (a RED recall signal, §4 of the learning-loop plan) when it has a
// real sample but NO code-verified positives — every outcome was ignored/open/gone, never fixed. Worth
// surfacing so a human notices a domain the bot may be over-suppressing. Returns the flagged domains.
export function silentDomains(tally, minSample = 8) {
  const flagged = [];
  for (const [d, v] of Object.entries(tally || {})) {
    if (d === "unknown") continue;
    const total = Object.values(v).reduce((a, b) => a + b, 0);
    const fixed = (v.fixed || 0) + (v.dismissed || 0);
    if (total >= minSample && fixed === 0) flagged.push(d);
  }
  return flagged;
}

// Render the health report markdown from the per-slice records. Pure (timestamp passed in) so it is
// unit-testable and the runner can stamp `at` from new Date() at call time.
export function formatReport(records, nowIso) {
  const lines = [`# cc-review memory — maintenance report`, ``, `_generated ${nowIso}_`, ``];
  if (!records.length) { lines.push(`No slices found.`); return lines.join("\n") + "\n"; }
  for (const r of records) {
    lines.push(`## ${r.owner}/${r.repo}`);
    lines.push(`- pr dirs: ${r.prKept} kept, ${r.prPruned} ${r.applied ? "pruned" : "prunable"}`);
    lines.push(`- outcomes: ${r.outcomesTotal} rows${r.outcomesTrimmed ? ` (${r.outcomesTrimmed} ${r.applied ? "trimmed" : "trimmable"})` : ""}`);
    const domains = Object.entries(r.byDomain).map(([d, v]) => `${d} {${Object.entries(v).map(([k, n]) => `${k}:${n}`).join(", ")}}`);
    if (domains.length) lines.push(`  - by domain: ${domains.join("; ")}`);
    if (r.silent.length) lines.push(`  - ⚠ trending to silence (sample but 0 fixed): ${r.silent.join(", ")}`);
    lines.push(`- misses: ${r.misses}${r.misses > 0 ? " ⚠ (recall candidates — currently read by nothing; review manually)" : ""}`);
    lines.push(`- known_patterns: ${r.knownPatterns} (never auto-pruned)`);
    lines.push(`- MEMORY.md: ${r.memoryBytes} bytes`);
    lines.push(``);
  }
  return lines.join("\n") + "\n";
}

// --- I/O (not unit-tested) --------------------------------------------------

function flag(name) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; }
function hasFlag(name) { return process.argv.includes(`--${name}`); }

function dirs(p) {
  try { return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { return []; }
}

// Slices live at depth 2: <owner>/<repo>/. Skip dotfiles and the report itself. A repo dir counts as a
// slice only if it carries a memory artifact (MEMORY.md / learnings / a pr-* dir) — so a stray dir
// isn't mistaken for a slice.
function listSlices(root) {
  const out = [];
  for (const owner of dirs(root)) {
    // Skip dotfiles and `_`-prefixed dirs — the cross-repo `_global/` additive layer is NOT a consumer
    // slice (it has no <owner>/<repo> shape and must never be pruned/trimmed like one).
    if (owner.startsWith(".") || owner.startsWith("_")) continue;
    for (const repo of dirs(join(root, owner))) {
      const dir = join(root, owner, repo);
      const looksLikeSlice = existsSync(join(dir, "MEMORY.md")) || existsSync(join(dir, "learnings")) ||
        dirs(dir).some((d) => prDirNum(d) !== null);
      if (looksLikeSlice) out.push({ owner, repo, dir });
    }
  }
  return out;
}

function fileLineCount(p) {
  if (!existsSync(p)) return 0;
  return readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).length;
}

function byteSize(p) { try { return statSync(p).size; } catch { return 0; } }

function maintainSlice(slice, keep, apply, nowIso) {
  const { owner, repo, dir } = slice;
  // 1. prune pr-<N> dirs
  const prNums = dirs(dir).map(prDirNum).filter((n) => n !== null);
  const toPrune = prDirsToPrune(prNums, keep);
  if (apply) for (const n of toPrune) { try { rmSync(join(dir, `pr-${n}`), { recursive: true, force: true }); } catch { /* best-effort */ } }

  // 2. trim outcomes.jsonl / misses.jsonl to the window
  let outcomesTrimmed = 0;
  const outcomesPath = join(dir, "learnings", "outcomes.jsonl");
  const outcomeRows = readJsonl(outcomesPath);
  if (outcomeRows.length) {
    const kept = trimOutcomes(outcomeRows, nowIso, OUTCOME_MAX_DAYS);
    outcomesTrimmed = outcomeRows.length - kept.length;
    if (apply && outcomesTrimmed > 0) writeFileSync(outcomesPath, kept.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  }
  const missesPath = join(dir, "learnings", "misses.jsonl");
  const missRows = readJsonl(missesPath);
  if (apply && missRows.length) {
    const kept = trimOutcomes(missRows, nowIso, OUTCOME_MAX_DAYS);
    if (kept.length !== missRows.length) writeFileSync(missesPath, kept.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  }

  const byDomain = tallyVerdicts(outcomeRows);
  return {
    owner, repo, applied: apply,
    prKept: Math.max(0, prNums.length - toPrune.length), prPruned: toPrune.length,
    outcomesTotal: outcomeRows.length, outcomesTrimmed,
    byDomain, silent: silentDomains(byDomain),
    misses: missRows.length,
    knownPatterns: fileLineCount(join(dir, "learnings", "known-patterns.md")),
    memoryBytes: byteSize(join(dir, "MEMORY.md")),
  };
}

function main() {
  const root = flag("root");
  if (!root || !existsSync(root)) { console.log(`memory-maintenance: --root missing or not found (${root}); nothing to do`); return; }
  const keep = Number.isFinite(Number(flag("keep-pr"))) && Number(flag("keep-pr")) > 0 ? Number(flag("keep-pr")) : KEEP_PR_DEFAULT;
  const apply = hasFlag("apply");
  const nowIso = new Date().toISOString();

  const slices = listSlices(root);
  const records = slices.map((s) => maintainSlice(s, keep, apply, nowIso));
  const report = formatReport(records, nowIso);
  writeFileSync(join(root, "MAINTENANCE.md"), report, "utf8");

  const pruned = records.reduce((a, r) => a + r.prPruned, 0);
  const trimmed = records.reduce((a, r) => a + r.outcomesTrimmed, 0);
  console.log(`memory-maintenance: ${slices.length} slice(s); ${pruned} pr-dir(s) ${apply ? "pruned" : "prunable"}, ${trimmed} outcome row(s) ${apply ? "trimmed" : "trimmable"}${apply ? "" : " (DRY RUN — pass --apply to write)"}; report -> MAINTENANCE.md`);
}

// Run main() only when executed directly, not when imported by the test.
if (process.argv[1] && process.argv[1].endsWith("memory-maintenance.mjs")) {
  try { main(); } catch (e) { console.log(`memory-maintenance: unexpected error (non-fatal): ${e?.message || e}`); }
}
