# Gatekeeper

**English** · [简体中文](README.zh-CN.md)

A Python project quality gate for DSH: it reads the project, generates the
configuration a gate needs, and runs the same gate locally and in CI. Chinese
name: 「门禁」. Machine identifier: `gatekeeper`.

Three tools, one sidebar panel and a composer chip answer "what does this Python
project need?" — and refuse to answer when the project is not a uv project.

The three are cut by what they do to the project, not by which artefact they emit:
`py-audit` reads, `py-scaffold` writes, `py-run` executes. That is the whole
surface. Everything they generate comes from one pipeline definition (8 default
stages, 5 optional), so a local pass, a commit hook pass and a CI pass mean the
same thing.

This is a DSH bundle. It ships sixteen skill documents as text — twelve distilled
from the four upstream Python skills, plus four written for this plugin (container
validation, pipeline shape, releasing, deploying) — hands out the configuration
they describe, and writes
nothing to your project until the write step is asked for explicitly: `py-scaffold`
and `py-run` both default to a dry run, and `py-audit` writes nothing on any path.

## Why it exists

The upstream skills are good documents and poor tools. An agent can read "don't use
uv in projects managed by other tools" in `1-uv/SKILL.md` and reach for `uv add` in
a Poetry repository anyway, because that sentence is advice, not a predicate. Here
it is a predicate over the project's own lockfiles:

- `poetry.lock`, `pdm.lock`, `Pipfile.lock` → `py-scaffold` returns
  `{ blocked: true, reason }`, and the reason quotes the rule it enforces.
- `uv.lock` → the tools produce configuration and a workflow.

The other half is provenance. `py-audit` can return one bundled document at a time
and names its source, so a caller can see whether a sentence came from Astral's
`uv` skill or from a template collection that predates uv.

## The three tools

| Tool | What it does | Moves by default |
| --- | --- | --- |
| `py-audit` | Reads the project once and reports: which lockfile manages the dependencies (uv, or a foreign Poetry/PDM/Pipenv lockfile uv must stay out of), the declared Python version and where it came from, which of ruff/mypy/ty/pytest/prek/detect-secrets are configured, whether the git hook is installed, whether `.secrets.baseline` exists, which workflows exist and what the 13 static rules say about them, and the gate order the pipeline would use. `topic` returns one of the sixteen bundled skill documents verbatim; `run: true` also executes the whitelisted read-only probes. Never writes. | no |
| `py-scaffold` | Generates the nine gate artefacts — the `pyproject.toml` tables, `.pre-commit-config.yaml`, `.github/dependabot.yml`, the GitHub Actions workflow, `scripts/ci.py`, `release/agent_versions.json`, `scripts/validate_version_manifest.py`, `scripts/secret_scan.py`, `scripts/container_report.py` — as a preview by default, and writes them only with `dryRun: false`, to those nine fixed paths and nowhere else. | no, unless `dryRun: false` |
| `py-run` | Runs the gates in pipeline order and reports each stage's exit code — the eight default stages, the five optional ones when named, `profile: "commit"` for the durable fast subset, `from` to resume after a failure. Prints the plan by default; `dryRun: false` executes. | no, unless `dryRun: false` |

Every tool defaults to the calling session's working directory; pass `path` to
point it at another project. Relative paths resolve against the session directory,
never against the process working directory, and a path that leaves the project
root is refused rather than followed.

### `py-audit`: the read

One call answers "what is this project?" without touching it: package manager and
the lockfile that proves it, Python version and whether it came from
`.python-version`, `requires-python` or the default, which linters exist, whether
`prek` installed the commit hook, whether the secret baseline exists, which
workflows exist, and the recommended gate order. It also reports `blockers[]` — the
file that says "not a uv project" before any other tool has to.

`topic` takes one of the sixteen ids and returns that document verbatim with a
`source` field naming the upstream package.

### `py-scaffold`: the write

Nine artefacts, nine fixed paths:

