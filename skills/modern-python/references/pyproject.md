# pyproject.toml Configuration Reference

Complete reference for configuring `pyproject.toml` for modern Python projects.

**Default vs. wide.** This skill's default is the course's **chapter 8 baseline**: Ruff at its
formatter's own width (88), a narrow rule set (`E`, `F`, `I`, `B`, `UP`), `mypy --strict`, and a
coverage floor that lives in `[tool.coverage.report]`. That is the configuration a new project
starts from, and the one the toolchain generator writes. The pre-v0.10 wide policy
(`select = ["ALL"]`) still exists, but as an explicit opt-in — see
[Wide policy (opt-in)](#wide-policy-opt-in) and [ruff-config.md](./ruff-config.md).

**Important**: Always use `uv add` and `uv remove` to manage dependencies. Do not hand-edit the
`dependencies` or `dependency-groups` sections of a project that is already managed.

## Course-default Configuration

This is the complete block the generator appends to a new project. Tables only: an existing file
is never rewritten, only missing tables are appended.

```toml
[project]
name = "myproject"
version = "0.1.0"
description = "A modern Python project"
readme = "README.md"
requires-python = ">=3.13"
dependencies = []

[project.scripts]
myproject = "myproject.cli:main"

[build-system]
requires = ["uv_build>=0.9,<1"]  # uv init writes this range; keep the one it chose
build-backend = "uv_build"

[dependency-groups]
dev = [
    { include-group = "lint" },
    { include-group = "test" },
    { include-group = "security" },
]
lint = ["mypy>=1.15,<2.0", "ruff>=0.11,<1.0"]
test = ["pytest>=8.3,<10.0", "pytest-cov>=6.0,<8.0"]
security = ["detect-secrets>=1.5,<2.0"]

[tool.ruff]
line-length = 88
target-version = "py313"
src = ["src"]

[tool.ruff.lint]
select = ["E", "F", "I", "B", "UP"]

[tool.ruff.lint.per-file-ignores]
# Generated scripts own their wrapping; the formatter below already steps aside.
"scripts/**/*.py" = ["E501"]

[tool.ruff.format]
quote-style = "double"
indent-style = "space"
docstring-code-format = true
exclude = [
    "scripts/ci.py",
    "scripts/secret_scan.py",
    "scripts/validate_version_manifest.py",
    "scripts/container_report.py",
]

[tool.mypy]
python_version = "3.13"
strict = true

[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = "-ra --strict-markers"

[tool.coverage.run]
branch = true
source = ["src"]

[tool.coverage.report]
show_missing = true
fail_under = 90

[tool.uv]
required-version = ">=0.5"
```

Why each choice:

| Choice | Reason |
|--------|--------|
| `line-length = 88` | `ruff format`'s own default, so `ruff check` and `ruff format --check` cannot disagree about a line that is one character long |
| `select = ["E", "F", "I", "B", "UP"]` | The rules that catch mistakes which cost money: undefined names, unused imports, import order, bugbear footguns, pyupgrade drift |
| `mypy` + `strict = true` | A checker only pays for itself when its output is actionable; `strict` is the bundle of flags that gets you there |
| `fail_under` in `[tool.coverage.report]` | The one place both `pytest --cov` and a bare `coverage report` read. A floor in pytest `addopts` only applies when pytest happens to run, and creates a second number that can silently win |
| `dev` re-exports the others | `uv sync --all-groups` is the only command anyone needs to remember, and the groups cannot drift apart |
| `required-version` | One uv behaviour for the whole team; a lower bound only, so a newer compatible uv is not rejected |

### Coverage floor: new vs. existing projects

- **New project**: `fail_under = 90`.
- **Existing project**: add the table conservatively with `fail_under = 80`, then raise it once a
  baseline exists. A number the project cannot satisfy on day one gets deleted or disabled.
- **No measurable baseline**: omit `fail_under` entirely. A floor nobody measured is a guess
  dressed as a policy; the plugin's resolver reports `null` in that case.

## Section Reference

### [project]

Core project metadata following PEP 621.

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Package name (lowercase, hyphens) |
| `version` | Yes | Semantic version |
| `description` | No | One-line description |
| `readme` | No | Path to README file |
| `license` | No | SPDX license identifier |
| `requires-python` | Recommended | Interpreter range; keep it in sync with `.python-version` |
| `authors` | No | List of author dicts |
| `dependencies` | No | Runtime dependencies (managed by `uv add`) |

`requires-python = ">=3.13"` is what `uv init` writes against a 3.13 interpreter; narrowing it
(`>=3.13,<3.14`) is a legitimate choice for an application that will not be tested on 3.14.

### [project.optional-dependencies]

**Rarely needed.** Only use for optional *runtime* features that end users install:

```toml
[project.optional-dependencies]
postgres = ["psycopg2"]
```

**Do NOT use for dev tools** — use `[dependency-groups]` instead.

### [project.scripts]

Console entry points:

```toml
[project.scripts]
myproject = "myproject.cli:main"
myproject-serve = "myproject.server:run"
```

### [build-system]

Build backend configuration. `uv init` writes `uv_build`; keep it for a src-layout package:

```toml
[build-system]
requires = ["uv_build>=0.9,<1"]  # use the range uv init wrote; check https://pypi.org/project/uv-build/
build-backend = "uv_build"
```

`uv_build` is simpler and sufficient for most projects. Use static versioning in
`[project].version` rather than VCS-aware dynamic versioning.

For flat layout (no `src/` directory), configure the module root:

```toml
[tool.uv.build-backend]
module-root = ""
```

> **Note:** These tools evolve rapidly. Prefer `>=X.Y,<X+1` constraints for tooling to get newer
> releases within the same major version.

### [dependency-groups]

Development dependencies (PEP 735). Unlike optional-dependencies, these are NOT installed by
users, and they keep pytest and ruff out of the runtime set:

```toml
[dependency-groups]
dev = [
    { include-group = "lint" },
    { include-group = "test" },
    { include-group = "security" },
]
lint = ["mypy>=1.15,<2.0", "ruff>=0.11,<1.0"]
test = ["pytest>=8.3,<10.0", "pytest-cov>=6.0,<8.0"]
security = ["detect-secrets>=1.5,<2.0"]

# Opt-in: the audit stage is not part of the default gate.
audit = ["pip-audit"]
```

Install everything with: `uv sync --all-groups`

`dev` is not a junk drawer: it re-exports the other groups with `include-group`, so a tool version
lives in exactly one place. The optional `audit` group is for the opt-in `audit` stage; the
workflow's audit job can equally use `uv run --locked --with pip-audit pip-audit` and install
nothing permanently.

### [tool.uv]

uv-specific configuration:

```toml
[tool.uv]
required-version = ">=0.5"
```

`required-version` is a lower bound on purpose: a generator cannot know which uv is installed, an
upper bound would reject a newer compatible one, and an exact pin would reject every machine one
patch release ahead.

### Workspace root (multi-package)

When several packages live in one repository, the root declares them and names its workspace
dependencies by package name:

```toml
[tool.uv.workspace]
members = ["packages/release_guard", "packages/*"]

[tool.uv.sources]
release-guard = { workspace = true }
```

`members` are paths (globs allowed). `[tool.uv.sources]` maps a **package name** — read from the
member's own `pyproject.toml` — to the workspace copy. `uv build --all-packages` is only valid
from a workspace root; a single package builds with plain `uv build`.

## Ruff Tables

The default is deliberately narrow; see [ruff-config.md](./ruff-config.md) for the full reference
and the wide policy.

```toml
[tool.ruff]
line-length = 88
target-version = "py313"
src = ["src"]

[tool.ruff.lint]
select = ["E", "F", "I", "B", "UP"]
```

- `line-length`: the formatter's own default, so lint and format agree.
- `target-version`: the project's interpreter, not the author's — otherwise `UP` suggests syntax
  the project cannot run.
- `src = ["src"]`: lets the isort rules resolve `src/`-layout first-party imports.
- `src` in `[tool.ruff]` is not `[tool.coverage.run].source`; they answer different questions.

### Wide policy (opt-in)

Choose it only for a greenfield codebase with no legacy debt, where "default deny" is genuinely
the cheapest way to keep the tree clean. The ignores are not preferences — they are what makes
`ALL` usable at all:

```toml
[tool.ruff.lint]
select = ["ALL"]
ignore = [
    "D",       # pydocstyle: docstring requirements, enable selectively
    "COM812",  # formatter conflict: missing trailing comma
    "ISC001",  # formatter conflict: implicit string concatenation
    "CPY001",  # copyright header: organisation policy, not a property of code
]

[tool.ruff.lint.per-file-ignores]
"**/tests/**/*.py" = ["S101", "PLR2004", "ANN"]  # assertions/magic values are the point
"scripts/**/*.py" = ["T20", "INP001", "S603", "PTH100", "SIM105", "E501"]
"__init__.py" = ["F401"]                        # re-exports
```

An existing codebase is the wrong place for `ALL`: adopt it through `extend-select` one family at a
time, or keep the narrow default and add the rules the team actually argues about.

## Type Checking Tables

`mypy` in `strict` mode is the default. A project that already uses `ty` keeps `ty` — switching
checkers is its own migration, not a configuration detail.

### mypy (default)

```toml
[tool.mypy]
python_version = "3.13"
strict = true
```

`python_version` must match the interpreter the project targets: mypy analyzes against it, not
against whatever runs the hook. `strict = true` bundles the flags that make findings actionable;
per-module relaxations belong in `[[tool.mypy.overrides]]`, added deliberately as `strict` reveals
them.

### ty (only when the project already uses ty)

```toml
[tool.ty.terminal]
error-on-warning = true

[tool.ty.environment]
python-version = "3.13"
```

`python-version` lives under `[tool.ty.environment]`; putting a `python-version` key directly in
`[tool.ty]` is the anti-pattern the course calls out — it is in the wrong table and is silently
ignored. Do not run both checkers in one gate: two type checkers disagreeing is a migration
project, not a CI style.

## pytest Tables

pytest reads `[tool.pytest.ini_options]`. The short `[tool.pytest]` form from older notes is not a
table pytest 8 looks at, so following it literally produces a configuration file whose settings
are silently ignored.

```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = "-ra --strict-markers"
```

- `testpaths`: keeps a bare `pytest` on the suite instead of collecting vendored code. In a
  src-layout package whose tests are inside the package (`src/tests`), point it there.
- `-ra`: prints the reasons for skips and xfails, which is the difference between a green run
  that means something and a green run with eight silently skipped tests.
- `--strict-markers`: a typo'd marker becomes an error instead of a silently deselected test.
- **No coverage flags here.** The floor lives in `[tool.coverage.report]`; see below.

## Coverage Tables

```toml
[tool.coverage.run]
branch = true
source = ["src"]

[tool.coverage.report]
show_missing = true
fail_under = 90
```

- `branch = true`: an `if` nobody has taken the other way is not covered.
- `source`: first-party code only. Without it the number includes test files themselves and
  flatters every project.
- `show_missing`: uncovered line numbers are what make a failure actionable.
- `fail_under`: the floor. Both `pytest --cov` and `coverage report` read it, so the number is
  enforced on every path. Do **not** duplicate it as a coverage flag in pytest `addopts` — a
  second floor silently wins whenever the two disagree.

The test stage runs:

```bash
uv run --locked pytest --cov --cov-report=term-missing
```

## Version Specifiers

| Specifier | Meaning |
|-----------|---------|
| `>=1.0` | At least version 1.0 |
| `>=1.0,<2.0` | Version 1.x only |
| `~=1.4` | Compatible release (>=1.4, <2.0) |
| `==1.4.*` | Any 1.4.x version |

## uv.lock Handling

| Project Type | uv.lock in Git? | Why |
|--------------|-----------------|-----|
| Application | ✅ Commit | Reproducible deploys; the lock stage runs `uv lock --check` |
| Library | ❌ .gitignore | Users resolve their own deps |

## Common Patterns

### Library Package

```toml
[project]
name = "mylib"
version = "0.1.0"
requires-python = ">=3.13"
dependencies = []  # minimal runtime deps

[project.optional-dependencies]
async = ["httpx"]  # user installs with mylib[async]

[dependency-groups]
dev = [{ include-group = "lint" }, { include-group = "test" }, { include-group = "security" }]
lint = ["mypy>=1.15,<2.0", "ruff>=0.11,<1.0"]
test = ["pytest>=8.3,<10.0", "pytest-cov>=6.0,<8.0"]
security = ["detect-secrets>=1.5,<2.0"]
```

### Application Package

```toml
[project]
name = "myapp"
version = "0.1.0"
requires-python = ">=3.13"
dependencies = ["fastapi", "uvicorn", "sqlalchemy"]

[project.scripts]
myapp = "myapp.main:run"

[dependency-groups]
dev = [{ include-group = "lint" }, { include-group = "test" }, { include-group = "security" }]
lint = ["mypy>=1.15,<2.0", "ruff>=0.11,<1.0"]
test = ["pytest>=8.3,<10.0", "pytest-cov>=6.0,<8.0"]
security = ["detect-secrets>=1.5,<2.0"]
```

### CLI Tool

```toml
[project]
name = "mytool"
version = "0.1.0"
requires-python = ">=3.13"
dependencies = ["typer", "rich"]

[project.scripts]
mytool = "mytool.cli:app"

[dependency-groups]
dev = [{ include-group = "lint" }, { include-group = "test" }, { include-group = "security" }]
lint = ["mypy>=1.15,<2.0", "ruff>=0.11,<1.0"]
test = ["pytest>=8.3,<10.0", "pytest-cov>=6.0,<8.0"]
security = ["detect-secrets>=1.5,<2.0"]
```

## Existing Projects

The generator appends only the tables a project is missing and never rewrites `[project]`. When
migrating by hand, the same rule applies: keep the values the project already has (line length,
rule set, checker, test paths) and add what is missing — a migration that also reflows every file
is a migration nobody finishes. The resolver reports where each value came from
(`existing` / `detected` / `default`), which is what makes "adopt gradually" auditable instead of
hopeful.
