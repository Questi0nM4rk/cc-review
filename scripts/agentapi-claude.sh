#!/usr/bin/env bash
# ============================================================================
#  agentapi-claude.sh — run a Claude Code task through coder/agentapi
#  (https://github.com/coder/agentapi): an INTERACTIVE `claude` session wrapped
#  as an HTTP API. NOT `claude -p`.
#
#  WHY: `claude -p` (headless/print) bills the scarce headless/SDK pool — each run
#  moves the weekly /usage ~3% while the 5-hour session window doesn't budge. An
#  interactive session draws from the abundant 5-hour bucket. agentapi runs
#  `claude` interactively and exposes a clean control surface, so we get the cheap
#  bucket WITHOUT hand-scraping a TUI:
#    POST /message      — send the prompt (200 = the agent started processing)
#    GET  /status       — "running" | "stable"  → completion is "stable" (official,
#                         deterministic — replaces the old tmux sentinel/capture hack)
#    GET  /messages     — the full conversation (a clean log; correctness is still
#                         verified against GitHub ground truth, never by parsing this)
#
#  Usage:
#    agentapi-claude.sh --prompt-file FILE --out FILE [--claude-arg ARG]...
#    agentapi-claude.sh --selftest      # drives `bash` as a stand-in agent — no claude, no quota
#
#  Tunables (env): AGENTAPI_PORT=3284  AGENTAPI_POLL_SECS=4  AGENTAPI_READY_SECS=40  AGENTAPI_MAX_SECS=2400
#  Exit: 0 = turn completed (status stable); 1 = timed out / not ready; 2 = setup error.
# ============================================================================
set -uo pipefail

PORT="${AGENTAPI_PORT:-3284}"; POLL="${AGENTAPI_POLL_SECS:-4}"; READY="${AGENTAPI_READY_SECS:-40}"; MAX="${AGENTAPI_MAX_SECS:-2400}"
BASE="http://localhost:${PORT}"

PROMPT_FILE=""; OUT_FILE="/dev/stdout"; SELFTEST=0; CLAUDE_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --prompt-file) PROMPT_FILE="$2"; shift 2 ;;
    --out)         OUT_FILE="$2"; shift 2 ;;
    --claude-arg)  CLAUDE_ARGS+=("$2"); shift 2 ;;
    --selftest)    SELFTEST=1; shift ;;
    *) echo "agentapi-claude: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

command -v curl >/dev/null 2>&1 || { echo "agentapi-claude: curl is required" >&2; exit 2; }
command -v jq   >/dev/null 2>&1 || { echo "agentapi-claude: jq is required" >&2; exit 2; }

# agentapi is a single static binary — install it to ~/.local/bin if missing.
if ! command -v agentapi >/dev/null 2>&1; then
  echo "agentapi-claude: installing agentapi (coder/agentapi)…" >&2
  OS=$(uname -s | tr '[:upper:]' '[:lower:]'); ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
  mkdir -p "$HOME/.local/bin"
  curl -fsSL "https://github.com/coder/agentapi/releases/latest/download/agentapi-${OS}-${ARCH}" -o "$HOME/.local/bin/agentapi" \
    && chmod +x "$HOME/.local/bin/agentapi" || { echo "agentapi-claude: agentapi install failed" >&2; exit 2; }
  export PATH="$HOME/.local/bin:$PATH"
fi

