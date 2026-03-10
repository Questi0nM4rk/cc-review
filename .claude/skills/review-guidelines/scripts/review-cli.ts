#!/usr/bin/env tsx
/**
 * review-cli.ts — Full Review Lifecycle CLI
 *
 * Single entry point for ALL PR review operations. The model MUST use this CLI
 * instead of raw `gh` commands. Enforcement hooks block direct API calls.
 *
 * Subcommands:
 *   post     — Post a review with inline comments (absorbs post-review.ts)
 *   approve  — Approve a PR (with unresolved thread guard)
 *   status   — Get review status + unresolved thread count
 *   list     — List all reviews on a PR
 *   resolve  — Resolve a review thread by node ID
 *
 * Usage:
 *   tsx review-cli.ts post    --repo owner/repo --pr 98 --diff /tmp/pr-diff.txt --findings /tmp/findings.json [--dry-run]
 *   tsx review-cli.ts approve --repo owner/repo --pr 98 [--force] [--dry-run]
 *   tsx review-cli.ts status  --repo owner/repo --pr 98
 *   tsx review-cli.ts list    --repo owner/repo --pr 98
 *   tsx review-cli.ts resolve --repo owner/repo --pr 98 --thread-id <nodeId>
 */

import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { resolve, dirname } from "path";

// ── Types ───────────────────────────────────────────────

interface Finding {
  file: string | null;
  search?: string | null;
  line?: number | null;
  body: string;
}

interface FindingsInput {
  summary: string;
  findings: Finding[];
}

interface DiffLine {
  file: string;
  line: number;
  side: "RIGHT" | "LEFT";
  type: "added" | "removed" | "context";
  content: string;
}

interface ReviewComment {
  path: string;
  line: number;
  side: "RIGHT" | "LEFT";
  body: string;
}

interface ReviewPayload {
  body: string;
  event: "REQUEST_CHANGES" | "APPROVE" | "COMMENT";
  comments: ReviewComment[];
}

// ── Shared Infrastructure ───────────────────────────────

function parseGlobalArgs(): {
  subcommand: string;
  repo: string;
  pr: number;
  rest: string[];
} {
  const args = process.argv.slice(2);
  const subcommand = args[0] ?? "";
  let repo = "";
  let pr = 0;
  const rest: string[] = [];

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case "--repo":
        repo = args[++i];
        break;
      case "--pr":
        pr = parseInt(args[++i], 10);
        break;
      default:
        rest.push(args[i]);
        break;
    }
  }

  if (!subcommand) {
    printUsage();
    process.exit(1);
  }

  if (!repo || !pr) {
    process.stderr.write(`[review-cli] --repo and --pr are required for '${subcommand}'\n`);
    process.exit(1);
  }

  return { subcommand, repo, pr, rest };
}

function parseRestArgs(rest: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      // Check if next arg is a value or another flag
      if (i + 1 < rest.length && !rest[i + 1].startsWith("--")) {
        result[key] = rest[++i];
      } else {
        result[key] = true;
      }
    }
  }
  return result;
}