| Path | What it is |
| --- | --- |
| `pyproject.toml` | The `[tool.ruff]`, `[tool.ruff.lint]` (with `per-file-ignores`), `[tool.ruff.format]`, `[tool.mypy]`, `[tool.pytest.ini_options]`, `[tool.coverage]`, `[tool.uv]` and `[dependency-groups]` tables, appended — your `[project]` table is never rewritten |
| `.pre-commit-config.yaml` | prek hooks, remote revs deliberately unpinned, plus the two local gatekeeper hooks |
| `.github/dependabot.yml` | weekly pip + Actions updates with a 7-day cooldown |
| `.github/workflows/<project>.yml` | the workflow the pipeline IR renders |
| `scripts/ci.py` | the same pipeline as a local runner, so CI and a developer run one thing |
| `release/agent_versions.json` | the version manifest: schema version, service, runtime, agent components |
| `scripts/validate_version_manifest.py` | the single-file validator for that manifest |
| `scripts/secret_scan.py` | the read-only secret scanner used by CI and the commit hook |
| `scripts/container_report.py` | the six-item image report for the container stage |

An existing file gets a `.bak.<timestamp>` copy before it is modified; a file that
did not exist is created exclusively, so a concurrent write cannot clobber it. The
manifest is diff-only: existing entries are kept, only missing components are
added.

### `py-run`: the execute

The stages come from the same IR the workflow and `scripts/ci.py` are rendered
from. The default is the eight gates a push is measured against; the five optional
stages (`integration`, `audit`, `container`, `release`, `deploy`) are named
explicitly, never dragged in by `stages: "all"`. `profile: "commit"` narrows the
run to the fast subset a hook can afford; `from` resumes at the stage that broke.

The argv is not improvised at runtime: it is the same IR string the workflow and
`scripts/ci.py` carry. Failures stop the run; a stage that never started is
reported as skipped, not as passed.

A failure that comes from the tool not starting (missing `uv`, a permission error
writing a cache directory) is tagged `kind: 'environment'` and worded as "the tool
did not run", which is a different statement from "the project failed".

### The shape of a refusal

Blocked is not an error, and it is not a degraded result:

```json
{ "blocked": true, "reason": "\"poetry.lock\" means another tool manages this project's dependencies. The 1-uv skill is explicit: don't use uv in projects managed by other tools." }
```

The panel renders that sentence instead of a half-filled dashboard, because a
report about the wrong package manager is worse than no report.

## The nine-command gate chain (chapter 8: eight default stages, five optional)

The chapter 8 pipeline is nine commands carried by eight default stages — `lint` runs two
steps (check and format) under one stage id:

| # | Step | Stage | Command |
| --- | --- | --- | --- |
| 1 | Lock check | `lock` | `uv lock --check` |
| 2 | Sync | `sync` | `uv sync --locked --all-groups` |
| 3 | Ruff check | `lint` | `uv run --locked ruff check .` |
| 4 | Ruff format check | `lint` | `uv run --locked ruff format --check .` |
| 5 | Type check | `type` | `uv run --locked mypy <detected source roots>` |
| 6 | Version manifest | `manifest` | `uv run --locked python scripts/validate_version_manifest.py` |
| 7 | Test | `test` | `uv run --locked pytest --cov --cov-report=term-missing` |
| 8 | Secret scan | `security` | `uv run --locked python scripts/secret_scan.py` |
| 9 | Build | `build` | clear `dist/`, then `uv build --all-packages --out-dir dist` (workspace) or `uv build` (single package) |

Order is the chapter's: cheap and deterministic first, so the most common failure
is the cheapest one. Failures stop the chain; fix, rerun from the failing stage,
then rerun from the top once.

Five stages are optional and only enter a workflow when asked for:

