#!/usr/bin/env npx tsx
/**
 * review-platform — deterministic GitHub/GitLab I/O adapter for cc-review.
 *
 * The strict-review workflow's agents and the GitHub Action call THIS instead of
 * hand-crafting `gh`/`glab` API calls. One verb interface, two backends, JSON in/out.
 *
 * Platform detection: remote host (handles SSH aliases like github.com-foo) + CI env.
 *   GitHub  -> bot mode  (App token, branches pushed by the GHA)
 *   GitLab  -> local mode (your creds; NEVER pushes branches — posts to the MR only)
 *
 * Verbs:
 *   detect                                  -> { platform, host, repo }
 *   context      --pr N                      -> { platform, repo, pr_number, base, head, title, body, author, diff }
 *   threads      --pr N                      -> { threads: NormThread[] }   (open/unresolved only)
 *   get-overview  --pr N                      -> { id, body } of the bot's marked overview comment, or { id: null }
 *   post-overview --pr N --body-file F        -> { id, url }
 *   edit-overview --pr N --comment-id ID --body-file F -> { id, url }   (edit the overview comment in place)
 *   post-review  --pr N --payload F          -> { posted, event }           (atomic on GH; note+discussions on GL)
 *   resolve      --pr N --thread ID          -> { resolved }
 *   reply        --pr N --thread ID --body-file F  -> { replied }
 *
 * Payload file shape (post-review):
 *   { "event": "APPROVE"|"REQUEST_CHANGES", "body": "...", "comments": [{ "path","line","side"?,"body" }] }
 *
 * Exit 0 + JSON on stdout = success. Exit 1 + { error } on stdout = failure.
 * Runtime: node + tsx (no bun, no extra deps).
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { classifyPosted } from "./posted.mjs";

// Hidden marker on the bot's overview comment. It doubles as the per-PR "already reviewed"
// state flag (SPEC §4): get-overview matches it, and the brain embeds it in the overview body.
const OVERVIEW_MARKER = "<!-- cc-review:overview -->";

// --------------------------------------------------------------------------- //
// shell + io helpers
// --------------------------------------------------------------------------- //

type Run = { code: number; stdout: string; stderr: string };

function run(bin: string, args: string[], input?: string): Run {
  const r = spawnSync(bin, args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

function out(obj: unknown): never {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

function die(message: string, detail?: string): never {
  process.stdout.write(JSON.stringify({ error: message, detail: detail ?? "" }));
  process.exit(1);
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function requireFlag(name: string): string {
  const v = flag(name);
  if (!v) die(`missing required flag --${name}`);
  return v;
}

function bodyFromFile(name = "body-file"): string {
  return readFileSync(requireFlag(name), "utf8");
}

// The GHA pre-fetches the diff to /tmp/pr-diff.txt (with a large-diff git fallback).
// Prefer it over a fresh `gh pr diff`, which 404s on diffs too large for the API.
function prefetchedDiff(): string | null {
  try {
    const s = readFileSync("/tmp/pr-diff.txt", "utf8");
    return s.trim() ? s : null;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------- //
// detection
// --------------------------------------------------------------------------- //

type Platform = "github" | "gitlab";
interface Detected { platform: Platform; host: string; repo: string }

function parseRemote(url: string): { host: string; repo: string } {
  // SSH: git@github.com-alias:Owner/Repo.git   HTTPS: https://gitlab.com/group/sub/repo.git
  let host = "";
  let repo = "";
  const ssh = url.match(/^[^@]+@([^:]+):(.+?)(?:\.git)?$/);
  const https = url.match(/^https?:\/\/(?:[^@]+@)?([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) { host = ssh[1]; repo = ssh[2]; }
  else if (https) { host = https[1]; repo = https[2]; }
  return { host, repo };
}

function detect(): Detected {
  // CI env wins (unambiguous), else fall back to the origin remote.
  if (process.env.GITHUB_ACTIONS && process.env.GITHUB_REPOSITORY) {
    return { platform: "github", host: "github.com", repo: process.env.GITHUB_REPOSITORY };
  }
  if (process.env.GITLAB_CI && process.env.CI_PROJECT_PATH) {
    return { platform: "gitlab", host: "gitlab.com", repo: process.env.CI_PROJECT_PATH };
  }
  const remote = run("git", ["remote", "get-url", "origin"]);
  if (remote.code !== 0) die("cannot read origin remote; not in a git repo?", remote.stderr);
  const { host, repo } = parseRemote(remote.stdout);
  if (!host || !repo) die(`cannot parse remote: ${remote.stdout}`);
  const platform: Platform = /gitlab/i.test(host) ? "gitlab" : "github";
  return { platform, host, repo };
}

// --------------------------------------------------------------------------- //
// normalized thread shape (shared by both platforms)
// --------------------------------------------------------------------------- //

interface NormThread {
  id: string;            // GH: reviewThread node id   GL: discussion id
  path: string;
  line: number;
  original_body: string; // first comment (the bot's finding)
  author_replied: boolean;
  latest_reply: string;
  bot_replied_last: boolean; // newest comment is the bot's (it opened the thread) — nothing new to answer
  comment_db_id?: number; // GH only — REST id of the first review comment, for in_reply_to
}

// --------------------------------------------------------------------------- //
// GitHub backend (gh)
// --------------------------------------------------------------------------- //

const gh = {
  context(repo: string, pr: string) {
    const meta = run("gh", ["pr", "view", pr, "--repo", repo, "--json", "title,body,author,baseRefName,headRefName,headRefOid"]);
    if (meta.code !== 0) die("gh pr view failed", meta.stderr);
    const m = JSON.parse(meta.stdout);
    let diff = prefetchedDiff();
    if (diff === null) {
      const d = run("gh", ["pr", "diff", pr, "--repo", repo]);
      diff = d.code === 0 ? d.stdout : "";
    }
    return {
      platform: "github", repo, pr_number: Number(pr),
      // `head` is the real head COMMIT SHA (headRefOid), not the branch name — the brain stamps it
      // into the review-state marker, and a SHA is what identifies "what was last reviewed".
      base: m.baseRefName, head: m.headRefOid ?? m.headRefName, title: m.title,
      body: m.body ?? "", author: m.author?.login ?? "",
      diff,
    };
  },

  threads(repo: string, pr: string): NormThread[] {
    const [owner, name] = repo.split("/");
    const q = `query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){reviewThreads(first:100){nodes{id isResolved isOutdated comments(first:50){pageInfo{hasNextPage} nodes{databaseId author{login} body path line}}}}}}}`;
    const r = run("gh", ["api", "graphql", "-f", `query=${q}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `pr=${pr}`]);
    if (r.code !== 0) die("gh graphql reviewThreads failed", r.stderr);
    const nodes = JSON.parse(r.stdout)?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    return nodes
      .filter((t: any) => !t.isResolved)
      .map((t: any): NormThread => {
        const cs = t.comments?.nodes ?? [];
        const first = cs[0] ?? {};
        const last = cs.length ? cs[cs.length - 1] : first;
        const replies = cs.slice(1);
        const lastReply = replies.length ? replies[replies.length - 1] : null;
        // The bot opened the thread, so its login == first.author. "Bot spoke last" means
        // no new human comment since the bot's last word -> nothing to re-reply to. If the
        // comment list was truncated (>50), we can't see the true newest comment, so fail
        // SAFE: treat it as "not bot-last" so the reply is allowed (a redundant note beats
        // silencing the bot on a thread a human may have just commented on).
        const truncated = t.comments?.pageInfo?.hasNextPage === true;
        const botLogin = first.author?.login;
        return {
          id: t.id,
          path: first.path ?? "", line: first.line ?? 0,
          original_body: first.body ?? "",
          author_replied: replies.length > 0,
          latest_reply: lastReply?.body ?? "",
          bot_replied_last: !truncated && !!botLogin && last.author?.login === botLogin,
          comment_db_id: first.databaseId,
        };
      });
  },

  getOverview(repo: string, pr: string) {
    // --paginate merges array pages into one JSON array (no --jq, which would break that).
    const r = run("gh", ["api", `repos/${repo}/issues/${pr}/comments`, "--paginate"]);
    if (r.code !== 0) die("gh list comments failed", r.stderr);
    const comments: Array<{ id: number; body: string }> = JSON.parse(r.stdout || "[]");
    const hit = [...comments].reverse().find((c) => (c.body ?? "").includes(OVERVIEW_MARKER));
    return hit ? { id: hit.id, body: hit.body } : { id: null };
  },

  postOverview(repo: string, pr: string, body: string) {
    const r = run("gh", ["api", `repos/${repo}/issues/${pr}/comments`, "--method", "POST", "-f", `body=${body}`, "--jq", "{id:.id,url:.html_url}"]);
    if (r.code !== 0) die("gh post overview failed", r.stderr);
    return JSON.parse(r.stdout);
  },

  editOverview(repo: string, commentId: string, body: string) {
    const r = run("gh", ["api", `repos/${repo}/issues/comments/${commentId}`, "--method", "PATCH", "-f", `body=${body}`, "--jq", "{id:.id,url:.html_url}"]);
    if (r.code !== 0) die("gh edit overview failed", r.stderr);
    return JSON.parse(r.stdout);
  },

  postReview(repo: string, pr: string, payloadFile: string) {
    // One atomic review. The contract in docs/github-review-api.md.
    const payload = JSON.parse(readFileSync(payloadFile, "utf8"));
    // Idempotency: the body carries an integrity marker (<!-- cc-review:review <hash> -->).
    // If a prior review already bears the SAME marker, this is a retry of an identical
    // review (e.g. after a partial-post failure) — skip it instead of double-posting.
    const marker = (String(payload.body ?? "").match(/<!-- cc-review:review \S+ -->/) ?? [])[0];
    if (marker) {
      // --paginate (no --jq) merges pages into one JSON array; parse it ourselves (the
      // getOverview pattern) rather than --jq, which applies per-page and is fragile.
      const existing = run("gh", ["api", `repos/${repo}/pulls/${pr}/reviews`, "--paginate"]);
      if (existing.code === 0) {
        const reviews: Array<{ body?: string }> = JSON.parse(existing.stdout || "[]");
        if (reviews.some((rv) => (rv.body ?? "").includes(marker))) {
          return { posted: false, duplicate: true, event: payload.event };
        }
      }
    }
    const comments = payload.comments ?? [];
    const body = { event: payload.event, body: payload.body ?? "", comments };
    const r = run("gh", ["api", `repos/${repo}/pulls/${pr}/reviews`, "--method", "POST", "--input", "-"], JSON.stringify(body));
    if (r.code === 0) return { posted: true, event: payload.event };

    // The review is one ATOMIC POST: a single inline comment whose `line` isn't part of the diff
    // (an agent mis-routed the line, hunk-context vs. exact added line) makes GitHub 422 and rejects
    // the WHOLE review — every finding lost. If that happens, don't lose the review: demote ALL
    // inline comments into the summary body as bullets and re-POST with no inline comments. The
    // verdict (event) is preserved. (docs/github-review-api.md "Common 422 causes".)
    const looksLikeLineError = comments.length > 0 &&
      /422|line must be part of the diff|must be on a line in the diff|Unprocessable/i.test(r.stderr);
    if (looksLikeLineError) {
      const bullets = comments.map((c: { path: string; line: number; body: string }) => `- **\`${c.path}:${c.line}\`** — ${c.body}`).join("\n");
      const demotedText = `${payload.body ?? ""}\n\n### Inline comments that could not be positioned in the diff\n\n${bullets}`;
      const retry = run("gh", ["api", `repos/${repo}/pulls/${pr}/reviews`, "--method", "POST", "--input", "-"],
        JSON.stringify({ event: payload.event, body: demotedText, comments: [] }));
      if (retry.code === 0) return { posted: true, event: payload.event, inline_demoted: comments.length };
      die("gh post-review failed (inline-demotion retry also failed)", retry.stderr);
    }
    die("gh post-review failed", r.stderr);
  },

  resolve(threadId: string) {
    const q = `mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}`;
    const r = run("gh", ["api", "graphql", "-f", `query=${q}`, "-F", `id=${threadId}`]);
    if (r.code !== 0) die("gh resolve thread failed", r.stderr);
    return { resolved: true };
  },

  reply(repo: string, pr: string, commentDbId: string, body: string) {
    // Reply lands in the same thread via in_reply_to (REST comment id).
    const r = run("gh", ["api", `repos/${repo}/pulls/${pr}/comments`, "--method", "POST", "-f", `body=${body}`, "-F", `in_reply_to=${commentDbId}`]);
    if (r.code !== 0) die("gh reply failed", r.stderr);
    return { replied: true };
  },
};

// --------------------------------------------------------------------------- //
// GitLab backend (glab) — local mode, never pushes branches.
// NOTE: inline-comment positioning needs the MR diff_refs and is the part most
// likely to need adjustment against a real instance — flagged inline below.
// --------------------------------------------------------------------------- //

function glProject(repo: string): string {
  return encodeURIComponent(repo); // URL-encoded project path for `glab api`
}

const gl = {
  mr(repo: string, iid: string): any {
    const r = run("glab", ["api", `projects/${glProject(repo)}/merge_requests/${iid}`]);
    if (r.code !== 0) die("glab mr fetch failed", r.stderr);
    return JSON.parse(r.stdout);
  },

  context(repo: string, iid: string) {
    const m = gl.mr(repo, iid);
    let diff = prefetchedDiff();
    if (diff === null) {
      const d = run("glab", ["mr", "diff", iid, "--repo", repo]);
      diff = d.code === 0 ? d.stdout : "";
    }
    return {
      platform: "gitlab", repo, pr_number: Number(iid),
      // `head` is the real head COMMIT SHA (diff_refs.head_sha, falling back to the MR `sha`), not
      // the source branch name — the brain stamps it into the review-state marker.
      base: m.target_branch, head: m.diff_refs?.head_sha ?? m.sha ?? m.source_branch, title: m.title,
      body: m.description ?? "", author: m.author?.username ?? "",
      diff,
    };
  },

  threads(repo: string, iid: string): NormThread[] {
    const r = run("glab", ["api", "--paginate", `projects/${glProject(repo)}/merge_requests/${iid}/discussions`]);
    if (r.code !== 0) die("glab discussions fetch failed", r.stderr);
    const discussions = JSON.parse(r.stdout) ?? [];
    return discussions
      .filter((d: any) => Array.isArray(d.notes) && d.notes.some((n: any) => n.resolvable))
      .filter((d: any) => !d.notes.every((n: any) => n.resolved))
      .map((d: any): NormThread => {
        const notes = d.notes ?? [];
        const first = notes[0] ?? {};
        const last = notes.length ? notes[notes.length - 1] : first;
        const replies = notes.slice(1);
        const lastReply = replies.length ? replies[replies.length - 1] : null;
        const botUser = first.author?.username;
        return {
          id: String(d.id),
          path: first.position?.new_path ?? first.position?.old_path ?? "",
          line: first.position?.new_line ?? first.position?.old_line ?? 0,
          original_body: first.body ?? "",
          author_replied: replies.length > 0,
          latest_reply: lastReply?.body ?? "",
          bot_replied_last: !!botUser && last.author?.username === botUser,
        };
      });
  },

  getOverview(repo: string, iid: string) {
    const r = run("glab", ["api", "--paginate", `projects/${glProject(repo)}/merge_requests/${iid}/notes`]);
    if (r.code !== 0) die("glab list notes failed", r.stderr);
    const notes: Array<{ id: number; body: string }> = JSON.parse(r.stdout || "[]");
    const hit = [...notes].reverse().find((n) => (n.body ?? "").includes(OVERVIEW_MARKER));
    return hit ? { id: hit.id, body: hit.body } : { id: null };
  },

  postOverview(repo: string, iid: string, body: string) {
    const r = run("glab", ["api", `projects/${glProject(repo)}/merge_requests/${iid}/notes`, "--method", "POST", "-f", `body=${body}`]);
    if (r.code !== 0) die("glab post overview failed", r.stderr);
    const n = JSON.parse(r.stdout);
    return { id: n.id, url: n.web_url ?? "" };
  },

  editOverview(repo: string, iid: string, noteId: string, body: string) {
    const r = run("glab", ["api", `projects/${glProject(repo)}/merge_requests/${iid}/notes/${noteId}`, "--method", "PUT", "-f", `body=${body}`]);
    if (r.code !== 0) die("glab edit overview failed", r.stderr);
    const n = JSON.parse(r.stdout);
    return { id: n.id, url: n.web_url ?? "" };
  },

  postReview(repo: string, iid: string, payloadFile: string) {
    // GitLab has no atomic "review" object. We emulate:
    //   - inline findings  -> one resolvable discussion each (positioned on the diff)
    //   - summary          -> a single MR note
    //   - APPROVE          -> POST .../approve ; REQUEST_CHANGES -> leave unapproved
    const payload = JSON.parse(readFileSync(payloadFile, "utf8"));
    const proj = glProject(repo);
    // Idempotency (best-effort; GitLab has no atomic review): the summary note carries the
    // integrity marker. If a prior note already bears it, this review was posted — skip the retry.
    const marker = (String(payload.body ?? "").match(/<!-- cc-review:review \S+ -->/) ?? [])[0];
    if (marker) {
      const notesR = run("glab", ["api", "--paginate", `projects/${proj}/merge_requests/${iid}/notes`]);
      if (notesR.code === 0) {
        const notes: Array<{ body?: string }> = JSON.parse(notesR.stdout || "[]");
        if (notes.some((n) => (n.body ?? "").includes(marker))) {
          return { posted: false, duplicate: true, event: payload.event };
        }
      }
    }
    const mr = gl.mr(repo, iid);
    const refs = mr.diff_refs ?? {}; // base_sha, head_sha, start_sha — required for inline positioning
    const fellBack: string[] = [];

    for (const c of payload.comments ?? []) {
      // Positioned (inline) discussion. GitLab needs `position` as a NESTED object: the bracket
      // form (`-f "position[new_line]=N"`) is silently DROPPED by the API, which then creates a
      // FLOATING note with HTTP 201 — no error to detect. So we send a JSON body via `--input -`
      // (stdin), and then VERIFY the created note is a real DiffNote. If the instance still rejects
      // the position (e.g. the line is not part of the diff), GitLab makes a non-positioned note:
      // delete that stray note and fall back to the summary list so the finding is neither lost
      // nor left as a confusing floating comment.
      const discBody = JSON.stringify({
        body: c.body,
        position: {
          position_type: "text",
          base_sha: refs.base_sha ?? "",
          head_sha: refs.head_sha ?? "",
          start_sha: refs.start_sha ?? "",
          new_path: c.path,
          old_path: c.path,
          new_line: c.line,
        },
      });
      const r = run("glab", [
        "api", `projects/${proj}/merge_requests/${iid}/discussions`, "--method", "POST",
        "--header", "Content-Type: application/json", "--input", "-",
      ], discBody);

      let positioned = false;
      if (r.code === 0) {
        try {
          const d = JSON.parse(r.stdout);
          const note = d.notes?.[0];
          positioned = note?.type === "DiffNote";
          // A non-DiffNote means the position didn't take — remove the stray floating note before falling back.
          if (!positioned && d.id && note?.id) {
            run("glab", ["api", `projects/${proj}/merge_requests/${iid}/discussions/${d.id}/notes/${note.id}`, "--method", "DELETE"]);
          }
        } catch { /* unparseable response -> treat as not positioned, fall back below */ }
      }
      if (!positioned) fellBack.push(`- **\`${c.path}:${c.line}\`** — ${c.body}`);
    }

    let summary = payload.body ?? "";
    if (fellBack.length) summary += `\n\n### Inline comments that could not be positioned\n\n${fellBack.join("\n")}`;
    if (summary.trim()) {
      const note = run("glab", ["api", `projects/${proj}/merge_requests/${iid}/notes`, "--method", "POST", "-f", `body=${summary}`]);
      if (note.code !== 0) die("glab summary note failed", note.stderr);
    }

    if (payload.event === "APPROVE") {
      const ap = run("glab", ["api", `projects/${proj}/merge_requests/${iid}/approve`, "--method", "POST"]);
      if (ap.code !== 0) return { posted: true, event: payload.event, approve_warning: ap.stderr };
    }
    return { posted: true, event: payload.event, inline_fallbacks: fellBack.length };
  },

  resolve(repo: string, iid: string, discussionId: string) {
    const r = run("glab", ["api", `projects/${glProject(repo)}/merge_requests/${iid}/discussions/${discussionId}`, "--method", "PUT", "-f", "resolved=true"]);
    if (r.code !== 0) die("glab resolve failed", r.stderr);
    return { resolved: true };
  },

  reply(repo: string, iid: string, discussionId: string, body: string) {
    const r = run("glab", ["api", `projects/${glProject(repo)}/merge_requests/${iid}/discussions/${discussionId}/notes`, "--method", "POST", "-f", `body=${body}`]);
    if (r.code !== 0) die("glab reply failed", r.stderr);
    return { replied: true };
  },
};

