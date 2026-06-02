# Strict review checklist — TypeScript

Read this when the diff touches `*.ts`, `*.tsx`, `*.mts`, `*.cts`. Flag any violation as a required change (imperative mood, no severity labels).

## Types
- `any` introduced — use `unknown` + narrowing, or a real type. `any` disables checking for everything it touches.
- Non-null assertion `!` without a guard proving non-null — it silences the compiler, not the bug.
- `as` cast that hides a real shape mismatch (especially `as unknown as T`) — model the type correctly instead.
- `switch`/discriminated union without an exhaustive `never` check — new variants slip through silently.
- Public function missing an explicit return type where inference is non-obvious.

## Async
- Floating promise — a promise not awaited and not explicitly `void`ed. Unhandled rejection / lost error.
- `array.forEach(async ...)` — the async callbacks are not awaited. Use `for...of` + await, or `Promise.all(map(...))`.
- Sequential `await`s over independent work in a loop — parallelize with `Promise.all`.
- `async` function with a `try` that swallows and returns a default — the caller cannot tell success from failure.

## Correctness / quality
- Optional/possibly-undefined accessed without `?.` or a guard.
- Unused imports / dead exports introduced alongside new code.
- `eval`, `new Function`, or `innerHTML` with non-constant input — injection. (Also security.)
- Mutating a parameter object/array the caller still owns.

## Typecheck (tsgo)
- The PR must typecheck clean. Verify with **`tsgo --noEmit`** — `tsgo` is the native Go TypeScript compiler (TS v7-era), the project's typecheck tool. Flag any type error the diff introduces.
- If `tsgo` is unavailable, fall back to `tsc --noEmit`; note which was used.

## Verify
- `tsgo --noEmit` (or `tsc --noEmit`) clean on the changed files.
- New behavior needs tests; assertions must check the contract, not the implementation.
