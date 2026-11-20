# Migration Checklist

Comprehensive checklist for migrating Python projects to the course's default toolchain.

## Before Migration

- [ ] **Determine layout**: `src/` or flat? The gate's `typePaths` resolves to `src` when a `src/`
      directory exists, and workspace members each contribute their own `src/`.
- [ ] **Decide uv.lock strategy**: application (commit it) vs library (still commit it — the gate
      runs `uv lock --check` and `uv sync --locked`)
- [ ] **Backup current state**: Create a branch or tag before starting

## Cleanup Old Artifacts

Find and remove legacy linter comments:

```bash
# Find files with old linter pragmas
rg "# pylint:|# noqa:|# type: ignore" --files-with-matches

# Find missing __init__.py files
uv run ruff check --select=INP001 .
```

Remove these files after migration:
- [ ] `requirements.txt`, `requirements-dev.txt`
- [ ] `setup.py`, `setup.cfg`, `MANIFEST.in`
- [ ] `.flake8`, `pyrightconfig.json`, `mypy.ini` (pyproject tables replace the standalone file)
- [ ] `tox.ini` (if not needed)
- [ ] `Pipfile`, `Pipfile.lock`
- [ ] Old virtual environments (`venv/`, `.venv/`)

## .gitignore Updates

Add these entries:

```gitignore
# Python
__pycache__/
*.py[cod]
.venv/

# Tools
.ruff_cache/
.mypy_cache/
.coverage
htmlcov/

# uv (commit uv.lock; the venv and caches are local)
# uv.lock
```

## pyproject.toml Sections to Remove

- [ ] `[tool.black]`
- [ ] `[tool.isort]`
- [ ] `[tool.pyright]`
- [ ] `[tool.pylint]`
- [ ] `[tool.flake8]` (if present)
- [ ] Old lenient `[tool.mypy]` settings — replace them with the course default
      (`python_version = "3.13"`, `strict = true`); do **not** delete the table outright if the
      project already type-checks

## pyproject.toml Sections to Add

Use the generated block as the source of truth ([pyproject.md](./pyproject.md)):

- [ ] `[dependency-groups]` with `lint`, `test`, `security`, and a `dev` aggregator
      (`include-group` for the other three, so `uv sync --all-groups` installs everything)
- [ ] `[tool.ruff]`: `line-length = 88`, `target-version = "py313"`, `src = ["src"]`
- [ ] `[tool.ruff.lint]`: `select = ["E", "F", "I", "B", "UP"]`
- [ ] `[tool.mypy]`: `python_version = "3.13"`, `strict = true`
- [ ] `[tool.pytest.ini_options]`: `testpaths` and `addopts = "-ra --strict-markers"`
- [ ] `[tool.coverage.run]` (`branch = true`, `source = ["src"]`) and
      `[tool.coverage.report]` (`show_missing = true`, `fail_under`)
- [ ] `[tool.uv] required-version = ">=0.5"`
- [ ] `[tool.uv.workspace] members` + `[tool.uv.sources]` for a multi-package repository

Do not add a coverage flag to `addopts`: the floor lives in `[tool.coverage.report] fail_under`
and both `pytest --cov` and `coverage report` read it.

## Post-Migration Easy Wins

Run these to modernize code automatically:

```bash
# Pyupgrade modernization (typing, syntax)
uv run ruff check --select=UP --fix .

# Unnecessary variable assignments before return
uv run ruff check --select=RET504 --fix .

# Simplifications (conditionals, comprehensions)
uv run ruff check --select=SIM --fix .

# Remove commented-out code
uv run ruff check --select=ERA --fix .
```

## CI Cleanup

- [ ] Remove scheduled CI triggers (activity without progress is theater)
- [ ] Run `uv lock --check` before anything installs
- [ ] Replace hand-written install steps with the gate's `sync` stage:
      `uv sync --locked --all-groups`
- [ ] Run lint (`ruff check` **and** `ruff format --check`), type, manifest, test, security, build
      in that order — the generated workflow does exactly this
- [ ] Pin GitHub Actions to SHA hashes
- [ ] Set up the security stage once: detect-secrets in the `security` group plus an audited
      `.secrets.baseline` (see [security-setup.md](./security-setup.md))
- [ ] Enable the optional `audit` stage if the project wants dependency advisories

## Gradual mypy Adoption

For legacy codebases with many type errors, keep `mypy` and start lenient **per module** — do not
switch checkers and do not turn strict mode off globally:

```toml
[tool.mypy]
python_version = "3.13"
strict = true

# Tolerate legacy modules first; delete each override as the module is fixed.
[[tool.mypy.overrides]]
module = ["legacy.*", "vendor.*"]
ignore_errors = true
```

Remove the overrides as you fix errors. Track progress:

```bash
# Count remaining issues (strict errors are the same ones the gate reports)
uv run --locked mypy src 2>&1 | tail -n 1
```

A project that **already** uses `ty` keeps `ty`; that is a migration of its own, not part of this
checklist, and running both checkers in one gate is a defect (see
[pyproject.md](./pyproject.md#type-checking-tables)).

## Supply Chain Security

- [ ] Add detect-secrets to the `security` dependency group (locked), create the baseline once, and
      **audit** it — the pipeline scans read-only and never writes the baseline
- [ ] Treat `pip-audit` as the optional `audit` stage
      (`uv run --locked --with pip-audit pip-audit`), never as the default gate
- [ ] Configure Dependabot with a 7-day cooldown (see [dependabot.md](./dependabot.md))
- [ ] Pin exact versions in production (`==` not `>=`)

## Verification

After migration, run what CI will run:

```bash
# Lockfile is up to date
uv lock --check

# Install every group from the lockfile
uv sync --all-groups

# Linting and formatting
uv run ruff check .
uv run ruff format --check .

# Type checking (the project's checker: mypy by default, ty only if already in use)
uv run --locked mypy src

# Version manifest
uv run --locked python scripts/validate_version_manifest.py

# Tests (the coverage floor comes from pyproject.toml)
uv run --locked pytest --cov --cov-report=term-missing

# Secret scan (read-only; fails when the baseline is missing)
uv run --locked python scripts/secret_scan.py

# Build the distribution
uv build
```

`pip-audit` is deliberately absent from the default list: it belongs to the opt-in `audit` stage.