| Stage | What it proves | Why optional |
| --- | --- | --- |
| `integration` | `uv run --locked pytest -m integration` | needs a real database or network; with no integration tests the stage prints one visible skip line and exits 0 instead of failing |
| `audit` | `uv run --locked --with pip-audit pip-audit` | network, noisy |
| `container` | compose config, image build check, `up --wait`, teardown, six-item image report (the report reads the image's `Config.User`, so identity needs no `compose exec`) | needs Docker |
| `release` | reuses the verified `dist`, attests, SBOMs, uploads, `gh release create` | only on a tag |
| `deploy` | annotated deployment: `gh release view`, a command you must replace, conditional health probe | cannot be guessed |

`deploy` fails red while its placeholder is unreplaced: `echo "::error::部署命令未配置：把本步替换成你的部署命令"` plus `exit 1`. A deployment job that is green and deployed nothing is worse than a red one.

## The three entry points

All three read one definition — `lib/pipeline/ir.js` — so they cannot drift:

| Entry | Command | What runs |
| --- | --- | --- |
| Manual (repair) | `uv run --locked python scripts/ci.py` | all eight default stages, fail fast |
| Manual (resume) | `uv run --locked python scripts/ci.py --from test` | starts at the named stage instead of the top |
| Local automatic | `git commit` → `.git/hooks/pre-commit` (prek) → `uv run --locked python scripts/ci.py --profile commit` | `lock`, `lint`, `manifest`; the secrets hook scans the staged diff |
| Remote automatic | `git push` / PR → GitHub Actions | the same eight stages, rendered from the same IR |

`scripts/ci.py` also keeps `--profile full|commit`, `--stage`, `--stop-after`,
`--list` (grouped by job), `--json`, `--root` and `--timeout`. The three canonical
commands appear at the top of its `--help`, in `py-scaffold`'s next steps, and in
this README.

`--list` renders the payload's stages grouped by job: the eight gates for a default
selection, and all thirteen when the project was generated with `stages: "all"` —
there `release` and `deploy` are tagged `[CI only]` because a laptop has no
equivalent step. The default run still executes only the eight default gates;
`stages: "all"` expands to those eight and never pulls in an optional stage by
itself.

## What `py-scaffold` generates

| Id | Path | Mode | Source |
| --- | --- | --- | --- |
| `pyproject` | `pyproject.toml` | append | resolved project values |
| `prek` | `.pre-commit-config.yaml` | whole file | `py-prek` |
| `dependabot` | `.github/dependabot.yml` | whole file | `py-dependabot` |
| `workflow` | `.github/workflows/<name>.yml` | whole file | `py-ci-render` |
| `ci-script` | `scripts/ci.py` | whole file | `py-ci-run` |
| `manifest` | `release/agent_versions.json` | diff-only | probe + manifest renderer |
| `validator` | `scripts/validate_version_manifest.py` | whole file | manifest module |
| `secret-scan` | `scripts/secret_scan.py` | whole file | secret-scan module |
| `container-report` | `scripts/container_report.py` | whole file | container module |

`py-scaffold` previews these by default; `dryRun: false` writes them. Passing
`targets` narrows the set; an unknown target is reported instead of silently
ignored.

## The pyproject it writes (chapter 8 defaults)

For a new project the template is the strict chapter 8 configuration:

- `[tool.ruff]`: `line-length = 88`, `target-version` from the project's Python,
  `src = ["src"]`.
- `[tool.ruff.lint]`: `select = ["E", "F", "I", "B", "UP"]` — the chapter's set,
  not `ALL`; `extend-select` is how a project widens it. The wide `ALL` mode with
  per-file ignores exists at the library level — `renderPyprojectBlock` accepts
  `ruffSelect`/`ruffIgnore` — but the scaffold tool exposes no option for it, so a
  project that wants ALL must edit the generated `[tool.ruff.lint]` itself.
- `[tool.mypy]`: `python_version` plus `strict = true`.
- `[tool.ty]` only when the project's type checker resolves to `ty`.
- `[tool.pytest.ini_options]`: `testpaths`, `addopts = "-ra --strict-markers"`.
- `[tool.coverage.run]`: `branch = true`, `source` from detection.
- `[tool.coverage.report]`: `show_missing = true`, `fail_under` — 90 for a new
  project, 80 when an existing project gets missing tables, so the first added
  floor cannot turn a green gate red by itself.
- `[dependency-groups]`: four groups — `lint` (`mypy`, `ruff`), `test` (`pytest`,
  `pytest-cov`), `security` (`detect-secrets`), and `dev` aggregating the other
  three with `include-group`.
- `[tool.uv]`: `required-version`, so the uv that runs the gates is verified to be
  one that understands the lock format and `--all-groups`.
- For a workspace: `[tool.uv.workspace]` with `members`, plus
  `[tool.uv.sources]` entries with `workspace = true` for the members the project
  imports.

An existing project gets only the tables it is missing; a table this plugin does
not own is never rewritten. Every value the template writes is a resolved value,
and the dry run prints where each came from.

## How values are resolved (existing > detected > default)

Nothing about a project is hard-coded. Each gate value is read in one order:

1. **existing** — the project's own `pyproject.toml` configuration;
2. **detected** — what probing the repository found (`.python-version`,
   lockfiles, `tests/` vs `src/<pkg>/tests`, workspace members, mypy/ty presence,
   `.secrets.baseline`);
3. **default** — the plugin defaults, in one place.

Every value carries its source, so a dry run says
`ruff.line-length=88 (default)` instead of presenting a guess as the project's own
statement. The table covers Python version and target, ruff line length and rule
set, type checker and paths, test directories, build mode, coverage floor, manifest
components and state baselines.

## Version manifest

`release/agent_versions.json` is the version evidence the `manifest` stage checks:
a schema version, the service, the runtime, and the agent components — prompt
files, knowledge files, indexes, eval sets, source trees — each with a path and a
digest. `scripts/validate_version_manifest.py` is one standard-library file that
verifies the schema, that every path stays inside the repository root, and that
every recorded digest matches the file on disk. The manifest is diff-only when
regenerated: existing entries are kept, missing components are added. When the
project has no `uv.lock`, the runtime block records no `lockfile` field at all — a
missing lockfile is written as absent, never guessed as `uv.lock`.

## Secret scanning

`scripts/secret_scan.py` is read-only: it scans the files git tracks (or, with
`--staged`, the staged diff) and reports candidates. The baseline
`.secrets.baseline` is a file with a human audit history and is **never written by
this plugin** — if the baseline is missing, the security stage fails with a
guidance message, and setting one up means `detect-secrets scan` once and then
auditing every finding before it becomes a baseline. Overwriting the baseline to
make a run green erases the audit trail; the plugin does not do it for you.

`detect-secrets` ships in the `security` dependency group, installed by
`uv sync --locked --all-groups`.

## Commit hooks (prek)

`py-scaffold` writes `.pre-commit-config.yaml` with the remote repos it cannot pin
(ruff + ruff-format, the built-in whitespace/yaml/toml/merge checks, shellcheck,
actionlint, zizmor — revs stay `<latest>` placeholders on purpose, with the
releases URL in a comment) and two local hooks that run the project's own gates:

- `gatekeeper` — `uv run --locked python scripts/ci.py --profile commit`, language
  `system`, `pass_filenames: false`, `always_run: true`.
- `gatekeeper-secrets` — `uv run --locked python scripts/secret_scan.py --staged`,
  same settings; the scan is staged-only so a credential cannot be committed.

Setup, once per clone:

```text
uv tool install prek
prek install                # writes .git/hooks/pre-commit
prek run --all-files
```

The first run needs a `.secrets.baseline`: run the scanner, audit every finding,
and only then keep the baseline. `prek install` is what makes the gate automatic;
until it runs, the hook file does not exist and the panel reports it as not
installed.

## Install

```text
plugin_manager action=install_bundle target=<absolute path to this directory>
```

The bundle is added to `dsh.profile.bundles` and its patch inserts the plugin row;
`GET /gatekeeper/status` returning 200 is the proof the Host half is live. The
client half (panel + chip) needs one page reload.

## Configuration

Settings are all optional and all volatile, so a bad value never has to survive a
restart:

| Key | Default | Meaning |
| --- | --- | --- |
| `tools.audit` / `tools.scaffold` / `tools.run` | on | register that tool at all |
| `defaultPythonVersion` | `3.13` | used only when the project pins nothing |
| `matrixPythonVersions` | `''` | empty follows the project's own version |
| `testPaths` | `''` | empty uses the directories the detector found |
| `includeSecurityGate` | on | whether the security stage (secret scan, baseline wiring) is part of the generated result |
| `includeIntegrationGate` | off | whether `integration` enters CI |

Two environment variables override the two version settings, and one turns the
integration stage on; their names still carry the pre-rename `DSH_` prefix, which
the code keeps unchanged.

A project's Python version is read in one order, in one place: `.python-version`,
then the lower bound of `requires-python`, then the default. `requires-python =
">=3.9"` means target 3.9 — the floor is what the code has to parse under, and
claiming 3.9 support while linting for 3.13 is how a repository drifts.

`@deepseek-ai/schemastery` is an optional peer dependency. With it the panel shows
the effective configuration; without it the three tools run on their defaults and
the panel says so instead of pretending it can toggle them.

## The panel

A seat in the sidebar (`main` + `sidebar.panellist`) showing one project at a time:
path, package manager, Python, lint, tests, CI, the 13-stage matrix with the eight
default stages and the five optional ones marked, the four job groups, the nine
apply targets with existence per target, the git hook state (installed and whether
it points to prek), the secret baseline state, and the resolved gate values with
their sources.

It follows the session, not the installation: the route accepts `?session=` and the
chip publishes the session id it is rendered in, so switching sessions switches the
panel. `?refresh=1` re-reads instead of replaying the cached snapshot; a 10-second
poll keeps it honest without flicker.

The routes are `GET /gatekeeper/status` and `GET /gatekeeper/preview`, both
`cache-control: no-store`, because yesterday's dashboard is worse than a blank one.
The preview route renders the workflow for the stages named in `?stages=`, so you
can see a variant before writing it. When the status route is not mounted (an older
Host without `webServer`) the panel says so in one line and the three tools keep
working.

## The skill pack (the mode chip under the composer)

The panel is for *looking*; the chip is for *dispatching*. A small `技能包` pill sits
in the composer dock, grouped by tool into three foldable bars, holding sixteen
documents. Picking one writes exactly one skill command — the real name the Host
registered — into the draft; no prompt text is inserted, so there is never a
paragraph to delete. If the composer cannot accept an insertion, the command is
copied to the clipboard and the chip says so.

The last pick is remembered in browser localStorage, so the chip and its status bar
survive a reload.

## Verify

```text
node test/smoke.mjs     # Host half: detection, rendering, gates, refusals, apply, pipeline
node test/client.mjs    # Client half in a VM: seats, panel copy, chip, folding
```

Both are dependency-free Node scripts. `test/client.mjs` renders the real component
tree against a React stand-in and a fake fetch, so a broken seat registration fails
before it reaches a browser.

## The pipeline IR

Thirteen stages live in `lib/pipeline/ir.js`: eight default (lock, sync, lint, type,
manifest, test, security, build) and five optional (integration, audit, container,
release, deploy). Each stage carries its argv, the reason it exists, the job it
belongs to, and the stages it needs. Three renderers read that one source:

- `lib/pipeline/github.js` → the GitHub Actions workflow (jobs, `needs`, matrix,
  permissions, cache, artefacts)
- `lib/pipeline/local.js` → `scripts/ci.py`, the local runner
- `py-run` → the same argv, executed

Changing a gate means changing it once. A gate that exists in the workflow but not
in `py-run` is the bug this arrangement is meant to make impossible.

Jobs are isolation units, not parallelism for its own sake: `quality` carries the
eight default stages (and the optional `integration` / `audit`), `container` needs
Docker, `release` needs a tag and write permissions, `deploy` needs the release and
a command you supply. Container teardown renders `if: always()`, so a failed job
still cleans its compose stack; `down -v` stays a commented step you uncomment
yourself. `release` reuses the `dist` artifact the quality job verified instead of
rebuilding it. `deploy` keeps its health probe conditional on
`vars.DEPLOY_HEALTH_URL`.

## Auditing a pipeline it did not write

`py-audit` runs thirteen static rules over `.github/workflows/*`, in the order
`RULE_IDS` declares them: `pin-policy-mixed`, `job-timeout-missing`, `no-artifact`,
`artifact-always-error`, `sync-unlocked`, `run-unlocked`, `pip-install`,
`no-concurrency`, `permissions-missing`, `coverage-floor-missing`,
`uv-version-drift`, `container-stage-missing` and `secret-in-run`. Each finding
names the file, the rule, and what to change.

The release/deploy matrix is checked by id too, beyond the thirteen rules:
`release-no-download-artifact`, `release-rebuilds`, `release-job-missing`,
`deploy-placeholder-missing` (a deploy job without `::error::` or `exit 1` is a
silent green lie), and `deploy-job-missing`; the shape notices
`workflow-not-uv`, `workflow-stale` and `workflow-security-missing` cover the rest.

## What may execute, what may not

Execution goes through fifteen argv prefixes, never through a shell — `uv`
(`--version`, `sync`, `run`, `build`, `lock`), `docker compose` (`config`, `ps`,
`build`, `up`, `down`, `exec`, `logs`) and `docker build`; the exact list is
`lib/pipeline/exec.js`. Nothing else, and `shell: false` always.

Two limits are stated rather than hidden:

- `uv run` is prefix-equivalent to running the repository's own code, so gates run
  trusted code by design. Running them is the point.
- A timeout kills the process the tool started, not its grandchildren. Treat the
  timeout as "this tool stopped waiting", not "the machine is clean".

## What may write, what may not

Only `py-scaffold`, only with `dryRun: false`, only the nine paths above, only
inside the project root. The path check resolves symlinks component by component
and refuses a link found below the root — a project that is itself a link (a
Windows junction to another drive) still works; a link planted inside it does not.
The manifest target is diff-only, so an existing version file is never replaced.

No source file is ever edited. No global tool state is touched except tool caches,
which are the tools' own.

## How it maps onto the upstream skills

| Upstream | Becomes |
| --- | --- |
| `1-uv` | the lockfile predicate, the refusal sentence, the `uv-basics` / `uv-commands` documents |
| `2-modern-python` | the pyproject / ruff / mypy / pytest / coverage config, prek hooks, Dependabot, PEP 723, migration and security documents |
| `3-ci-cd-and-automation` | gate order, the local runner, `ci-design` |
| `4-github-actions-templates` | the workflow renderer, `gh-workflow` |

The four documents this plugin adds — `ci-container`, `ci-pipeline`, `ci-release`,
`ci-deploy` — cover what the upstream set stops short of: the container stage, how
many jobs a workflow should have, and the release/deploy half a generator can break
most expensively by guessing.

## Bundled skills

Sixteen documents under `skills/`, one directory per upstream package plus the
additions. `skills/VERSIONS.md` records what was copied and when;
`scripts/sync-skills.mjs` re-copies the vendored documents from the source tree,
while the two `modern-python/templates/*` files are not vendored: they are rendered
by `lib/prek.js` and `lib/dependabot.js`. At runtime the documents are read and
registered into the Host's `runtime` skill layer — nothing is written into
`DSH_HOME/skills`.

## Validation

v0.10 is covered by `test/smoke.mjs` (287 checks), `test/client.mjs` (76 checks)
and `tmp/e2e-run.mjs` (12 end-to-end checks against a generated project). The
nine gate commands were also run one by one on an empty project: `lock`, `sync`,
`lint`, `type`, `test` and `build` pass; `type` and `test` report a visible skip
when the project has no sources or tests; `security` fails on purpose until a
`.secrets.baseline` exists, printing the `detect-secrets` scan → audit steps.

The what-was-checked / what-was-fixed / what-remains table lives in
[docs/audit/version-audit.md](docs/audit/version-audit.md), together with the
evidence for every compatibility fix.

## Uninstall

```text
plugin_manager action=remove_bundle target=gatekeeper
```

Removing the bundle removes the tools, the seats, the routes and the registered
skills. Files `py-scaffold` already wrote into a project stay where they are; a
`.bak.<timestamp>` beside them is the previous content.

## Audit trail

This plugin was brought from DSH 0.2.1 to 0.2.2 by auditing the host rather than
guessing at it: reading `app.asar` for the real contract, then writing the
findings down. That work is kept, because "it works" is not a claim you can check.

| Path | What it is |
|---|---|
| [docs/audit/version-audit.md](docs/audit/version-audit.md) | The report: every incompatibility found, the minimal fix, and the evidence |
| [docs/audit/host-contract.md](docs/audit/host-contract.md) | Host-side services, events and config contract, as measured |
| [docs/audit/client-half.md](docs/audit/client-half.md) | Slots, the composer, and the slash trigger source |
| [docs/audit/runtime-evidence.md](docs/audit/runtime-evidence.md) | What actually failed at runtime, reproduced |
| [docs/audit/verify-round2.md](docs/audit/verify-round2.md) | An independent re-verification, including what it could not check |
| [docs/audit/placement-sim.html](docs/audit/placement-sim.html) | A browser reproduction of the popover containing-block bug |
| [scripts/audit/](scripts/audit/) | The probes, kept runnable: `npm run audit`, `npm run verify` |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The three test suites need nothing but
Node (and `uv` for the pipeline ones).

## License

MIT — see [LICENSE](LICENSE).
