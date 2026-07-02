# searxng web search — design/plan

> **Status:** Decided · **Scope:** Replace the review brain's built-in `WebSearch`
> with a self-hosted searxng meta-search, ported from
> `qsm-marketplace2/tools/qsm-searxng`. **Local-first** — cc-review runs as a
> pure Workflow in local Claude sessions; searxng resolves from disk config
> (default: public salonek instance), with a `WebSearch` fallback. No CI docker.

## Context

The Gather phase runs two parallel `sonnet` research agents (`research:ai-slop`,
`research:general`) told to "USE WebSearch/WebFetch" (`strict-review.mjs:262-269`,
invoked `:812-813`; only when difficulty ≥ 2 and not a small non-risky diff,
`:805`). Web research is validated to improve reviews, but built-in `WebSearch`
is unreliable under the Max **OAuth token** path cc-review uses ("No API
billing"). searxng is a self-hostable meta-search (Google/Bing/DDG/Brave/… in one
query) hit over plain HTTP with clean JSON out — no key, no billing.
`qsm-searxng` (a validated, tested Bun/TS client in the marketplace) is ported.

**Direction:** cc-review is moving to **local-first** — invoked as a pure
Workflow inside local Claude chats (the way Workflows are created and run), not
primarily as a GitHub CI Action. That deletes the only reason for a CI searxng
container: a local run executes on a machine that already has a searxng instance.

## Goals / non-goals

- **Goal:** research agents query searxng instead of `WebSearch`, resolving the
  instance from disk (config file / env), with a graceful `WebSearch` fallback
  when no instance is reachable (the bot must never break on searxng downtime).
- **Goal:** self-contained — ship a default config (salonek) so a fresh checkout
  works without depending on the user's global setup.
- **Non-goal:** CI service container / workflow YAML changes (YAGNI while
  local-first; the GitHub-CI path degrades to the `WebSearch` fallback).
- **Non-goal:** the full #73 config-globals refactor (separate follow-on).
- **Non-goal:** live GitLab / fresh-install verification of #74/#11/#21 this
  session (deferred).

## Key facts driving the design

- cc-review is **node 24 + tsx**: tools are `.ts` invoked via `tsx ${TOOL} …`
  (`strict-review.mjs:43-44`); CI uses node 24; tests run `node --test`.
  `qsm-searxng` is **bun** (`#!/usr/bin/env bun`, `bun:test`) → **adapt to
  node+tsx**, don't copy verbatim.
- `qsm-searxng` core (`lib/searxng.ts`, 285 lines) is pure `fetch` + node stdlib
  → runs on node 24 unchanged. Only the shebang and test runner are bun-specific.
- Instance resolution reads a **file on disk** (`~/.config/qsm-searxng/config.json`)
  or `QSM_SEARXNG_INSTANCE` env → available to the research **subagent** (a file,
  not an env var; cc-review's "subagents don't inherit env" gotcha,
  `strict-review.mjs:38-42`, does NOT block file reads). So local runs
  self-resolve — no `--instance` arg plumbing needed.

## Design

### 1. Port the tool → `scripts/web-search.ts` (node+tsx)

- Vendor the pure core from `qsm-marketplace2/tools/qsm-searxng/lib/searxng.ts`:
  `buildSearchUrl`, `fetchResults`, `resolveInstance`, config load, JSON/text/csv
  formatters, and the stdout=JSON-only invariant (warnings → stderr).
- Expose as `scripts/web-search.ts` with a `tsx` CLI main (mirrors
  `analysis-tools.ts` / `review-platform.ts`): `tsx scripts/web-search.ts "<q>"
  -n 15 [--engines …] [--time-range …] [--instance <url>] 2>/dev/null` → JSON
  array `[{url,title,content,engine,score,…}]`.
- Add config resolution order: `--instance` > `QSM_SEARXNG_INSTANCE` >
  `~/.config/qsm-searxng/config.json` > **vendored `searxng.config.json`
  (salonek default)** in the cc-review repo.
