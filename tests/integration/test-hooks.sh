#!/usr/bin/env bash
# Integration tests for cc-review hooks and CLI.
# Runs inside Docker (or locally if tsx is installed).
# Exit code 0 = all pass, non-zero = failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FIXTURES="$SCRIPT_DIR/fixtures"
HOOK_DIR="${HOOK_ROOT:-.claude/hooks}"
CLI_SCRIPT="${CLI_ROOT:-.claude/skills/review-guidelines/scripts}/review-cli.ts"

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

assert_exit_code() {
  local test_name="$1"
  local expected="$2"
  local actual="$3"
  TOTAL=$((TOTAL + 1))

  if [ "$actual" = "$expected" ]; then
    echo "  ✓ $test_name"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $test_name (expected exit=$expected, got=$actual)"
    FAIL=$((FAIL + 1))
  fi
}

# ── Test Suite 1: enforce-review-cli.ts — Block Patterns ──

echo ""
echo "═══ Test Suite: enforce-review-cli.ts — Block Patterns ═══"
echo ""

ENFORCE_HOOK="$HOOK_DIR/scripts/enforce-review-cli.ts"

echo "Test 1.1: Should BLOCK 'gh pr review' commands"
OUTPUT=$(run_hook "$ENFORCE_HOOK" "$FIXTURES/enforce-gh-pr-review.json")
assert_decision "decision=block" "block" "$OUTPUT"
assert_contains "reason mentions review-cli.ts post" "review-cli.ts post" "$OUTPUT"

echo ""
echo "Test 1.2: Should BLOCK 'gh api .../reviews --method POST' commands"
OUTPUT=$(run_hook "$ENFORCE_HOOK" "$FIXTURES/enforce-gh-api-post-review.json")
assert_decision "decision=block" "block" "$OUTPUT"
assert_contains "reason mentions review-cli.ts post" "review-cli.ts post" "$OUTPUT"

echo ""
echo "Test 1.3: Should BLOCK 'gh api .../reviews' with APPROVE"
OUTPUT=$(run_hook "$ENFORCE_HOOK" "$FIXTURES/enforce-gh-api-approve.json")
assert_decision "decision=block" "block" "$OUTPUT"
assert_contains "reason mentions review-cli.ts approve" "review-cli.ts approve" "$OUTPUT"

echo ""
echo "Test 1.4: Should BLOCK 'gh api graphql' with resolveReviewThread"
OUTPUT=$(run_hook "$ENFORCE_HOOK" "$FIXTURES/enforce-graphql-resolve.json")
assert_decision "decision=block" "block" "$OUTPUT"
assert_contains "reason mentions review-cli.ts resolve" "review-cli.ts resolve" "$OUTPUT"

# ── Test Suite 2: enforce-review-cli.ts — Allow Patterns ──

echo ""
echo "═══ Test Suite: enforce-review-cli.ts — Allow Patterns ═══"
echo ""

echo "Test 2.1: Should ALLOW review-cli.ts commands"
OUTPUT=$(run_hook "$ENFORCE_HOOK" "$FIXTURES/enforce-review-cli-allowed.json")
assert_decision "decision=allow" "allow" "$OUTPUT"

echo ""
echo "Test 2.2: Should ALLOW 'gh api .../reviews --method GET' (read-only)"
OUTPUT=$(run_hook "$ENFORCE_HOOK" "$FIXTURES/enforce-gh-api-get-reviews.json")
assert_decision "decision=allow" "allow" "$OUTPUT"

echo ""
echo "Test 2.3: Should ALLOW unrelated commands"
OUTPUT=$(run_hook "$ENFORCE_HOOK" "$FIXTURES/hook-input-unrelated.json")
assert_decision "decision=allow" "allow" "$OUTPUT"

# ── Test Suite 3: settings.json + hooks.json structure ────

echo ""
echo "═══ Test Suite: settings.json + hooks.json validation ═══"
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
if [ "$HOOK_COUNT" = "1" ]; then
  echo "  ✓ 1 hook registered (enforce-review-cli)"
  PASS=$((PASS + 1))
else
  echo "  ✗ expected 1 hook, got $HOOK_COUNT"
  FAIL=$((FAIL + 1))
fi

assert_json_eq "hook runs enforce-review-cli.ts" \
  '.hooks.PreToolUse[0].hooks[0].command' \
  "tsx .claude/hooks/scripts/enforce-review-cli.ts" "$SETTINGS"

# Verify old hooks are gone
TOTAL=$((TOTAL + 1))
if [ ! -f "$HOOK_DIR/scripts/block-pr-review.ts" ]; then
  echo "  ✓ block-pr-review.ts deleted"
  PASS=$((PASS + 1))
else
  echo "  ✗ block-pr-review.ts still exists (should be deleted)"
  FAIL=$((FAIL + 1))
fi

