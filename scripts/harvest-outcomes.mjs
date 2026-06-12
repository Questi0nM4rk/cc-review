#!/usr/bin/env node
// ============================================================================
//  harvest-outcomes.mjs — learning-loop Phase 1.
//
//  On PR MERGE, classify each posted finding's fate against GitHub ground truth
//  (review-thread state + GitHub's own `isOutdated` "the code under this thread
//  changed" bit) and append one row per finding to learnings/outcomes.jsonl.
//
//  DETERMINISTIC — no LLM reads any comment text. The verdict is computed purely
//  from thread state, so an injected/poisoned old comment can't steer it (the
//  same "don't trust a self-report, verify against ground truth" spine the rest
//  of cc-review runs on). Crucially, "thread still open at merge" is NOT treated
//  as noise: resolution is bot-gated on a re-run the default trigger rarely fires,
//  so open-at-merge is the DEFAULT terminal state. Only open + region-unchanged +
//  no author engagement is a (weak) "ignored" signal; an open thread the author
//  replied to is `open-but-acted` and is excluded from any suppression downstream.
//
//  Runs as a GHA RUNNER step (not a sandboxed brain agent), so it may use node +
//  gh + fs freely. Best-effort: it logs what it did and always exits 0 — a harvest
//  failure must never fail a PR-close cleanup.
//
//  Usage: node harvest-outcomes.mjs --repo owner/name --pr N --slice <dir>
//    <slice> = the staged memory slice dir (has pr-<N>/findings.jsonl + learnings/).
// ============================================================================

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

// The bot's GitHub App identity — the login on every comment it authored. A reply by ANY other
// login is a human author engaging. Matches the exact-match identity rule used in ci-run.sh.
const BOT_LOGIN = "cc-review[bot]";
// Rolling window for outcomes.jsonl — older rows are trimmed on every harvest (deterministic,
// runner-side; the prose-curating memory agent must NEVER touch this machine-owned file).
export const OUTCOME_MAX_DAYS = 180;

// --- pure helpers (unit-tested in harvest-outcomes.test.mjs) ----------------

// Pull the Phase-0 finding id out of a comment body. Returns the 8-hex id or null.
export function extractFindingId(body) {
  const m = /<!--\s*cc-review:finding\s+([0-9a-f]{8})\s*-->/.exec(String(body || ""));
  return m ? m[1] : null;
}

// Classify one finding's fate from its thread state. `t` is null when no thread carries the id
// (the bot comment was deleted) — recorded as 'gone' so it can be filtered, never as a signal.
//   resolved + a 'Dismissed:' reply -> dismissed (intentional; not a miss, not noise)
//   resolved (else)                 -> fixed
//   open + region changed           -> fixed      (code changed even if not formally resolved)
//   open + unchanged + author replied-> open-but-acted (engaged; NOT a noise signal)
//   open + unchanged + no reply      -> ignored    (the only — weak — noise prior)
export function classifyOutcome(t) {
  if (!t) return "gone";
  if (t.isResolved) return t.dismissed ? "dismissed" : "fixed";
  if (t.isOutdated) return "fixed";
  if (t.authorReplied) return "open-but-acted";
  // Fail SAFE on a truncated thread: we couldn't read the whole comment list, so we cannot CONFIRM
  // "no engagement". Never manufacture the (only) noise signal from missing data — downgrade to
  // open-but-acted. (Positive detections above — dismissed/authorReplied found within the window —
  // stay valid; only this negative conclusion is unsafe under truncation.)
  if (t.truncated) return "open-but-acted";
  return "ignored";
}

// Reduce GraphQL review-thread nodes to { findingId -> state } for the bot's threads. A thread is
// the bot's iff its FIRST comment carries a finding marker. authorReplied = a non-bot comment after
// the first; dismissed = any comment says 'Dismissed:' (the bot's resolve-as-intentional message).
export function indexThreads(nodes) {
  const byId = new Map();
  for (const t of (nodes || [])) {
    const comments = t?.comments?.nodes ?? [];
    if (!comments.length) continue;
    const id = extractFindingId(comments[0].body);
    if (!id) continue; // not a Phase-0-instrumented finding thread
    const authorReplied = comments.slice(1).some((c) => (c?.author?.login || "") !== BOT_LOGIN);
    const dismissed = comments.some((c) => /(?:^|\n)\s*Dismissed:/.test(String(c?.body || "")));
    // The comment list was capped by the query — a longer thread we couldn't fully read. classifyOutcome
    // uses this to avoid concluding "ignored" (the noise signal) from a partial list.
    const truncated = t?.comments?.pageInfo?.hasNextPage === true;
    byId.set(id, { isResolved: !!t.isResolved, isOutdated: !!t.isOutdated, authorReplied, dismissed, truncated });
  }
  return byId;
}