- **Drop** the marketplace packaging: `.claude-plugin/`, `.codex-plugin/`,
  `marketplace.json`, `install.ts`, `config.example.ini`.
- **TDD:** port `searxng.test.ts` (mocked `fetch`, stdout-purity invariant) to
  run under `tsx --test scripts/web-search.test.ts`; add to `npm test`. Tests
  first.

### 2. Vendor default config

- `searxng.config.json` at the repo root (or `scripts/`): `{ "instance":
  "https://searx.salonek.org", "default_engines": [...], "default_num_results":
  10, "timeout_ms": 10000 }` — the self-contained default, overridable by
  env/global config.

### 3. Wire into the brain (`strict-review.mjs`)

- Rewrite `webResearchPrompt()` (`:262-269`): instruct the agent to run
  `tsx ${BOT}/scripts/web-search.ts "<q>" -n 15` for search, then `WebFetch`/read
  the promising URLs — **unchanged** `RESEARCH_SCHEMA`, so squad routing is
  untouched.
- **Fallback:** if the tool errors or returns empty (no instance / instance
  down), the prompt tells the agent to fall back to built-in `WebSearch`.
- Update `SPEC.md` web-gatherers section (searxng + fallback + local-first note).

### Config flow

`local run → tool reads --instance | QSM_SEARXNG_INSTANCE | ~/.config | vendored
salonek` → JSON results → observations. No args plumbing, no CI wiring.

## Follow-on (secondary, separate branches — not this branch)

- **#73** — detect platform+mode once → single config object via args; fold in
  `memDir`; relocate local memory to `~/.claude/cc-review-memory/<repo>/`. Close
  on completion.
- **#21** — re-read `setup.ts` + `install-to-repo.sh` vs current SPEC; fix if
  stale. Close on completion (code side; throwaway-repo e2e deferred).
- **#74 / #11** — code already merged (`1e9a5bd`). Annotate "code-done,
  live-verify-pending"; add `docs/gitlab-verify-checklist.md`. Leave open.
- **#24** — update tracking; closes when #11/#21 fully close.

## Phasing & PR strategy

- **This branch — `feat/searxng-websearch`:** Phases 1-3 above → PR to main →
  cc-review's own bot reviews it → merge.
- **Then:** #73, #21, closure as follow-on branches.

## Verification

- **Unit:** `npm test` green incl. new `web-search` tests;
  `node scripts/check-brain.mjs` passes (brain still parses).
- **Local smoke:** `tsx scripts/web-search.ts "structured concurrency" -n 5 |
  jq '.[0]'` returns a real result against salonek.
- **Workflow smoke:** run the review Workflow locally on a sample diff; confirm
  the research agents invoke `web-search.ts` and (with the instance unset) fall
  back to `WebSearch`.

## Risks / open questions

- **salonek public-instance flakiness** (rate limits / downtime / bot-blocks /
  JSON disabled) → the `WebSearch` fallback covers outages; self-host later if
  needed.
- **GitHub-CI reviews** (if still run) silently use the `WebSearch` fallback (no
  instance on the runner) — acceptable while local-first; revisit with a
  container if the bot path becomes primary again.

---

# searxng Web Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the review brain's built-in `WebSearch` with a self-hosted searxng meta-search (ported from `qsm-marketplace2/tools/qsm-searxng`), with a `WebSearch` fallback, running local-first.

**Architecture:** Vendor the pure `searxng.ts` core (node-compatible as-is) into cc-review as a `tsx`-invoked tool `scripts/web-search.ts` + `scripts/web-search-lib.ts`, mirroring the `analysis-tools.ts` / `review-platform.ts` tool convention. Rewrite `webResearchPrompt()` in the brain to drive the tool, falling back to `WebSearch` when no instance is reachable. Default instance (salonek) baked into `DEFAULT_CONFIG`, overridable via `--instance` / `QSM_SEARXNG_INSTANCE` / `~/.config/qsm-searxng/config.json`.

**Tech Stack:** node 24, tsx, `node:test`. No new npm deps (pure `fetch` + node stdlib).

## Global Constraints

