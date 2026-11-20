# Testing with pytest

Configuration and best practices for pytest with coverage enforcement.

The coverage floor is **project configuration**, not a command-line flag: it lives in
`[tool.coverage.report] fail_under`, which both `pytest --cov` and a bare `coverage report` read.
The test stage runs `uv run --locked pytest --cov --cov-report=term-missing` and never passes a
coverage threshold on the command line.

## Setup

Add test dependencies (a generated project already has the `test` group):

```bash
uv add --group test pytest pytest-cov
uv sync --all-groups
```

Optional extras:

```bash
uv add --group test pytest-asyncio  # async tests
uv add --group test hypothesis      # property-based tests
```

## pyproject.toml Configuration

```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = "-ra --strict-markers"
markers = [
    "slow: marks tests as slow",
    "integration: marks integration tests",
]
filterwarnings = [
    "error",                    # Treat warnings as errors
    "ignore::DeprecationWarning:third_party.*",
]

[tool.coverage.run]
branch = true
source = ["src"]

[tool.coverage.report]
show_missing = true
fail_under = 90
```

- **`[tool.pytest.ini_options]`** is the table pytest 8 reads. The short `[tool.pytest]` form from
  older notes is not a table pytest looks at, so its settings are silently ignored.
- **`testpaths`** keeps a bare `pytest` on the suite instead of collecting vendored code. A package
  whose tests live inside the package (`src/tests`) points it there; the generator uses the
  detected path for the project.
- **`addopts`** carries only `-ra --strict-markers`: skip/xfail reasons are printed, and a typo'd
  marker is an error instead of a silently deselected test.
- **No coverage flags in `addopts`.** `--cov` and `--cov-report` come from the test stage command;
  the floor is `fail_under` in `[tool.coverage.report]`.
- **`fail_under`**: 90 for a new project, 80 when adding the table to an existing one, and omitted
  entirely when no baseline has been measured. A floor the project cannot satisfy gets deleted or
  disabled.

### Test paths for src layouts

| Layout | `testpaths` | Why |
|--------|-------------|-----|
| src layout, top-level tests | `["tests"]` | The common case |
| src layout, tests inside the package | `["src/tests"]` | Keeps the suite with the code it tests |
| flat layout | `["test"]` or `["tests"]` | Use whichever exists; do not create both |

## Project Structure

```
myproject/
├── src/
│   └── myproject/
│       ├── __init__.py
│       └── core.py
├── tests/
│   ├── __init__.py
│   ├── conftest.py          # Shared fixtures
│   ├── test_core.py
│   └── integration/
│       └── test_api.py
└── pyproject.toml
```

## Running Tests

```bash
# Run all tests (the gate's command)
uv run --locked pytest --cov --cov-report=term-missing

# Plain run, no coverage
uv run --locked pytest

# Verbose output
uv run --locked pytest -v

# Specific file / test
uv run --locked pytest tests/test_core.py
uv run --locked pytest tests/test_core.py::test_function_name

# Tests matching a pattern
uv run --locked pytest -k "test_parse"

# Marked tests
uv run --locked pytest -m "not slow"
uv run --locked pytest -m integration

# Stop on first failure
uv run --locked pytest -x

# Run last failed
uv run --locked pytest --lf
```

The gate's test stage uses `--cov --cov-report=term-missing` with no threshold flag: the
number is in `pyproject.toml`, so a local run, a hook run and CI all enforce the same floor.

## Coverage Commands

```bash
# Coverage for one package during development
uv run --locked pytest --cov=myproject --cov-report=term-missing

# HTML report
uv run --locked pytest --cov=myproject --cov-report=html
open htmlcov/index.html

# Report from existing data (also enforces fail_under)
uv run --locked coverage report
uv run --locked coverage html
```

`coverage report` reads `fail_under` from `[tool.coverage.report]`. That is why the floor belongs
there and not in pytest `addopts`: the gate and a manual report must not be able to disagree.

## Writing Tests

### Basic Test

```python
# tests/test_core.py
from myproject.core import add_numbers

def test_add_numbers():
    assert add_numbers(2, 3) == 5

def test_add_negative():
    assert add_numbers(-1, 1) == 0
```

### Using Fixtures

