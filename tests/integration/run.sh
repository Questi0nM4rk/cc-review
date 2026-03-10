#!/usr/bin/env bash
# Build and run integration tests in Docker.
# Usage: ./tests/integration/run.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE_NAME="cc-review-integration-test"

echo "Building test image..."
docker build -t "$IMAGE_NAME" -f "$REPO_ROOT/tests/integration/Dockerfile" "$REPO_ROOT"

echo ""
echo "Running integration tests..."
docker run --rm "$IMAGE_NAME"
