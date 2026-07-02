#!/usr/bin/env npx tsx
/**
 * qsm-searxng — SearXNG meta-search CLI.
 *
 * Iron Law: stdout = requested output only (JSON/text/csv).
 *           stderr = warnings, errors, debug — ALWAYS.
 *
 * Exit codes:
 *   0  success (empty results are still success)
 *   1  CLI parse error
 *   2  missing instance URL
 *   3  network failure
 *   4  non-2xx HTTP response
 *   5  invalid JSON from instance
 */

import {
  fetchResults,
  formatOutput,
  loadConfig,
  resolveInstance,
  runConfigSetup,
  type FormatType,
} from "./web-search-lib.ts";

const VERSION = "1.0.0";

function usage(): void {
  process.stderr.write(`qsm-searxng v${VERSION}

Bun-native SearXNG meta-search CLI. stdout = JSON only. stderr = warnings.

Usage:
  qsm-searxng <query>                      search (default JSON output)
  qsm-searxng -q <query>                   explicit --query flag
  qsm-searxng <query> -n 10               --num-results N (default: 10)
  qsm-searxng <query> -e google,bing       --engines ENGINE1,ENGINE2
  qsm-searxng <query> --time-range week    day|week|month|year
  qsm-searxng <query> --category news      general|news|images|videos|files|map|music|it|science
  qsm-searxng <query> --instance https://  override SearXNG instance URL
  qsm-searxng <query> --format json        json (default)|text|csv
  qsm-searxng --config                     interactive config setup
  qsm-searxng --help
  qsm-searxng --version

Environment:
  QSM_SEARXNG_INSTANCE  override instance URL
  QSM_SEARXNG_CONFIG    override config file path (default: ~/.config/qsm-searxng/config.json)

Not implemented (file issue if needed):
  --lucky, --list-engines, --list-categories, --safe-search

Exit codes: 0=success, 1=parse error, 2=no instance, 3=network, 4=HTTP error, 5=bad JSON
`);
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const positional: string[] = [];
let query = "";
let numResults = -1; // sentinel: -1 means "use config default"
let engines: string[] = [];
let timeRange: string | undefined;
let category: string | undefined;
let instanceOverride: string | undefined;
let format: FormatType = "json";
let configMode = false;

let i = 0;
while (i < args.length) {
  const a = args[i];
  switch (a) {
    case "--help":
    case "-h":
      usage();
      process.exit(0);
      break;
    case "--version":
    case "-v":
      process.stdout.write(`${VERSION}\n`);
      process.exit(0);
      break;
    case "--config":
      configMode = true;
      break;
    case "--query":
    case "-q":
      i++;
      if (i >= args.length) {
        process.stderr.write("qsm-searxng: --query requires a value\n");
        process.exit(1);
      }
      query = args[i];
      break;
    case "--num-results":
    case "-n":
      i++;
      if (i >= args.length) {
        process.stderr.write("qsm-searxng: --num-results requires a value\n");
        process.exit(1);
      }
      numResults = parseInt(args[i], 10);
      if (Number.isNaN(numResults) || numResults < 1) {
        process.stderr.write("qsm-searxng: --num-results must be a positive integer\n");
        process.exit(1);
      }
      break;
    case "--engines":
    case "-e":
      i++;
      if (i >= args.length) {
        process.stderr.write("qsm-searxng: --engines requires a value\n");
        process.exit(1);
      }
      engines = args[i].split(",").map((e) => e.trim()).filter(Boolean);
      break;
    case "--time-range":
      i++;
      if (i >= args.length) {
        process.stderr.write("qsm-searxng: --time-range requires a value\n");
        process.exit(1);
      }
      timeRange = args[i];
      break;
    case "--category":
      i++;
      if (i >= args.length) {
        process.stderr.write("qsm-searxng: --category requires a value\n");
        process.exit(1);
      }
      category = args[i];
      break;
    case "--instance":
      i++;
      if (i >= args.length) {
        process.stderr.write("qsm-searxng: --instance requires a value\n");
        process.exit(1);
      }
      instanceOverride = args[i];
      break;
    case "--format":
      i++;
      if (i >= args.length) {
        process.stderr.write("qsm-searxng: --format requires json|text|csv\n");
        process.exit(1);
      }
      if (args[i] !== "json" && args[i] !== "text" && args[i] !== "csv") {
        process.stderr.write(`qsm-searxng: unknown format "${args[i]}" — use json|text|csv\n`);
        process.exit(1);
      }
      format = args[i] as FormatType;
      break;
    // back-compat: upstream used --json as a flag
    case "--json":
      format = "json";
      break;
    default:
      if (a.startsWith("--")) {
        process.stderr.write(`qsm-searxng: unknown flag "${a}"\n`);
        process.exit(1);
      }
      positional.push(a);
  }
  i++;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (configMode) {
    await runConfigSetup();
    return;
  }

  // Resolve query
  const effectiveQuery = query || positional.join(" ");
  if (!effectiveQuery.trim()) {
    process.stderr.write("qsm-searxng: query required. Use --help for usage.\n");
    process.exit(1);
  }

  // Load config
  const config = loadConfig();
  const instance = resolveInstance(config, instanceOverride);

  if (!instance) {
    process.stderr.write(
      "qsm-searxng: no SearXNG instance URL. Set QSM_SEARXNG_INSTANCE or run `qsm-searxng --config`\n",
    );
    process.exit(2);
  }

  const effectiveNumResults = numResults > 0 ? numResults : config.default_num_results;
  const effectiveEngines = engines.length > 0 ? engines : config.default_engines;

  try {
    const { results, warnings } = await fetchResults(instance, {
      query: effectiveQuery,
      numResults: effectiveNumResults,
      engines: effectiveEngines,
      timeRange,
      category,
      format,
    });

    // Warnings ONLY to stderr — never stdout
    for (const w of warnings) {
      process.stderr.write(`qsm-searxng: warning: ${w}\n`);
    }

    if (results.length === 0) {
      process.stderr.write("qsm-searxng: no results found\n");
    }

    // stdout is the formatted results — nothing else ever goes here
    process.stdout.write(formatOutput(results, format) + (format === "json" ? "\n" : ""));
  } catch (err: unknown) {
    const e = err as Error & { exitCode?: number };
    process.stderr.write(`qsm-searxng: ${e.message}\n`);
    process.exit(e.exitCode ?? 1);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`qsm-searxng: fatal: ${msg}\n`);
  process.exit(1);
});
