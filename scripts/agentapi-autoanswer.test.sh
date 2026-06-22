#!/usr/bin/env bash
# Unit test for auto_answer_for (scripts/agentapi-autoanswer.sh): which digit, if any, the invoker
# auto-sends for an interactive consent prompt. Plain bash (no bats) so CI runs it with no extra install.
# Run: bash scripts/agentapi-autoanswer.test.sh
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/agentapi-autoanswer.sh
. "$DIR/agentapi-autoanswer.sh"

fails=0
check() { # $1=desc  $2=expected  $3=actual
  if [ "$2" = "$3" ]; then
    printf 'ok   - %s\n' "$1"
  else
    printf 'FAIL - %s  (expected [%s], got [%s])\n' "$1" "$2" "$3"
    fails=$((fails + 1))
  fi
}

wf=$'Run a dynamic workflow?\n  1. Yes, run it\n  2. No\n  3. Yes, and switch to auto mode'
check "dynamic-workflow consent w/ numbered menu -> 1 (option 1 = affirmative)" "1" "$(auto_answer_for "$wf")"

proceed=$'Do you want to proceed?\n  1. No, exit\n  2. Yes'
check "generic per-tool proceed prompt -> NOT auto-answered" "" "$(auto_answer_for "$proceed")"

bypass=$'WARNING: Claude Code running in Bypass Permissions mode\n  1. No, exit\n  2. Yes, I accept'
check "bypass-acceptance dialog (option 1 = No,exit) -> NOT auto-answered" "" "$(auto_answer_for "$bypass")"

nomenu='Run a dynamic workflow?'
check "dynamic-workflow text but no numbered menu rendered yet -> nothing" "" "$(auto_answer_for "$nomenu")"

prose='Here is some prose that happens to mention running a workflow.'
check "arbitrary prose -> nothing" "" "$(auto_answer_for "$prose")"

check "empty message -> nothing" "" "$(auto_answer_for "")"

if [ "$fails" -eq 0 ]; then
  echo "PASS - all auto_answer_for cases"
  exit 0
else
  echo "FAILED - $fails case(s)"
  exit 1
fi
