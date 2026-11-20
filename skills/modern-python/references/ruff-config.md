# Ruff Configuration Reference

Ruff is an extremely fast Python linter and formatter written in Rust. It replaces flake8, black,
isort, pyupgrade, pydocstyle, and many other tools.

**This skill's default is the course's chapter 8 baseline**, not Ruff's maximum. A narrow rule set
is easier to keep green, and a green gate that people trust beats a broad one they learn to ignore.
The wide policy is documented below as an explicit opt-in.

## Default Setup (Course Baseline)

```toml
[tool.ruff]
line-length = 88
target-version = "py313"
src = ["src"]

[tool.ruff.lint]
select = ["E", "F", "I", "B", "UP"]

[tool.ruff.lint.per-file-ignores]
# The generated scripts own their wrapping; the formatter already steps aside.
"scripts/**/*.py" = ["E501"]

[tool.ruff.format]
quote-style = "double"
indent-style = "space"
docstring-code-format = true
```

Why these values:

- **`line-length = 88`** is `ruff format`'s own default. A different linter width is how you get a
  file the formatter reflows and the linter then reports — two tools, one line, neither wrong.
- **`target-version = "py313"`** must be the project's interpreter, not the author's. `UP` rewrites
  toward `target-version`; a newer target silently suggests syntax the project cannot run.
- **`src = ["src"]`** lets the isort rules resolve `src/`-layout first-party imports.
- **`select = ["E", "F", "I", "B", "UP"]`** catches undefined names, unused imports, import order,
  bugbear footguns, and pyupgrade drift — the mistakes that cost debugging time. Add a family when
  a project needs it with `extend-select`, not by adopting everything and then suppressing it.

The gate runs two separate commands, in this order:

```bash
uv run --locked ruff check .
uv run --locked ruff format --check .
```

They are separate on purpose: one is correctness, the other is style, and a combined step hides
which of the two failed.

## Wide Policy (Opt-in)

The pre-v0.10 default: every rule on, with the relaxations that make `ALL` usable. Choose it for a
**greenfield codebase with no legacy debt**, where default-deny is the cheapest way to keep the
tree clean. Do not choose it for an existing codebase — you will spend the first week adding
ignores, and the ignore list becomes the real policy nobody wrote down.

```toml
[tool.ruff]
line-length = 88
target-version = "py313"
src = ["src"]

[tool.ruff.lint]
select = ["ALL"]
ignore = [
    "D",       # pydocstyle: docstring requirements, enable selectively
    "COM812",  # formatter conflict: missing trailing comma
    "ISC001",  # formatter conflict: implicit string concatenation
    "CPY001",  # copyright header: organisation policy, not a property of code
]

[tool.ruff.lint.per-file-ignores]
"**/tests/**/*.py" = ["S101", "PLR2004", "ANN"]
"scripts/**/*.py" = ["T20", "INP001", "S603", "PTH100", "SIM105", "E501"]
"__init__.py" = ["F401"]
```

The four ignores are not preferences:

| Rule | Why it is off even in the wide policy |
|------|----------------------------------------|
| `D` | Docstring *requirements* are a policy; turning them on for every file makes a fresh project fail on its own first run |
| `COM812` | Documented formatter conflict: the fix the linter wants is the one the formatter removes |
| `ISC001` | Same formatter conflict, for implicit string concatenation |
| `CPY001` | A copyright header belongs to the organisation, not to the code; `ALL` turns it on everywhere |

### Migrating between the two policies

Narrow → wide: do it once, in a greenfield project, with the per-file relaxations above already in
place. Wide → narrow: keep the current config until the tree is green, then move the families you
actually rely on into `extend-select` and drop `ALL` — the diff is small and the policy becomes
readable.

Add rules to the narrow default without changing the policy:

```toml
[tool.ruff.lint]
select = ["E", "F", "I", "B", "UP"]
extend-select = ["PT", "SIM"]   # pytest style, simplification
```

## Running Ruff

```bash
# Lint
uv run --locked ruff check .
uv run --locked ruff check --fix .                # Auto-fix
uv run --locked ruff check --fix --unsafe-fixes . # Including unsafe fixes

# Format
uv run --locked ruff format .
uv run --locked ruff format --check .  # Check only (used by the lint stage)
uv run --locked ruff format --diff .   # Show diff
```

## Rule Categories

The default enables `E`, `F`, `I`, `B`, `UP` (bold rows). The rest are available through
`extend-select`.

| Code | Category | Description | Default |
|------|----------|-------------|---------|
| `E`, `W` | pycodestyle | Style errors and warnings | ✅ `E` |
| `F` | Pyflakes | Logical errors | ✅ |
| `I` | isort | Import sorting | ✅ |
| `UP` | pyupgrade | Python upgrade suggestions | ✅ |
| `B` | flake8-bugbear | Bug detection | ✅ |
| `N` | pep8-naming | Naming conventions | |
| `D` | pydocstyle | Docstring conventions | |
| `S` | flake8-bandit | Security issues | |
| `A` | flake8-builtins | Built-in shadowing | |
| `C4` | flake8-comprehensions | Comprehension improvements | |
| `DTZ` | flake8-datetimez | Timezone-aware datetime | |
| `T10` | flake8-debugger | Debugger statements | |
| `T20` | flake8-print | Print statements | |
| `PT` | flake8-pytest-style | Pytest style | |
| `Q` | flake8-quotes | Quote consistency | |
| `SIM` | flake8-simplify | Simplification suggestions | |
| `TID` | flake8-tidy-imports | Import hygiene | |
| `ARG` | flake8-unused-arguments | Unused arguments | |
| `ERA` | eradicate | Commented-out code | |
| `PL` | Pylint | Pylint rules | |
| `RUF` | Ruff-specific | Ruff's own rules | |
| `ANN` | flake8-annotations | Type annotation checks | |