# Pre-seed Claude Code's onboarding/UI state on a fresh runner. Interactive `claude` on a fresh HOME
# blocks on first-run TUI gates (theme picker → trust-folder dialog → --dangerously-skip-permissions
# confirmation) and so never reaches agentapi's "stable" status — the review then times out.
# Gate on the SEMANTIC state, not file presence: the claude installer leaves a stub ~/.claude.json
# WITHOUT hasCompletedOnboarding, so "seed only if the file is absent" never fired. Seed whenever claude
# is not already onboarded → covers the stub; a logged-in dev machine (hasCompletedOnboarding:true) is
# untouched. The seed is MERGED over any stub so installer-written keys survive. Auth is NOT seeded
# here: it rides on CLAUDE_CODE_OAUTH_TOKEN (a secret), never a committed credential.
if [ "$SELFTEST" != "1" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  SEED_FILE="$SCRIPT_DIR/ci-claude.json"
  CFG="$HOME/.claude.json"
  if [ -f "$SEED_FILE" ] && ! jq -e '.hasCompletedOnboarding == true' "$CFG" >/dev/null 2>&1; then
    # The "trust this folder?" dialog is PER-PROJECT (keyed by workspace path), not global — the top-level
    # flag in the seed can't pre-accept it because the CI path is only known at runtime. claude inherits
    # this process's CWD, so $PWD is exactly the path it prompts about: inject a trusted entry for it
    # (+ each --add-dir path) so claude boots straight past the gate.
    TRUST_DIRS=("$PWD"); for ((i=0; i<${#CLAUDE_ARGS[@]}; i++)); do
      [ "${CLAUDE_ARGS[$i]}" = "--add-dir" ] && [ $((i+1)) -lt ${#CLAUDE_ARGS[@]} ] && TRUST_DIRS+=("${CLAUDE_ARGS[$((i+1))]}")
    done
    existing='{}'; [ -f "$CFG" ] && existing="$(cat "$CFG" 2>/dev/null)"; [ -n "$existing" ] || existing='{}'
    seed_tmp="$(mktemp)"
    # Merge: (installer stub) * (committed seed) → seed wins on onboarding keys, stub keys survive; then
    # inject the per-project trust entries.
    if printf '%s\n' "${TRUST_DIRS[@]}" | jq -R . | jq -s \
         --argjson base "$existing" --slurpfile seed "$SEED_FILE" \
         '($base * $seed[0]) as $m
          | reduce .[] as $d ($m; .projects[$d] = {hasTrustDialogAccepted:true, hasCompletedProjectOnboarding:true, projectOnboardingSeenCount:1, allowedTools:[]})' \
         > "$seed_tmp" 2>/dev/null && [ -s "$seed_tmp" ]; then
      mv "$seed_tmp" "$CFG"
      echo "agentapi-claude: seeded \$HOME/.claude.json (un-onboarded runner — onboarding done, trusts: ${TRUST_DIRS[*]})" >&2
    else
      rm -f "$seed_tmp"; echo "agentapi-claude: WARN onboarding-seed merge failed — claude may hit the onboarding TUI" >&2
    fi

    # SETTINGS seed (separate file, separate concern): ~/.claude/settings.json governs permission-prompt
    # BEHAVIOUR. Without skipDangerousModePermissionPrompt, interactive `claude --dangerously-skip-permissions`
    # prints "Bypass permissions mode was disabled by settings" and then blocks on "Run a dynamic workflow?",
    # so the brain never runs. Merge our skip-flags into any existing settings (stub-safe), same fresh-runner gate.
    SETTINGS_SEED="$SCRIPT_DIR/ci-claude-settings.json"
    if [ -f "$SETTINGS_SEED" ]; then
      mkdir -p "$HOME/.claude"
      sfile="$HOME/.claude/settings.json"
      scur='{}'; [ -f "$sfile" ] && scur="$(cat "$sfile" 2>/dev/null)"; [ -n "$scur" ] || scur='{}'
      s_tmp="$(mktemp)"
      if jq -n --argjson base "$scur" --slurpfile seed "$SETTINGS_SEED" '$base * $seed[0]' > "$s_tmp" 2>/dev/null && [ -s "$s_tmp" ]; then
        mv "$s_tmp" "$sfile"
        echo "agentapi-claude: seeded \$HOME/.claude/settings.json (skip dangerous-mode + workflow prompts)" >&2
      else
        rm -f "$s_tmp"; echo "agentapi-claude: WARN settings-seed merge failed — claude may block on a permission prompt" >&2
      fi
    fi
  fi
fi

# Build the server command + the prompt.
if [ "$SELFTEST" = "1" ]; then
  SERVER_CMD=(agentapi server --port "$PORT" -- bash --norc)   # stand-in agent — no claude, no quota
  PROMPT='echo "agentapi-claude selftest: the plumbing works"'
else
  [ -n "$PROMPT_FILE" ] && [ -f "$PROMPT_FILE" ] || { echo "agentapi-claude: --prompt-file missing/not found" >&2; exit 2; }
  SERVER_CMD=(agentapi server --type=claude --port "$PORT" -- claude "${CLAUDE_ARGS[@]}")
  PROMPT="$(cat "$PROMPT_FILE")"
fi

# Start the agentapi server (it owns the interactive agent's pty) in the background.
"${SERVER_CMD[@]}" >/tmp/agentapi-server.log 2>&1 &
SERVER_PID=$!
cleanup() { kill "$SERVER_PID" 2>/dev/null || true; }
trap cleanup EXIT

status() { curl -s --max-time 5 "${BASE}/status" 2>/dev/null | jq -r '.status // empty' 2>/dev/null; }

# Wait for the server to come up (the /status endpoint responds at all).
waited=0; up=0
while [ "$waited" -lt "$READY" ]; do
  [ -n "$(status)" ] && { up=1; break; }
  sleep 2; waited=$((waited + 2))
done
[ "$up" = "1" ] || { echo "agentapi-claude: server did not come up in ${READY}s" >&2; tail -20 /tmp/agentapi-server.log >&2 2>/dev/null; exit 1; }

# SELFTEST = reachability only. agentapi can't drive a generic `bash` (agent_type=custom) to "stable" —
# stable-detection needs a KNOWN agent type (claude/codex/…) whose prompt it recognises. So we confirm
# only: installed, server up, /status responds, /messages parses. (A full turn needs the real claude type.)
if [ "$SELFTEST" = "1" ]; then
  n=$(curl -s --max-time 10 "${BASE}/messages" 2>/dev/null | jq -r '(.messages // []) | length' 2>/dev/null)
  curl -s --max-time 10 "${BASE}/messages" 2>/dev/null | jq -r '(.messages // [])[] | "[\(.role)] \(.content)"' > "$OUT_FILE" 2>/dev/null || true
  echo "agentapi-claude: selftest OK — agentapi installed, server up on :${PORT}, /status='$(status)', /messages parsed (${n:-0} msg)." >&2
  echo "  (Full agent-turn completion is only detectable for a real agent type, not the bash stand-in.)" >&2
  exit 0
fi

# REAL PATH — 1) Wait until claude has booted and is ready for input (status == stable).
waited=0; ready=0
while [ "$waited" -lt "$READY" ]; do
  [ "$(status)" = "stable" ] && { ready=1; break; }
  sleep 2; waited=$((waited + 2))
done
if [ "$ready" != "1" ]; then
  echo "agentapi-claude: agent not ready (no 'stable' status) in ${READY}s" >&2
  # Capture whatever screen claude is stuck on (onboarding / trust / login) to --out, so a CI failure is
  # self-diagnosing in the pushed log branch instead of needing a local repro to see it.
  curl -s --max-time 8 "${BASE}/messages" 2>/dev/null \
    | jq -r '(.messages // [])[] | "[\(.role)] \(.content)"' > "$OUT_FILE" 2>/dev/null || true
  { echo "── claude appears stuck on this screen (GET /messages) ──"; head -40 "$OUT_FILE" 2>/dev/null; \
    echo "── agentapi server log ──"; tail -20 /tmp/agentapi-server.log 2>/dev/null; } >&2
  exit 1
fi

# 2) Send the prompt (jq builds safe JSON regardless of newlines/quotes in the prompt).
jq -n --arg c "$PROMPT" '{content:$c, type:"user"}' \
  | curl -s --max-time 30 -X POST "${BASE}/message" -H 'Content-Type: application/json' -d @- >/dev/null

# 3) Wait for the turn to complete: after the POST the agent goes "running"; poll until "stable".
sleep 3   # let the status flip to "running" before we start checking for the return to "stable"
elapsed=0; done=0
while [ "$elapsed" -lt "$MAX" ]; do
  [ "$(status)" = "stable" ] && { done=1; break; }
  sleep "$POLL"; elapsed=$((elapsed + POLL))
done

# 4) Capture the conversation (best-effort log; correctness = GitHub ground truth, not this).
curl -s --max-time 15 "${BASE}/messages" 2>/dev/null \
  | jq -r '(.messages // [])[] | "[\(.role)] \(.content)"' > "$OUT_FILE" 2>/dev/null \
  || curl -s --max-time 15 "${BASE}/messages" > "$OUT_FILE" 2>/dev/null || true

if [ "$done" = "1" ]; then
  echo "agentapi-claude: completed (status stable after ${elapsed}s)" >&2
  exit 0
else
  echo "agentapi-claude: TIMED OUT after ${MAX}s (status never returned to 'stable')" >&2
  exit 1
fi
