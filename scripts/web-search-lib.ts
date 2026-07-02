/**
 * searxng.ts — core logic for qsm-searxng CLI.
 *
 * Exported for testing. All warnings → stderr. stdout is JSON-only.
 *
 * Exit codes (used by the CLI entry point):
 *   0  success (even if results are empty)
 *   1  CLI parse error
 *   2  missing instance URL (no config, no env)
 *   3  network failure
 *   4  non-2xx HTTP response
 *   5  invalid JSON from instance
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchResult {
  url: string;
  title: string;
  content: string;
  engine: string;
  engines: string[];
  score: number;
  category: string;
  publishedDate: string | null;
}

export interface SearxngConfig {
  instance: string;
  default_engines: string[];
  default_num_results: number;
  timeout_ms: number;
}

export interface SearchOptions {
  query: string;
  numResults: number;
  engines: string[];
  timeRange?: string;
  category?: string;
  instance?: string;
  format: "json" | "text" | "csv";
}

export type FormatType = "json" | "text" | "csv";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: SearxngConfig = {
  // Vendored default so cc-review is self-contained. Overridable via --instance,
  // QSM_SEARXNG_INSTANCE, or ~/.config/qsm-searxng/config.json.
  instance: "https://searx.salonek.org",
  default_engines: ["google", "duckduckgo", "bing"],
  default_num_results: 10,
  timeout_ms: 10000,
};

export function configPath(): string {
  const envPath = process.env.QSM_SEARXNG_CONFIG;
  if (envPath) return envPath;
  return join(homedir(), ".config", "qsm-searxng", "config.json");
}

export function loadConfig(): SearxngConfig {
  const path = configPath();
  if (!existsSync(path)) {
    process.stderr.write(`qsm-searxng: config not found at ${path} — falling back to env vars\n`);
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = readFileSync(path, "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) } as SearxngConfig;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`qsm-searxng: failed to parse config: ${msg}\n`);
    return { ...DEFAULT_CONFIG };
  }
}

export function resolveInstance(config: SearxngConfig, override?: string): string {
  if (override) return override;
  if (process.env.QSM_SEARXNG_INSTANCE) return process.env.QSM_SEARXNG_INSTANCE;
  return config.instance;
}

export function writeConfig(cfg: SearxngConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

export function buildSearchUrl(instance: string, opts: SearchOptions): string {
  const params = new URLSearchParams();
  params.set("q", opts.query);
  params.set("format", "json");
  if (opts.engines.length > 0) params.set("engines", opts.engines.join(","));
  if (opts.timeRange) params.set("time_range", opts.timeRange);
  if (opts.category) params.set("categories", opts.category);
  params.set("pageno", "1");
  return `${instance.replace(/\/$/, "")}/search?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export interface FetchSearchResult {
  results: SearchResult[];
  warnings: string[];
}

// SearXNG raw result shape
interface RawResult {
  url?: string;
  title?: string;
  content?: string;
  engine?: string;
  engines?: string[];
  score?: number;
  category?: string;
  publishedDate?: string | null;
}

interface SearxngResponse {
  results?: RawResult[];
  unresponsive_engines?: Array<[string, string]>;
  number_of_results?: number;
}

export async function fetchResults(
  instance: string,
  opts: SearchOptions,
): Promise<FetchSearchResult> {
  const url = buildSearchUrl(instance, opts);
  const warnings: string[] = [];

  let resp: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.numResults > 0 ? 30000 : 10000);
    resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw Object.assign(new Error(`failed to reach ${instance}: ${msg}`), { exitCode: 3 });
  }

  if (!resp.ok) {
    throw Object.assign(new Error(`instance returned HTTP ${resp.status}`), { exitCode: 4 });
  }

  let body: SearxngResponse;
  try {
    body = (await resp.json()) as SearxngResponse;
  } catch {
    throw Object.assign(new Error("invalid JSON from instance"), { exitCode: 5 });
  }

  // Collect engine warnings — these go to stderr only
  if (body.unresponsive_engines && body.unresponsive_engines.length > 0) {
    for (const [engine, reason] of body.unresponsive_engines) {
      warnings.push(`engine suspended: ${engine} (${reason})`);
    }
  }

  const raw = body.results ?? [];
  const results: SearchResult[] = raw.slice(0, opts.numResults).map((r) => ({
    url: r.url ?? "",
    title: r.title ?? "",
    content: r.content ?? "",
    engine: r.engine ?? "",
    engines: r.engines ?? (r.engine ? [r.engine] : []),
    score: r.score ?? 0,
    category: r.category ?? "general",
    publishedDate: r.publishedDate ?? null,
  }));

  return { results, warnings };
}

// ---------------------------------------------------------------------------
// Output formatters — stdout only
// ---------------------------------------------------------------------------

export function formatJson(results: SearchResult[]): string {
  return JSON.stringify(results, null, 2);
}

export function formatText(results: SearchResult[]): string {
  if (results.length === 0) return "(no results)\n";
  return results.map((r) => `${r.title}\n${r.url}\n${r.content}`).join("\n---\n") + "\n";
}

function csvEscape(val: string): string {
  if (/[",\n\r]/.test(val)) return `"${val.replace(/"/g, '""')}"`;
  return val;
}

export function formatCsv(results: SearchResult[]): string {
  const header = "url,title,content,engine,engines,score,category,publishedDate";
  if (results.length === 0) return header + "\n";
  const rows = results.map((r) =>
    [
      csvEscape(r.url),
      csvEscape(r.title),
      csvEscape(r.content),
      csvEscape(r.engine),
      csvEscape(r.engines.join("|")),
      String(r.score),
      csvEscape(r.category),
      csvEscape(r.publishedDate ?? ""),
    ].join(","),
  );
  return [header, ...rows].join("\n") + "\n";
}

export function formatOutput(results: SearchResult[], format: FormatType): string {
  if (format === "text") return formatText(results);
  if (format === "csv") return formatCsv(results);
  return formatJson(results);
}

// ---------------------------------------------------------------------------
// Interactive config setup
// ---------------------------------------------------------------------------

export async function runConfigSetup(): Promise<void> {
  const current = loadConfig();
  const rl = createInterface({ input: process.stdin, output: process.stderr });

  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  process.stderr.write("=== qsm-searxng config setup ===\n\n");

  const instanceHint = current.instance || "https://searxng.example.com";
  const instanceInput = await question(`SearXNG instance URL [${instanceHint}]: `);
  const instance = instanceInput.trim() || current.instance;

  if (!instance) {
    process.stderr.write("Instance URL required. Aborting.\n");
    rl.close();
    process.exit(1);
  }

  const enginesHint = (current.default_engines ?? DEFAULT_CONFIG.default_engines).join(",");
  const enginesInput = await question(`Default engines (comma-separated) [${enginesHint}]: `);
  const default_engines = enginesInput.trim()
    ? enginesInput
        .trim()
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean)
    : current.default_engines;

  const numHint = String(current.default_num_results ?? DEFAULT_CONFIG.default_num_results);
  const numInput = await question(`Default num results [${numHint}]: `);
  const default_num_results = numInput.trim()
    ? parseInt(numInput.trim(), 10)
    : current.default_num_results;

  const timeoutHint = String(current.timeout_ms ?? DEFAULT_CONFIG.timeout_ms);
  const timeoutInput = await question(`Timeout ms [${timeoutHint}]: `);
  const timeout_ms = timeoutInput.trim() ? parseInt(timeoutInput.trim(), 10) : current.timeout_ms;

  rl.close();

  const cfg: SearxngConfig = { instance, default_engines, default_num_results, timeout_ms };
  writeConfig(cfg);
  const path = configPath();
  process.stderr.write(`\nConfig written to ${path}\n`);
  process.stderr.write("Run: qsm-searxng --help\n");
}
