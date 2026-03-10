#!/usr/bin/env npx tsx

import { createServer, IncomingMessage, ServerResponse } from "http";
import { execSync, spawnSync } from "child_process";
import { mkdtempSync, rmSync, mkdirSync, copyFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { tmpdir, platform } from "os";

// ── Helpers ───────────────────────────────────────────────

const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const RED = "\x1b[31m";
const NC = "\x1b[0m";

const ok = (msg: string) => console.log(`  ${GREEN}✓${NC} ${msg}`);
const info = (msg: string) => console.log(`  ${BLUE}→${NC} ${msg}`);
const warn = (msg: string) => console.log(`  ${YELLOW}!${NC} ${msg}`);
const err = (msg: string) => console.log(`  ${RED}✗${NC} ${msg}`);

const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const TEMPLATE_DIR = resolve(SCRIPT_DIR, "..");
const CALLBACK_PORT = 19428;

function run(cmd: string, opts?: { silent?: boolean; input?: string }): string {
  try {
    const result = execSync(cmd, {
      encoding: "utf-8",
      stdio: opts?.silent ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "inherit"],
      input: opts?.input,
    });
    return result.trim();
  } catch {
    return "";
  }
}

function runOrFail(cmd: string, opts?: { silent?: boolean; input?: string }): string {
  const result = execSync(cmd, {
    encoding: "utf-8",
    stdio: opts?.silent ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "inherit"],
    input: opts?.input,
  });
  return result.trim();
}

