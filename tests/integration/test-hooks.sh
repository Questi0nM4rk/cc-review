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
