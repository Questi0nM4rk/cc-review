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
  let origFetch: typeof globalThis.fetch;
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