TOTAL=$((TOTAL + 1))
if [ ! -f "$HOOK_DIR/scripts/fix-review-payload.ts" ]; then
  echo "  ✓ fix-review-payload.ts deleted"
  PASS=$((PASS + 1))
else
  echo "  ✗ fix-review-payload.ts still exists (should be deleted)"
  FAIL=$((FAIL + 1))
fi

# ── Test Suite 4: hook-runtime.ts module ─────────────────

echo ""
echo "═══ Test Suite: hook-runtime.ts module ═══"
echo ""

echo "Test 4.1: Should handle invalid JSON on stdin"
TOTAL=$((TOTAL + 1))
OUTPUT=$(echo "not json" | tsx "$ENFORCE_HOOK" 2>/dev/null || true)
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
OUTPUT=$(echo "" | tsx "$ENFORCE_HOOK" 2>/dev/null || true)
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

# ── Test Suite 6: review-cli.ts dry-run ──────────────────

echo ""
echo "═══ Test Suite: review-cli.ts dry-run ═══"
echo ""

echo "Test 6.1: post --dry-run produces valid payload"
OUTPUT=$(tsx "$CLI_SCRIPT" post --repo owner/repo --pr 42 --diff "$FIXTURES/sample-diff.txt" --findings "$FIXTURES/sample-findings.json" --dry-run 2>/dev/null)
EXIT_CODE=$?
assert_exit_code "exit code 0" "0" "$EXIT_CODE"

TOTAL=$((TOTAL + 1))
if echo "$OUTPUT" | jq empty 2>/dev/null; then
  echo "  ✓ output is valid JSON"
  PASS=$((PASS + 1))
else
  echo "  ✗ output is not valid JSON"
  echo "    Got: $OUTPUT"
  FAIL=$((FAIL + 1))
fi

TOTAL=$((TOTAL + 1))
EVENT=$(echo "$OUTPUT" | jq -r '.event' 2>/dev/null || echo "MISSING")
if [ "$EVENT" = "REQUEST_CHANGES" ]; then
  echo "  ✓ event=REQUEST_CHANGES (has findings)"
  PASS=$((PASS + 1))
else
  echo "  ✗ expected event=REQUEST_CHANGES, got $EVENT"
  FAIL=$((FAIL + 1))
fi

TOTAL=$((TOTAL + 1))
COMMENT_COUNT=$(echo "$OUTPUT" | jq '.comments | length' 2>/dev/null || echo "0")
if [ "$COMMENT_COUNT" -ge 1 ]; then
  echo "  ✓ has $COMMENT_COUNT inline comment(s)"
  PASS=$((PASS + 1))
else
  echo "  ✗ expected at least 1 inline comment, got $COMMENT_COUNT"
  FAIL=$((FAIL + 1))
fi

TOTAL=$((TOTAL + 1))
BODY=$(echo "$OUTPUT" | jq -r '.body' 2>/dev/null || echo "")
if echo "$BODY" | grep -q "Outside Diff"; then
  echo "  ✓ body has 'Outside Diff' section (for null-file finding)"
  PASS=$((PASS + 1))
else
  echo "  ✗ expected 'Outside Diff' section in body"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "Test 6.2: post --dry-run with zero findings → APPROVE"
echo '{"summary":"LGTM","findings":[]}' > /tmp/empty-findings.json
OUTPUT=$(tsx "$CLI_SCRIPT" post --repo owner/repo --pr 42 --diff "$FIXTURES/sample-diff.txt" --findings /tmp/empty-findings.json --dry-run 2>/dev/null)
TOTAL=$((TOTAL + 1))
EVENT=$(echo "$OUTPUT" | jq -r '.event' 2>/dev/null || echo "MISSING")
if [ "$EVENT" = "APPROVE" ]; then
  echo "  ✓ event=APPROVE (no findings)"
  PASS=$((PASS + 1))
else
  echo "  ✗ expected event=APPROVE, got $EVENT"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "Test 6.3: post without required args → exit 1"
EXIT_CODE=0
tsx "$CLI_SCRIPT" post --repo owner/repo --pr 42 2>/dev/null || EXIT_CODE=$?
assert_exit_code "exit code 1 (missing --diff/--findings)" "1" "$EXIT_CODE"

echo ""
echo "Test 6.4: unknown subcommand → exit 1"
EXIT_CODE=0
tsx "$CLI_SCRIPT" bogus --repo owner/repo --pr 42 2>/dev/null || EXIT_CODE=$?
assert_exit_code "exit code 1 (unknown subcommand)" "1" "$EXIT_CODE"

echo ""
echo "Test 6.5: no args → exit 1"
EXIT_CODE=0
tsx "$CLI_SCRIPT" 2>/dev/null || EXIT_CODE=$?
assert_exit_code "exit code 1 (no args)" "1" "$EXIT_CODE"

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
