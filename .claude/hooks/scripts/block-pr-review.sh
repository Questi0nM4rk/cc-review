#!/bin/bash
# PreToolUse hook: blocks `gh pr review` commands.
# All reviews MUST use `gh api repos/{owner}/{repo}/pulls/N/reviews`

input=$(cat)
command=$(echo "$input" | grep -o '"command":"[^"]*"' | head -1 | sed 's/"command":"//;s/"$//')

if echo "$command" | grep -qE '\bgh\s+pr\s+review\b'; then
  echo '{"decision":"block","reason":"BLOCKED: Do not use gh pr review. Use gh api repos/{owner}/{repo}/pulls/N/reviews --method POST --input /tmp/review-payload.json instead."}'
else
  echo '{"decision":"allow"}'
fi