## Ignores

### Formatter conflicts (only relevant with the wide policy)

If you enable `ALL`, these two must stay off — ruff's own docs list them as formatter conflicts:

```toml
ignore = ["COM812", "ISC001"]
```

### Common opt-in ignores

```toml
ignore = [
    "ANN401",   # Dynamically typed Any
    "TD002",    # Missing TODO author
    "TD003",    # Missing TODO link
    "FIX002",   # Line contains TODO
]
```

## Per-File Ignores

Default policy: only the generated scripts need a line-width exemption, because the generator owns
their wrapping and the formatter already skips them:

```toml
[tool.ruff.lint.per-file-ignores]
"scripts/**/*.py" = ["E501"]
```

Wide policy: tests, scripts and re-exports need the relaxations shown in
[Wide policy](#wide-policy-opt-in). Scope them narrowly — a repo-wide `"ALL"` ignore is not a
relaxation, it is a second, invisible policy.

Migration directories, when a project has them, are the one legitimate whole-file exception:

```toml
"**/migrations/*.py" = ["ALL"]
```

## Import Sorting (isort)

```toml
[tool.ruff.lint.isort]
known-first-party = ["myproject"]
required-imports = ["from __future__ import annotations"]
```

`known-first-party` (or `src = ["src"]` in `[tool.ruff]`) is what makes import order stable for a
src-layout package; without it ruff guesses and the first-party block moves between runs.

## Docstring Style (pydocstyle)

Docstrings are off by default. If you enable them, choose a convention and do not mix it with
`D203`/`D213` — those two disagree with the other convention's blank-line rules:

```toml
[tool.ruff.lint]
extend-select = ["D"]

[tool.ruff.lint.pydocstyle]
convention = "google"  # or "numpy", "pep257"
```

## Formatter Configuration

```toml
[tool.ruff.format]
quote-style = "double"           # or "single"
indent-style = "space"           # or "tab"
skip-magic-trailing-comma = false
line-ending = "auto"             # or "lf", "crlf"
docstring-code-format = true
docstring-code-line-length = 88  # keep it equal to line-length
```

### Excluding generated files from the formatter

Files a generator writes must not be reformatted by a later tool run: the formatter rewrites them
according to the *target* Python version, so a hand-checked layout is correct for one interpreter
and wrong for the next, and the gate runs `ruff format --check`. Linting still applies; only
formatting steps aside:

```toml
[tool.ruff.format]
exclude = [
    "scripts/ci.py",
    "scripts/secret_scan.py",
    "scripts/validate_version_manifest.py",
    "scripts/container_report.py",
]
```

## Type Checking

Ruff does not type-check. This skill's default checker is **mypy in strict mode**:

```bash
# Already in the lint group of a generated project
uv run --locked mypy src
```

```toml
[tool.mypy]
python_version = "3.13"
strict = true
```

A project that **already** uses `ty` keeps `ty` — swapping checkers is a migration, not a CI
decision. Only then does the second configuration apply:

```toml
[tool.ty.terminal]
error-on-warning = true

[tool.ty.environment]
python-version = "3.13"
```

`[tool.ty.environment] python-version` is the correct location; a `python-version` key directly in
`[tool.ty]` is silently ignored. Do not run mypy and ty in the same gate.

See [pyproject.md](./pyproject.md#type-checking-tables) for the rationale and per-module overrides.

## CI Configuration

```yaml
# GitHub Actions
- name: Lint
  run: |
    uv run --locked ruff check .
    uv run --locked ruff format --check .
```

The gate deliberately passes no `--output-format=github`: the same command has to run on a laptop
and on a runner, and an output format that only exists in one of them is where the two commands
start to drift. If you want the annotations, add them at the workflow level, not in the project's
lint command.

## Migration from Other Tools

### From flake8

Ruff covers most flake8 plugins. Remove:
- flake8
- flake8-* plugins
- `.flake8` config file

Map each rule family you actually relied on into `select`/`extend-select`; do not replace
`ignore = [...]` with `select = ["ALL"]` — that trades a list you read for a list you filter.

### From black

Remove black and use `ruff format`. Remove:
- black
- `[tool.black]` config

Keep `line-length = 88` (black's default and the formatter's), so the migration produces a diff
about rules, not about line wrapping.

### From isort

Ruff includes isort. Remove:
- isort
- `[tool.isort]` config

Use `[tool.ruff.lint.isort]` for isort settings.

## Code Modernization

Run pyupgrade rules to modernize syntax to your target Python version:

```bash
uv run --locked ruff check --select=UP --fix .  # Auto-fix upgrades
uv run --locked ruff check --select=UP .        # Preview only
```

Common modernizations include:
- `typing.Optional[X]` → `X | None`
- `typing.List[X]` → `list[X]`
- `super(ClassName, self)` → `super()`
- Format strings and other syntax upgrades

## Line Length Migration

The default is 88. If an existing project uses 100 or 120, **keep its width** for the first pass:

```toml
line-length = 120  # match existing; tighten in a dedicated commit
```

Changing the width reflows every file and buries the actual migration diff. Tighten later, with the
formatter run alone, so the change is reviewable as formatting and nothing else.
