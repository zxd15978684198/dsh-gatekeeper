# Security Setup

Security tooling for Python projects: the secret-scan gate, the optional dependency-audit stage,
and the local hooks that make a leaked credential a red gate instead of a red face.

## What the Gate Actually Checks

The pipeline's `security` stage is a **secret scan**, not a dependency audit:

| Concern | Stage | Tool | Replaces |
|---------|-------|------|----------|
| A credential in the tree | `security` (default, every push and every commit) | `detect-secrets` through `scripts/secret_scan.py` | the Yelp/detect-secrets pre-commit remote hook |
| A vulnerable dependency | `audit` (opt-in) | `pip-audit` | a "security" stage that audited dependencies and therefore let secrets through |

A leaked credential cannot be fixed by a later commit — it must be rotated — so it gets the
unconditional gate. A CVE in a dependency can be scheduled, accepted, or fixed in the next release,
which is why it is opt-in. Merging the two teaches people to treat both as noise.

## Tool Installation

### prek (pre-commit runner)

```bash
# Homebrew (recommended)
brew install prek

# Cargo
cargo install prek

# Standalone installer
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/j178/prek/releases/latest/download/prek-installer.sh | sh
```

### detect-secrets (locked, not installed globally)

`detect-secrets` belongs to the project's `security` dependency group, so the hook and CI run the
same pinned version:

```bash
uv add --group security detect-secrets
uv sync --all-groups
```

The generated script (`scripts/secret_scan.py`) calls it through `uv run --locked`, so no global
install is needed. For one-off CLI work, prefix with `uv run --locked detect-secrets ...`.

### Optional workflow-security tools

These audit the CI files themselves, not the project's code. They are useful, but they are not part
of the default gate:

```bash
# Homebrew (macOS/Linux)
brew install actionlint shellcheck

# uv tool
uv tool install zizmor

# Alternatives
go install github.com/rhysd/actionlint/cmd/actionlint@latest
cargo install zizmor
```

## Quick Setup

The baseline is the one thing a pipeline must never create by itself: deciding a candidate is a
false positive is a human audit, and a gate that writes its own exceptions is not a gate. Do this
**once**, by hand:

```bash
# 1. Install the repository's commit hooks
prek install

# 2. Review the staged credential-scan hook (it reads the baseline; it never writes it)
prek run --all-files

# 3. Create the baseline once, by hand, then audit every entry
uv run --locked detect-secrets scan --baseline .secrets.baseline
uv run --locked detect-secrets audit .secrets.baseline

# 4. Commit the audited baseline (it is project configuration, like pyproject.toml)
git add .secrets.baseline
git commit -m "chore: add audited secret-scan baseline"
```

After that, the baseline is **read-only for automation**. The generated helper:

- scans all tracked files in CI and only the staged set from the hook (`--staged`);
- fails when a candidate is not covered by an audited baseline entry;
- fails when `.secrets.baseline` is missing, printing how to create one — a missing baseline is a
  red gate, never an empty green one;
- never rewrites the baseline. New false positives are added by a human:
  `uv run --locked detect-secrets scan --baseline .secrets.baseline` (re-scan), then audit, then
  commit. A real secret is removed from the code and the credential is rotated.

See [templates/pre-commit-config.yaml](../templates/pre-commit-config.yaml) for the hook
configuration, and [prek.md](./prek.md) for the full hook reference.

## Tool Matrix

| Tool | Runs | Catches | In the default gate? |
|------|------|---------|----------------------|
| **detect-secrets** | `security` stage, commit hook | Leaked API keys, passwords, tokens | ✅ |
| **pip-audit** | `audit` stage (opt-in) | Known CVEs in dependencies | ❌ opt-in |
| **actionlint** | optional hook / manual | Workflow syntax errors, invalid refs | ❌ optional |
| **zizmor** | optional hook / manual | Workflow security issues, excessive permissions | ❌ optional |
| **shellcheck** | optional hook / manual | Shell script bugs, quoting issues | ❌ optional |
| **Dependabot** | scheduled | Outdated dependencies with vulnerabilities | ❌ scheduled |

## Pre-commit Hooks

prek runs the repository's own gates, through `uv`, so the hook and CI execute one locked toolchain.
The generated `.pre-commit-config.yaml` has two `repo: local` hooks:

