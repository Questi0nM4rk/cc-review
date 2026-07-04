// Pure Post-phase sequencer (reshape plan Phase 2). Everything the brain's Post phase did through
// LLM-as-RPC agents — reply-once, resolve, post-review with idempotency+verify-retry, then the
// review-state + findings.jsonl marker writes — runs here as deterministic code. Moving it out of the
// brain deletes the verbatim-transcription prompts and the verify-retry loop the LLM used to drive.
//
// Three seams keep it pure and unit-testable without gh/glab/tsx/fs:
//   adapter(verb, argsObject) -> parsed JSON result   (the ONLY platform touch; injected)
//   writeFile(path, content)                          (OVERWRITE disk touch; injected — review-state)
//   appendFile(path, content)                         (APPEND disk touch; injected — findings.jsonl)
// scripts/review-platform.ts's `post-run` verb builds the real closures over its gh/gl internals.
// WHY two disk seams: review-state.json is a single-marker OVERWRITE (a re-run fully replaces it), but
// findings.jsonl is the learning loop's UNION of rows across re-runs — an overwrite would drop every
// earlier run's findings, so its rows must APPEND. (Codex P2 regression: findings.jsonl was overwritten.)
//
// Sequence (all inside one call): (a) each reply ONCE — reply failures are LOGGED, never retried
// (replies are not idempotent: a verify false-negative from GitHub read-lag must not stack duplicate
// replies) and never abort; (b) each resolve — a failure is logged, the sequence continues; (c)
// post-review then verify-posted, retried up to 3 attempts total while landed !== true (GitLab: skip
// verify, one post, landed = posted); (d) on landed: OVERWRITE review-state.json with the exact bytes
// of ctx.review_state and APPEND finding_rows as JSONL to findings.jsonl under mem_dir/pr-<N>/ — only
// when finding_rows is non-empty AND mem_dir is provided; (e) return a fully deterministic summary.

const MAX_ATTEMPTS = 3;

/**
 * @param {object} ctx - { pr_number, repo, platform, head_sha, bot_login, payload, replies,
 *   resolve_ids, review_state, finding_rows, mem_dir }
 * @param {(verb: string, args: object) => Promise<any>} adapter - injected platform seam.
 * @param {(path: string, content: string) => Promise<void>} writeFile - injected OVERWRITE disk seam (review-state).
 * @param {(path: string, content: string) => Promise<void>} appendFile - injected APPEND disk seam (findings.jsonl).
 * @returns {Promise<{ landed: boolean, posted: boolean, attempts: number,
 *   replyFailures: Array<object>, resolveFailures: Array<object>, writes: string[] }>}
 */
export async function executePostRun(ctx, adapter, writeFile, appendFile) {
  const c = ctx && typeof ctx === "object" ? ctx : {};
  const replies = Array.isArray(c.replies) ? c.replies : [];
  const resolveIds = Array.isArray(c.resolve_ids) ? c.resolve_ids : [];
  const findingRows = Array.isArray(c.finding_rows) ? c.finding_rows : [];
  const isGitlab = c.platform === "gitlab";

  const replyFailures = [];
  const resolveFailures = [];
  const writes = [];

  // (a) replies — ONCE each, outside any retry loop. A failure is recorded, never retried, never fatal.
  for (const r of replies) {
    try {
      await adapter("reply", {
        pr: c.pr_number, repo: c.repo, thread: r.thread,
        comment_id: r.comment_id, body: r.body,
      });
    } catch (e) {
      replyFailures.push({ thread: r?.thread, error: String(e?.message ?? e) });
    }
  }

  // (b) resolves — a failure is logged, the sequence continues.
  for (const id of resolveIds) {
    try {
      await adapter("resolve", { pr: c.pr_number, repo: c.repo, thread: id });
    } catch (e) {
      resolveFailures.push({ thread: id, error: String(e?.message ?? e) });
    }
  }

  // (c) post-review (+ verify) with retry up to MAX_ATTEMPTS total while not landed.
  let landed = false;
  let posted = false;
  let attempts = 0;
  while (attempts < MAX_ATTEMPTS && !landed) {
    attempts++;
    const postRes = await adapter("post-review", { pr: c.pr_number, repo: c.repo, payload: c.payload });
    // A byte-identical re-post the adapter skipped surfaces as { posted:false, duplicate:true } — that
    // IS a successful (idempotent) post, so it counts as posted for the landed check.
    const didPost = postRes?.posted === true || postRes?.duplicate === true;
    if (didPost) posted = true;

    if (isGitlab) {
      // GitLab has no run-scoped verify (inline DiffNote already verified in the adapter) — one post,
      // landed = posted. No retry loop.
      landed = didPost;
      break;
    }

    const verifyRes = await adapter("verify-posted", {
      pr: c.pr_number, repo: c.repo, head_sha: c.head_sha, bot_login: c.bot_login,
    });
    landed = verifyRes?.landed === true;
  }

  // (d) marker writes — ONLY on landed. review-state OVERWRITE (exact bytes); findings APPEND as JSONL.
  if (landed) {
    const dir = typeof c.mem_dir === "string" && c.mem_dir ? `${c.mem_dir}/pr-${c.pr_number}` : "";
    if (dir) {
      if (typeof c.review_state === "string" && c.review_state) {
        const statePath = `${dir}/review-state.json`;
        await writeFile(statePath, c.review_state);
        writes.push(statePath);
      }
      if (findingRows.length > 0) {
        const findPath = `${dir}/findings.jsonl`;
        const jsonl = findingRows.map((row) => JSON.stringify(row)).join("\n") + "\n";
        // APPEND (not overwrite): the learning loop reads the UNION of rows across re-runs, so this
        // run's rows must land AFTER any earlier run's rows — never replace them.
        await appendFile(findPath, jsonl);
        writes.push(findPath);
      }
    }
  }

  return { landed, posted, attempts, replyFailures, resolveFailures, writes };
}
