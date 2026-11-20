---
name: ci-cd-and-automation
description: Automates CI/CD pipeline setup for Python projects on uv, ruff, mypy, pytest and prek. Use when setting up or modifying build and deployment pipelines, automating quality gates, configuring test runners in CI, or establishing deployment strategies.
---

# CI/CD and Automation

## Overview

Automate quality gates so that no change reaches production without passing lock verification, lint, type checking, tests, secret scanning and build. CI/CD is the enforcement mechanism for every other skill — it catches what humans and agents miss, and it does it consistently on every single change.

**Shift Left:** Catch problems as early in the pipeline as possible. A bug caught in linting costs minutes; the same bug caught in production costs hours. Move checks upstream — the lock check before the install, static analysis before tests, tests before build, build before deploy.

**Faster is Safer:** Smaller batches and more frequent releases reduce risk, not increase it. A deployment with 3 changes is easier to debug than one with 30. Frequent releases build confidence in the release process itself.

**One gate, three runners:** the same stage list runs in the GitHub workflow, on the developer's machine through `scripts/ci.py`, and in the commit hook (a fast subset). A stage list copied into three places drifts; one catalog rendered three ways does not.

## When to Use

- Setting up a new Python project's CI pipeline
- Adding or modifying automated checks
- Configuring deployment pipelines
- When a change should trigger automated verification
- Debugging CI failures
- Explaining why a commit hook runs less than CI

## The Gate: Nine Commands, Eight Default Stages (13 in the Catalog)

The gate is the course's nine-step quality gate. Nine steps do not survive contact with a CI runner, so the pipeline IR carries them in **13 stages**: 8 default stages plus 5 opt-in ones. Every output — the workflow, `scripts/ci.py`, the panel, the audit report — is rendered from that one catalog.

| Step | Command | Stage |
|---|---|---|
| 1 | `uv lock --check` | `lock` |
| 2 | `uv sync --locked --all-groups` | `sync` |
| 3 | `ruff check .` | `lint` (step 1 of 2) |
| 4 | `ruff format --check` | `lint` (step 2 of 2) |
| 5 | `mypy <paths>` / `ty check <paths>` | `type` |
| 6 | `python scripts/validate_version_manifest.py` | `manifest` |
| 7 | `pytest --cov --cov-report=term-missing` | `test` |
| 8 | `python scripts/secret_scan.py` | `security` |
| 9 | `uv build --all-packages --out-dir dist` (workspace) / `uv build` | `build` |

```
push / pull request
    │
    ▼
  lock ──► sync ──► lint ──► type ──► manifest ──► test ──► security ──► build
  (8 默认阶段，顺序固定)
    │
    ├─► integration   (需要真实数据库/网络，opt-in)
    ├─► audit         (pip-audit 查 OSV，联网且噪声大，opt-in)
    ├─► container     (需要 docker daemon，opt-in)
    ├─► release       (tag 触发，消费 build 产出的 dist)
    └─► deploy        (release 之后，需要真实环境)
```

Why the split matters:

- **`lock` is a proof, `sync` is preparation.** `uv lock --check` fails when the declarations and the lockfile disagree; `uv sync --locked --all-groups` then installs exactly what the reviewed lock says. Merging them into one “install” step is how a stale lock reaches the test run as a resolution error in the middle of the pipeline instead of as a one-line failure at the top.
- **`lint` keeps check and format as two steps** so a style failure and a real defect failure read differently.
- **`security` is a secret scan, not a dependency audit.** `detect-secrets` runs through the generated `scripts/secret_scan.py`; pip-audit is the separate, opt-in `audit` stage.
- **`build` proves the artefact exists and is what release will ship.** The `quality` job uploads `dist/`; the `release` job downloads that exact artefact instead of rebuilding.

### Stage selection

```bash
python scripts/ci.py                 # all 8 default stages, in order, stop at first failure
python scripts/ci.py --stage test    # one stage
python scripts/ci.py --from test     # resume where a gate failed
python scripts/ci.py --profile commit    # the fast subset: lock, lint, manifest
python scripts/ci.py --list          # what exists, grouped by job
python scripts/ci.py --json          # machine-readable result
```

Opt-in stages are named explicitly: `--stage integration`, `--stage audit`, `--stage container`, `--stage release`, `--stage deploy`. “Run everything” means the 8 defaults — it never means deploy.

### 失败即停、从失败项重跑、最终从头跑一遍

1. **失败即停 (fail fast):** the runner stops at the first failing stage. A red `lint` means the `type` results are not worth reading yet, and an early stop keeps the feedback loop short.
2. **从失败项重跑 (resume):** fix the failure, then resume with `--from <stage>` instead of paying for the stages that already passed. The stage you resume from is itself re-run — a fix can break the stage before it.
3. **最终从头跑一遍 (final full run):** before pushing for review, run the full gate once from the top (`python scripts/ci.py`) and let CI repeat it. Resuming is a debugging loop; the claim “my change is green” must come from a full run, not from the tail of one.

