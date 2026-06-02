# Strict review checklist — .NET / C#

Read this when the diff touches `*.cs`, `*.csproj`, `*.sln`. Flag any violation as a required change (imperative mood, no severity labels).

## Async / concurrency
- `.Result` / `.Wait()` / `.GetAwaiter().GetResult()` on a Task — blocking on async, deadlock + thread-starvation risk. Make the caller async and `await`.
- `async void` on anything but an event handler — the exception escapes the await chain and crashes the process.
- `await` inside a `foreach` over independent work — sequential round-trips. Batch with `Task.WhenAll` or a single query.
- A `CancellationToken` available but not passed down — cancellation does not propagate.
- Library code awaiting without `ConfigureAwait(false)` only matters pre-`net8` ASP.NET; do not flag in modern minimal-API/host code.

## EF Core / data
- Lazy-loaded navigation accessed inside a loop — N+1. Eager-load with a projection or `Include`.
- Read-only query without `AsNoTracking()` — wasted change-tracking on large reads.
- `SaveChanges`/`SaveChangesAsync` inside a loop — one round-trip per row. Batch.
- Multiple writes that must be atomic without a transaction / a context-restoration marker interface boundary.
- Raw SQL string interpolation into a query — parameterize. (Also a security finding.)

## Lifetime / disposal
- `IDisposable` / `IAsyncDisposable` created and not disposed (`using` / `await using`).
- Captive dependency: a singleton holding a scoped/transient service (e.g. `DbContext` captured by a singleton).
- `HttpClient` newed per call — socket exhaustion. Use `IHttpClientFactory`.

## Correctness / quality
- Nullable reference types ignored: dereference without a null check where the type is `T?`. Prefer `ArgumentNullException.ThrowIfNull`.
- `IEnumerable` enumerated more than once (each pass re-runs the query/work).
- `catch (Exception) { }` or catching broadly and swallowing — at minimum log and rethrow or handle specifically.
- String concatenation in a loop — use `StringBuilder` or `string.Join`.

## Verify
- The PR must build: `dotnet build -warnaserror` clean. Flag any new warning.
- New public surface needs tests; bug fixes need a regression test.
