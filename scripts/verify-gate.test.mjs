// Contract spec for the fetch identity-gate in .claude/workflows/strict-review.mjs.
//
// That workflow can't be imported (it's a Workflow script: injected globals like
// `agent`/`phase` + top-level `await` execute on import and crash). So this file
// mirrors the gate predicate VERBATIM and pins the scenarios that define the
// contract — above all the failure that motivated it: a fetch that resolves no
// real PR must ABORT, never review a fallback diff and report ok:true.
//
// Keep this predicate byte-identical to strict-review.mjs. The scenarios ARE the
// spec; if the gate changes, change them here too.   Run: node scripts/verify-gate.test.mjs

function resolveContext(fetched, a) {
  const isPlaceholderRepo = (r) => !r || /^(unknown|n\/?a|none)$/i.test(String(r).trim());
  const diff = fetched?.diff || a.diff || "";
  const repo = isPlaceholderRepo(fetched?.repo) ? "" : String(fetched.repo).trim();
  const prNumber = Number(fetched?.pr_number) > 0 ? Number(fetched.pr_number) : 0;
  const post = a.post === true || fetched?.post === true;
  const expectedPr = Number(a.prNumber) > 0 ? Number(a.prNumber) : 0;
  const targeted = expectedPr > 0 || post;

  if (!diff.trim()) return { ok: false, reason: "empty diff" };
  if (targeted && (prNumber <= 0 || !repo)) return { ok: false, reason: "unresolved target" };
  if (expectedPr > 0 && prNumber !== expectedPr) return { ok: false, reason: "wrong PR" };
  return { ok: true, repo, prNumber, localDryRun: !targeted };
}

const cases = [
  {
    name: "last-session repro: targeted PR, fetch returns 'unknown'/0 over a non-empty fallback diff -> ABORT",
    fetched: { repo: "unknown", pr_number: 0, diff: "diff --git a/x b/x\n+stray local change\n" },
    args: { prNumber: 4, repo: "Questi0nM4rk/feats", post: false },
    expect: { ok: false, reason: "unresolved target" },
  },
  {
    name: "CI success: fetch resolved a real PR, post=true -> PASS, not a dry-run",
    fetched: { repo: "o/r", pr_number: 4, diff: "diff\n+x\n", post: true },
    args: {},
    expect: { ok: true, repo: "o/r", prNumber: 4, localDryRun: false },
  },
  {
    name: "local dry-run: no PR, post=false -> PASS, localDryRun=true",
    fetched: { repo: "o/r", pr_number: 0, diff: "diff\n+x\n" },
    args: {},
    expect: { ok: true, repo: "o/r", prNumber: 0, localDryRun: true },
  },
  {
    name: "wrong PR: fetch resolved #7 but #4 was requested -> ABORT",
    fetched: { repo: "o/r", pr_number: 7, diff: "diff\n+x\n" },
    args: { prNumber: 4 },
    expect: { ok: false, reason: "wrong PR" },
  },
  {
    name: "targeted success: both signals (expectedPr>0 AND post=true), resolved PR matches -> PASS, not a dry-run",
    fetched: { repo: "o/r", pr_number: 4, diff: "diff\n+x\n", post: true },
    args: { prNumber: 4 },
    expect: { ok: true, repo: "o/r", prNumber: 4, localDryRun: false },
  },
  {
    name: "empty diff: nothing to review -> ABORT",
    fetched: { repo: "o/r", pr_number: 4, diff: "   \n", post: true },
    args: {},
    expect: { ok: false, reason: "empty diff" },
  },
  {
    name: "placeholder repo variant 'N/A' with post=true -> normalized to empty -> ABORT",
    fetched: { repo: "N/A", pr_number: 4, diff: "diff\n+x\n", post: true },
    args: {},
    expect: { ok: false, reason: "unresolved target" },
  },
];

let failed = 0;
for (const c of cases) {
  const got = resolveContext(c.fetched, c.args);
  const ok = Object.entries(c.expect).every(([k, v]) => got[k] === v);
  if (!ok) {
    failed++;
    console.error(`FAIL  ${c.name}`);
    console.error(`      expected ${JSON.stringify(c.expect)}`);
    console.error(`      got      ${JSON.stringify(got)}`);
  } else {
    console.log(`ok    ${c.name}`);
  }
}

console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