## Pre-commit: the Fast Subset

A commit hook that takes minutes gets bypassed with `--no-verify`, and then it protects nothing. The hook therefore runs a deliberately small slice:

| Where | What runs | Command |
|---|---|---|
| `git commit` (prek) | `lock`, `lint`, `manifest` + staged secret scan | `uv run --locked python scripts/ci.py --profile commit` |
| staged files only | secret scan of the staged set | `uv run --locked python scripts/secret_scan.py --staged` |
| Before push / on PR | the full 8-stage gate | `uv run --locked python scripts/ci.py` |
| CI | the full 8-stage gate (+ any opt-in stages) | `.github/workflows/ci.yml` |

`type`, `test` and `build` are intentionally not in the commit profile: they are the slow gates whose failure a commit should not wait for. `security` is also absent from the profile — the profile has no notion of “staged files”, so the staged secret scan is its own hook entry. That is why a commit hook run and a full run disagree by design, not by accident.

```bash
# one-time hook installation
uv run --locked prek install
uv run --locked prek run --all-files   # prove an existing tree is clean before enabling the hook
```

## GitHub Actions

The workflow is rendered from the same stage catalog. The dependency install is the `sync` stage — a command with flags the IR owns, not a hand-written step name:

```yaml
# .github/workflows/ci.yml
name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install uv
        uses: astral-sh/setup-uv@v5
        with:
          cache: true

      - name: Lock check
        run: uv lock --check

      - name: Sync
        run: uv sync --locked --all-groups

      - name: Lint
        run: |
          uv run --locked ruff check .
          uv run --locked ruff format --check

      - name: Type check
        run: uv run --locked mypy src

      - name: Version manifest
        run: uv run --locked python scripts/validate_version_manifest.py

      - name: Test
        run: uv run --locked pytest --cov --cov-report=term-missing

      - name: Secret scan
        run: uv run --locked python scripts/secret_scan.py

      - name: Build
        run: uv run --locked uv build

      - uses: actions/upload-artifact@v4
        with:
          name: dist
          path: dist/
          if-no-files-found: error
```

Notes that keep the workflow honest:

- `uv sync --locked --all-groups` is the `sync` stage's command. Do not replace it with a bare dependency install followed by “hope the lock matches”: the `lock` step already proved it, and `--locked` makes the install fail loudly if it stopped being true.
- The `type` step's checker and paths come from the project (`mypy src`, `ty check src`, or the resolved path list) — a project that already uses ty must not be switched to mypy by the template.
- The coverage floor is not a flag in this file. It lives in `[tool.coverage.report] fail_under`, so the workflow, `scripts/ci.py` and a human running `coverage report` all read the same number.

### Optional jobs

`integration` and `audit` join the quality job only when the project opts in, because one needs a real database and the other a network lookup against OSV:

```yaml
  integration:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_DB: testdb
          POSTGRES_USER: ci_user
          POSTGRES_PASSWORD: ${{ secrets.CI_DB_PASSWORD }}
        ports: [5432:5432]
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v5
        with: { cache: true }
      - run: uv sync --locked --all-groups
      - name: Run migrations
        run: uv run --locked python -m myproject.migrate
        env:
          DATABASE_URL: postgresql://ci_user:${{ secrets.CI_DB_PASSWORD }}@localhost:5432/testdb
      - name: Integration tests
        run: uv run --locked pytest -m integration
        env:
          DATABASE_URL: postgresql://ci_user:${{ secrets.CI_DB_PASSWORD }}@localhost:5432/testdb
```

```yaml
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v5
        with: { cache: true }
      - run: uv sync --locked --all-groups
      - name: Dependency audit
        run: uv run --locked --with pip-audit pip-audit
```

> **Note:** Even for CI-only test databases, use GitHub Secrets for credentials rather than hardcoding values. This builds good habits and prevents accidental reuse of test credentials in other contexts.

### Delivery jobs

`container`, `release` and `deploy` need a daemon, a registry or a live environment, so they are never part of the default run. Their shape:

- **container** — `docker compose config --quiet` validates interpolation, `docker build --check .` fails a broken Dockerfile cheaply, then `build`, `up -d --wait`, a report-only `scripts/container_report.py`, and `docker compose down` with `if: always()`. Identity is one of the report's six facts: it reads the image's `Config.User`, so a healthy container that still runs as root is caught without a `compose exec` (and without guessing a service name). The report is advisory except when `[tool.gatekeeper.image] max_size_mb` is configured.
- **release** — tag-gated, `needs: quality`, downloads the `dist` artifact (never rebuilds), attests build provenance, generates an SBOM, attaches the distributions to the run, and only then offers tag-gated publishing steps.
- **deploy** — `needs: release`, `environment: production` (approvals and deployment history come from that line), a tag or `workflow_dispatch` gate, a health probe driven by `DEPLOY_HEALTH_URL` (unset → the step is skipped, not failed), and a real failing command slot the operator must replace.

