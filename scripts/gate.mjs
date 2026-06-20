// Pure post-run completion-gate decision for ci-run.sh (issue #75).
// ci-run.sh is thin shell; the verdict logic lives HERE (unit-tested in gate.test.mjs) so it
// can't silently drift the way the old inline OR-rule did. Three inputs:
//   1) the brain's completion sentinel (.cc-run/cc-result.json) — proves the workflow FINISHED
//      and in which mode; absent => it froze (e.g. stalled at an interactive prompt while
//      agentapi reported 'stable'), which must FAIL even on a clean agentapi exit.
//   2) the agentapi exit code (non-zero = never went stable / died / quota).
//   3) before/after GitHub bot-artifact counts — the ground-truth cross-check, per mode.
//
// Run as CLI (ci-run.sh): env-driven, prints the failure reason to stdout (empty = pass), exit 0.
//   SENTINEL=.cc-run/cc-result.json RUN_RC=$? CC_POST=1 \
//   BEFORE_REVIEWS=.. AFTER_REVIEWS=.. BEFORE_COMMENTS=.. AFTER_COMMENTS=.. node scripts/gate.mjs

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Modes that post a FORMAL review (POST /pulls/N/reviews → review count rises) vs comment-only modes.
const REVIEW_MODES = new Set(["first", "rerun"]);
const COMMENT_MODES = new Set(["answer", "rerun-blocked"]);

// A count snapshot is a stringified integer, or "ERR"/"" when the GitHub query failed.
const readable = (n) => n !== "ERR" && n !== "" && n != null && Number.isFinite(Number(n));
const rose = (before, after) => readable(before) && readable(after) && Number(after) > Number(before);
const unreadable = (before, after) => !readable(before) || !readable(after);

// result: parsed sentinel object (brain return) or null if absent/unparseable.
// counts: { beforeReviews, afterReviews, beforeComments, afterComments } (strings).
// opts:   { runRc:number, post:boolean }
// Returns { pass:boolean, reason:string } — reason "" on pass.
export function decideGate(result, counts, opts) {
  // 1) agentapi exit code: non-zero = the turn never completed (timed out / auth / quota / died).
  if (opts.runRc !== 0) {
    return { pass: false, reason: "the review did not signal completion (timed out or died mid-review — often a usage/quota limit)" };
  }
  // 2) Completion sentinel: the orchestrator writes the brain's return JSON LAST.
  //    - ABSENT => the workflow never finished (froze at a prompt while agentapi reported 'stable').
  //    - PRESENT but ok!==true => the brain INTENTIONALLY aborted (empty diff / unresolved PR /
  //      wrong PR); surface ITS reason so the failure comment is accurate.
  if (!result || result.ok !== true) {
    const why = (result && typeof result.reason === "string" && result.reason.trim())
      ? result.reason
      : "the run reported no completion result — the strict-review workflow did not finish (it may have stalled at an interactive prompt while agentapi reported 'stable')";
    return { pass: false, reason: why };
  }
  // 3) Nothing to verify: posting wasn't requested, or the brain ran a local dry-run.
  if (!opts.post || result.localDryRun === true) return { pass: true, reason: "" };

  // 4) Mode-aware GitHub ground-truth cross-check. An overview comment NEVER satisfies a normal
  //    review — that mode must raise the formal review count. Unreadable snapshot => degrade to
  //    trusting the (present, ok) sentinel rather than false-failing on a transient API error.
  const mode = String(result.mode || "");
  if (REVIEW_MODES.has(mode)) {
    if (rose(counts.beforeReviews, counts.afterReviews)) return { pass: true, reason: "" };
    if (unreadable(counts.beforeReviews, counts.afterReviews)) return { pass: true, reason: "" };
    return { pass: false, reason: `the run finished in '${mode}' mode but no new formal cc-review review appeared on the PR — the verdict was not posted (an overview comment alone does not count)` };
  }
  if (COMMENT_MODES.has(mode)) {
    if (rose(counts.beforeComments, counts.afterComments)) return { pass: true, reason: "" };
    if (unreadable(counts.beforeComments, counts.afterComments)) return { pass: true, reason: "" };
    return { pass: false, reason: `the run finished in '${mode}' mode but no new cc-review comment appeared on the PR — the response was not posted` };
  }
  // 5) Unknown mode (a future brain): don't hard-fail on the gate's ignorance — trust the sentinel.
  return { pass: true, reason: "" };
}

// --- CLI entry (ci-run.sh) — thin: read env + sentinel file, print reason, always exit 0. --------
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const e = process.env;
  let result = null;
  try { result = JSON.parse(readFileSync(e.SENTINEL || ".cc-run/cc-result.json", "utf8")); } catch { result = null; }
  const { reason } = decideGate(
    result,
    { beforeReviews: e.BEFORE_REVIEWS, afterReviews: e.AFTER_REVIEWS, beforeComments: e.BEFORE_COMMENTS, afterComments: e.AFTER_COMMENTS },
    { runRc: Number(e.RUN_RC || 0), post: e.CC_POST === "1" },
  );
  if (reason) process.stdout.write(reason);
  process.exit(0);
}