```python
# tests/conftest.py
import pytest
from myproject.db import Database

@pytest.fixture
def db():
    """Provide a test database."""
    database = Database(":memory:")
    database.init()
    yield database
    database.close()

@pytest.fixture
def sample_data(db):
    """Populate database with sample data."""
    db.insert({"name": "test"})
    return db
```

```python
# tests/test_db.py
def test_query(sample_data):
    result = sample_data.query("test")
    assert result is not None
```

### Parametrized Tests

```python
import pytest

@pytest.mark.parametrize("input,expected", [
    ("hello", 5),
    ("", 0),
    ("test", 4),
])
def test_string_length(input, expected):
    assert len(input) == expected
```

### Testing Exceptions

```python
import pytest
from myproject.core import divide

def test_divide_by_zero():
    with pytest.raises(ZeroDivisionError):
        divide(1, 0)

def test_divide_by_zero_message():
    with pytest.raises(ZeroDivisionError, match="division by zero"):
        divide(1, 0)
```

### Async Tests

```python
import pytest

@pytest.mark.asyncio
async def test_async_function():
    result = await fetch_data()
    assert result is not None
```

### Property-Based Testing with Hypothesis

```python
from hypothesis import given, strategies as st
from myproject.core import reverse_string, add

@given(st.text())
def test_reverse_is_reversible(s):
    assert reverse_string(reverse_string(s)) == s

@given(st.integers(), st.integers())
def test_add_commutative(a, b):
    assert add(a, b) == add(b, a)
```

## Markers

```python
import pytest

@pytest.mark.slow
def test_slow_operation():
    # Long running test
    pass

@pytest.mark.integration
def test_api_call():
    # Requires a real service; the opt-in `integration` stage runs these
    pass

@pytest.mark.skip(reason="Not implemented yet")
def test_future_feature():
    pass

@pytest.mark.skipif(sys.platform == "win32", reason="Unix only")
def test_unix_feature():
    pass
```

Declare every marker in `markers = [...]`: with `--strict-markers`, an undeclared marker is an
error, and an error is cheaper than a test that silently stopped running.

The generated gate splits the suite by marker: the default `test` stage runs everything, and the
opt-in `integration` stage runs `uv run --locked pytest -m integration` when the project has tests
that need a real database or network.

## CI Configuration

The test stage inside the generated workflow is one step:

```yaml
- name: Test
  run: uv run --locked pytest --cov --cov-report=term-missing
```

It relies on two earlier steps: `uv sync --frozen --all-groups` (the sync stage; the local gate uses
`--locked`) and `uv lock --check` (the lock stage). Coverage thresholds are not re-specified here —
they come from `[tool.coverage.report]`.

Optional upload of the terminal report as an artefact, if the project needs history:

```yaml
- name: Upload coverage HTML
  if: always()
  run: uv run --locked coverage html
  # then actions/upload-artifact with path: htmlcov/
```

Dependency auditing is a different gate: it is the opt-in `audit` stage
(`uv run --locked --with pip-audit pip-audit`), not a step of the test job. Keeping a failing test
and a vulnerable dependency on separate lines is what makes the notification actionable.

## Makefile Target

```makefile
.PHONY: test test-cov test-fast

test:
	uv run --locked pytest --cov --cov-report=term-missing

test-cov:
	uv run --locked pytest --cov --cov-report=html
	open htmlcov/index.html

test-fast:
	uv run --locked pytest -x -q --no-cov
```

`test-fast` skips coverage on purpose: during red/green iteration the floor is noise, and the full
run is one command away. The gate never uses `--no-cov`.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `fail_under` ignored | Floor is in `addopts`, or in `[tool.pytest]` instead of `[tool.pytest.ini_options]` | Move it to `[tool.coverage.report]` and check the table name |
| Tests not collected | `testpaths` points at a directory that does not exist | Point it at the real suite (`tests` or `src/tests`) |
| Async tests skipped | Missing `pytest-asyncio` or `asyncio_mode` | `uv add --group test pytest-asyncio` and set `asyncio_mode = "auto"` |
| Integration tests fail in CI | No database service or network | Move them to the opt-in `integration` stage / job |
| Coverage differs local vs CI | Different `source` or a stale `.coverage` file | Keep `source = ["src"]`; delete `.coverage` when in doubt |
