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
 *   post-overview --pr N --body-file F       -> { id, url }
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
  comment_db_id?: number; // GH only — REST id of the first review comment, for in_reply_to
}

// --------------------------------------------------------------------------- //
// GitHub backend (gh)
// --------------------------------------------------------------------------- //

const gh = {
  context(repo: string, pr: string) {
    const meta = run("gh", ["pr", "view", pr, "--repo", repo, "--json", "title,body,author,baseRefName,headRefName"]);
    if (meta.code !== 0) die("gh pr view failed", meta.stderr);
    const m = JSON.parse(meta.stdout);
    let diff = prefetchedDiff();
    if (diff === null) {
      const d = run("gh", ["pr", "diff", pr, "--repo", repo]);
      diff = d.code === 0 ? d.stdout : "";
    }
    return {
      platform: "github", repo, pr_number: Number(pr),
      base: m.baseRefName, head: m.headRefName, title: m.title,
      body: m.body ?? "", author: m.author?.login ?? "",
      diff,
    };
  },

  threads(repo: string, pr: string): NormThread[] {
    const [owner, name] = repo.split("/");
    const q = `query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){reviewThreads(first:100){nodes{id isResolved isOutdated comments(first:50){nodes{databaseId author{login} body path line}}}}}}}`;
    const r = run("gh", ["api", "graphql", "-f", `query=${q}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `pr=${pr}`]);
    if (r.code !== 0) die("gh graphql reviewThreads failed", r.stderr);
    const nodes = JSON.parse(r.stdout)?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    return nodes
      .filter((t: any) => !t.isResolved)
      .map((t: any): NormThread => {
        const cs = t.comments?.nodes ?? [];
        const first = cs[0] ?? {};
        const replies = cs.slice(1);
        const lastReply = replies.length ? replies[replies.length - 1] : null;
        return {
          id: t.id,
          path: first.path ?? "", line: first.line ?? 0,
          original_body: first.body ?? "",
          author_replied: replies.length > 0,
          latest_reply: lastReply?.body ?? "",
          comment_db_id: first.databaseId,
        };
      });
  },

  postOverview(repo: string, pr: string, body: string) {
    const r = run("gh", ["api", `repos/${repo}/issues/${pr}/comments`, "--method", "POST", "-f", `body=${body}`, "--jq", "{id:.id,url:.html_url}"]);
    if (r.code !== 0) die("gh post overview failed", r.stderr);
    return JSON.parse(r.stdout);
  },

  postReview(repo: string, pr: string, payloadFile: string) {
    // One atomic review. The contract in docs/github-review-api.md.
    const payload = JSON.parse(readFileSync(payloadFile, "utf8"));
    const body = { event: payload.event, body: payload.body ?? "", comments: payload.comments ?? [] };
    const r = run("gh", ["api", `repos/${repo}/pulls/${pr}/reviews`, "--method", "POST", "--input", "-"], JSON.stringify(body));
    if (r.code !== 0) die("gh post-review failed", r.stderr);
    return { posted: true, event: payload.event };
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
      base: m.target_branch, head: m.source_branch, title: m.title,
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
        const replies = notes.slice(1);
        const lastReply = replies.length ? replies[replies.length - 1] : null;
        return {
          id: String(d.id),
          path: first.position?.new_path ?? first.position?.old_path ?? "",
          line: first.position?.new_line ?? first.position?.old_line ?? 0,
          original_body: first.body ?? "",
          author_replied: replies.length > 0,
          latest_reply: lastReply?.body ?? "",
        };
      });
  },

  postOverview(repo: string, iid: string, body: string) {
    const r = run("glab", ["api", `projects/${glProject(repo)}/merge_requests/${iid}/notes`, "--method", "POST", "-f", `body=${body}`]);
    if (r.code !== 0) die("glab post overview failed", r.stderr);
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
    const mr = gl.mr(repo, iid);
    const refs = mr.diff_refs ?? {}; // base_sha, head_sha, start_sha — required for inline positioning
    const fellBack: string[] = [];

    for (const c of payload.comments ?? []) {
      // Positioned discussion. If the instance rejects the position, fall back
      // to appending the finding to the summary note (so nothing is lost).
      const args = [
        "api", `projects/${proj}/merge_requests/${iid}/discussions`, "--method", "POST",
        "-f", `body=${c.body}`,
        "-f", "position[position_type]=text",
        "-f", `position[base_sha]=${refs.base_sha ?? ""}`,
        "-f", `position[head_sha]=${refs.head_sha ?? ""}`,
        "-f", `position[start_sha]=${refs.start_sha ?? ""}`,
        "-f", `position[new_path]=${c.path}`,
        "-f", `position[old_path]=${c.path}`,
        "-f", `position[new_line]=${c.line}`,
      ];
      const r = run("glab", args);
      if (r.code !== 0) fellBack.push(`- **\`${c.path}:${c.line}\`** — ${c.body}`);
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
    process.stdout.write("verbs: detect | context | threads | post-overview | post-review | resolve | reply\n");
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
    case "post-overview":
      return out(d.platform === "github" ? gh.postOverview(d.repo, requireFlag("pr"), bodyFromFile()) : gl.postOverview(d.repo, requireFlag("pr"), bodyFromFile()));
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
    default:
      return die(`unknown verb: ${verb}`);
  }
}

main();
