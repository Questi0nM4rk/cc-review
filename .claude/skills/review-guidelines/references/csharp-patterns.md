# C# / .NET Review Patterns

## Critical Patterns (Always Flag)

### IDisposable Leaks
- `HttpClient` created per-request instead of via `IHttpClientFactory`
- `DbContext` not disposed (missing `using` or DI scope)
- `Stream`, `SqlConnection`, `HttpResponseMessage` without `using`/`await using`

### Async Anti-Patterns
- `async void` methods (except event handlers) — swallows exceptions
- `Task.Result` or `.Wait()` in async context — deadlock risk
- `Task.Run` wrapping already-async code — thread pool waste
- `async Task` methods with no `await` inside — misleading signature
- `ConfigureAwait(false)` in ASP.NET controllers/Razor — breaks HttpContext

### Null Safety
- `x.Property` without null check after `FirstOrDefault()`, `Find()`, dictionary lookup
- `x?.Method()` where the null case silently drops important work
- `!` null-forgiving operator hiding real nullability issues

### LINQ Materialization
- `.ToList()` or `.ToArray()` in hot paths when `IEnumerable` suffices
- `.Where().Count() > 0` instead of `.Any()`
- Multiple enumeration of `IEnumerable` (materialize once or use `IReadOnlyList`)

### Security
- String concatenation in SQL queries (use parameterized queries)
- `[AllowAnonymous]` on endpoints that handle sensitive data
- Secrets in `appsettings.json` instead of user secrets / env vars
- Missing `[ValidateAntiForgeryToken]` on state-changing endpoints

## Medium Patterns (Flag if Clear Impact)

### Performance
- N+1 queries via lazy loading in loops — use `.Include()` or projection
- `DateTime.Now` in loops instead of capturing once
- String concatenation in loops instead of `StringBuilder`
- Missing `AsNoTracking()` on read-only EF Core queries

### Error Handling
- `catch (Exception)` that swallows without logging
- `throw ex` instead of `throw` (loses stack trace)
- Missing validation on external input (API parameters, file reads)

### Modern C# Missed
- `if (x != null) { x.DoSomething(); }` instead of `x?.DoSomething()`
- `private readonly` fields that should be `const`
- Verbose null checks where pattern matching (`is not null`) is clearer
