#!/usr/bin/env npx tsx

/**
 * PreToolUse hook: moves null-line comments to review body "Outside Diff" section.
 * Runs before gh api review POST calls. Fixes the payload file in place.
 */

import { readFileSync, writeFileSync } from "fs";
import { readHookInput, allow, extractCommand } from "../lib/hook-runtime.js";

interface ReviewComment {
  path: string;
  line: number | null;
  body: string;
}

interface ReviewPayload {
  body: string;
  event: string;
  comments: ReviewComment[];
}

async function run(): Promise<never> {
  const input = await readHookInput();
  const command = extractCommand(input.tool_input);

  // Only process gh api review POST calls
  if (!command.includes("/reviews") || !command.includes("POST")) {
    allow();
  }

  // Extract payload file path from command
  const match = command.match(/\/tmp\/[^\s"']+\.json/);
  const payloadPath = match?.[0] ?? "/tmp/review-payload.json";

  let payload: ReviewPayload;
  try {
    payload = JSON.parse(readFileSync(payloadPath, "utf8"));
  } catch {
    allow(); // Can't read payload — let it through
  }

  const nullComments = (payload!.comments ?? []).filter((c) => c.line == null);
  if (nullComments.length === 0) {
    allow();
  }

  // Build "Outside Diff" section
  const outsideItems = nullComments
    .map((c) => `- **\`${c.path}\`**: ${c.body}`)
    .join("\n\n");

  const validComments = payload!.comments.filter((c) => c.line != null);

  const fixedPayload: ReviewPayload = {
    body: `${payload!.body}\n\n### Outside Diff\n\n${outsideItems}`,
    event: payload!.event,
    comments: validComments,
  };

  writeFileSync(payloadPath, JSON.stringify(fixedPayload, null, 2));
  allow();
}

run().catch(() => process.exit(0));
