# Python Review Patterns

## Critical Patterns (Always Flag)

### Mutability Bugs
- Mutable default arguments (`def foo(items=[]): ...`) — shared across calls
- Modifying a dict/list while iterating over it
- Using mutable objects as dictionary keys

### Error Handling
- `except Exception: pass` — swallows all errors silently
- `except:` bare except — catches `SystemExit`, `KeyboardInterrupt`
- `except Exception as e: return None` — hides real errors from callers
- Missing `finally` for resource cleanup (prefer context managers)

### Security
- `eval()` or `exec()` on user input
- `os.system()` / `subprocess.call(shell=True)` with user input — command injection
- `pickle.load()` on untrusted data — arbitrary code execution
- SQL string formatting (`f"SELECT * FROM users WHERE id = {user_id}"`)
- Missing input validation on API endpoints (FastAPI: use Pydantic models)

### Type Safety
- `type: ignore` comments hiding real type issues
- `Any` type annotations where specific types are known
- `import *` from modules — namespace pollution, breaks type checking

### Async Patterns
- `asyncio.run()` called inside an already-running event loop
- Blocking calls (`time.sleep`, `requests.get`) inside async functions
- Missing `await` on coroutines (coroutine never executed)

## Medium Patterns (Flag if Clear Impact)

### Performance
- N+1 query patterns in ORM code (SQLAlchemy: use `joinedload`, `selectinload`)
- Loading entire file into memory when streaming would work
- Repeated regex compilation (use `re.compile` at module level)
- List comprehension where generator expression suffices for large data

### Code Quality
- Unnecessary classes wrapping functions (Java-brain pattern)
- `f"{str(x)}"` instead of `f"{x}"`
- `if len(items) == 0` instead of `if not items`
- Global state / module-level mutable variables
- Functions with 5+ parameters (use dataclass or typed dict)

### Resource Management
- File handles opened without `with` statement
- Database connections not properly pooled
- Missing `close()` on HTTP sessions / clients
