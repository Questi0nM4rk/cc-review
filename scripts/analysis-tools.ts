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

// Changed files: prefer the GHA's pre-fetched diff, else nothing (tool-runner is best-effort).
function changedFiles(): string[] {
  const files = new Set<string>();
  if (existsSync("/tmp/pr-diff.txt")) {
    const diff = readFileSync("/tmp/pr-diff.txt", "utf8");
    for (const m of diff.matchAll(/^\+\+\+ b\/(.+)$/gm)) files.add(m[1]);
  }
  return [...files].filter(sourceFile);
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

function main() {
  const available = CANDIDATES.filter(have);
  let findings: Finding[] = [];

  const files = changedFiles();
  if (files.length) {
    if (available.includes("semgrep")) { try { findings.push(...runSemgrep(files)); } catch { /* skip */ } }
    if (available.includes("lizard")) { try { findings.push(...runLizard(files)); } catch { /* skip */ } }
  }

  if (findings.length > MAX_FINDINGS) findings = findings.slice(0, MAX_FINDINGS);
  process.stdout.write(JSON.stringify({ available, findings }));
}

main();
