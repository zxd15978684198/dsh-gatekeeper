---
name: modern-python
description: Configures Python projects with modern tooling (uv, ruff, mypy, pytest, prek). Use when creating projects, writing standalone scripts, or migrating from pip/Poetry/black/legacy type checkers.
---

# Modern Python

Guide for modern Python tooling and best practices, based on [trailofbits/cookiecutter-python](https://github.com/trailofbits/cookiecutter-python).

The **default configuration in this skill is the course's chapter 8 baseline** (“课程默认口径”), which is also what this plugin's generator writes: `line-length = 88`, `select = ["E","F","I","B","UP"]`, `mypy` with `strict = true`, a coverage floor in `[tool.coverage.report]`, and four dependency groups (`lint` / `test` / `security` / `dev`). The wide `select = ["ALL"]` policy still exists, but as an explicit opt-in, not the default — see [宽口径（可选）](#21-宽口径可选).

## When to Use This Skill

- Creating a new Python project or package
- Setting up `pyproject.toml` configuration
- Configuring development tools (linting, formatting, type checking, testing)
- Writing Python scripts with external dependencies
- Migrating from legacy tools (when user requests it)
- Choosing a type checker: the default is **mypy**; a project that already configures `ty` keeps `ty`

## When NOT to Use This Skill

- **User wants to keep legacy tooling**: Respect existing workflows if explicitly requested
- **Python < 3.11 required**: These tools target modern Python (new projects: 3.13)
- **Non-Python projects**: Mixed codebases where Python isn't primary

## Anti-Patterns to Avoid

| Avoid | Use Instead |
|-------|-------------|
| Swapping a working type checker for “a faster one” | Keep the project's checker; new projects use `mypy`, a project with `[tool.ty]` or a `ty` dependency keeps `ty` |
| 把覆盖门槛写进 pytest `addopts` | `[tool.coverage.report] fail_under` — the one place `pytest --cov` and `coverage report` both read |
| `select = ["ALL"]` as the default | `select = ["E","F","I","B","UP"]`; ALL + per-file-ignores only as an explicit choice |
| `[tool.ty]` python-version | `[tool.ty.environment]` python-version (only when the project uses ty) |
| `uv pip install` | `uv add` and `uv sync` |
| Editing pyproject.toml manually to add deps | `uv add <pkg>` / `uv remove <pkg>` |
| `hatchling` build backend | `uv_build` (simpler, sufficient for most cases) |
| Poetry | uv (faster, simpler, better ecosystem integration) |
| requirements.txt | PEP 723 for scripts, pyproject.toml for projects |
| `[project.optional-dependencies]` for dev tools | `[dependency-groups]` (PEP 735) |
| Manual virtualenv activation (`source .venv/bin/activate`) | `uv run <cmd>` |
| pre-commit | prek (faster, no Python runtime needed) |

**Key principles:**
- Always use `uv add` and `uv remove` to manage dependencies
- Never manually activate or manage virtual environments—use `uv run` for all commands
- Use `[dependency-groups]` for dev/test/docs dependencies, not `[project.optional-dependencies]`
- Keep the coverage floor out of command lines; it belongs in `[tool.coverage.report]`

## Decision Tree

```
What are you doing?
│
├─ Single-file script with dependencies?
│   └─ Use PEP 723 inline metadata (./references/pep723-scripts.md)
│
├─ New multi-file project (not distributed)?
│   └─ Minimal uv setup (see Quick Start below)
│
├─ New reusable package/library?
│   └─ Full project setup (see Full Setup below)
│
└─ Migrating existing project?
    └─ See Migration Guide below
```

## Tool Overview

| Tool | Purpose | Replaces |
|------|---------|----------|
| **uv** | Package/dependency management | pip, virtualenv, pip-tools, pipx, pyenv |
| **ruff** | Linting AND formatting | flake8, black, isort, pyupgrade, pydocstyle |
| **mypy** | Type checking (default) | pyright, ty (optional alternative for projects already using it) |
| **pytest** | Testing with coverage | unittest |
| **prek** | Pre-commit hooks ([setup](./references/prek.md)) | pre-commit (faster, Rust-native) |

### Security Tools

| Tool | Purpose | When It Runs |
|------|---------|--------------|
| **detect-secrets** | Secret detection | commit hook (staged files) and the CI `security` stage, via the generated `scripts/secret_scan.py` |
| **shellcheck** | Shell script linting | pre-commit |
| **actionlint** | Workflow syntax validation | pre-commit, CI |
| **zizmor** | Workflow security audit | pre-commit, CI |
| **pip-audit** | Dependency vulnerability scanning | opt-in CI `audit` stage, manual |
| **Dependabot** | Automated dependency updates | scheduled |

`security` is the secret scan. Dependency advisories are a different failure with a different fix, so pip-audit lives in the opt-in `audit` stage instead of sharing a colour with a leaked credential. See [security-setup.md](./references/security-setup.md).

## Quick Start: Minimal Project

For simple multi-file projects not intended for distribution:

```bash
# Create project with uv
uv init myproject
cd myproject

# Add dependencies
uv add requests rich

# Add dev dependencies, grouped by what they prove
uv add --group lint ruff mypy
uv add --group test pytest pytest-cov

# Run code
uv run python src/myproject/main.py

# Run tools
uv run ruff check .
uv run mypy src
uv run pytest
```

## Full Project Setup
If starting from scratch, ask the user if they prefer to use the Trail of Bits cookiecutter template to bootstrap a complete project with already preconfigured tooling.

```bash
uvx cookiecutter gh:trailofbits/cookiecutter-python
```

### 1. Create Project Structure

```bash
uv init --package myproject
cd myproject
```

This creates:
```
myproject/
├── pyproject.toml
├── README.md
├── src/
│   └── myproject/
│       └── __init__.py
└── .python-version
```

`uv init --package` writes a `uv_build` build system. The plugin never replaces an existing backend: `uv_build`, `hatchling` and `setuptools` are all kept as-is.

### 2. Configure pyproject.toml

See [pyproject.md](./references/pyproject.md) for complete configuration reference.

Key sections (the course default / what the generator writes for a new project):

```toml
[project]
name = "myproject"
version = "0.1.0"
requires-python = ">=3.13"
dependencies = []

# PEP 735 groups: `uv sync --all-groups` installs every one of these.
# `dev` aggregates the others with `include-group` so they cannot drift apart.
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

[tool.mypy]
python_version = "3.13"
strict = true

[tool.pytest.ini_options]
testpaths = ["src/tests"]
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

Why these values:

- `line-length = 88` is `ruff format`'s own default, so the linter and the formatter cannot disagree about a line one character long.
- `select = ["E","F","I","B","UP"]` catches the mistakes that cost money: undefined names, unused imports, import order, bugbear footguns, pyupgrade drift. Add rules per project with `extend-select` — do not adopt ALL and then ignore the storm.
- `mypy` with `strict = true` is the twelve flags bundled; a new project has no legacy annotations to fight, so it starts strict.
- `addopts = "-ra --strict-markers"`: `-ra` prints skip/xfail reasons; `--strict-markers` turns a typo'd marker into an error instead of a silently deselected test. **No coverage flags here.**
- `fail_under` lives in `[tool.coverage.report]` because that is the one place both `pytest --cov` and a bare `coverage report` read; a floor hidden in `addopts` silently wins whenever the two disagree. New projects start at 90; an existing project being adopted gets 80 until it has a baseline to defend.
- `[tool.uv] required-version` pins one uv behaviour for the team; a lower bound only, because the generator cannot know which uv is installed locally.

### 2.1 宽口径（可选）

The wide policy is the pre-v0.10 default: every rule on, relaxations explicit. It is a legitimate choice for a **greenfield codebase with no legacy debt**, where “default deny” is the fastest way to keep the tree clean. It is not the default because a copied `ALL` list is what makes people disable whole rule families later.

```toml
[tool.ruff.lint]
select = ["ALL"]
# Rules every project ends up suppressing; write down why instead of deleting them.
ignore = [
    "D",       # pydocstyle: docstring requirements, enable selectively
    "COM812",  # conflicts with the formatter
    "ISC001",  # conflicts with the formatter
    "CPY001",  # copyright header policy
]

[tool.ruff.lint.per-file-ignores]
"tests/**/*.py" = ["S101", "PLR2004"]   # asserts and literals in tests
"scripts/**/*.py" = ["E501", "T201"]    # generated scripts control their own wrapping
```

When to choose it, and when not:

- **Choose it** for a new project with no migrations ahead, or when the team wants to review each new rule as it appears (`ALL` is how ruff adds rules to your backlog automatically).
- **Avoid it** when adopting an existing codebase: the first `ruff check` produces a wall of violations, and the usual answer is a blanket ignore file that hides real findings.
- **Migrate incrementally** either way: start from the narrow set, then add rule families with `extend-select = ["S", "PT", ...]` and per-file relaxations. Same destination, smaller blast radius.

### 3. Sync the Environment

```bash
# Install all dependency groups
uv sync --all-groups

# Or install specific groups
uv sync --group dev
```

In CI the lock is proven first (`uv lock --check`) and then installed with `uv sync --locked --all-groups`, so the environment is exactly what the reviewed lock says. See the `ci-cd-and-automation` skill for the gate that runs these.

### 4. Add Makefile

```makefile
.PHONY: dev lint format type test build

dev:
	uv sync --all-groups

lint:
	uv run ruff format --check && uv run ruff check

type:
	uv run mypy src

format:
	uv run ruff format .

test:
	uv run pytest

build:
	uv build
```

### 5. Run the Gate

When the project is generated by this plugin it also gets `scripts/ci.py`, which runs the same stage list on a laptop as CI does:

```bash
uv run --locked python scripts/ci.py              # full gate, stop at first failure
uv run --locked python scripts/ci.py --profile commit   # the fast subset a git hook runs
uv run --locked python scripts/ci.py --from test         # resume from the stage that failed
uv run --locked python scripts/ci.py --list              # what exists, grouped by job
```

The order is `lock → sync → lint → type → manifest → test → security → build`; the details live in the `ci-cd-and-automation` skill.

## Migration Guide

When a user requests migration from legacy tooling:

### From requirements.txt + pip

First, determine the nature of the code:

**For standalone scripts**: Convert to PEP 723 inline metadata (see [pep723-scripts.md](./references/pep723-scripts.md))

**For projects**:
```bash
# Initialize uv in existing project
uv init --bare

# Add dependencies using uv (not by editing pyproject.toml)
uv add requests rich  # add each package

# Or import from requirements.txt (review each package before adding)
# Note: Complex version specifiers may need manual handling
grep -v '^#' requirements.txt | grep -v '^-' | grep -v '^\s*$' | while read -r pkg; do
    uv add "$pkg" || echo "Failed to add: $pkg"
done

uv sync
```

Then:
1. Delete `requirements.txt`, `requirements-dev.txt`
2. Delete virtual environment (`venv/`, `.venv/`)
3. Add `uv.lock` to version control

### From setup.py / setup.cfg

1. Run `uv init --bare` to create pyproject.toml
2. Use `uv add` to add each dependency from `install_requires`
3. Use `uv add --group dev` for dev dependencies
4. Copy non-dependency metadata (name, version, description, etc.) to `[project]`
5. Delete `setup.py`, `setup.cfg`, `MANIFEST.in`

### From flake8 + black + isort

1. Remove flake8, black, isort via `uv remove`
2. Delete `.flake8`, `pyproject.toml [tool.black]`, `[tool.isort]` configs
3. Add ruff: `uv add --group lint ruff`
4. Add ruff configuration (see [ruff-config.md](./references/ruff-config.md))
5. Run `uv run ruff check --fix .` to apply fixes
6. Run `uv run ruff format .` to format

### Type checker migration (only when explicitly requested)

The type checker is a project fact, not a plugin opinion: a repository already typing with mypy keeps mypy, one configured with `[tool.ty]` or a `ty` dependency keeps ty. Swapping checkers is its own migration, with its own PR, not a side effect of adding a CI gate.

If a migration is genuinely wanted:

1. **Adopting mypy strict on an existing codebase** — do not flip `strict = true` on day one. Add mypy first, then turn on strictness per module:
   ```toml
   [tool.mypy]
   python_version = "3.13"
   strict = true

   [[tool.mypy.overrides]]
   module = "legacy.*"
   strict = false
   ```
2. Run `uv run mypy src`, fix or annotate one module at a time, and shrink override blocks as they get clean.
3. Delete `mypy.ini` / `setup.cfg [mypy]` after moving the config into `pyproject.toml` — the plugin reads `[tool.mypy]`, and two config files drift.
4. If the project uses ty instead: keep `[tool.ty]` and the `ty` dependency, and the generator renders `ty check` for the `type` stage. Never render both checkers for one project.

## Quick Reference: uv Commands

| Command | Description |
|---------|-------------|
| `uv init` | Create new project |
| `uv init --package` | Create distributable package |
| `uv add <pkg>` | Add dependency |
| `uv add --group dev <pkg>` | Add to dependency group |
| `uv remove <pkg>` | Remove dependency |
| `uv sync` | Resolve and install the locked environment |
| `uv sync --all-groups` | Install all dependency groups |
| `uv lock --check` | Prove the lock matches the declarations |
| `uv run <cmd>` | Run command in venv |
| `uv run --with <pkg> <cmd>` | Run with temporary dependency |
| `uv build` | Build package |
| `uv publish` | Publish to PyPI |

### Ad-hoc Dependencies with `--with`

Use `uv run --with` for one-off commands that need packages not in your project:

```bash
# Run Python with a temporary package
uv run --with requests python -c "import requests; print(requests.get('https://httpbin.org/ip').json())"

# Run a module with temporary deps
uv run --with rich python -m rich.progress

# Multiple packages
uv run --with requests --with rich python script.py

# Combine with project deps (adds to existing venv)
uv run --with httpx pytest  # project deps + httpx
```

**When to use `--with` vs `uv add`:**
- `uv add`: Package is a project dependency (goes in pyproject.toml/uv.lock)
- `--with`: One-off usage, testing, or scripts outside a project context — e.g. the optional `audit` stage runs pip-audit this way so it never becomes a dependency the project did not ask for

See [uv-commands.md](./references/uv-commands.md) for complete reference.

## Quick Reference: Dependency Groups

```toml
[dependency-groups]
dev = [{include-group = "lint"}, {include-group = "test"}, {include-group = "security"}]
lint = ["ruff", "mypy"]
test = ["pytest", "pytest-cov"]
security = ["detect-secrets"]
```

Install with: `uv sync --all-groups` (or `--group lint --group test` for a narrower environment).

## Best Practices Checklist

- [ ] Use `src/` layout for packages
- [ ] Set `requires-python = ">=3.13"` for new projects (keep an older lower bound when the project genuinely supports it)
- [ ] Configure ruff with `line-length = 88` and `select = ["E","F","I","B","UP"]`; choose the wide `ALL` policy deliberately
- [ ] Type-check with `mypy` + `strict = true` for new projects; keep `ty` only when the project already uses it
- [ ] Put the coverage floor in `[tool.coverage.report] fail_under`, never in `addopts`
- [ ] Use the four dependency groups (`lint`, `test`, `security`, `dev`) instead of extras
- [ ] Create and audit `.secrets.baseline` once; never auto-regenerate it in a pipeline
- [ ] Add `uv.lock` to version control
- [ ] Use PEP 723 for standalone scripts

## Read Next

- [migration-checklist.md](./references/migration-checklist.md) - Step-by-step migration cleanup
- [pyproject.md](./references/pyproject.md) - Complete pyproject.toml reference
- [uv-commands.md](./references/uv-commands.md) - uv command reference
- [ruff-config.md](./references/ruff-config.md) - Ruff linting/formatting configuration
- [testing.md](./references/testing.md) - pytest and coverage setup
- [pep723-scripts.md](./references/pep723-scripts.md) - PEP 723 inline script metadata
- [prek.md](./references/prek.md) - Fast pre-commit hooks with prek
- [security-setup.md](./references/security-setup.md) - Security hooks and dependency scanning
- [dependabot.md](./references/dependabot.md) - Automated dependency updates
