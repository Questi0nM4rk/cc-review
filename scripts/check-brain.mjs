// Syntax gate for the Workflow brain. `node --check` can't validate it raw: the
// orchestration uses top-level `return` (illegal outside a function) while line 1 is
// `export const meta` (illegal inside one). The Workflow runtime resolves this by
// wrapping the body in a function; we mirror that exact transform, then `node --check`.
// Catches a broken edit (e.g. the mangled globToRe that once shipped) at commit time.
//
// Run: node scripts/check-brain.mjs   (exit 0 = ok, 1 = syntax error)

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BRAIN = fileURLToPath(new URL("../.claude/workflows/strict-review.mjs", import.meta.url));
const src = readFileSync(BRAIN, "utf8");

// Strip the single module-level export so it's legal inside a function, then wrap.
const wrapped = `async function __wf(){\n${src.replace(/^export const meta/m, "const meta")}\n}`;
const file = join(mkdtempSync(join(tmpdir(), "ccr-check-")), "wrapped.mjs");
writeFileSync(file, wrapped, "utf8");

try {
  execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  console.log(`brain syntax OK (wrapped): ${BRAIN}`);
} catch (e) {
  console.error("brain syntax check FAILED:");
  console.error(e.stderr?.toString() || e.message);
  process.exit(1);
}
