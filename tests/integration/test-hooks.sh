#!/usr/bin/env bash
# Integration tests for cc-review hooks.
# Runs inside Docker (or locally if tsx is installed).
# Exit code 0 = all pass, non-zero = failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FIXTURES="$SCRIPT_DIR/fixtures"
HOOK_DIR="${HOOK_ROOT:-.claude/hooks}"

PASS=0
FAIL=0
TOTAL=0

# ── Helpers ──────────────────────────────────────────────

run_hook() {
  local hook_script="$1"
  local input_file="$2"
  cat "$input_file" | tsx "$hook_script" 2>/dev/null || true
}

assert_decision() {
  local test_name="$1"
  local expected="$2"
  local actual="$3"
  TOTAL=$((TOTAL + 1))

  local decision
  decision=$(echo "$actual" | jq -r '.decision' 2>/dev/null || echo "PARSE_ERROR")

  if [ "$decision" = "$expected" ]; then
    echo "  ✓ $test_name"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $test_name (expected=$expected, got=$decision)"
    echo "    Output: $actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local test_name="$1"
  local needle="$2"
  local haystack="$3"
  TOTAL=$((TOTAL + 1))

  if echo "$haystack" | grep -q "$needle"; then
    echo "  ✓ $test_name"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $test_name (expected to contain: $needle)"
    echo "    Got: $haystack"
    FAIL=$((FAIL + 1))
  fi
}

assert_json_eq() {
  local test_name="$1"
  local jq_filter="$2"
  local expected="$3"
  local json_file="$4"
  TOTAL=$((TOTAL + 1))

  local actual
  actual=$(jq -r "$jq_filter" "$json_file" 2>/dev/null || echo "JQ_ERROR")

  if [ "$actual" = "$expected" ]; then
    echo "  ✓ $test_name"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $test_name (expected=$expected, got=$actual)"
    FAIL=$((FAIL + 1))
  fi
}

# ── Test Suite 1: block-pr-review.ts ─────────────────────

echo ""
echo "═══ Test Suite: block-pr-review.ts ═══"
echo ""

BLOCK_HOOK="$HOOK_DIR/scripts/block-pr-review.ts"

echo "Test 1.1: Should BLOCK 'gh pr review' commands"
OUTPUT=$(run_hook "$BLOCK_HOOK" "$FIXTURES/hook-input-gh-pr-review.json")
assert_decision "decision=block" "block" "$OUTPUT"
assert_contains "reason mentions gh pr review" "gh pr review" "$OUTPUT"

echo ""
echo "Test 1.2: Should ALLOW 'gh api .../reviews' commands"
OUTPUT=$(run_hook "$BLOCK_HOOK" "$FIXTURES/hook-input-gh-api-review.json")
assert_decision "decision=allow" "allow" "$OUTPUT"

echo ""
echo "Test 1.3: Should ALLOW unrelated commands"
OUTPUT=$(run_hook "$BLOCK_HOOK" "$FIXTURES/hook-input-unrelated.json")
assert_decision "decision=allow" "allow" "$OUTPUT"

# ── Test Suite 2: fix-review-payload.ts ──────────────────

echo ""
echo "═══ Test Suite: fix-review-payload.ts ═══"
echo ""

FIX_HOOK="$HOOK_DIR/scripts/fix-review-payload.ts"

echo "Test 2.1: Should move null-line comments to body 'Outside Diff' section"
# Copy fixture to /tmp where the hook expects it
cp "$FIXTURES/review-payload-with-nulls.json" /tmp/review-payload.json
OUTPUT=$(run_hook "$FIX_HOOK" "$FIXTURES/hook-input-gh-api-review.json")
assert_decision "decision=allow (passthrough)" "allow" "$OUTPUT"

# Verify the payload was modified
assert_json_eq "comments array has 2 items (nulls removed)" \
  '.comments | length' "2" /tmp/review-payload.json

assert_json_eq "first comment line=42" \
  '.comments[0].line' "42" /tmp/review-payload.json

assert_json_eq "second comment line=105" \
  '.comments[1].line' "105" /tmp/review-payload.json

BODY=$(jq -r '.body' /tmp/review-payload.json)
assert_contains "body has 'Outside Diff' header" "### Outside Diff" "$BODY"
assert_contains "body has src/utils.ts finding" "src/utils.ts" "$BODY"
assert_contains "body has src/config.ts finding" "src/config.ts" "$BODY"

echo ""
echo "Test 2.2: Should NOT modify payload when all comments have valid lines"
cp "$FIXTURES/review-payload-clean.json" /tmp/review-payload.json
ORIGINAL_MD5=$(md5sum /tmp/review-payload.json | cut -d' ' -f1)
OUTPUT=$(run_hook "$FIX_HOOK" "$FIXTURES/hook-input-gh-api-review.json")
AFTER_MD5=$(md5sum /tmp/review-payload.json | cut -d' ' -f1)
assert_decision "decision=allow" "allow" "$OUTPUT"

