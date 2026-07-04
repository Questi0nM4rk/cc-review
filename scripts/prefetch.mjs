// Pure context assembly for the `prefetch` adapter verb (reshape plan Phase 1).
//
// The Workflow runtime gives the brain NO filesystem access and inlining a whole diff through the
// invoking LLM's args is worse than an agent, so ALL review-context assembly moved to deterministic
// runner code: `scripts/review-platform.ts prefetch` does the I/O (reads /tmp/cc-input.json,
// /tmp/cc-user-msg.txt, .cc-review.yaml, <mem>/pr-<N>/review-state.json + calls the existing
// context/threads/get-overview internals) and hands the raw pieces here. `assembleCtx` shapes them
// into the FETCH_SCHEMA JSON the brain's single relay agent cats and returns verbatim. Keeping the
// logic here (not in the .ts verb) makes it unit-testable without tsx/gh/git — the pattern shared
// with posted.mjs / threads.mjs.

// The two platform labels the FETCH_SCHEMA enum accepts; anything else defaults to github.
function normPlatform(p) {
  return p === "gitlab" ? "gitlab" : "github";
}

// The on-disk path the runner writes the FULL unified diff to. The ctx JSON the relay agent returns
// carries only a bounded EXCERPT of the diff (never the whole thing — a large diff overflows the
// tool-result truncation cap and can never be relayed verbatim); the reviewers read the full diff
// from this file with bash. Must match review-platform.ts's prefetchedDiff() path.
export const DIFF_PATH = "/tmp/pr-diff.txt";

// The maximum number of characters of the diff carried inline in the ctx excerpt. Anything longer is
// sliced to this length and flagged diff_truncated; the reviewers byte-slice/grep the full file at
// DIFF_PATH for the rest. Chosen well under the tool-result truncation cap so the relay always fits.
export const DIFF_EXCERPT_MAX = 20000;

// Ported VERBATIM from the brain's changedFiles (strict-review.mjs) — kept in parity so the brain can
// consume ctx.diff_files instead of re-parsing a (possibly excerpted) diff. Captures `+++ b/<path>`
// hunk headers plus `diff --git a/… b/<path>` (renames, binary/mode-only changes with no hunk), dedups.
export function diffFiles(diff) {
  if (typeof diff !== "string" || !diff) return [];
  const files = new Set();
  for (const m of diff.matchAll(/^\+\+\+ b\/(.+)$/gm)) files.add(m[1]);
  for (const m of diff.matchAll(/^diff --git a\/.+ b\/(.+)$/gm)) files.add(m[1]);
  return [...files];
}

// Ported VERBATIM from the brain's addedLineCount — counts added (`+`) lines, excluding the `+++`
// file header. The brain uses ctx.added_line_count instead of recomputing on the excerpted diff.
export function addedLines(diff) {
  if (typeof diff !== "string" || !diff) return 0;
  let n = 0;
  for (const _m of diff.matchAll(/^\+(?!\+\+ )/gm)) n++;
  return n;
}

// Given the FULL diff, produce the three precomputed fields the ctx carries alongside a bounded
// excerpt: a truncated `diff` excerpt, a `diff_truncated` flag, and the exact `diff_files` /
// `added_line_count` (computed over the FULL diff, never the excerpt).
function diffFields(fullDiff) {
  const full = typeof fullDiff === "string" ? fullDiff : "";
  return {
    diff: full.slice(0, DIFF_EXCERPT_MAX),
    diff_truncated: full.length > DIFF_EXCERPT_MAX,
    diff_path: DIFF_PATH,
    diff_files: diffFiles(full),
    added_line_count: addedLines(full),
  };
}

