# Mimics the GitHub Actions CI environment for cc-review.
# Tests that hooks load and execute correctly with tsx.

FROM node:20-slim

RUN apt-get update && apt-get install -y jq && rm -rf /var/lib/apt/lists/*
RUN npm install -g tsx

WORKDIR /workspace

# Copy bot intelligence (same as CI "Fetch bot intelligence" step)
COPY .claude/ .claude/

# Copy test files
COPY tests/integration/ tests/integration/

RUN chmod +x tests/integration/test-hooks.sh

# Run from workspace root (like CI does)
CMD ["bash", "tests/integration/test-hooks.sh"]