```yaml
repos:
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

Why these choices:

- **`pass_filenames: false`** — the profile selects its own stages and files; a hook-filtered file
  list would quietly make the local gate weaker than CI.
- **`always_run: true`** — a commit that touches nothing a hook matches must still run the gate
  instead of reporting success by skipping it.
- **`--profile commit`** is the fast subset (`lock`, `lint`, `manifest`) plus this staged secret
  scan, not the full pipeline. The full gate is `uv run --locked python scripts/ci.py --profile full`
  and is what CI runs; the commit hook is a pre-flight, not a substitute.

The secret hook is deliberately local and locked: a remote `Yelp/detect-secrets` hook would install
a *second*, unpinned copy of detect-secrets and scan with a different version than CI.

If the project's `.github/workflows` and shell scripts matter, add the optional remote hooks:

```yaml
  - repo: https://github.com/koalaman/shellcheck-precommit
    rev: <latest>  # https://github.com/koalaman/shellcheck-precommit/tags
    hooks:
      - id: shellcheck
        args: [--severity=error]

  - repo: https://github.com/rhysd/actionlint
    rev: <latest>  # https://github.com/rhysd/actionlint/releases
    hooks:
      - id: actionlint

  - repo: https://github.com/zizmorcore/zizmor-pre-commit
    rev: <latest>  # https://github.com/zizmorcore/zizmor-pre-commit/releases
    hooks:
      - id: zizmor
        args: [--persona=regular, --min-severity=medium, --min-confidence=medium]
```

## The `security` Stage in CI

The workflow's security step is the generated helper, not a bare `detect-secrets` invocation:

```yaml
- name: Secret scan
  run: uv run --locked python scripts/secret_scan.py
```

It runs after lint/type/manifest/test and before build: a secret is the one finding that makes
anything built afterwards untrustworthy, and the scan is fast enough that its position costs
nothing.

What the script does and does not do:

| Does | Does not |
|------|----------|
| Scan all tracked files in CI, staged files from the hook | Write or update `.secrets.baseline` |
| Fail on un-audited findings | Fail silently when the baseline is missing |
| Print the finding and the file/line | Decide that a finding is a false positive — that is an audit |

## The `audit` Stage (Opt-in)

Dependency advisories live in the opt-in `audit` stage:

```bash
# No permanent dependency needed
uv run --locked --with pip-audit pip-audit
```

Or pin it in a dedicated group, so the version is shared:

```toml
[dependency-groups]
audit = ["pip-audit"]
```

```bash
uv sync --all-groups
uv run --locked pip-audit
```

In a workflow, the stage renders as its own job (or step) and is not part of the required checks
until the team turns it on. When to turn it on: a service with a production deployment and a
regular release cadence. When not to: a library or a teaching project where dependency churn is the
only output the job produces.

Useful commands:

```bash
uv run --locked pip-audit            # audit the current environment
uv run --locked pip-audit .          # audit the project's declarations
uv run --locked pip-audit --fix      # upgrade vulnerable packages
```

**When vulnerabilities are found:**

1. Check whether the CVE affects the code path you use — many do not.
2. Update the package: `uv add <package>@latest`.
3. If no fix exists, record the decision (risk accepted, ignore list with a review date) instead of
   silently disabling the job.

## Workflow Security (Optional)

`actionlint` and `zizmor` audit the CI files. They are optional because they protect the pipeline
rather than the project, and are worth adding once the workflow is more than a toy:

```bash
uv tool run actionlint .github/workflows/
uv tool run zizmor .github/workflows/
```

**Fixing `excessive-permissions`:** by default a workflow gets `write` access to everything. Lock
it down with an explicit block:

```yaml
# Read-only workflows (lint, test, security)
permissions:
  contents: read

# Release workflows that push tags or create releases
permissions:
  contents: write

# Workflows that comment on PRs
permissions:
  contents: read
  pull-requests: write
```

Common findings:
- `excessive-permissions`: no `permissions:` block
- `template-injection`: using `${{ github.event.* }}` unsafely
- `unpinned-action`: actions not pinned to a SHA
- `dangerous-triggers`: `pull_request_target` with checkout

## Dependabot

Dependabot opens PRs for outdated dependencies and workflow actions. Copy
[templates/dependabot.yml](../templates/dependabot.yml) to `.github/dependabot.yml`.

**How the secret scan and Dependabot fit together:**

| Tool | Trigger | Scope |
|------|---------|-------|
| detect-secrets (security stage) | Every CI run and every commit | Credentials in the tree |
| pip-audit (audit stage, opt-in) | Every run where the stage is enabled | Known CVEs in current deps |
| Dependabot | Weekly schedule | All outdated deps, security + non-security |

- **detect-secrets** catches: "a credential is in the repository"
- **pip-audit** catches: "a dependency version you ship is known vulnerable"
- **Dependabot** prevents: "you fall so far behind that upgrades stop being routine"

The 7-day cooldown protects against attackers publishing malicious updates and hoping for quick
adoption before detection.

See [dependabot.md](./dependabot.md) for advanced configuration, and
[prek.md](./prek.md) for the complete hook configuration.

## Rationalizations to Reject

| Claim | Reality |
|-------|---------|
| "The secret scan can just write the baseline when it finds something" | Then it finds nothing, forever: exceptions become invisible and the gate is decorative. A human audits, a pipeline reports |
| "We audit dependencies in the security stage, one gate is simpler" | A leaked key and a vulnerable package have different fixes and different urgency; one gate means one of them gets ignored |
| "Add `--no-verify` to get past the hook" | The hook is the same gate CI runs; skipping it locally just moves the failure one step later |
| "The baseline is generated, so it needs no review" | The baseline is a list of every accepted false positive; it is exactly the file that needs a review |