- Runtime is **node 24 + tsx**. Tools are `.ts` invoked via `tsx ${TOOL} …`; shebang `#!/usr/bin/env npx tsx`. Match `scripts/analysis-tools.ts:1`.
- Tests run via the `test` npm script. New tests use `node:test` + `node:assert/strict` (NOT `bun:test`) and run under `tsx --test`.
- The brain (`.claude/workflows/strict-review.mjs`) uses top-level `return` → validate with `node scripts/check-brain.mjs`, NEVER raw `node --check`.
- `RESEARCH_SCHEMA` output of the research agents MUST stay identical (squad routing depends on `{observations:[{pattern,location,note,suggested_domain,source_url}]}`).
- The bot must NEVER break on searxng downtime — the fallback to `WebSearch` is mandatory in the prompt.
- Local-first: NO changes to `.github/workflows/*.yml`, no docker, no service container.
- Conventional commits; commit after each green task.

## File Structure

- `scripts/web-search-lib.ts` (new) — vendored pure core: config, URL build, fetch, formatters. One responsibility: talk to searxng, return typed results.
- `scripts/web-search.ts` (new) — the `tsx` CLI entry: arg parse → `fetchResults` → stdout JSON. Mirrors the `qsm-searxng` CLI, adapted to cc-review's shebang/imports.
- `scripts/web-search.test.ts` (new) — `node:test` port of the lib smoke tests (URL build, fetch incl. stdout-purity invariant, formatters, config resolution).
- `.claude/workflows/strict-review.mjs` (modify) — add `WEBSEARCH` path const near `:43-44`; rewrite `webResearchPrompt()` at `:266-269`.
- `package.json` (modify) — append the web-search test to the `test` script.
- `SPEC.md` (modify) — web-gatherers section: searxng + fallback + local-first.
- `docs/searxng-websearch-plan.md` (new) — this plan + the design doc, committed with the code.

---

### Task 1: Vendor the searxng core lib

**Files:**
- Create: `scripts/web-search-lib.ts`
- Source (copy from): `qsm-marketplace2/tools/qsm-searxng/lib/searxng.ts`

**Interfaces:**
- Produces: `SearchResult`, `SearxngConfig`, `SearchOptions`, `FormatType` (types); `DEFAULT_CONFIG`, `configPath()`, `loadConfig(): SearxngConfig`, `resolveInstance(config, override?): string`, `buildSearchUrl(instance, opts): string`, `fetchResults(instance, opts): Promise<{results,warnings}>`, `formatJson/formatText/formatCsv/formatOutput`, `runConfigSetup()`.

- [ ] **Step 1: Copy the core verbatim**

Copy `qsm-marketplace2/tools/qsm-searxng/lib/searxng.ts` → `cc-review/scripts/web-search-lib.ts`, byte-for-byte. It imports only `node:fs`, `node:os`, `node:path`, `node:readline` and uses global `fetch`/`AbortController`/`URLSearchParams` — all available in node 24, so **no code changes are needed to run it under tsx.**

- [ ] **Step 2: Bake the salonek default instance (the vendored config)**

In `scripts/web-search-lib.ts`, change `DEFAULT_CONFIG.instance` from `""` to the salonek default so a fresh checkout works with no config file. Override order stays `--instance` > `QSM_SEARXNG_INSTANCE` > `~/.config/qsm-searxng/config.json` > this default.

```ts
export const DEFAULT_CONFIG: SearxngConfig = {
  // Vendored default so cc-review is self-contained. Overridable via --instance,
  // QSM_SEARXNG_INSTANCE, or ~/.config/qsm-searxng/config.json.
  instance: "https://searx.salonek.org",
  default_engines: ["google", "duckduckgo", "bing"],
  default_num_results: 10,
  timeout_ms: 10000,
};
```

- [ ] **Step 3: Verify it type-checks / imports under tsx**

Run: `cd cc-review && tsx -e "import('./scripts/web-search-lib.ts').then(m => console.log(Object.keys(m).join(',')))"`
Expected: prints the export names (`SearchResult` types are erased; functions like `buildSearchUrl,fetchResults,loadConfig,resolveInstance,formatOutput,...` print). No import/syntax error.