## The `security` Stage vs the `audit` Stage

| | `security` (default) | `audit` (opt-in) |
|---|---|---|
| Tool | `detect-secrets` via `scripts/secret_scan.py` | `pip-audit`, provisioned with `uv run --with` |
| Failure | a credential is about to be committed | a locked dependency has a known advisory |
| Fix | remove/rotate the secret, audit the baseline | bump the dependency, or record the exception |
| Needs | the tracked file list (or the staged set in a hook) | network lookup against OSV |
| In commit hook | yes, staged scan | never |

`scripts/secret_scan.py` takes `--staged` (hook), `--baseline`, and `--root` (CI, whole tree). The baseline is created **once and audited by a human** — deciding a candidate is a false positive is an audit, not a pipeline side effect. A missing `.secrets.baseline` is therefore a red gate that prints how to create one; a pipeline must never write a fresh baseline to make the gate green, because that would mean the gate never ran.

## Feeding CI Failures Back to Agents

The power of CI with AI agents is the feedback loop. When CI fails:

```
CI fails
    │
    ▼
Copy the failure output
    │
    ▼
Feed it to the agent:
"The CI pipeline failed with this error:
[paste specific error]
Fix the issue and verify locally before pushing again."
    │
    ▼
Agent fixes → runs the same stage locally → pushes → CI runs again
```

**Key patterns:**

```
Lock failure    → run `uv lock`, review the diff, commit uv.lock
Lint failure    → `uv run ruff check --fix` then re-read the remaining findings
Type failure    → fix the annotation or narrow the module's override
Manifest failure→ regenerate the manifest entries that drifted, never hand-edit hashes
Test failure    → reproduce with `uv run pytest -x`, fix the code, not the assertion
Secret failure  → remove/rotate the secret; audit the baseline only for real false positives
Build failure   → check package layout and build backend before changing workflow cache
```

Local repro is the same command the gate runs; that is the point of one catalog. Use `python scripts/ci.py --from <stage>` for the debugging loop.

## Deployment Strategies

### Preview Deployments

Every PR gets a preview deployment for manual testing:

```yaml
# Deploy preview on PR (the command belongs to the operator, not the generator)
deploy-preview:
  runs-on: ubuntu-latest
  if: github.event_name == 'pull_request'
  environment: preview
  steps:
    - uses: actions/checkout@v4
    - name: Deploy preview
      run: ./scripts/deploy.sh preview
      env:
        DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}
```

### Feature Flags

Feature flags decouple deployment from release. Deploy incomplete or risky features behind flags so you can:

- **Ship code without enabling it.** Merge to main early, enable when ready.
- **Roll back without redeploying.** Disable the flag instead of reverting code.
- **Canary new features.** Enable for 1% of users, then 10%, then 100%.
- **Run A/B tests.** Compare behavior with and without the feature.

```python
# Simple feature flag pattern
if feature_flags.is_enabled("new-checkout-flow", user_id=user.id):
    return render_new_checkout()
return render_legacy_checkout()
```

**Flag lifecycle:** Create → Enable for testing → Canary → Full rollout → Remove the flag and dead code. Flags that live forever become technical debt — set a cleanup date when you create them.

### Staged Rollouts

```
PR merged to main
    │
    ▼
  Staging deployment (auto)
    │ Manual verification
    ▼
  Production deployment (manual trigger or auto after staging)
    │
    ▼
  Monitor for errors (15-minute window)
    │
    ├── Errors detected → Rollback
    └── Clean → Done
```

Deploy only artefacts that were attested by `release`; a deploy job that rebuilds reintroduces the exact divergence the download-artifact step removes.

### Rollback Plan

Every deployment should be reversible:

```yaml
# Manual rollback workflow
name: Rollback
on:
  workflow_dispatch:
    inputs:
      version:
        description: 'Version to roll back to'
        required: true

jobs:
  rollback:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - name: Rollback deployment
        run: |
          ./scripts/deploy.sh rollback "${{ inputs.version }}"
        env:
          DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}
```

## Environment Management

```
.env.example       → Committed (template for developers)
.env                → NOT committed (local development)
.env.test           → Committed (test environment, no real secrets)
CI secrets          → Stored in GitHub Secrets / vault
Production secrets  → Stored in deployment platform / vault
```

CI should never have production secrets. Use separate secrets for CI testing. A secret that reaches a tracked file is a rotated credential, not a deleted line.

## Automation Beyond CI