function ghApi(endpoint: string, method?: string, inputFile?: string): string {
  let cmd = `gh api ${endpoint}`;
  if (method) cmd += ` --method ${method}`;
  if (inputFile) cmd += ` --input ${inputFile}`;

  try {
    return execSync(cmd, { encoding: "utf8", timeout: 30_000 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[review-cli] API error: ${msg}\n`);
    process.exit(1);
  }
}

function ghGraphQL(query: string, variables: Record<string, unknown> = {}): unknown {
  const payload = JSON.stringify({ query, variables });
  const tmpFile = "/tmp/review-cli-graphql.json";
  writeFileSync(tmpFile, payload);

  try {
    const output = execSync(`gh api graphql --input ${tmpFile}`, {
      encoding: "utf8",
      timeout: 30_000,
    });
    return JSON.parse(output);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[review-cli] GraphQL error: ${msg}\n`);
    process.exit(1);
  }
}

function printUsage(): void {
  process.stderr.write(
    `Usage: tsx review-cli.ts <subcommand> --repo owner/repo --pr N [options]

Subcommands:
  post      Post a review with inline comments
            --diff <path> --findings <path> [--dry-run]
  approve   Approve a PR (checks for unresolved threads first)
            [--force] [--dry-run]
  status    Get review status and unresolved thread count
  list      List all reviews on a PR
  resolve   Resolve a review thread
            --thread-id <nodeId>
`
  );
}

// ── Diff Line Resolution (reused from post-review.ts) ───

function getDiffLines(diffPath: string, file?: string): DiffLine[] {
  const scriptPath = resolve(dirname(new URL(import.meta.url).pathname), "diff-lines.ts");
  const fileArg = file ? ` "${file}"` : "";
  const cmd = `tsx "${scriptPath}" "${diffPath}"${fileArg}`;
  try {
    const output = execSync(cmd, { encoding: "utf8", timeout: 30_000 });
    return JSON.parse(output) as DiffLine[];
  } catch {
    process.stderr.write(`[review-cli] Failed to run diff-lines.ts\n`);
    return [];
  }
}

function resolveLineNumber(
  diffLines: DiffLine[],
  finding: Finding
): { line: number; side: "RIGHT" | "LEFT"; path: string } | null {
  if (!finding.file) return null;

  const fileLines = diffLines.filter((dl) => dl.file === finding.file);
  if (fileLines.length === 0) return null;

  if (finding.line != null) {
    const match = fileLines.find((dl) => dl.line === finding.line);
    if (match) return { line: match.line, side: match.side, path: match.file };
  }

  if (finding.search) {
    const searchLower = finding.search.toLowerCase();
    const added = fileLines.find(
      (dl) => dl.type === "added" && dl.content.toLowerCase().includes(searchLower)
    );
    if (added) return { line: added.line, side: added.side, path: added.file };

    const any = fileLines.find((dl) => dl.content.toLowerCase().includes(searchLower));
    if (any) return { line: any.line, side: any.side, path: any.file };
  }

  return null;
}

function buildPayload(input: FindingsInput, diffLines: DiffLine[]): ReviewPayload {
  const inlineComments: ReviewComment[] = [];
  const outsideFindings: string[] = [];

  for (const finding of input.findings) {
    const resolved = resolveLineNumber(diffLines, finding);

    if (resolved) {
      inlineComments.push({
        path: resolved.path,
        line: resolved.line,
        side: resolved.side,
        body: finding.body,
      });
    } else {
      const fileRef = finding.file ? `**\`${finding.file}\`**: ` : "";
      outsideFindings.push(`- ${fileRef}${finding.body}`);
    }
  }

  let body = input.summary;
  if (outsideFindings.length > 0) {
    body += `\n\n### Outside Diff\n\n${outsideFindings.join("\n\n")}`;
  }

  const hasFindings = inlineComments.length > 0 || outsideFindings.length > 0;
  const event = hasFindings ? "REQUEST_CHANGES" : "APPROVE";

  return { body, event, comments: inlineComments };
}

// ── Subcommand: post ────────────────────────────────────

function cmdPost(repo: string, pr: number, rest: string[]): void {
  const opts = parseRestArgs(rest);
  const diffPath = opts["diff"] as string;
  const findingsPath = opts["findings"] as string;
  const dryRun = opts["dry-run"] === true;

  if (!diffPath || !findingsPath) {
    process.stderr.write(
      "[review-cli] post requires --diff <path> --findings <path>\n"
    );
    process.exit(1);
  }

  // Read findings
  let findingsRaw: string;
  if (findingsPath === "-") {
    findingsRaw = readFileSync(0, "utf8");
  } else {
    findingsRaw = readFileSync(findingsPath, "utf8");
  }

  let input: FindingsInput;
  try {
    input = JSON.parse(findingsRaw);
  } catch {
    process.stderr.write(`[review-cli] Invalid findings JSON\n`);
    process.exit(1);
  }

  if (!input.findings || !Array.isArray(input.findings)) {
    process.stderr.write(`[review-cli] findings must be an array\n`);
    process.exit(1);
  }

  // Parse diff
  const diffLines = getDiffLines(diffPath);
  if (diffLines.length === 0) {
    process.stderr.write(`[review-cli] Warning: diff produced 0 commentable lines\n`);
  }

  // Build payload
  const payload = buildPayload(input, diffLines);

  const stats = {
    total: input.findings.length,
    inline: payload.comments.length,
    outside: input.findings.length - payload.comments.length,
    event: payload.event,
  };

  process.stderr.write(
    `[review-cli] post: ${stats.total} findings: ${stats.inline} inline, ${stats.outside} in body → ${stats.event}\n`
  );

  if (dryRun) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    process.stderr.write(`[review-cli] Dry run — payload written to stdout\n`);
    return;
  }

  // Post
  const payloadPath = "/tmp/review-payload.json";
  writeFileSync(payloadPath, JSON.stringify(payload, null, 2));
  const output = ghApi(`repos/${repo}/pulls/${pr}/reviews`, "POST", payloadPath);
  const result = JSON.parse(output);
  process.stderr.write(`[review-cli] Review posted: ${result.state} (ID: ${result.id})\n`);
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

// ── Subcommand: approve ─────────────────────────────────

function cmdApprove(repo: string, pr: number, rest: string[]): void {
  const opts = parseRestArgs(rest);
  const force = opts["force"] === true;
  const dryRun = opts["dry-run"] === true;

  // Check for unresolved threads via GraphQL
  const [owner, name] = repo.split("/");
  const query = `
    query($owner: String!, $name: String!, $pr: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $pr) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              comments(first: 1) {
                nodes {
                  body
                }
              }
            }
          }
        }
      }
    }
  `;

  const result = ghGraphQL(query, { owner, name, pr }) as {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: Array<{
              id: string;
              isResolved: boolean;
              comments: { nodes: Array<{ body: string }> };
            }>;
          };
        };
      };
    };
  };

  const threads = result.data.repository.pullRequest.reviewThreads.nodes;
  const unresolved = threads.filter((t) => !t.isResolved);
  const total = threads.length;

  process.stderr.write(
    `[review-cli] approve: ${unresolved.length} unresolved / ${total} total threads\n`
  );

  if (unresolved.length > 0 && !force) {
    process.stderr.write(
      `[review-cli] REFUSED: ${unresolved.length} unresolved thread(s). Resolve them first or use --force.\n`
    );
    // Print thread summaries
    for (const t of unresolved) {
      const preview = t.comments.nodes[0]?.body.slice(0, 100) ?? "(empty)";
      process.stderr.write(`  - ${t.id}: ${preview}\n`);
    }

    const output = {
      approved: false,
      unresolvedThreads: unresolved.length,
      totalThreads: total,
      threads: unresolved.map((t) => ({
        id: t.id,
        preview: t.comments.nodes[0]?.body.slice(0, 100) ?? "(empty)",
      })),
    };
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
    process.exit(1);
  }

  const payload: ReviewPayload = {
    body: "LGTM — all review threads resolved.",
    event: "APPROVE",
    comments: [],
  };

  if (dryRun) {
    const output = {
      approved: true,
      unresolvedThreads: unresolved.length,
      totalThreads: total,
      payload,
    };
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
    process.stderr.write(`[review-cli] Dry run — would approve\n`);
    return;
  }

  // Post approval
  const payloadPath = "/tmp/review-payload.json";
  writeFileSync(payloadPath, JSON.stringify(payload, null, 2));
  const apiResult = ghApi(`repos/${repo}/pulls/${pr}/reviews`, "POST", payloadPath);
  const parsed = JSON.parse(apiResult);
  process.stderr.write(`[review-cli] Approved: review ID ${parsed.id}\n`);
  process.stdout.write(JSON.stringify({ approved: true, reviewId: parsed.id }, null, 2) + "\n");
}