/**
 * The abort shape: emitted on any platform failure (adapter error / PR not found / no auth) and by
 * the relay agent when the ctx file is missing. NEVER fabricate a diff or identity — a zero pr_number
 * and an empty diff make the brain's fetch gate abort cleanly instead of reviewing a fallback diff.
 *
 * @param {string} [reason] - optional human-readable cause, accepted for call-site clarity/logging.
 *   Intentionally NOT surfaced in the returned object: the FETCH_SCHEMA has no `reason` field and the
 *   brain validates the ctx against it, so leaking a key would break validation.
 * @returns {object} the FETCH_SCHEMA abort shape (pr_number 0, empty diff, empty threads, null overview)
 */
export function abortCtx(reason) {
  void reason;
  return {
    ...diffFields(""),
    pr_number: 0,
    repo: "",
    platform: "github",
    head_sha: "",
    post: false,
    ping_override: false,
    user_message: "",
    config: {},
    threads: [],
    overview_id: null,
    reviewed_file_count: null,
    reviewed_head_sha: "",
  };
}

/**
 * Shape the raw I/O pieces the `prefetch` verb gathered into the FETCH_SCHEMA JSON.
 *
 * pieces (platform mode): { input, config, userMessage, context:{diff,head,repo,platform}, threads[], overview:{id}, reviewState }
 * pieces (local mode):    { local:true, input, config, userMessage, diff, repo, reviewState }
 * pieces (abort):         { abort:true }  (or null / undefined)
 */
export function assembleCtx(pieces) {
  if (!pieces || pieces.abort) return abortCtx();

  const input = pieces.input && typeof pieces.input === "object" ? pieces.input : {};
  const config = pieces.config && typeof pieces.config === "object" ? pieces.config : {};
  const userMessage = typeof pieces.userMessage === "string" ? pieces.userMessage : "";

  // review-state marker (the prior run's stamp) — only its count + sha; absent ⇒ null/"" (never fabricate).
  const rs = pieces.reviewState && typeof pieces.reviewState === "object" ? pieces.reviewState : null;
  const reviewed_file_count = rs && Number.isInteger(rs.reviewed_file_count) ? rs.reviewed_file_count : null;
  const reviewed_head_sha = rs && typeof rs.reviewed_head_sha === "string" ? rs.reviewed_head_sha : "";

  if (pieces.local) {
    // Local dry-run: no PR. Posting is hard-off, no threads, no overview — the brain treats pr_number 0
    // as a local dry-run and never touches a remote. The full diff already lives at DIFF_PATH (the
    // runner wrote it / --local mode read it from there); the ctx carries only the bounded excerpt.
    return {
      ...diffFields(typeof pieces.diff === "string" ? pieces.diff : ""),
      pr_number: 0,
      repo: typeof pieces.repo === "string" ? pieces.repo : "",
      platform: normPlatform(input.platform),
      head_sha: "",
      post: false,
      ping_override: false,
      user_message: userMessage,
      config,
      threads: [],
      overview_id: null,
      reviewed_file_count,
      reviewed_head_sha,
    };
  }

  // Platform mode: diff + head come from the adapter's context verb; threads + overview from theirs.
  const ctx = pieces.context && typeof pieces.context === "object" ? pieces.context : {};
  const threads = Array.isArray(pieces.threads) ? pieces.threads : [];
  const overview = pieces.overview && typeof pieces.overview === "object" ? pieces.overview : {};
  const overview_id = Number.isInteger(overview.id) && overview.id > 0 ? overview.id : null;
  const prNum = Number(input.pr_number);

  return {
    // The full diff came from the adapter's context verb; the runner also writes it to DIFF_PATH.
    // The ctx carries only the bounded excerpt + the exact precomputed file-list / added-line count.
    ...diffFields(typeof ctx.diff === "string" ? ctx.diff : ""),
    pr_number: Number.isFinite(prNum) && prNum > 0 ? Math.trunc(prNum) : 0,
    // Prefer the requested repo (cc-input.json) — that's what the identity gate compares against;
    // fall back to the adapter's detected repo only when the input omitted it.
    repo: typeof input.repo === "string" && input.repo.trim() ? input.repo.trim()
      : (typeof ctx.repo === "string" ? ctx.repo : ""),
    platform: normPlatform(input.platform || ctx.platform),
    head_sha: typeof ctx.head === "string" ? ctx.head : "",
    post: input.post === true,
    ping_override: input.ping_override === true,
    user_message: userMessage,
    config,
    threads,
    overview_id,
    reviewed_file_count,
    reviewed_head_sha,
  };
}