- [ ] **Step 4: Commit**

```bash
git add scripts/web-search-lib.ts
git commit -m "feat(web-search): vendor searxng core lib (node+tsx, salonek default)"
```

---

### Task 2: Port the lib tests to node:test

**Files:**
- Create: `scripts/web-search.test.ts`
- Source (adapt from): `qsm-marketplace2/tools/qsm-searxng/lib/searxng.test.ts`

**Interfaces:**
- Consumes: everything exported from `./web-search-lib.ts` (Task 1).

- [ ] **Step 1: Write the ported test file (node:test, not bun:test)**

The port swaps `bun:test`'s `expect`/`mock`/`spyOn` for `node:test` + `node:assert/strict`. `globalThis.fetch` mocking stays a plain assignment; `spyOn(process.stdout,"write")` becomes `mock.method`. Write `scripts/web-search.test.ts`:

```ts
/**
 * web-search.test.ts — smoke tests for the vendored searxng lib.
 * Critical invariant: stdout = JSON-only. Engine warnings -> warnings[], never stdout.
 * Run: tsx --test scripts/web-search.test.ts
 */
import { describe, test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSearchUrl, DEFAULT_CONFIG, fetchResults, formatCsv, formatJson,
  formatText, loadConfig, resolveInstance,
} from "./web-search-lib.ts";

function makeOpts(o = {}) {
  return { query: "test query", numResults: 10, engines: [], format: "json", ...o };
}
function makeResult(o = {}) {
  return {
    url: "https://example.com/page", title: "Example title", content: "Snippet text...",
    engine: "google", engines: ["google", "bing"], score: 4.5, category: "general",
    publishedDate: null, ...o,
  };
}
function makeSearxngBody(results = [makeResult()], unresponsive = []) {
  return JSON.stringify({ query: "test query", results, number_of_results: results.length, unresponsive_engines: unresponsive });
}
function mockFetch(body, status = 200) {
  return (async () => ({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(body), text: async () => body }));
}
function withEnv(key, val, fn) {
  const orig = process.env[key];
  if (val === undefined) delete process.env[key]; else process.env[key] = val;
  try { fn(); } finally { if (orig !== undefined) process.env[key] = orig; else delete process.env[key]; }
}

describe("buildSearchUrl", () => {
  test("basic query produces correct URL", () => {
    const url = buildSearchUrl("https://searxng.example.com", makeOpts({ query: "anthropic claude" }));
    assert.ok(url.includes("/search?"));
    assert.ok(url.includes("q=anthropic+claude"));
    assert.ok(url.includes("format=json"));
  });
  test("engines flag included when specified", () => {
    assert.ok(buildSearchUrl("https://x.com", makeOpts({ engines: ["google", "bing"] })).includes("engines=google%2Cbing"));
  });
  test("time_range included when specified", () => {
    assert.ok(buildSearchUrl("https://x.com", makeOpts({ timeRange: "week" })).includes("time_range=week"));
  });
  test("category included when specified", () => {
    assert.ok(buildSearchUrl("https://x.com", makeOpts({ category: "news" })).includes("categories=news"));
  });
  test("trailing slash on instance is stripped", () => {
    const url = buildSearchUrl("https://x.com/", makeOpts());
    assert.ok(!url.includes("//search"));
    assert.ok(url.includes("/search?"));
  });
});

describe("fetchResults", () => {
  let origFetch;
  beforeEach(() => { origFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = origFetch; });

  test("returns parsed results", async () => {
    globalThis.fetch = mockFetch(makeSearxngBody());
    const { results, warnings } = await fetchResults("https://x.com", makeOpts());
    assert.equal(results.length, 1);
    assert.equal(results[0].url, "https://example.com/page");
    assert.equal(warnings.length, 0);
  });
  test("default num_results caps at 10", async () => {
    const raw = Array.from({ length: 20 }, (_, i) => makeResult({ url: `https://example.com/${i}` }));
    globalThis.fetch = mockFetch(makeSearxngBody(raw));
    const { results } = await fetchResults("https://x.com", makeOpts({ numResults: 10 }));
    assert.equal(results.length, 10);
  });
  test("engine warnings go to warnings[] NOT stdout — CRITICAL", async () => {
    const spy = mock.method(process.stdout, "write", () => true);
    globalThis.fetch = mockFetch(makeSearxngBody([makeResult()], [["google", "suspended"]]));
    const { warnings } = await fetchResults("https://x.com", makeOpts());
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes("google"));
    assert.equal(spy.mock.callCount(), 0);
    spy.mock.restore();
  });
  test("empty results returns empty array", async () => {
    globalThis.fetch = mockFetch(makeSearxngBody([]));
    const { results } = await fetchResults("https://x.com", makeOpts());
    assert.equal(results.length, 0);
  });
  test("network failure throws exitCode 3", async () => {
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); });
    await assert.rejects(fetchResults("https://x.com", makeOpts()), (e) => e.exitCode === 3 && /failed to reach/.test(e.message));
  });
  test("non-2xx throws exitCode 4", async () => {
    globalThis.fetch = mockFetch("Not Found", 404);
    await assert.rejects(fetchResults("https://x.com", makeOpts()), (e) => e.exitCode === 4 && /HTTP 404/.test(e.message));
  });
  test("invalid JSON throws exitCode 5", async () => {
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad"); } }));
    await assert.rejects(fetchResults("https://x.com", makeOpts()), (e) => e.exitCode === 5 && /invalid JSON/.test(e.message));
  });
});