// ── Subcommand: status ──────────────────────────────────

function cmdStatus(repo: string, pr: number): void {
  const [owner, name] = repo.split("/");
  const query = `
    query($owner: String!, $name: String!, $pr: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $pr) {
          reviews(last: 1) {
            nodes {
              state
              author { login }
              submittedAt
            }
          }
          reviewThreads(first: 100) {
            nodes {
              isResolved
            }
          }
        }
      }
    }
  `;

  const result = ghGraphQL(query, { owner, name, pr }) as {
    data: {
      repository: {
        pullRequest: {
          reviews: {
            nodes: Array<{
              state: string;
              author: { login: string };
              submittedAt: string;
            }>;
          };
          reviewThreads: {
            nodes: Array<{ isResolved: boolean }>;
          };
        };
      };
    };
  };

  const prData = result.data.repository.pullRequest;
  const latestReview = prData.reviews.nodes[0] ?? null;
  const threads = prData.reviewThreads.nodes;
  const unresolvedCount = threads.filter((t) => !t.isResolved).length;

  const output = {
    latestReview: latestReview
      ? {
          state: latestReview.state,
          user: latestReview.author.login,
          date: latestReview.submittedAt,
        }
      : null,
    unresolvedThreads: unresolvedCount,
    totalThreads: threads.length,
  };

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

// ── Subcommand: list ────────────────────────────────────

function cmdList(repo: string, pr: number): void {
  const output = ghApi(`repos/${repo}/pulls/${pr}/reviews`, "GET");
  const reviews = JSON.parse(output) as Array<{
    id: number;
    state: string;
    user: { login: string };
    submitted_at: string;
  }>;

  const formatted = reviews.map((r) => ({
    id: r.id,
    state: r.state,
    user: r.user.login,
    submittedAt: r.submitted_at,
  }));

  process.stdout.write(JSON.stringify(formatted, null, 2) + "\n");
}

// ── Subcommand: resolve ─────────────────────────────────

function cmdResolve(repo: string, _pr: number, rest: string[]): void {
  const opts = parseRestArgs(rest);
  const threadId = opts["thread-id"] as string;

  if (!threadId) {
    process.stderr.write("[review-cli] resolve requires --thread-id <nodeId>\n");
    process.exit(1);
  }

  const query = `
    mutation($threadId: ID!) {
      resolveReviewThread(input: { threadId: $threadId }) {
        thread {
          id
          isResolved
        }
      }
    }
  `;

  const result = ghGraphQL(query, { threadId }) as {
    data: {
      resolveReviewThread: {
        thread: { id: string; isResolved: boolean };
      };
    };
  };

  const thread = result.data.resolveReviewThread.thread;
  process.stderr.write(`[review-cli] Thread ${thread.id} resolved: ${thread.isResolved}\n`);
  process.stdout.write(JSON.stringify({ threadId: thread.id, resolved: thread.isResolved }, null, 2) + "\n");
}

// ── Main Dispatcher ─────────────────────────────────────

function main(): void {
  const { subcommand, repo, pr, rest } = parseGlobalArgs();

  switch (subcommand) {
    case "post":
      cmdPost(repo, pr, rest);
      break;
    case "approve":
      cmdApprove(repo, pr, rest);
      break;
    case "status":
      cmdStatus(repo, pr);
      break;
    case "list":
      cmdList(repo, pr);
      break;
    case "resolve":
      cmdResolve(repo, pr, rest);
      break;
    default:
      process.stderr.write(`[review-cli] Unknown subcommand: ${subcommand}\n`);
      printUsage();
      process.exit(1);
  }
}

main();
