---
name: memory-load
description: "Load project memory from the claude-reviewer/memory branch."
allowed-tools: "Bash(git:*)"
---

Load the project memory file from the `claude-reviewer/memory` branch.

```bash
git show claude-reviewer/memory:MEMORY.md 2>/dev/null || echo "No project memory found. This is a fresh project — memory will be created after the first review."
```

Store the content in your context. This memory contains:
- Recurring patterns and anti-patterns seen in this codebase
- Common mistakes made by contributors
- Project-specific conventions and architectural decisions
- Known false positives to skip
- Language/framework quirks specific to this project

Use this context to make your review more targeted and avoid repeating feedback the team already knows.
