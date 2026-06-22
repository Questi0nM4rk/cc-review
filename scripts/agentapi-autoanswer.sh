#!/usr/bin/env bash
# Pure decision for the invoker's interactive-consent auto-answer (issue #75).
#
# Under `--permission-mode auto` (what ci-run.sh now passes), per-tool "Do you want to proceed?"
# prompts do not appear. The one consent that can still surface is the Workflow-tool launch
# ("Run a dynamic workflow?"), whose option 1 is the affirmative "Yes, run it" — so we auto-answer
# ONLY that, and ONLY once a real numbered selection menu is rendered (a "1." / "1)" line).
#
# Everything else is deliberately NOT auto-answered. In particular the Bypass-Permissions ACCEPTANCE
# dialog renders option 1 as "No, exit" — blindly sending "1" there (the old behaviour) would QUIT
# claude. A generic "Do you want to proceed?" likewise must not get a blind "1". If such a prompt
# ever appears under auto mode, stalling to the done-marker timeout (a safe red failure) beats a
# blind keystroke that could exit the session or approve a risky op.
#
# Prints the digit to send (currently only "1"), or nothing if the prompt must not be auto-answered.
auto_answer_for() {
  local msg="$1"
  case "$msg" in
    *"Run a dynamic workflow?"*)
      # Require a real numbered menu line so prose merely quoting the phrase never misfires.
      if printf '%s' "$msg" | grep -qE '^[[:space:]]*[0-9][.)]'; then printf '1'; fi
      ;;
  esac
}