// Merge freshly-scored rows into the existing log, then trim. IDEMPOTENT across re-runs: any existing
// row sharing an (id, pr) with a new row is dropped first, so re-harvesting a PR (a GHA job re-run)
// REPLACES its prior rows instead of duplicating them — duplicates would inflate Phase 2's rate math.
export function mergeOutcomes(existing, newRows, nowIso, maxDays = OUTCOME_MAX_DAYS) {
  const fresh = new Set(newRows.map((r) => `${r.id}#${r.pr}`));
  const kept = (existing || []).filter((r) => !fresh.has(`${r.id}#${r.pr}`));
  return trimOutcomes([...kept, ...newRows], nowIso, maxDays);
}

// Keep only rows whose `at` timestamp is within maxDays of `nowIso`. Rows with a missing/unparseable
// `at` are KEPT (fail-safe — never silently drop data we can't date). Deterministic.
export function trimOutcomes(rows, nowIso, maxDays = OUTCOME_MAX_DAYS) {
  const now = Date.parse(nowIso);
  const cutoff = Number.isFinite(now) ? now - maxDays * 86400000 : NaN;
  if (!Number.isFinite(cutoff)) return rows.slice();
  return rows.filter((r) => {
    const t = Date.parse(r?.at);
    return !Number.isFinite(t) || t >= cutoff;
  });
}

// --- miss capture (Phase 4) -------------------------------------------------
// Does this merged PR look like a fix/revert/hotfix? A weak, deliberately broad heuristic (the plan
// rates Phase 4 lowest-confidence). Matches both prose titles and conventional-commit prefixes.
export function detectFixPr(title) {
  const t = String(title || "");
  // Note: 'patch' is deliberately EXCLUDED — it overloads onto semver "patch release/version" bumps
  // (false positives). A genuine patch still matches via fix/bug/regression.
  return /\b(fix(es|ed)?|revert(s|ed)?|hotfix|bug(fix)?|regression)\b/i.test(t)
    || /^\s*(fix|revert)(\(|:|!)/i.test(t);
}

// A `miss` candidate = this fix PR touches a file that an EARLIER PR was reviewed CLEAN on (APPROVED,
// no findings) — i.e. the bot may have missed something there. cleanReviews = [{pr, files}] of prior
// APPROVED reviews. Only PRs reviewed clean BEFORE refPr count; the most recent clean review of each
// file is attributed. One miss per file. This is a WEAK prior (most fix PRs aren't fixing a bot miss).
export function findMisses(targetFiles, cleanReviews, refPr) {
  const targets = new Set(targetFiles || []);
  const prior = (cleanReviews || []).filter((cr) => cr && cr.pr < refPr).sort((a, b) => b.pr - a.pr);
  const misses = [];
  const seen = new Set();
  for (const cr of prior) {
    for (const f of (cr.files || [])) {
      if (targets.has(f) && !seen.has(f)) { seen.add(f); misses.push({ file: f, ref_pr: refPr, clean_pr: cr.pr }); }
    }
  }
  return misses;
}

// Parse a .jsonl file into an array of objects, skipping blank/malformed lines. [] if absent.
export function readJsonl(path) {
  if (!existsSync(path)) return [];
  const rows = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try { rows.push(JSON.parse(s)); } catch { /* skip a malformed line, don't abort the harvest */ }
  }
  return rows;
}

// --- I/O (not unit-tested; thin wrapper over gh) ----------------------------

