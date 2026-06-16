#!/usr/bin/env npx tsx
/**
 * analysis-tools — optional static-analysis runner for cc-review.
 *
 * The strict-review workflow calls this once per run; reviewers treat the output
 * as LEADS to verify, never as verdicts. Every tool is optional: if it is not on
 * PATH, it is skipped and noted in `available`. The review works tool-less.
 *
 *   tsx scripts/analysis-tools.ts --changed
 *     -> { "available": ["semgrep","lizard"], "findings": [{tool,file,line,message}] }
 *
 * Tools used for findings:  semgrep (security/bug patterns), lizard (complexity).
 * Runtime: node + tsx. No extra deps.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

interface Finding { tool: string; file: string; line: number; message: string }

const MAX_FINDINGS = 60;
// Only the tools that actually produce findings. `available` then accurately
// reflects what ran (no dead detection of tools nothing consumes).
const CANDIDATES = ["semgrep", "lizard"];

function have(bin: string): boolean {
  return spawnSync("which", [bin], { encoding: "utf8" }).status === 0;
}

function sourceFile(p: string): boolean {
  return /\.(cs|ts|tsx|mts|cts|js|jsx|py|go|rb|java|php|sh|bash)$/.test(p) && existsSync(p);
}

// Changed paths from the GHA's pre-fetched diff (best-effort; empty if absent). Raw paths — the static
// tools filter these to source files; the learning-loop prior-signal match wants ALL changed paths.
function changedPaths(): string[] {
  const files = new Set<string>();
  if (existsSync("/tmp/pr-diff.txt")) {
    const diff = readFileSync("/tmp/pr-diff.txt", "utf8");
    for (const m of diff.matchAll(/^\+\+\+ b\/(.+)$/gm)) files.add(m[1]);
  }
  return [...files];
}

function runSemgrep(files: string[]): Finding[] {
  const r = spawnSync("semgrep", ["scan", "--config", "auto", "--json", "--quiet", "--timeout", "120", ...files], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status === null || !r.stdout) return [];
  try {
    const results = JSON.parse(r.stdout)?.results ?? [];
    return results.map((x: any): Finding => ({ tool: "semgrep", file: x.path, line: x.start?.line ?? 0, message: (x.extra?.message ?? x.check_id ?? "").split("\n")[0].slice(0, 240) }));
  } catch {
    return [];
  }
}

function runLizard(files: string[]): Finding[] {
  // -w = warnings only (functions over the CCN / length / param thresholds).
  const r = spawnSync("lizard", ["-w", ...files], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (!r.stdout) return [];
  const out: Finding[] = [];
  for (const line of r.stdout.split("\n")) {
    const m = line.match(/^(.+?):(\d+):\s*(?:warning:\s*)?(.+)$/);
    if (m) out.push({ tool: "lizard", file: m[1], line: Number(m[2]), message: `High complexity — ${m[3].trim().slice(0, 200)}` });
  }
  return out;
}

// Learning-loop outcome rows (Phase 2 calibration source). Read DETERMINISTICALLY here — not relayed
// through the synthesis LLM agent — so the per-domain rate math runs on the exact bytes the harvester
// wrote, never an LLM paraphrase (the spine principle). Absent before the first harvest -> []. Only
// {domain,verdict} is projected (all calibration consumes); the file also carries id/pr/at — YAGNI here.
function outcomes(): { domain: string; verdict: string }[] {
  const path = ".cc-memory/learnings/outcomes.jsonl";
  if (!existsSync(path)) return [];
  const rows: { domain: string; verdict: string }[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && o.domain && o.verdict) rows.push({ domain: String(o.domain), verdict: String(o.verdict) });
    } catch { /* skip a malformed line — never abort the run */ }
  }
  return rows;
}

// File-keyed RECALL signals for the learning loop: changed files that an earlier review MISSED a bug on
// (misses.jsonl) or recorded a confirmed issue on (found-issues.md). Deterministic path match — the brain
// turns these into routed observations that RAISE scrutiny on exactly those files (additive; never
// suppresses). One signal per file (the reviewer re-scrutinizes the whole file regardless).
function priorSignals(changed: string[]): { misses: { file: string; note: string }[]; priorIssues: { file: string; note: string }[] } {
  const set = new Set(changed);
  const seenMiss = new Set<string>(), seenIssue = new Set<string>();
  const misses: { file: string; note: string }[] = [];
  const priorIssues: { file: string; note: string }[] = [];
  // misses.jsonl rows: { file, ref_pr, clean_pr } — the recall signal harvested on a later fix PR.
  if (existsSync(".cc-memory/learnings/misses.jsonl")) {
    for (const line of readFileSync(".cc-memory/learnings/misses.jsonl", "utf8").split("\n")) {
      const s = line.trim(); if (!s) continue;
      try {
        const m = JSON.parse(s);
        if (m && m.file && set.has(m.file) && !seenMiss.has(m.file)) {
          seenMiss.add(m.file);
          misses.push({ file: m.file, note: `a bug was MISSED here before (fix in PR #${m.ref_pr ?? "?"})` });
        }
      } catch { /* skip a malformed line */ }
    }
  }
  // found-issues.md bullets, e.g. "- path/to/file.ts:42 — description". Best-effort path-substring match
  // (the curating memory agent may reword a bullet, so this is additive, never relied upon).
  if (existsSync(".cc-memory/learnings/found-issues.md")) {
    for (const line of readFileSync(".cc-memory/learnings/found-issues.md", "utf8").split("\n")) {
      for (const f of changed) {
        if (f && line.includes(f) && !seenIssue.has(f)) {
          seenIssue.add(f);
          priorIssues.push({ file: f, note: line.replace(/^\s*[-*]\s*/, "").trim().slice(0, 200) });
          break;
        }
      }
    }
  }
  return { misses, priorIssues };
}

function main() {
  const available = CANDIDATES.filter(have);
  let findings: Finding[] = [];

  const all = changedPaths();
  const files = all.filter(sourceFile);
  if (files.length) {
    if (available.includes("semgrep")) { try { findings.push(...runSemgrep(files)); } catch { /* skip */ } }
    if (available.includes("lizard")) { try { findings.push(...runLizard(files)); } catch { /* skip */ } }
  }

  if (findings.length > MAX_FINDINGS) findings = findings.slice(0, MAX_FINDINGS);
  // outcomes + file-keyed prior signals ride on this one invocation (gather already calls it) — no extra agent.
  process.stdout.write(JSON.stringify({ available, findings, outcomes: outcomes(), priorSignals: priorSignals(all) }));
}

main();
