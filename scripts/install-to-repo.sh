#!/usr/bin/env bash
set -euo pipefail

# Quick install — copies only workflows + config to a target repo.
# Bot intelligence (.claude/) is fetched at CI runtime from github.com/Questi0nM4rk/cc-review.
# Assumes secrets are already configured. For full setup, use setup.sh instead.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="$(dirname "$SCRIPT_DIR")"

if [[ $# -lt 1 ]]; then
    echo "Usage: $0 /path/to/target/repo"
    echo ""
    echo "Copies workflow files and .cc-review.yaml to the target repo."
    echo "Bot prompts are fetched at CI runtime — nothing else needed in the repo."
    echo "You still need to configure secrets — run setup.sh for full setup."
    exit 1
fi

TARGET="$1"

if [[ ! -d "$TARGET/.git" ]]; then
    echo "Error: $TARGET is not a git repository"
    exit 1
fi

echo "Installing cc-review bot to: $TARGET"

FILES=(
    ".github/workflows/cc-review.yml"
    ".github/workflows/cc-review-interactive.yml"
    ".cc-review.yaml"
)

for file in "${FILES[@]}"; do
    mkdir -p "$TARGET/$(dirname "$file")"
    cp "$TEMPLATE_DIR/$file" "$TARGET/$file"
done

echo ""
echo "Done! Installed ${#FILES[@]} files:"
for file in "${FILES[@]}"; do
    echo "  $file"
done
echo ""
echo "Target repo is clean — no .claude/ files needed."
echo "Bot intelligence is fetched at CI runtime from github.com/Questi0nM4rk/cc-review."
echo ""
echo "Next steps:"
echo "  1. Edit .cc-review.yaml to configure review behavior for this project"
echo "  2. Configure secrets if not done (run scripts/setup.sh for full setup)"
echo "  3. Commit and push the installed files"