TOTAL=$((TOTAL + 1))
if [ "$ORIGINAL_MD5" = "$AFTER_MD5" ]; then
  echo "  ✓ payload unchanged (no null-line comments to fix)"
  PASS=$((PASS + 1))
else
  echo "  ✗ payload was modified when it shouldn't have been"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "Test 2.3: Should pass through for non-review commands"
cp "$FIXTURES/review-payload-clean.json" /tmp/review-payload.json
ORIGINAL_MD5=$(md5sum /tmp/review-payload.json | cut -d' ' -f1)
OUTPUT=$(run_hook "$FIX_HOOK" "$FIXTURES/hook-input-unrelated.json")
AFTER_MD5=$(md5sum /tmp/review-payload.json | cut -d' ' -f1)
assert_decision "decision=allow (non-review command)" "allow" "$OUTPUT"

TOTAL=$((TOTAL + 1))
if [ "$ORIGINAL_MD5" = "$AFTER_MD5" ]; then
  echo "  ✓ payload untouched for unrelated commands"
  PASS=$((PASS + 1))
else
  echo "  ✗ payload was modified on unrelated command"
  FAIL=$((FAIL + 1))
fi

# ── Test Suite 3: settings.json structure ────────────────

echo ""
echo "═══ Test Suite: settings.json validation ═══"
echo ""

SETTINGS="${SETTINGS_PATH:-.claude/settings.json}"

TOTAL=$((TOTAL + 1))
if [ -f "$SETTINGS" ]; then
  echo "  ✓ settings.json exists"
  PASS=$((PASS + 1))
else
  echo "  ✗ settings.json missing at $SETTINGS"
  FAIL=$((FAIL + 1))
fi

TOTAL=$((TOTAL + 1))
if jq empty "$SETTINGS" 2>/dev/null; then
  echo "  ✓ settings.json is valid JSON"
  PASS=$((PASS + 1))
else
  echo "  ✗ settings.json is invalid JSON"
  FAIL=$((FAIL + 1))
fi

assert_json_eq "has hooks.PreToolUse array" \
  '.hooks.PreToolUse | type' "array" "$SETTINGS"

assert_json_eq "PreToolUse matcher is 'Bash'" \
  '.hooks.PreToolUse[0].matcher' "Bash" "$SETTINGS"

HOOK_COUNT=$(jq '.hooks.PreToolUse[0].hooks | length' "$SETTINGS" 2>/dev/null || echo "0")
TOTAL=$((TOTAL + 1))
if [ "$HOOK_COUNT" = "2" ]; then
  echo "  ✓ 2 hooks registered (block-pr-review + fix-review-payload)"
  PASS=$((PASS + 1))
else
  echo "  ✗ expected 2 hooks, got $HOOK_COUNT"
  FAIL=$((FAIL + 1))
fi

assert_json_eq "hook 1 runs block-pr-review.ts" \
  '.hooks.PreToolUse[0].hooks[0].command' \
  "tsx .claude/hooks/scripts/block-pr-review.ts" "$SETTINGS"

assert_json_eq "hook 2 runs fix-review-payload.ts" \
  '.hooks.PreToolUse[0].hooks[1].command' \
  "tsx .claude/hooks/scripts/fix-review-payload.ts" "$SETTINGS"

# ── Test Suite 4: hook-runtime.ts module ─────────────────

echo ""
echo "═══ Test Suite: hook-runtime.ts module ═══"
echo ""

echo "Test 4.1: Should handle invalid JSON on stdin"
TOTAL=$((TOTAL + 1))
OUTPUT=$(echo "not json" | tsx "$BLOCK_HOOK" 2>/dev/null || true)
# Should exit cleanly (exit 0) without crashing
if [ $? -eq 0 ]; then
  echo "  ✓ graceful exit on invalid JSON"
  PASS=$((PASS + 1))
else
  echo "  ✗ crashed on invalid JSON"
  FAIL=$((FAIL + 1))
fi

echo "Test 4.2: Should handle empty stdin"
TOTAL=$((TOTAL + 1))
OUTPUT=$(echo "" | tsx "$BLOCK_HOOK" 2>/dev/null || true)
if [ $? -eq 0 ]; then
  echo "  ✓ graceful exit on empty stdin"
  PASS=$((PASS + 1))
else
  echo "  ✗ crashed on empty stdin"
  FAIL=$((FAIL + 1))
fi

# ── Test Suite 5: diff-lines.ts script ───────────────────

echo ""
echo "═══ Test Suite: diff-lines.ts ═══"
echo ""

DIFF_SCRIPT=".claude/skills/review-guidelines/scripts/diff-lines.ts"

