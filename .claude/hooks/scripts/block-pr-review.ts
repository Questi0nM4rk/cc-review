#!/usr/bin/env npx tsx

/**
 * PreToolUse hook: blocks `gh pr review` commands.
 * All reviews MUST use `gh api repos/{owner}/{repo}/pulls/N/reviews`
 * to ensure inline comments are bundled in a single review block.
 */

import { readHookInput, allow, block, extractCommand } from "../lib/hook-runtime.js";

async function run(): Promise<never> {
  const input = await readHookInput();
  const command = extractCommand(input.tool_input);

  if (/\bgh\s+pr\s+review\b/.test(command)) {
    block(
      "BLOCKED: Do not use `gh pr review`. Use `gh api repos/{owner}/{repo}/pulls/N/reviews --method POST --input /tmp/review-payload.json` instead."
    );
  }

  allow();
}

run().catch(() => process.exit(0));
