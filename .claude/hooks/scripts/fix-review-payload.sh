#!/bin/bash
# PreToolUse hook: moves null-line comments to review body "Outside Diff" section.
# Runs before gh api review POST calls. Fixes the payload file in place.

input=$(cat)
command_str=$(echo "$input" | jq -r '.tool_input.command // ""' 2>/dev/null)

# Only process gh api review POST calls
if ! echo "$command_str" | grep -qE 'gh api.*reviews.*POST'; then
  echo '{"decision":"allow"}'
  exit 0
fi

PAYLOAD=$(echo "$command_str" | grep -oE '/tmp/[^ ]+\.json' | head -1)
[ -z "$PAYLOAD" ] && PAYLOAD="/tmp/review-payload.json"
[ ! -f "$PAYLOAD" ] && { echo '{"decision":"allow"}'; exit 0; }

# Count null-line comments
NULL_COUNT=$(jq '[.comments // [] | .[] | select(.line == null)] | length' "$PAYLOAD" 2>/dev/null || echo 0)

if [ "$NULL_COUNT" -gt "0" ] 2>/dev/null; then
  jq '
    (.comments // []) as $all |
    [$all[] | select(.line == null)] as $null_comments |
    [$all[] | select(.line != null)] as $valid_comments |

    # Build "Outside Diff" bullet list from null-line comments
    ($null_comments | map("- **`\(.path)`**: \(.body)") | join("\n\n")) as $outside |

    # Append to review body
    (if ($outside | length) > 0 then
      .body + "\n\n### Outside Diff\n\n" + $outside
    else .body end) as $new_body |

    { body: $new_body, event: .event, comments: $valid_comments }
  ' "$PAYLOAD" > "${PAYLOAD}.fixed" && mv "${PAYLOAD}.fixed" "$PAYLOAD"
fi

echo '{"decision":"allow"}'
