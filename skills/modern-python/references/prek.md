# Pre-commit Hooks with prek

Fast, reliable pre-commit hooks: installation, configuration, and how the local gate relates to CI.

## What is prek?

[prek](https://github.com/j178/prek) is a Rust binary that runs pre-commit hook configurations. It
reads the standard `.pre-commit-config.yaml` format and adds parallel execution, native single-binary
speed, and better UX. It is a drop-in replacement for `pre-commit` itself: same config file, same
hook ids, same `pre-commit-hooks.yaml` contract.

Why it matters for this toolchain: the commit hook must be **the same gate CI runs**, only shorter.
The generated config therefore invokes the project's own `scripts/ci.py --profile commit` through
`uv run --locked`, so the hook and CI share one lockfile, one ruff version, one mypy version, and one
set of stage definitions. A hook that installs its own copy of the tools is a second gate that can
disagree with the first.

## Installation

```bash
# Homebrew (recommended)
brew install prek

# Cargo
cargo install prek

# Standalone installer
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/j178/prek/releases/latest/download/prek-installer.sh | sh

# uv
uv tool install prek
```

Verify:

```bash
prek --version
```

## Quick Start

The project's `.pre-commit-config.yaml` is generated — copy it from the template, then install:

```bash
# Install the git hooks (writes .git/hooks/pre-commit)
prek install

# Run every hook against every file (first run is the slow one)
prek run --all-files

# Normal development: hooks run on commit
git add src/myproject/core.py
git commit -m "feat: add parser"
```

That is the whole daily loop. `prek install` is per-clone — a teammate who clones the repository and
runs `git commit` without installing gets no hooks, which is why CI must run the same profile.

## Configuration

The generated file has three parts: the repository's gate (two local hooks), formatter/lint hooks
from prek's own repositories, and a small set of hygiene hooks.

```yaml
# .pre-commit-config.yaml
default_language_version:
  python: "3.13"   # pin, or the hook language version follows whatever is first on PATH

repos:
  # Real linters/formatters, run as isolated tool environments with pinned revs.
  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: <pinned>  # renovate: datasource=github-releases depName=astral-sh/ruff-pre-commit
    hooks:
      - id: ruff
      - id: ruff-format

  # Language-agnostic hygiene.
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: <pinned>  # renovate: datasource=github-releases depName=pre-commit/pre-commit-hooks
    hooks:
      - id: trailing-whitespace
      - id: end-of-file-fixer
      - id: check-yaml
      - id: check-toml
      - id: check-merge-conflict

  # The project's own gate: one locked toolchain, driven by the generated scripts.
  - repo: local
    hooks:
      - id: gatekeeper
        name: gatekeeper (commit profile)
        entry: uv run --locked python scripts/ci.py --profile commit
        language: system
        pass_filenames: false
        always_run: true

      - id: gatekeeper-secrets
        name: gatekeeper (secrets, staged)
        entry: uv run --locked python scripts/secret_scan.py --staged
        language: system
        pass_filenames: false
        always_run: true
```

### Why `repo: local` for the gate

- **One toolchain.** The hook runs `uv run --locked`, so it uses the project's exact `uv.lock`
  versions. A remote hook would install its own lint/type versions and drift from CI.
- **One definition of the gate.** The stage list, the commands and the stage arguments live in
  `scripts/ci.py`, generated from the same IR that renders the workflow. The hook cannot fall behind
  CI because it does not restate the gate.
- **Staged scanning for secrets.** `scripts/secret_scan.py --staged` scans exactly what is about to
  be committed, which is dramatically faster than a full-tree scan and is where a leaked key is
  cheapest to catch. CI runs the same script without `--staged` to scan the whole tree.
- **`pass_filenames: false`** — the profile selects its own files and must not depend on the hook
  runner's file list, which would silently make the local gate weaker than CI.
- **`always_run: true`** — a commit that touches nothing a hook matches must still run the gate
  instead of reporting success by skipping it.

### Why not install detect-secrets as a remote hook

A remote `Yelp/detect-secrets` hook installs a second, independently pinned copy of detect-secrets.
It would produce a different candidate set than CI, maintain its own baseline handling, and can
drift from the `security` dependency group. The generated project uses the locked copy through
`scripts/secret_scan.py` instead, and the baseline is human-audited exactly once (see
[security-setup.md](./security-setup.md)).

### Optional security and workflow hooks

When the project's CI files and shell scripts deserve their own review, add these pinned hooks:

```yaml
  - repo: https://github.com/koalaman/shellcheck-precommit
    rev: <pinned>  # renovate: datasource=github-releases depName=koalaman/shellcheck-precommit
    hooks:
      - id: shellcheck
        args: [--severity=error]

  - repo: https://github.com/rhysd/actionlint
    rev: <pinned>  # renovate: datasource=github-releases depName=rhysd/actionlint
    hooks:
      - id: actionlint

  - repo: https://github.com/zizmorcore/zizmor-pre-commit
    rev: <pinned>  # renovate: datasource=github-releases depName=zizmorcore/zizmor-pre-commit
    hooks:
      - id: zizmor
        args: [--persona=regular, --min-severity=medium, --min-confidence=medium]
```

## Hook Reference

| Hook | Source | What it does | Runs on |
|------|--------|--------------|---------|
| `ruff` | astral-sh/ruff-pre-commit | Lint with auto-fix | Every commit |
| `ruff-format` | astral-sh/ruff-pre-commit | Format | Every commit |
| `trailing-whitespace` | pre-commit-hooks | Strip trailing whitespace | Every commit |
| `end-of-file-fixer` | pre-commit-hooks | Ensure newline at EOF | Every commit |
| `check-yaml` / `check-toml` | pre-commit-hooks | Validate syntax | Every commit |
| `check-merge-conflict` | pre-commit-hooks | Reject conflict markers | Every commit |
| `gatekeeper` | local | Commit profile: `lock`, `lint`, `manifest` | Every commit |
| `gatekeeper-secrets` | local | Staged secret scan | Every commit |
| `shellcheck` | optional remote | Shell script bugs | Every commit |
| `actionlint` | optional remote | Workflow syntax/refs | Every commit |
| `zizmor` | optional remote | Workflow security posture | Every commit |

Note that `ruff` also appears in the gate's `lint` stage. The hook gives instant per-commit feedback
in the editor loop; the stage is what CI actually enforces (and adds `ruff format --check`). Both
run the same pinned ruff version.

## Command Reference

### Installation

```bash
prek install              # install for commit (writes .git/hooks/pre-commit)
prek install --install-hooks   # also prepare hook environments now
prek uninstall            # remove the git hook
```

### Running hooks manually

```bash
prek run                          # run on files changed in the last commit (default)
prek run --all-files              # run on every tracked file
prek run --files src/core.py tests/test_core.py
prek run --last-commit            # hooks against the previous commit's changes
prek run --hook-stage manual      # run hooks configured for the manual stage
prek run ruff                     # only one hook
prek run --all-files --show-diff-on-failure
```

### Maintenance

```bash
prek validate          # check the config parses and hook ids exist
prek update            # update all pinned revs
prek update --dry-run  # show what would change
prek clean             # remove cached hook environments
```

`prek update` is a deliberate, reviewed change: a formatter upgrade can reformat the tree. The
weekly Dependabot/renovate PR is where that review happens.

## Recommended Workflow

```bash
# First clone
prek install
uv sync --all-groups
prek run --all-files

# Every commit: the hook runs lock/lint/manifest + staged secret scan
git add -A && git commit -m "feat: ..."

# Before pushing, run what CI will run
uv run --locked python scripts/ci.py --profile full
```

The commit hook is a pre-flight, not a substitute. If the profile has a bug or the tools changed,
`--no-verify` skips the same gate CI enforces — the failure is not avoided, it is moved to a slower,
more public place.

## CI

The canonical way to run the same hooks in CI is the project's own gate — it does not need prek at
all:

```yaml
- name: Lock check
  run: uv lock --check
- name: Sync
  run: uv sync --locked --all-groups
- name: Lint
  run: uv run --locked ruff check .
- name: Format check
  run: uv run --locked ruff format --check .
- name: Type check
  run: uv run --locked mypy src
# manifest → test → security → build
```

If the project also wants the third-party hooks (`trailing-whitespace`, optional security hooks),
run prek after `uv` is installed:

```yaml
- name: Install uv
  uses: astral-sh/setup-uv@v5
  with:
    enable-cache: true

- name: Sync
  run: uv sync --locked --all-groups

- name: Run all hooks
  run: prek run --all-files --show-diff-on-failure
```

The gate steps must run before or instead of a prek step — prek only sees the hooks, not the
`type`/`test`/`security`/`build` stages that make up CI.

## Makefile Targets

```makefile
.PHONY: install prek-install hooks lint format gate

prek-install:
	prek install

hooks:
	prek run --all-files

lint:
	uv run --locked ruff check .
	uv run --locked ruff format --check .

gate:
	uv run --locked python scripts/ci.py --profile full
```

## Migration from pre-commit

`prek` reads the same `.pre-commit-config.yaml`; the migration is one command:

```bash
prek install   # replaces the pre-commit launcher in .git/hooks/pre-commit
pre-commit uninstall  # optional: remove the old launcher
```

Then align the config with the v0.10 gate:

1. Drop the Yelp `detect-secrets` remote hook — the locked `gatekeeper-secrets` local hook replaces
   it (staged scanning, same pinned version as CI).
2. Keep `ruff-pre-commit` pinned; drop `ty`/`mypy` remote hooks if present, because type checking
   is the gate's `type` stage (dangerous to run per-file).
3. Add the `repo: local` hooks if the file predates this toolchain.
4. Run `prek update` only after the local gate works, so a hook-rev change is not mixed with the
   migration.

## Best Practices

1. **Pin every remote hook rev** and let automation bump it — floating `master` is a surprise
   refactor in your git history.
2. **Keep the commit hook under a few seconds.** The profile runs the fast, deterministic stages:
   `lock`, `lint`, `manifest` plus the staged secret scan. A slow `test` run on commit is a hook
   people learn to bypass; it belongs in CI and in `--profile full`.
3. **Do not duplicate the gate.** The hook calls `scripts/ci.py`; it does not re-list the stages.
   One definition, two entry points.
4. **Never write the baseline from a hook.** Scan, report, block. Audit is a human step; see
   [security-setup.md](./security-setup.md).
5. **Use `language: system` only where the toolchain is pinned.** It is correct here because `uv
   run --locked` pins the toolchain; for hooks that install their own environment, the isolated
   language is safer.
6. **Audit the first full run.** `prek run --all-files` on day one will touch unrelated files; land
   the hook together with the formatting/exclusions commit.
7. **Keep CI and hooks the same script.** If they diverge, the hook stops predicting CI and the
   team stops trusting it.
8. **Do not use `--no-verify`.** When the hook is too slow or too noisy, fix the hook — do not
   teach the team to skip it.
9. **Add security hooks only when they are actionable.** `shellcheck`/`actionlint`/`zizmor` are
   valuable but not gate material until their findings are routinely fixed.
10. **Update on a schedule.** A pinned hook left for a year is just a slow, silent tech-debt
    accumulator; the weekly dependency PR is the cheap place to spend the review.

## Verification Checklist

- [ ] `prek --version` runs
- [ ] `prek install` created `.git/hooks/pre-commit`
- [ ] `prek validate` accepts the generated config
- [ ] `prek run --all-files` runs the gate plus hygiene hooks and exits 0 on a clean tree
- [ ] A deliberate lint error in a staged file blocks `git commit`
- [ ] A staged credential candidate (not in the audited baseline) blocks `git commit`
- [ ] `git commit --no-verify` is documented as forbidden, not as a workflow
- [ ] CI runs `scripts/ci.py --profile full` (or the equivalent stage steps), not just prek
- [ ] No remote hook installs a second copy of ruff, mypy, or detect-secrets