describe("formatters", () => {
  test("formatJson is parseable + no leading garbage", () => {
    const out = formatJson([makeResult()]);
    assert.ok(out.trimStart().startsWith("["));
    assert.equal(JSON.parse(out)[0].url, "https://example.com/page");
  });
  test("formatJson empty -> []", () => { assert.deepEqual(JSON.parse(formatJson([])), []); });
  test("formatText is non-JSON human text", () => {
    const out = formatText([makeResult()]);
    assert.throws(() => JSON.parse(out));
    assert.ok(out.includes("Example title"));
  });
  test("formatCsv quotes commas + escapes quotes", () => {
    assert.ok(formatCsv([makeResult({ title: "Title, with comma" })]).includes('"Title, with comma"'));
    assert.ok(formatCsv([makeResult({ title: 'He said "hello"' })]).includes('""hello""'));
  });
  test("formatCsv empty -> header only", () => {
    const lines = formatCsv([]).trim().split("\n");
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes("url"));
  });
});

describe("config resolution", () => {
  const cfg = { ...DEFAULT_CONFIG, instance: "https://config.example.com" };
  test("env beats config", () => {
    withEnv("QSM_SEARXNG_INSTANCE", "https://env.example.com", () => assert.equal(resolveInstance(cfg), "https://env.example.com"));
  });
  test("override beats env", () => {
    withEnv("QSM_SEARXNG_INSTANCE", "https://env.example.com", () => assert.equal(resolveInstance(cfg, "https://arg.example.com"), "https://arg.example.com"));
  });
  test("falls back to config.instance", () => {
    withEnv("QSM_SEARXNG_INSTANCE", undefined, () => assert.equal(resolveInstance(cfg), "https://config.example.com"));
  });
  test("loadConfig reads a temp file", () => {
    const dir = mkdtempSync(join(tmpdir(), "web-search-test-"));
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ instance: "https://test.local", default_num_results: 5 }));
    withEnv("QSM_SEARXNG_CONFIG", p, () => {
      const c = loadConfig();
      assert.equal(c.instance, "https://test.local");
      assert.equal(c.default_num_results, 5);
    });
  });
  test("loadConfig defaults when file missing (salonek default)", () => {
    withEnv("QSM_SEARXNG_CONFIG", "/tmp/no-such-web-search-cfg-99999.json", () => {
      assert.equal(loadConfig().timeout_ms, DEFAULT_CONFIG.timeout_ms);
      assert.equal(loadConfig().instance, "https://searx.salonek.org");
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `cd cc-review && tsx --test scripts/web-search.test.ts`
Expected: all tests pass (0 fail). If `tsx --test` is unavailable, fall back to `node --test scripts/web-search.test.ts` (node 24 strips TS types natively).

- [ ] **Step 3: Commit**

```bash
git add scripts/web-search.test.ts
git commit -m "test(web-search): port searxng lib tests to node:test"
```

---

### Task 3: Port the CLI entry

**Files:**
- Create: `scripts/web-search.ts`
- Source (adapt from): `qsm-marketplace2/tools/qsm-searxng/scripts/qsm-searxng`

**Interfaces:**
- Consumes: `./web-search-lib.ts` (Task 1).
- Produces: a CLI runnable as `tsx scripts/web-search.ts "<query>" [-n N] [--engines a,b] [--time-range week] [--instance URL] [--format json|text|csv]` → JSON array on stdout, warnings on stderr.

- [ ] **Step 1: Copy the CLI verbatim, then adapt shebang + import**

Copy `qsm-marketplace2/tools/qsm-searxng/scripts/qsm-searxng` → `cc-review/scripts/web-search.ts`. Two changes only (the body is pure node-compatible — `process.argv/stdout/stderr/exit`):

1. Shebang line 1: `#!/usr/bin/env bun` → `#!/usr/bin/env npx tsx` (match `analysis-tools.ts:1`).
2. Import path: `from "../lib/searxng.ts"` → `from "./web-search-lib.ts"`.

- [ ] **Step 2: Smoke-test the CLI help path (no network)**

Run: `cd cc-review && tsx scripts/web-search.ts --version`
Expected: prints `1.0.0` to stdout, exit 0.

Run: `cd cc-review && tsx scripts/web-search.ts 2>&1 1>/dev/null | head -1`
Expected: stderr message `qsm-searxng: query required. Use --help for usage.` (exit 1). (The stderr program name can stay `qsm-searxng` — it's cosmetic; leave it or rename to `web-search` in a follow-up.)

- [ ] **Step 3: Live smoke against salonek (network — may be flaky; informational)**

Run: `cd cc-review && tsx scripts/web-search.ts "structured concurrency" -n 3 2>/dev/null | head -c 200`
Expected: a JSON array starting with `[` and containing a `"url"`. If salonek is down/rate-limited this may be empty — that is the exact case the brain's `WebSearch` fallback covers; do not block the task on it.

- [ ] **Step 4: Commit**

```bash
git add scripts/web-search.ts
git commit -m "feat(web-search): tsx CLI entry (adapted from qsm-searxng)"
```

---

### Task 4: Wire the tool into the brain

**Files:**
- Modify: `.claude/workflows/strict-review.mjs` (add const near `:43-44`; rewrite `webResearchPrompt` at `:266-269`)

**Interfaces:**
- Consumes: `scripts/web-search.ts` (Task 3), reached via `${BOT}/scripts/web-search.ts`.
- Produces: unchanged `RESEARCH_SCHEMA` observations (no downstream change).

- [ ] **Step 1: Add the WEBSEARCH path constant**

After the `TOOLS` const (`.claude/workflows/strict-review.mjs:44`), add:

```js
const WEBSEARCH = `${BOT}/scripts/web-search.ts`;
```

- [ ] **Step 2: Rewrite `webResearchPrompt` to drive the tool with a WebSearch fallback**

Replace the function at `:266-269` with:

```js
const webResearchPrompt = (kind, diff, category) => {
  const k = WEB_KINDS[kind];
  return `${STRICT}\n\nYou are a WEB-BACKED research agent for ${k.focus}. Check the diff's libraries/APIs/frameworks against current docs, best-practices, known issues and advisories, then report OBSERVATIONS (leads for the reviewers), NOT findings.\n` +
    `SEARCH with the meta-search tool (self-hosted searxng, clean JSON on stdout) from the repo root:\n  tsx ${WEBSEARCH} "<query>" -n 15 2>/dev/null\n` +
    `Run it for each concrete lead (library+version, API, advisory). Parse the JSON array [{url,title,content,...}] and WebFetch the most promising URLs to confirm. If the tool errors OR returns an empty array (no instance reachable), FALL BACK to the WebSearch/WebFetch tools for that query — never skip the research.\n` +
    `Scan for: ${k.scan}\n\nCategory: ${category}\n\nEach observation: pattern, location {file,line}, note (imperative), suggested_domain (security|architecture|testing|performance|data-access|api), and source_url when a web source backs it. Empty array if none. source='${kind}'.\n\nDIFF:\n${untrustedBlock("PR diff", diff)}`;
};
```

- [ ] **Step 3: Validate the brain still parses**

Run: `cd cc-review && node scripts/check-brain.mjs`
Expected: PASS (exit 0). (Raw `node --check` will falsely fail — the brain uses top-level `return`.)

- [ ] **Step 4: Run the full helper suite (no regression)**

Run: `cd cc-review && node --test scripts/helpers.test.mjs`
Expected: all pass (`webResearchPrompt` is not in the extracted-helpers export list, so this confirms no collateral damage).

- [ ] **Step 5: Commit**

```bash
git add .claude/workflows/strict-review.mjs
git commit -m "feat(review): drive web research via searxng tool, WebSearch fallback"
```

---

### Task 5: Wire tests into `npm test`, update SPEC + docs

**Files:**
- Modify: `package.json` (the `test` script)
- Modify: `SPEC.md` (web-gatherers section)
- Create: `docs/searxng-websearch-plan.md` (this plan + design doc)

- [ ] **Step 1: Append the web-search test to the test script**

In `package.json`, change the `test` script to append `&& tsx --test scripts/web-search.test.ts`:

```json
"test": "node scripts/check-brain.mjs && node --test scripts/helpers.test.mjs && node scripts/verify-gate.test.mjs && tsx --test scripts/web-search.test.ts"
```

- [ ] **Step 2: Run the full test script**

Run: `cd cc-review && npm test`
Expected: brain check passes, all helper/gate/web-search tests pass, exit 0.

- [ ] **Step 3: Update SPEC.md web-gatherers**

Find the web-gatherers / gather-phase description in `SPEC.md` (references `WebSearch`/`WebFetch`). Add one paragraph: the two research agents now search via `scripts/web-search.ts` (a vendored searxng client, default instance salonek, overridable via `--instance`/`QSM_SEARXNG_INSTANCE`/`~/.config/qsm-searxng/config.json`), falling back to built-in `WebSearch` when no instance is reachable. Note it is local-first — no CI searxng service (the CI path uses the fallback).

- [ ] **Step 4: Add the plan + design doc**

Copy the design doc and this plan into `docs/searxng-websearch-plan.md` (single file; design first, plan second).

- [ ] **Step 5: Commit**

```bash
git add package.json SPEC.md docs/searxng-websearch-plan.md
git commit -m "test(web-search): wire into npm test; docs: searxng plan + SPEC update"
```

---

## Verification (end-to-end)

- `cd cc-review && npm test` → green (incl. new web-search tests + brain parse gate).
- `tsx scripts/web-search.ts "bun test runner" -n 3 2>/dev/null | jq '.[0].url'` → a real URL (salonek up) OR empty (fallback territory — acceptable).
- Local review smoke: `scripts/run-local.sh --diff <some-diff-file>` → the run reaches the Gather phase and the `research:*` agents invoke `tsx …/web-search.ts` (visible in the agent transcript); with `QSM_SEARXNG_INSTANCE=` unset AND salonek blocked, they fall back to `WebSearch` and still produce observations.

## Self-review notes

- Spec coverage: port (T1) + tests (T2) + CLI (T3) + brain wiring w/ fallback (T4) + npm test + SPEC + docs (T5). CI service container is intentionally out of scope (local-first decision). ✓
- Type consistency: lib exports consumed by test (T2) + CLI (T3) match `web-search-lib.ts` signatures. ✓
- No placeholders: bulk port is "copy verbatim + named changes"; all new/changed code (salonek default, ported tests, brain edit) shown in full. ✓
