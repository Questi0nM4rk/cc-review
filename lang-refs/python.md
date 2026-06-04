# Strict review checklist — Python

Read this when the diff touches `*.py`, `*.pyi`. Flag any violation as a required change (imperative mood, no severity labels).

## Correctness traps
- Mutable default argument (`def f(x=[])` / `={}`) — the default is shared across calls. Use `None` + assign inside.
- Bare `except:` or `except Exception:` that swallows — catch the specific exception; log or re-raise.
- Resource opened without a context manager (`with open(...)`, `with conn`) — leaked file/socket/cursor handles.
- Late-binding closure in a loop (`lambda: i` capturing the loop var) — bind via default arg.
- Comparing with `==` to `None`/`True`/`False` — use `is`.

## Types
- Public function/method missing type hints — the contract is undocumented and unchecked.
- `Any` used where a concrete type or `Protocol` fits — it disables checking.
- The PR must pass the type checker: verify with `mypy` or `pyright` on the changed files; flag new errors.

## Async
- A coroutine called but not awaited — it never runs.
- A blocking call (sync I/O, `time.sleep`, heavy CPU) inside an `async def` — it stalls the event loop. Offload or use the async variant.
- Independent awaits run sequentially — use `asyncio.gather`.

## Performance / memory
- Building a full `list` where a generator suffices for a large/streamed dataset.
- Repeated membership tests against a `list` in a loop — use a `set`/`dict`.

## Security
- `subprocess` with `shell=True` and any non-constant input — command injection. Pass an arg list.
- `eval` / `exec` / `pickle.loads` on untrusted input.
- String-formatted SQL — parameterize.

## Verify
- `mypy`/`pyright` and `ruff` (or the project's linter) clean on changed files.
- Bug fixes need a regression test; new code paths need coverage.
