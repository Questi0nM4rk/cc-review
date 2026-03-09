---
description: Review guidelines and quality standards for automated PR reviews
globs: "**/*"
alwaysApply: true
---

# Review Guidelines

## Severity Classification

When reviewing code, classify findings by severity:

| Severity | Action | Examples |
|----------|--------|----------|
| Critical | Request changes | Security vulnerabilities, data loss, crashes |
| High | Request changes | Logic bugs, race conditions, broken functionality |
| Medium | Approve + comment | Performance issues, missing validation on boundaries |
| Low | Approve silently | Style preferences, naming, formatting |

## Language-Specific Patterns

### C# / .NET
- Check for `IDisposable` not being disposed (especially `HttpClient`, `DbContext`)
- Flag `async void` methods (except event handlers)
- Watch for LINQ materializing large collections (`.ToList()` in hot paths)
- Verify `ConfigureAwait` is used appropriately in library code

### TypeScript / JavaScript
- Check for unhandled promise rejections
- Flag `any` types that hide real bugs
- Watch for missing `await` on async calls

### General
- SQL injection via string concatenation
- Secrets or credentials in code
- Missing authorization checks on endpoints
- Unbounded queries without pagination