function gh(args) {
  const r = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// PR title + changed-file paths (for Phase 4 miss detection). Returns null on failure.
function prMeta(repo, pr) {
  const r = gh(["pr", "view", String(pr), "--repo", repo, "--json", "title,files"]);
  if (r.code !== 0) return null;
  try {
    const j = JSON.parse(r.stdout);
    return { title: j.title || "", files: (j.files || []).map((f) => f.path).filter(Boolean) };
  } catch { return null; }
}

// Read prior per-PR review-state markers from the slice — the ones a CLEAN review (APPROVE) wrote with
// its file list (Phase 4 needs to know what was reviewed clean). Returns [{pr, files}] for APPROVED
// reviews other than exceptPr. Markers written before Phase 4 shipped lack event/files and are skipped.
function readCleanReviews(slice, exceptPr) {
  const out = [];
  let entries;
  try { entries = readdirSync(slice, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const m = e.isDirectory() && /^pr-(\d+)$/.exec(e.name);
    if (!m) continue;
    const prNum = Number(m[1]);
    if (prNum === exceptPr) continue;
    let state; // review-state.json is a single JSON object, not jsonl

    try { state = JSON.parse(readFileSync(join(slice, e.name, "review-state.json"), "utf8")); } catch { continue; }
    if (state && state.event === "APPROVE" && Array.isArray(state.files)) out.push({ pr: prNum, files: state.files });
  }
  return out;
}

// Fetch merge state + ALL review threads, paging through reviewThreads so a PR with >100 threads
// isn't silently truncated (which would misclassify trailing findings as 'gone'). The opaque
// base64 endCursor is safe to inline into the GraphQL string (avoids gh's nullable-variable quirk).
// Per-thread comments are capped at 100 with a hasNextPage flag — classifyOutcome fails safe on the
// rare longer thread rather than paginating every thread's comments. Returns { merged, threads } or null.
function fetchPr(repo, pr) {
  const [owner, name] = repo.split("/");
  let merged = null;
  const threads = [];
  let after = null;
  for (let page = 0; page < 50; page++) { // backstop: 50 pages * 100 = 5000 threads
    const afterArg = after ? `,after:"${after}"` : "";
    const q = `query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){merged reviewThreads(first:100${afterArg}){pageInfo{hasNextPage endCursor} nodes{isResolved isOutdated comments(first:100){pageInfo{hasNextPage} nodes{author{login} body}}}}}}}`;
    const r = gh(["api", "graphql", "-f", `query=${q}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `pr=${pr}`]);
    if (r.code !== 0) return null;
    let pull;
    try { pull = JSON.parse(r.stdout)?.data?.repository?.pullRequest ?? null; } catch { return null; }
    if (!pull) return null;
    if (merged === null) merged = !!pull.merged;
    const rt = pull.reviewThreads;
    threads.push(...(rt?.nodes ?? []));
    if (!rt?.pageInfo?.hasNextPage) break;
    after = rt.pageInfo.endCursor;
  }
  return { merged, threads };
}

function main() {
  const repo = flag("repo");
  const pr = flag("pr");
  const slice = flag("slice");
  if (!repo || !pr || !slice) { console.log("harvest-outcomes: missing --repo/--pr/--slice; nothing to do"); return; }

  const prNum = Number(pr);
  const prData = fetchPr(repo, pr);
  if (!prData) { console.log(`harvest-outcomes: could not fetch PR #${pr} — skipping (will not retry)`); return; }
  if (!prData.merged) { console.log(`harvest-outcomes: PR #${pr} was closed without merging — no outcome signal, skipping`); return; }
  const at = new Date().toISOString();
  mkdirSync(join(slice, "learnings"), { recursive: true });

  // (A) OUTCOME HARVEST — classify this PR's own posted findings (needs its findings.jsonl).
  const findings = readJsonl(join(slice, `pr-${pr}`, "findings.jsonl"));
  if (findings.length) {
    const byId = indexThreads(prData.threads);
    const seen = new Set(); // dedup findings by id (a re-posted finding can appear more than once)
    const rowsToScore = findings.filter((f) => f && f.id && !seen.has(f.id) && seen.add(f.id));
    const verdicts = rowsToScore.map((f) => ({ f, verdict: classifyOutcome(byId.get(f.id) || null) }));
    // One row per finding (no per-PR aggregate — Phase 2 derives rates from verdicts grouped by pr).
    const newRows = verdicts.map(({ f, verdict }) => ({ id: f.id, pr: prNum, domain: f.domain || "unknown", verdict, at }));
    const outcomesPath = join(slice, "learnings", "outcomes.jsonl");
    const merged = mergeOutcomes(readJsonl(outcomesPath), newRows, at);
    writeFileSync(outcomesPath, merged.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    const tally = verdicts.reduce((m, v) => ((m[v.verdict] = (m[v.verdict] || 0) + 1), m), {});
    console.log(`harvest-outcomes: PR #${pr} — scored ${newRows.length} finding(s): ${JSON.stringify(tally)}; ${merged.length} row(s) in outcomes.jsonl`);
  } else {
    console.log(`harvest-outcomes: PR #${pr} — no findings.jsonl, nothing of its own to score`);
  }

  // (B) MISS CAPTURE (Phase 4) — if this is a fix/revert PR over a file an EARLIER PR was reviewed
  // CLEAN on, record a (weak) miss candidate. Independent of (A): a clean-reviewed fix PR has no
  // findings.jsonl of its own. Idempotent by (file, ref_pr); trimmed to the same window.
  const meta = prMeta(repo, pr);
  if (meta && detectFixPr(meta.title)) {
    const newMisses = findMisses(meta.files, readCleanReviews(slice, prNum), prNum).map((m) => ({ ...m, at }));
    if (newMisses.length) {
      const missesPath = join(slice, "learnings", "misses.jsonl");
      const existing = readJsonl(missesPath).filter((r) => !newMisses.some((n) => n.file === r.file && n.ref_pr === r.ref_pr));
      const mergedMisses = trimOutcomes([...existing, ...newMisses], at);
      writeFileSync(missesPath, mergedMisses.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
      console.log(`harvest-outcomes: PR #${pr} looks like a fix → ${newMisses.length} miss candidate(s) over previously-clean-reviewed file(s); ${mergedMisses.length} row(s) in misses.jsonl`);
    } else {
      console.log(`harvest-outcomes: PR #${pr} looks like a fix but touched no previously-clean-reviewed file — no miss`);
    }
  }
}

// Run main() only when executed directly, not when imported by the test.
if (process.argv[1] && process.argv[1].endsWith("harvest-outcomes.mjs")) {
  try { main(); } catch (e) { console.log(`harvest-outcomes: unexpected error (non-fatal): ${e?.message || e}`); }
}
