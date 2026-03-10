#!/usr/bin/env tsx
/**
 * Parses a unified diff and outputs all commentable lines as JSON.
 *
 * Usage:
 *   tsx diff-lines.ts /tmp/pr-diff.txt                    # all files
 *   tsx diff-lines.ts /tmp/pr-diff.txt src/steps/check.ts # single file
 *
 * Output: JSON array of { file, line, side, type, content }
 *   - file:    relative path (e.g. "src/steps/check.ts")
 *   - line:    file line number (use this in the comments array)
 *   - side:    "RIGHT" or "LEFT"
 *   - type:    "added" | "removed" | "context"
 *   - content: the actual line text (trimmed of diff prefix)
 *
 * Pipe to jq for filtering:
 *   tsx diff-lines.ts /tmp/pr-diff.txt | jq '.[] | select(.file=="src/foo.ts")'
 *   tsx diff-lines.ts /tmp/pr-diff.txt | jq '[.[] | select(.type=="added")]'
 */

import { readFileSync } from "fs";

interface CommentableLine {
  file: string;
  line: number;
  side: "RIGHT" | "LEFT";
  type: "added" | "removed" | "context";
  content: string;
}

function parseDiff(diffText: string, filterFile?: string): CommentableLine[] {
  const lines = diffText.split("\n");
  const results: CommentableLine[] = [];

  let currentFile = "";
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of lines) {
    // New file header: diff --git a/path b/path
    const fileMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (fileMatch) {
      currentFile = fileMatch[2];
      inHunk = false;
      continue;
    }

    // Skip if filtering to a specific file
    if (filterFile && currentFile !== filterFile) continue;

    // Hunk header: @@ -old,count +new,count @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1], 10);
      newLine = parseInt(hunkMatch[2], 10);
      inHunk = true;
      continue;
    }

    if (!inHunk || !currentFile) continue;

    // Stop hunk on next diff header or file header
    if (line.startsWith("diff --git") || line.startsWith("---") || line.startsWith("+++")) {
      if (line.startsWith("diff --git")) {
        const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
        if (m) currentFile = m[2];
        inHunk = false;
      }
      continue;
    }

    if (line.startsWith("+")) {
      results.push({
        file: currentFile,
        line: newLine,
        side: "RIGHT",
        type: "added",
        content: line.slice(1),
      });
      newLine++;
    } else if (line.startsWith("-")) {
      results.push({
        file: currentFile,
        line: oldLine,
        side: "LEFT",
        type: "removed",
        content: line.slice(1),
      });
      oldLine++;
    } else if (line.startsWith(" ") || line === "") {
      // Context line (or empty context)
      if (inHunk) {
        results.push({
          file: currentFile,
          line: newLine,
          side: "RIGHT",
          type: "context",
          content: line.startsWith(" ") ? line.slice(1) : line,
        });
        oldLine++;
        newLine++;
      }
    } else {
      // "\ No newline at end of file" or other non-diff content
      continue;
    }
  }

  return results;
}

// --- Main ---
const args = process.argv.slice(2);
if (args.length === 0) {
  process.stderr.write("Usage: tsx diff-lines.ts <diff-file> [file-path]\n");
  process.exit(1);
}

const diffPath = args[0];
const filterFile = args[1] || undefined;

let diffText: string;
try {
  diffText = readFileSync(diffPath, "utf8");
} catch {
  process.stderr.write(`Cannot read diff file: ${diffPath}\n`);
  process.exit(1);
}

const results = parseDiff(diffText, filterFile);
process.stdout.write(JSON.stringify(results, null, 2) + "\n");