function runOk(cmd: string): boolean {
  try {
    execSync(cmd, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function openBrowser(url: string): void {
  const plat = platform();
  const commands: Record<string, string[]> = {
    darwin: ["open", url],
    linux: ["sh", "-c", `wslview '${url}' 2>/dev/null || xdg-open '${url}' 2>/dev/null || sensible-browser '${url}' 2>/dev/null`],
    win32: ["cmd", "/c", "start", "", url],
  };
  const cmd = commands[plat] || commands.linux;
  try {
    spawnSync(cmd[0], cmd.slice(1), { stdio: "ignore" });
  } catch {
    warn(`Open this URL manually:\n    ${BLUE}${url}${NC}`);
  }
}

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(`  ${question}`);
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.resume();
    process.stdin.once("data", (chunk: string) => {
      process.stdin.pause();
      data = chunk.trim();
      resolve(data);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Manifest callback server ──────────────────────────────

function startManifestServer(manifest: object): Promise<string> {
  return new Promise((resolve, reject) => {
    const manifestJson = JSON.stringify(manifest);
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for GitHub callback (120s)"));
    }, 120_000);

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", `http://localhost:${CALLBACK_PORT}`);

      if (url.pathname === "/" || url.pathname === "/start") {
        // Serve auto-submitting form that POSTs manifest to GitHub
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html>
<html>
<head><title>Creating GitHub App...</title></head>
<body>
  <p>Redirecting to GitHub...</p>
  <form id="manifest-form" action="https://github.com/settings/apps/new" method="post">
    <input type="hidden" name="manifest" value='${manifestJson.replace(/'/g, "&#39;")}'>
  </form>
  <script>document.getElementById('manifest-form').submit();</script>
</body>
</html>`);
        return;
      }

      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html>
<html>
<head><title>Done</title></head>
<body>
  <h2>GitHub App created. You can close this tab.</h2>
  <script>window.close()</script>
</body>
</html>`);

        if (code) {
          clearTimeout(timeout);
          server.close();
          resolve(code);
        }
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    server.listen(CALLBACK_PORT, () => {
      info("Local server started for manifest flow.");
    });
  });
}

// ── Main ──────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n${BOLD}Claude Reviewer Bot — Setup${NC}\n`);

  // ── Prerequisites ─────────────────────────────────────
  for (const cmd of ["gh", "node"]) {
    if (!runOk(`which ${cmd}`)) {
      err(`${cmd} is required but not found.`);
      process.exit(1);
    }
  }

  if (!runOk("gh auth status")) {
    err("gh not authenticated. Run: gh auth login");
    process.exit(1);
  }

  const hasClaude = runOk("which claude");
  ok("Prerequisites OK");

  // ── Target repo ───────────────────────────────────────
  let targetRepo = process.argv[2] || "";

  if (!targetRepo) {
    // Auto-detect from git remote
    const remoteUrl = run("git remote get-url origin", { silent: true });
    if (remoteUrl) {
      const match = remoteUrl.match(/github\.com[/:](.+?\/.+?)(?:\.git)?$/);
      if (match) targetRepo = match[1];
    }
  }

  if (!targetRepo) {
    err("No repo specified and not inside a git repo with a GitHub remote.");
    console.log(`  Usage: ${BOLD}npx tsx scripts/setup.ts owner/repo-name${NC}`);
    process.exit(1);
  }

  // Validate repo format to prevent command injection
  if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(targetRepo)) {
    err(`Invalid repo format: "${targetRepo}". Expected: owner/repo-name`);
    process.exit(1);
  }

  // Create if missing (with initial commit so clone works)
  if (!runOk(`gh repo view ${targetRepo}`)) {
    info(`Repo ${targetRepo} doesn't exist — creating (private)...`);
    runOrFail(`gh repo create ${targetRepo} --private --clone=false`);
    ok(`Created ${targetRepo}`);
  }

  // Ensure repo has at least one commit (empty repos can't be cloned/pushed)
  const isEmpty = run(`gh repo view ${targetRepo} --json isEmpty -q .isEmpty`, { silent: true });
  if (isEmpty === "true") {
    info("Initializing empty repo with a commit...");
    run(`gh api repos/${targetRepo}/contents/README.md --method PUT --field message="Initial commit" --field content="IyBSZXBvIGluaXRpYWxpemVkIGJ5IENsYXVkZSBSZXZpZXdlciBCb3QK"`, { silent: true });
  }

  const repoName = targetRepo.split("/")[1];
  ok(`Target: ${targetRepo}`);

  // ── Claude OAuth token ────────────────────────────────
  let oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN || "";

  if (!oauthToken && hasClaude) {
    info("Generating Claude OAuth token...");
    oauthToken = run("claude setup-token", { silent: true });
  }

  if (!oauthToken || !oauthToken.startsWith("sk-ant")) {
    warn("Could not auto-generate token.");
    console.log(`  Generate it with: ${BOLD}claude setup-token${NC}`);
    console.log(`  Or set env: ${BOLD}CLAUDE_CODE_OAUTH_TOKEN=sk-ant-... npx tsx scripts/setup.ts${NC}\n`);
    oauthToken = await prompt("Paste token (sk-ant-...): ");
  }

  if (!oauthToken.startsWith("sk-ant")) {
    err("Invalid token format.");
    process.exit(1);
  }
  ok("Claude OAuth token ready");

  // ── Create GitHub App ─────────────────────────────────
  let appName = `${repoName}-reviewer`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 34);

  info(`Creating GitHub App '${appName}'...`);

  const manifest = {
    name: appName,
    url: `https://github.com/${targetRepo}`,
    redirect_url: `http://localhost:${CALLBACK_PORT}/callback`,
    hook_attributes: { url: `https://github.com/${targetRepo}`, active: false },
    public: false,
    default_permissions: {
      contents: "write",
      issues: "write",
      pull_requests: "write",
    },
    default_events: [],
  };

  // Start server and open browser
  const codePromise = startManifestServer(manifest);

  console.log(`  ${YELLOW}Browser will open — click 'Create GitHub App' (everything is pre-filled).${NC}`);
  await sleep(500);
  openBrowser(`http://localhost:${CALLBACK_PORT}/start`);

  let manifestCode: string;
  try {
    manifestCode = await codePromise;
  } catch (e: unknown) {
    warn("Callback timed out.");
    manifestCode = await prompt("Paste the code from the redirect URL: ");
  }

  if (!manifestCode) {
    err("No code received from GitHub.");
    process.exit(1);
  }

  // Exchange code for credentials
  const appResponseRaw = runOrFail(`gh api app-manifests/${manifestCode}/conversions --method POST`, { silent: true });

  let appId: string;
  let pemKey: string;
  let appSlug: string;
  try {
    const appResponse = JSON.parse(appResponseRaw);
    appId = String(appResponse.id);
    pemKey = appResponse.pem;
    appSlug = appResponse.slug || appName;
    if (!appId || !pemKey) throw new Error("Missing fields");
  } catch {
    err("Failed to get app credentials from GitHub.");
    console.log(`  Response: ${appResponseRaw.slice(0, 200)}`);
    process.exit(1);
  }

  ok(`GitHub App created (ID: ${appId}, slug: ${appSlug})`);

  // ── Install app on repo ───────────────────────────────
  info(`Installing app on ${targetRepo}...`);
  console.log(`  ${YELLOW}Browser will open — select your repo and click Install.${NC}`);
  await sleep(500);
  openBrowser(`https://github.com/apps/${appSlug}/installations/new`);

  // Poll until installed (up to 60s, 5s initial delay for user to interact)
  let installed = false;
  await sleep(5000);
  for (let i = 0; i < 28; i++) {
    await sleep(2000);
    if (runOk(`gh api repos/${targetRepo}/installation`)) {
      installed = true;
      break;
    }
  }

  if (installed) {
    ok(`App installed on ${targetRepo}`);
  } else {
    warn("Could not confirm installation — continuing. If reviews don't work, install manually:");
    console.log(`    https://github.com/apps/${appSlug}/installations/new`);
  }

  // ── Store secrets ─────────────────────────────────────
  info("Storing secrets...");

  runOrFail(`gh secret set REVIEWER_APP_ID --repo ${targetRepo}`, { input: appId });
  runOrFail(`gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo ${targetRepo}`, { input: oauthToken });
  runOrFail(`gh secret set REVIEWER_APP_PRIVATE_KEY --repo ${targetRepo}`, { input: pemKey });

  ok(`3 secrets stored on ${targetRepo}`);

  // ── Deploy workflow files ─────────────────────────────
  info("Deploying workflow files...");

  const workDir = mkdtempSync(join(tmpdir(), "reviewer-bot-"));

  try {
    runOrFail(`git clone --depth 1 -c "credential.https://github.com.helper=!/usr/bin/gh auth git-credential" "https://github.com/${targetRepo}.git" "${workDir}/repo"`, { silent: true });
    const repoDir = join(workDir, "repo");

    // Only deploy workflows + config. Bot intelligence (.claude/) is fetched at CI runtime.
    const filesToCopy: [string, string][] = [
      [".github/workflows/cc-review.yml", ".github/workflows/cc-review.yml"],
      [".github/workflows/cc-review-interactive.yml", ".github/workflows/cc-review-interactive.yml"],
      [".cc-review.yaml", ".cc-review.yaml"],
    ];

    for (const [src, dst] of filesToCopy) {
      const srcPath = join(TEMPLATE_DIR, src);
      const dstPath = join(repoDir, dst);
      mkdirSync(dirname(dstPath), { recursive: true });
      copyFileSync(srcPath, dstPath);
    }

    const status = run(`cd "${repoDir}" && git add -A && git diff --cached --quiet && echo "clean" || echo "dirty"`, { silent: true });

    if (status === "dirty") {
      runOrFail(`cd "${repoDir}" && git commit -m "Add Claude reviewer bot" && git push origin HEAD`, { silent: true });
      ok("Workflow files pushed");
    } else {
      warn("Files already exist in repo");
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  // ── Done ──────────────────────────────────────────────
  console.log(`\n${GREEN}${BOLD}Done.${NC} Auto-review is live on ${BOLD}${targetRepo}${NC}.\n`);
  console.log(`  Open a PR to test it. Comment ${BOLD}@cc-review${NC} for interactive mode.`);
  console.log(`  Customize review behavior in ${BOLD}.cc-review.yaml${NC}\n`);
}

main().catch((e: Error) => {
  err(e.message);
  process.exit(1);
});
