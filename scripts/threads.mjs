// Bot-thread ownership predicate for the `threads` adapter verbs. The review brain resolves and
// replies to EVERY thread the adapter returns, so the adapter must return only threads the bot
// owns — otherwise the brain would close conversations opened by human reviewers.
//
// Ownership contract (a thread is bot-owned if EITHER holds):
//   1. The first comment's author login/username equals `botLogin` (the live bot account). An empty
//      or undefined `botLogin` never matches an empty/missing author login — otherwise `"" === ""`
//      would falsely claim every author-less thread.
//   2. The first-comment body carries the hidden per-finding marker `<!-- cc-review:finding <id> -->`
//      (any id, matched as a substring). This keeps threads owned across two cases the login check
//      misses: old bot threads whose account label drifted, and in-session runs posting under a
//      human account (which is why `verify-posted` also honours a --bot-login flag).
//
// Pure + total: null/undefined login and body are tolerated (no throw) and simply fail their branch.

/** Hidden marker every bot-posted inline finding carries; id-agnostic substring match. */
const FINDING_MARKER = "<!-- cc-review:finding";

/**
 * Decide whether a review thread is owned by the review bot.
 * @param {string | null | undefined} firstAuthorLogin - first comment's author login (GitHub) / username (GitLab)
 * @param {string | null | undefined} firstBody - first comment's body text
 * @param {string | null | undefined} botLogin - the live bot account; empty/undefined disables the login branch
 * @returns {boolean} true when the bot owns the thread
 */
export function isBotThread(firstAuthorLogin, firstBody, botLogin) {
  if (botLogin && firstAuthorLogin === botLogin) return true;
  if (typeof firstBody === "string" && firstBody.includes(FINDING_MARKER)) return true;
  return false;
}
