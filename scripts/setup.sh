#!/usr/bin/env bash
# Thin wrapper — the real setup is in TypeScript for cross-platform support.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec npx tsx "$SCRIPT_DIR/setup.ts" "$@"