# Create a test diff
cat > /tmp/test-diff.txt <<'DIFFEOF'
diff --git a/src/auth.ts b/src/auth.ts
index abc123..def456 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,6 +10,9 @@ export function authenticate(token: string) {
   const decoded = jwt.verify(token, secret);
   const user = await findUser(decoded.sub);
   if (!user) throw new AuthError("User not found");
+  if (!user.active) throw new AuthError("Account disabled");
+  user.lastLogin = new Date();
+  await user.save();
   return user;
 }
diff --git a/src/config.ts b/src/config.ts
new file mode 100644
--- /dev/null
+++ b/src/config.ts
@@ -0,0 +1,4 @@
+export const config = {
+  port: 3000,
+  secret: process.env.SECRET,
+};
DIFFEOF

echo "Test 5.1: Should parse all commentable lines"
LINE_COUNT=$(tsx "$DIFF_SCRIPT" /tmp/test-diff.txt | jq length)
TOTAL=$((TOTAL + 1))
if [ "$LINE_COUNT" -gt 0 ]; then
  echo "  ✓ parsed $LINE_COUNT commentable lines"
  PASS=$((PASS + 1))
else
  echo "  ✗ parsed 0 lines"
  FAIL=$((FAIL + 1))
fi

echo "Test 5.2: Should filter by file path"
CONFIG_LINES=$(tsx "$DIFF_SCRIPT" /tmp/test-diff.txt src/config.ts | jq length)
TOTAL=$((TOTAL + 1))
if [ "$CONFIG_LINES" -ge 4 ] && [ "$CONFIG_LINES" -le 5 ]; then
  echo "  ✓ src/config.ts has $CONFIG_LINES lines"
  PASS=$((PASS + 1))
else
  echo "  ✗ expected 4 lines for src/config.ts, got $CONFIG_LINES"
  FAIL=$((FAIL + 1))
fi

echo "Test 5.3: Added lines have correct line numbers"
FIRST_ADDED=$(tsx "$DIFF_SCRIPT" /tmp/test-diff.txt src/auth.ts | jq '[.[] | select(.type=="added")][0].line')
TOTAL=$((TOTAL + 1))
if [ "$FIRST_ADDED" = "13" ]; then
  echo "  ✓ first added line in auth.ts is line 13"
  PASS=$((PASS + 1))
else
  echo "  ✗ expected line 13, got $FIRST_ADDED"
  FAIL=$((FAIL + 1))
fi

echo "Test 5.4: Added lines have side=RIGHT"
RIGHT_COUNT=$(tsx "$DIFF_SCRIPT" /tmp/test-diff.txt | jq '[.[] | select(.type=="added" and .side=="RIGHT")] | length')
ADDED_COUNT=$(tsx "$DIFF_SCRIPT" /tmp/test-diff.txt | jq '[.[] | select(.type=="added")] | length')
TOTAL=$((TOTAL + 1))
if [ "$RIGHT_COUNT" = "$ADDED_COUNT" ]; then
  echo "  ✓ all added lines have side=RIGHT"
  PASS=$((PASS + 1))
else
  echo "  ✗ not all added lines have side=RIGHT ($RIGHT_COUNT/$ADDED_COUNT)"
  FAIL=$((FAIL + 1))
fi

echo "Test 5.5: Can search by content pattern"
MATCH=$(tsx "$DIFF_SCRIPT" /tmp/test-diff.txt src/auth.ts | jq '.[] | select(.content | contains("lastLogin"))')
TOTAL=$((TOTAL + 1))
if echo "$MATCH" | jq -e '.line == 14' > /dev/null 2>&1; then
  echo "  ✓ found 'lastLogin' at line 14"
  PASS=$((PASS + 1))
else
  echo "  ✗ could not find 'lastLogin' at expected line"
  echo "    Got: $MATCH"
  FAIL=$((FAIL + 1))
fi

echo "Test 5.6: New file starts at line 1"
FIRST_LINE=$(tsx "$DIFF_SCRIPT" /tmp/test-diff.txt src/config.ts | jq '.[0].line')
TOTAL=$((TOTAL + 1))
if [ "$FIRST_LINE" = "1" ]; then
  echo "  ✓ new file src/config.ts starts at line 1"
  PASS=$((PASS + 1))
else
  echo "  ✗ expected line 1, got $FIRST_LINE"
  FAIL=$((FAIL + 1))
fi

echo "Test 5.7: Returns empty for non-existent file"
EMPTY=$(tsx "$DIFF_SCRIPT" /tmp/test-diff.txt src/nonexistent.ts | jq length)
TOTAL=$((TOTAL + 1))
if [ "$EMPTY" = "0" ]; then
  echo "  ✓ empty result for non-existent file"
  PASS=$((PASS + 1))
else
  echo "  ✗ expected 0 results, got $EMPTY"
  FAIL=$((FAIL + 1))
fi

# ── Summary ──────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════"
echo "  Results: $PASS/$TOTAL passed, $FAIL failed"
echo "═══════════════════════════════════════════"
echo ""

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi

exit 0
