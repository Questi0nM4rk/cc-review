#!/usr/bin/env bash
# ============================================================================
#  tmux-claude.sh — run a Claude Code task through an INTERACTIVE session in tmux.
#
#  WHY: `claude -p` (headless/print) bills the headless/SDK pool — empirically it
#  moves the weekly /usage ~3% per run while the 5-hour session window doesn't budge.
#  An INTERACTIVE session draws from the abundant 5-hour rolling bucket instead. This
#  driver makes an automated review "look like" an interactive session so it stops
#  burning the scarce pool. Personal/local by design.
#
#  ROBUST COMPLETION (the usual tmux pain point — the TUI has no machine-readable
#  "done"): we DON'T scrape the screen to decide done. We append a sentinel instruction
#  to the prompt ("as your last action run: echo done > <file>") and poll for that file.
#  The agent writes it after finishing (it has bash). capture-pane is then only a
#  best-effort transcript for the log — its messiness doesn't affect correctness, which
#  is verified downstream against GitHub ground truth, not by parsing this output.
#
#  Usage:
#    tmux-claude.sh --prompt-file FILE --out FILE [--claude-arg ARG]...
#    tmux-claude.sh --selftest                # drive `bash` as a stand-in — proves the
#                                             # plumbing (inject/sentinel/capture), NO claude, NO quota
#
#  Tunables (env): TMUX_POLL_SECS=5  TMUX_READY_SECS=25  TMUX_MAX_SECS=2400  TMUX_WIDTH=220 TMUX_HEIGHT=50
#  Exit: 0 = sentinel seen (completed); 1 = timed out; 2 = usage/setup error.
# ============================================================================
set -uo pipefail

POLL="${TMUX_POLL_SECS:-5}"; READY="${TMUX_READY_SECS:-25}"; MAX="${TMUX_MAX_SECS:-2400}"
W="${TMUX_WIDTH:-220}"; H="${TMUX_HEIGHT:-50}"

PROMPT_FILE=""; OUT_FILE="/dev/stdout"; SELFTEST=0; CLAUDE_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --prompt-file) PROMPT_FILE="$2"; shift 2 ;;
    --out)         OUT_FILE="$2"; shift 2 ;;
    --claude-arg)  CLAUDE_ARGS+=("$2"); shift 2 ;;
    --selftest)    SELFTEST=1; shift ;;
    *) echo "tmux-claude: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

command -v tmux >/dev/null 2>&1 || { echo "tmux-claude: tmux not installed" >&2; exit 2; }

SESSION="ccr-tmux-$$"
DONE_FILE="$(mktemp -u "${TMPDIR:-/tmp}/ccr-tmux-done.XXXXXX")"
PROMPT_AUG="$(mktemp "${TMPDIR:-/tmp}/ccr-tmux-prompt.XXXXXX")"
cleanup() { tmux kill-session -t "$SESSION" 2>/dev/null || true; rm -f "$PROMPT_AUG" "$DONE_FILE" 2>/dev/null || true; }
trap cleanup EXIT

# Build the prompt: real prompt (or a stand-in command) + the sentinel-completion instruction.
if [ "$SELFTEST" = "1" ]; then
  printf 'echo "tmux-claude selftest: the plumbing works"\n' > "$PROMPT_AUG"
  PANE_CMD="bash --norc -i"
else
  [ -n "$PROMPT_FILE" ] && [ -f "$PROMPT_FILE" ] || { echo "tmux-claude: --prompt-file missing/not found" >&2; exit 2; }
  cat "$PROMPT_FILE" > "$PROMPT_AUG"
  # Build the interactive claude command from the passed args (quoted safely).
  printf -v ARGS_STR '%q ' "${CLAUDE_ARGS[@]}"
  PANE_CMD="claude ${ARGS_STR}"
fi
# The sentinel: appended to EVERY prompt. The agent's last act writes it; we poll for it.
{ printf '\n\n---\nWhen you have COMPLETELY finished this task, as your VERY LAST action run exactly this shell command (do not skip it — it signals completion):\n'
  printf '  echo done > %s\n' "$DONE_FILE"; } >> "$PROMPT_AUG"

# 1) Launch the interactive program in a detached tmux pane.
tmux new-session -d -s "$SESSION" -x "$W" -y "$H" "$PANE_CMD" \
  || { echo "tmux-claude: failed to start session" >&2; exit 2; }

# 2) Wait for the TUI to be ready: the screen must be non-empty AND stable for two polls
#    (claude takes a few seconds to boot; bash is instant). Capped at READY seconds.
prev=""; stable=0; waited=0
while [ "$waited" -lt "$READY" ]; do
  sleep 2; waited=$((waited + 2))
  cur="$(tmux capture-pane -t "$SESSION" -p 2>/dev/null | tr -d '[:space:]')"
  if [ -n "$cur" ] && [ "$cur" = "$prev" ]; then stable=$((stable + 1)); [ "$stable" -ge 2 ] && break; else stable=0; fi
  prev="$cur"
done

# 3) Inject the prompt as ONE bracketed paste (multi-line stays a single paste — newlines
#    don't submit early), then press Enter once to send it.
tmux load-buffer -b ccr "$PROMPT_AUG"
tmux paste-buffer -p -b ccr -t "$SESSION"      # -p = bracketed paste
tmux send-keys -t "$SESSION" Enter

# 4) Wait for completion by polling the sentinel file (NOT the screen). Capped at MAX.
elapsed=0
while [ ! -f "$DONE_FILE" ] && [ "$elapsed" -lt "$MAX" ]; do
  sleep "$POLL"; elapsed=$((elapsed + POLL))
done

# 5) Capture the transcript (best-effort log; correctness is verified downstream).
tmux capture-pane -t "$SESSION" -p -S -100000 > "$OUT_FILE" 2>/dev/null || true

if [ -f "$DONE_FILE" ]; then
  echo "tmux-claude: completed (sentinel seen after ${elapsed}s)" >&2
  exit 0
else
  echo "tmux-claude: TIMED OUT after ${MAX}s without a completion sentinel" >&2
  exit 1
fi
