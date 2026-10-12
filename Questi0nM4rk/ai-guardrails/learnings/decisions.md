# Notable Review Decisions

## Bench harness quality bar
- bench/ files are subject to identical project constraints as src/ (no extends, no any, Zod at boundaries, no scratch dirs in repo). The bench directory is not exempt from the project's NON-NEGOTIABLE rules even though it is not shipped as a binary.

## Exit-code semantics are authoritative
- Claude Code's hook protocol defines exit 2 as the sole blocking exit code; all other non-zero exits are non-blocking. Reviewers must flag any harness or test that uses `!== 0` for block detection as a correctness bug, not a style issue.

## README accuracy over simplicity
- Metric labels in README are documentation that consumers rely on for capability claims. An inaccurate label (e.g., claiming "dangerous commands" when Write/Edit rows are included) is a correctness finding, not a nitpick.

## markdownlint line-length violations are blocking
- The project's lefthook pre-commit gate runs markdownlint with MD013 at 300 cols. Lines over the limit prevent commits; treat as blocking in review.
