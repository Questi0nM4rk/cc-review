// Run-scoped post verification (issue #75 retry loop). Given the bot's reviews + inline review
// comments on a PR, count those belonging to THIS run — same bot login AND submitted against the
// reviewed head SHA (a review/comment's `commit_id`) — and decide whether a verdict actually landed.
// Deterministic + pure: scripts/review-platform.ts's `verify-posted` verb wires gh queries to it; the
// brain's post loop retries until landed===true. Scoping by commit_id means a prior run's review on an
// older commit does NOT count as this run having posted.

export function classifyPosted(reviews, inlineComments, headSha, botLogin) {
  // Defensive: an empty headSha must never "match" a review/comment whose commit_id is also absent
  // (`"" === ""`). The verb's requireFlag makes this unreachable in production, but the pure fn must be
  // correct standalone — no head to scope against ⇒ nothing landed for this run.
  if (!headSha) return { reviews: 0, actionItems: 0, landed: false };
  const mine = (x) => ((x?.user?.login ?? "") === botLogin) && ((x?.commit_id ?? "") === headSha);
  const r = (Array.isArray(reviews) ? reviews : []).filter(mine).length;
  const a = (Array.isArray(inlineComments) ? inlineComments : []).filter(mine).length;
  return { reviews: r, actionItems: a, landed: r > 0 || a > 0 };
}
