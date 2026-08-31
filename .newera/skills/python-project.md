---
name: python-project
description: Build and verify a Python project (CLI tool, script suite, data pipeline, or small library) on a Linux CI runner. Use when the brief asks for Python, pip, a script, a scraper, data processing, or a command-line tool. Covers venv discipline, dependency pins, the test loop, and packaging. Read BEFORE the first `pip install`.
---

# Python project on a Linux runner

## Quick facts

- `python3` + `pip` are preinstalled (no setup-python step needed). Version: check `python3 --version` first and pin expectations to what is there.
- **Always use a venv** so `pip check` reflects only this project:
  ```bash
  python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt
  ```
  and run everything through `.venv/bin/python` — the runner's global site-packages is shared and untrustworthy.
- **Deploy note:** Python is NOT static-hostable through the pages pipeline. Ship a runnable CLI + tests; if a web UI is also required, produce a static UI separately and call the Python side the backend with the blocker documented.

## The build loop

1. Create venv, `pip install -r requirements.txt`.
2. First run: `.venv/bin/python -m <module>` or the CLI entry — it must execute end to end before adding features.
3. Feature slices → re-run the entry point after each; then run tests.
4. Tests: `pip install pytest` and `tests/test_*.py` with plain asserts. Run `.venv/bin/python -m pytest -q`.
5. Lint pass: `.venv/bin/python -m pyflakes .` (or `python -m py_compile` per file when offline).

## Conventions

```
<package>/
  __init__.py
  cli.py          ← argparse entry, thin — logic lives in modules
  core.py         ← pure logic, importable and testable
  utils.py
tests/
  test_core.py    ← mirrors core.py
requirements.txt  ← pinned: requests==2.32.3 style (NOT requirements.in)
README.md         ← run + install commands
```

- Entry point thin, logic pure: a `cli.py` that only parses args and calls `core.run(args)` is testable; a 400-line `main()` is not.
- `if __name__ == "__main__":` guard only in the entry module.
- CLI: `argparse` from the stdlib; subcommands for multi-verb CLIs.
- External calls: `requests` with `timeout=30` ALWAYS — an unbounded fetch hangs the job to its deadline.
- File IO: `pathlib.Path` over string paths; explicit `encoding="utf-8"` everywhere.

## Common failure → fix table

| Error | Fix |
|---|---|
| `ModuleNotFoundError: No module named '<pkg>'` | run through the venv: `.venv/bin/python`; or missing `__init__.py` |
| `pip install` fails on a wheel | no compiler on the image — prefer pure-python wheels, or `--only-binary :all:` |
| CLI hangs forever | `requests` without `timeout=`, or an input() waiting on stdin that does not exist |
| `SyntaxError` under older python | check `python3 --version` — match language level (no walrus on 3.7, etc.) |
| Tests import the package but fail | run `pytest` from the repo ROOT so `<package>/` is on sys.path |
| FileNotFoundError in tests | use `tmp_path` fixture — never write into the repo tree |

## Pre-finish checklist

- [ ] venv + `requirements.txt` installs clean
- [ ] entry point runs end to end with a real invocation
- [ ] `.venv/bin/python -m pytest -q` exits 0
- [ ] README shows the exact install + run commands
- [ ] finish summary documents the static-deploy reality for Python honestly