// ---------------------------------------------------------------------------
// parseReviewConfig — a minimal hand-rolled parser for the documented flat
// .cc-review.yaml (trigger, languages[], ignore_paths[], instructions,
// known_patterns[], significant_change{files_pct,added_lines}). No deps; parse
// failure or non-string input → {} (the fetch tolerates a missing config).
// ---------------------------------------------------------------------------

// Drop a trailing `# comment`. A `#` only begins a comment when it's at line start or preceded by
// whitespace AND is outside a quoted string — so a `#` inside "…" (or a glob) is preserved.
function stripComment(line) {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

// Strip one layer of matching surrounding quotes, else return the trimmed string.
function unquote(s) {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'"))) {
    return t.slice(1, -1);
  }
  return t;
}

// Coerce a bare scalar to boolean / number where unambiguous, else keep the (unquoted) string.
function parseScalar(raw) {
  const t = raw.trim();
  if (t === "") return "";
  const wasQuoted = (t[0] === '"' || t[0] === "'");
  const v = unquote(t);
  if (wasQuoted) return v; // a quoted value is always a string
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v);
  return v;
}

// Split a flow list body (`a, "b", c`) on top-level commas, honoring quotes.
function splitFlow(body) {
  const items = [];
  let cur = "";
  let quote = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === ",") { items.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim() !== "") items.push(cur);
  return items.map(parseScalar);
}

// A value after `key:` — a flow list `[...]`, else a scalar.
function parseValue(rest) {
  const t = rest.trim();
  if (t.startsWith("[") && t.endsWith("]")) {
    const body = t.slice(1, -1).trim();
    return body === "" ? [] : splitFlow(body);
  }
  return parseScalar(t);
}

const indentOf = (line) => line.length - line.trimStart().length;

export function parseReviewConfig(yamlText) {
  if (typeof yamlText !== "string" || !yamlText.trim()) return {};
  try {
    const lines = yamlText.split(/\r?\n/);
    const out = {};
    let i = 0;
    while (i < lines.length) {
      const raw = lines[i];
      const line = stripComment(raw);
      if (!line.trim() || indentOf(raw) > 0) { i++; continue; } // blanks, comments, stray nested lines
      const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
      if (!m) { i++; continue; }
      const key = m[1];
      const rest = m[2];
      if (rest === "") {
        // Block: look ahead at more-indented lines — list items (`- x`) or a nested map (`k: v`).
        const block = readBlock(lines, i + 1);
        out[key] = block.value;
        i = block.next;
      } else {
        out[key] = parseValue(rest);
        i++;
      }
    }
    return out;
  } catch {
    return {};
  }
}

// Read the indented block under a bare `key:` line. Returns an array (list items), an object (nested
// map), or "" when the block is empty. `next` is the index of the first line NOT consumed.
function readBlock(lines, start) {
  const list = [];
  const map = {};
  let sawList = false;
  let sawMap = false;
  let i = start;
  for (; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripComment(raw);
    if (!line.trim()) continue; // blank / comment-only lines don't end a block
    if (indentOf(raw) === 0) break; // back to top level — block ends
    const body = line.trim();
    if (body.startsWith("- ")) {
      sawList = true;
      list.push(parseScalar(body.slice(2)));
    } else if (body === "-") {
      sawList = true;
      list.push("");
    } else {
      const mm = body.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
      if (mm) { sawMap = true; map[mm[1]] = parseValue(mm[2]); }
    }
  }
  if (sawList) return { value: list, next: i };
  if (sawMap) return { value: map, next: i };
  return { value: "", next: i };
}
