#!/usr/bin/env npx tsx

/**
 * PreToolUse hook: enforces that ALL review operations go through review-cli.ts.
 *
 * Blocks:
 *   - `gh pr review` → Use review-cli.ts post
 *   - `gh api .../pulls/N/reviews --method POST` → Use review-cli.ts post
 *   - `gh api .../pulls/N/reviews` with APPROVE in body → Use review-cli.ts approve
 *   - `gh api graphql` with resolveReviewThread → Use review-cli.ts resolve
 *
 * Allows:
 *   - `tsx .../review-cli.ts` — our CLI
 *   - `tsx .../diff-lines.ts` — line resolution helper
 *   - `gh api .../pulls/N/reviews --method GET` — read-only listing
 *   - All other commands pass through
 */

import { readHookInput, allow, block, extractCommand } from "../lib/hook-runtime.js";

interface BlockRule {
  pattern: RegExp;
  message: string;
}

const BLOCK_RULES: BlockRule[] = [
  {
    pattern: /\bgh\s+pr\s+review\b/,
    message:
      "BLOCKED: Do not use `gh pr review`. Use `tsx .claude/skills/review-guidelines/scripts/review-cli.ts post` instead.",
  },
  {
    pattern: /gh\s+api\s+\S*\/pulls\/\d+\/reviews\s+.*--method\s+POST/,
    message:
      "BLOCKED: Do not POST reviews directly. Use `tsx .claude/skills/review-guidelines/scripts/review-cli.ts post` instead.",
  },
  {
    pattern: /gh\s+api\s+\S*\/pulls\/\d+\/reviews\s+.*APPROVE/,
    message:
      "BLOCKED: Do not approve reviews directly. Use `tsx .claude/skills/review-guidelines/scripts/review-cli.ts approve` instead.",
  },
  {
    pattern: /gh\s+api\s+graphql\b.*resolveReviewThread/,
    message:
      "BLOCKED: Do not resolve threads directly. Use `tsx .claude/skills/review-guidelines/scripts/review-cli.ts resolve` instead.",
  },
];

const ALLOW_PATTERNS: RegExp[] = [
  /tsx\s+.*\/review-cli\.ts/,
  /tsx\s+.*\/diff-lines\.ts/,
];

async function run(): Promise<never> {
  const input = await readHookInput();
  const command = extractCommand(input.tool_input);

  // Always allow our own CLI tools
  for (const pattern of ALLOW_PATTERNS) {
    if (pattern.test(command)) {
      allow();
    }
  }

  // Check block rules
  for (const rule of BLOCK_RULES) {
    if (rule.pattern.test(command)) {
      block(rule.message);
    }
  }

  // Everything else passes through
  allow();
}

run().catch(() => process.exit(0));