// --------------------------------------------------------------------------- //
// dispatch
// --------------------------------------------------------------------------- //

function main() {
  const verb = process.argv[2];
  if (!verb || verb === "--help" || verb === "-h") {
    process.stdout.write("verbs: detect | context | threads | get-overview | post-overview | edit-overview | post-review | resolve | reply | verify-posted\n");
    process.exit(verb ? 0 : 1);
  }

  const d = detect();

  // Each handler calls out()/die() (both `: never`, both process.exit). Explicit
  // `return` makes the no-fallthrough contract obvious — this is a dispatch table.
  switch (verb) {
    case "detect":
      return out(d);
    case "context":
      return out(d.platform === "github" ? gh.context(d.repo, requireFlag("pr")) : gl.context(d.repo, requireFlag("pr")));
    case "threads":
      return out({ threads: d.platform === "github" ? gh.threads(d.repo, requireFlag("pr")) : gl.threads(d.repo, requireFlag("pr")) });
    case "get-overview":
      return out(d.platform === "github" ? gh.getOverview(d.repo, requireFlag("pr")) : gl.getOverview(d.repo, requireFlag("pr")));
    case "post-overview":
      return out(d.platform === "github" ? gh.postOverview(d.repo, requireFlag("pr"), bodyFromFile()) : gl.postOverview(d.repo, requireFlag("pr"), bodyFromFile()));
    case "edit-overview":
      // GitHub edits a comment by its global id (--comment-id); GitLab needs the MR iid (--pr) + note id (--comment-id).
      return out(d.platform === "github"
        ? gh.editOverview(d.repo, requireFlag("comment-id"), bodyFromFile())
        : gl.editOverview(d.repo, requireFlag("pr"), requireFlag("comment-id"), bodyFromFile()));
    case "post-review":
      return out(d.platform === "github" ? gh.postReview(d.repo, requireFlag("pr"), requireFlag("payload")) : gl.postReview(d.repo, requireFlag("pr"), requireFlag("payload")));
    case "resolve":
      return out(d.platform === "github" ? gh.resolve(requireFlag("thread")) : gl.resolve(d.repo, requireFlag("pr"), requireFlag("thread")));
    case "reply":
      // GitHub replies via in_reply_to need the REST comment db id (--comment-id);
      // GitLab replies target the discussion id (--thread). Caller passes both.
      return out(d.platform === "github"
        ? gh.reply(d.repo, requireFlag("pr"), requireFlag("comment-id"), bodyFromFile())
        : gl.reply(d.repo, requireFlag("pr"), requireFlag("thread"), bodyFromFile()));
    case "verify-posted": {
      const pr = requireFlag("pr");
      const headSha = requireFlag("head-sha");
      const { repo } = detect();
      const revR = run("gh", ["api", `repos/${repo}/pulls/${pr}/reviews`, "--paginate"]);
      if (revR.code !== 0) die("gh list reviews failed", revR.stderr);
      const reviews: Array<unknown> = JSON.parse(revR.stdout || "[]");
      const comR = run("gh", ["api", `repos/${repo}/pulls/${pr}/comments`, "--paginate"]);
      if (comR.code !== 0) die("gh list inline comments failed", comR.stderr);
      const comments: Array<unknown> = JSON.parse(comR.stdout || "[]");
      return out(classifyPosted(reviews, comments, headSha, "cc-review[bot]"));
    }
    default:
      return die(`unknown verb: ${verb}`);
  }
}

main();