### Dependabot

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: pip
    directory: /
    schedule:
      interval: weekly
    cooldown:
      days: 7
    groups:
      python:
        patterns: ["*"]
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    cooldown:
      days: 7
    groups:
      actions:
        patterns: ["*"]
```

The cooldown keeps a freshly published (or freshly compromised) version from entering the lock the day it lands; the grouping keeps one dependency update from producing ten PRs.

### Build Cop Role

Designate someone responsible for keeping CI green. When the build breaks, the Build Cop's job is to fix or revert — not the person whose change caused the break. This prevents broken builds from accumulating while everyone assumes someone else will fix it.

### PR Checks

- **Required reviews:** At least 1 approval before merge
- **Required status checks:** the `quality` job must pass before merge
- **Branch protection:** No force-pushes to main
- **Auto-merge:** If all checks pass and approved, merge automatically

## CI Optimization

When the pipeline exceeds 10 minutes, apply these strategies in order of impact:

```
Slow CI pipeline?
├── Cache uv and the lock
│   └── `astral-sh/setup-uv` with `cache: true`; reuse the resolved environment across runs
├── Run jobs in parallel
│   └── quality, container and release already sit in separate jobs behind `needs`
├── Only run what changed
│   └── Path filters: skip e2e/container for docs-only PRs, keep quality required
├── Use matrix builds
│   └── Test 3.12/3.13 in one matrix job; pin the interpreter in pyproject
├── Optimize the test suite
│   └── Move slow integration tests to the opt-in `integration` stage
└── Use larger runners
    └── GitHub-hosted larger runners or self-hosted for CPU-heavy builds
```

**Example: caching and parallelism**

```yaml
jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v5
        with: { cache: true }
      - run: uv sync --locked --all-groups
      - run: uv run --locked ruff check .
      - run: uv run --locked ruff format --check
      - run: uv run --locked mypy src
      - run: uv run --locked pytest --cov --cov-report=term-missing

  container:
    needs: quality
    runs-on: ubuntu-latest
    steps:
      - run: docker compose config --quiet
```

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| “CI is too slow” | Optimize the pipeline (cache uv, split jobs, opt-in the slow stages), don't skip it. A 5-minute pipeline prevents hours of debugging. |
| “This change is trivial, skip CI” | Trivial changes break builds. CI is fast for trivial changes anyway. |
| “The test is flaky, just re-run” | Flaky tests mask real bugs and waste everyone's time. Fix the flakiness. |
| “We'll add CI later” | Projects without CI accumulate broken states. Set it up on day one. |
| “The hook is slow, use --no-verify” | The hook is the fast subset on purpose. A slow hook means the profile is wrong, not that the gate should be skipped. |
| “Skip the secret baseline, it's just noise” | An unaudited baseline means the secret gate never ran. Audit it once, then keep it. |
| “Move pip-audit into security so we have one security gate” | A leaked credential and a vulnerable dependency are different failures with different fixes; keep `security` and the opt-in `audit` separate. |
| “Manual testing is enough” | Manual testing doesn't scale and isn't repeatable. Automate what you can. |

## Red Flags

- No CI pipeline in the project
- CI failures ignored or silenced, or commit hooks routinely bypassed with `--no-verify`
- Tests disabled in CI to make the pipeline pass
- A coverage floor passed on a command line while `[tool.coverage.report]` says something else
- `.secrets.baseline` regenerated or overwritten by a pipeline
- `pip-audit` folded into the `security` stage (it is the opt-in `audit` stage)
- Production deploys without staging verification, or a deploy job that rebuilds instead of using the attested artefact
- No rollback mechanism
- Secrets stored in code or CI config files (not secrets manager)

## Verification

After setting up or modifying CI:

- [ ] All 8 default stages are present and in order: `lock → sync → lint → type → manifest → test → security → build`
- [ ] Opt-in stages (`integration`, `audit`, `container`, `release`, `deploy`) are named explicitly, never part of “run everything”
- [ ] The install step is the `sync` stage's `uv sync --locked --all-groups`, preceded by `uv lock --check`
- [ ] The commit hook runs the fast subset (`lock`, `lint`, `manifest` + staged secret scan) and a full run is documented
- [ ] `python scripts/ci.py --from <stage>` works for the resume loop, and a final full run is part of the push routine
- [ ] The coverage floor is configured in `[tool.coverage.report]`, not in `addopts`
- [ ] `.secrets.baseline` exists and was audited by a human; the pipeline never writes it
- [ ] The type stage uses the project's checker (mypy for new projects, ty when the project already uses it)
- [ ] Releases consume the `dist` artifact from the quality job; deploy consumes the attested release
- [ ] Failures block merge (branch protection configured)
- [ ] CI results feed back into the development loop
- [ ] Secrets are stored in the secrets manager, not in code
- [ ] Deployment has a rollback mechanism
- [ ] Pipeline runs in under 10 minutes for the test suite
