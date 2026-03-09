/**
 * PreToolUse hook: blocks `gh pr review` commands.
 * All reviews MUST use `gh api repos/{owner}/{repo}/pulls/N/reviews`
 * to ensure inline comments are bundled in a single review block.
 */

const input = JSON.parse(await Bun.stdin.text().catch(() => "{}"));
const command: string = input?.tool_input?.command ?? "";

if (/\bgh\s+pr\s+review\b/.test(command)) {
  console.log(
    JSON.stringify({
      decision: "block",
      reason:
        "BLOCKED: Do not use `gh pr review`. Use `gh api repos/{owner}/{repo}/pulls/N/reviews --method POST --input /tmp/review-payload.json` instead. This ensures all inline comments are bundled in a single review block.",
    })
  );
} else {
  console.log(JSON.stringify({ decision: "allow" }));
}
