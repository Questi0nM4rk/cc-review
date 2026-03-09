# TypeScript / JavaScript Review Patterns

## Critical Patterns (Always Flag)

### Type Safety
- `as any` casts hiding real type issues
- `!` non-null assertions instead of proper null handling
- `@ts-ignore` / `@ts-expect-error` without explanation
- `interface` with single property that could be the primitive type
- Missing discriminated union exhaustiveness checks (no `default` case)

### React-Specific
- `useEffect` with dependencies that cause infinite loops
- `useEffect` for derived state (should be `useMemo` or direct calculation)
- `useState` for values derivable from props/other state
- Missing cleanup in `useEffect` (timers, subscriptions, abort controllers)
- Stale closure bugs — referencing state in callbacks without deps

### Async Bugs
- Missing `await` on async calls (fire-and-forget without intent)
- `async/await` on functions that don't do anything async
- Unhandled promise rejections (`.catch()` missing)
- `Promise.all` where one failure should not cancel others (use `Promise.allSettled`)

### Security
- `innerHTML` / `dangerouslySetInnerHTML` with user input
- Template literals in SQL queries without parameterization
- Missing input validation/sanitization on API boundaries
- Secrets or API keys in client-side code

## Medium Patterns (Flag if Clear Impact)

### Performance
- `Object.keys(obj).forEach(...)` instead of `for...of` or direct iteration
- Barrel files (`index.ts`) creating circular dependencies
- Re-renders from new object/array literals in JSX props
- Missing `key` prop or using array index as key in dynamic lists

### Error Handling
- `try { ... } catch (e) { console.log(e) }` hiding errors
- Empty catch blocks
- `.catch(() => {})` swallowing promise errors

### Module Issues
- Circular imports between modules
- Side effects in module scope (runs on import)
- Default exports that complicate refactoring (prefer named exports)
