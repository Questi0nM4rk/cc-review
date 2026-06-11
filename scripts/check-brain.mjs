// Syntax gate for every Workflow script in .claude/workflows/. `node --check` can't validate them
// raw: the orchestration uses top-level `return` (illegal outside a function) while line 1 is
// `export const meta` (illegal inside one). The Workflow runtime resolves this by wrapping the body
// in a function; we mirror that exact transform, then `node --check`. Catches a broken edit (e.g. the
// mangled globToRe that once shipped) at commit time.
//
// Run: node scripts/check-brain.mjs   (exit 0 = all ok, 1 = a syntax error)

import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const WF_DIR = fileURLToPath(new URL("../.claude/workflows/", import.meta.url));
const scripts = readdirSync(WF_DIR).filter((f) => f.endsWith(".mjs")).sort();
if (!scripts.length) { console.error(`no workflow scripts found in ${WF_DIR}`); process.exit(1); }

const tmp = mkdtempSync(join(tmpdir(), "ccr-check-"));
let failed = 0;
for (const name of scripts) {
  const path = join(WF_DIR, name);
  const src = readFileSync(path, "utf8");
  // Strip the single module-level export so it's legal inside a function, then wrap.
  const wrapped = `async function __wf(){\n${src.replace(/^export const meta/m, "const meta")}\n}`;
  const file = join(tmp, `${name}.wrapped.mjs`);
  writeFileSync(file, wrapped, "utf8");
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    console.log(`workflow syntax OK (wrapped): ${name}`);
  } catch (e) {
    console.error(`workflow syntax check FAILED: ${name}`);
    console.error(e.stderr?.toString() || e.message);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
