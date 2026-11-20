---
name: ci-pipeline-shape
description: Choosing the shape of a CI pipeline — one job or several, `needs` dependency graphs, artifact passing between jobs, cache versus artifact, and what parallelism actually costs. Use when a workflow outgrows a single quality job, or when jobs need files from each other.
---

# Pipeline shape: one job, or many

Almost every pipeline starts as one job and should stay one job far longer than
people expect. The question this document answers is *when* splitting pays for
itself, and what exactly you have to write down when you do.

## When to Use

- A single job has grown past a few minutes and someone proposes splitting it.
- A job needs a wheel, a report, or an image produced by another job.
- A stage should run even when an earlier stage failed (evidence upload).
- You are choosing between matrix, `needs`, and separate workflows.

## Why one job first

Putting environment setup, quality gates, tests, and build in a single job has
three concrete advantages, and they are not sentimental:

- **Environment is prepared once.** Every additional job pays `checkout` +
  interpreter + `uv sync` again before it does any work.
- **The first failing step is obvious.** With one job, the log shows the step and
  the step order *is* the dependency order.
- **Build naturally depends on everything before it.** No `needs:` to get wrong,
  no artifact to hand over, no chance of a build that succeeds against a tree the
  tests never saw.

A split turns all three into configuration you now maintain, and each one is a
place where a pipeline can be green while being wrong.

## Why the gates still need an order

Inside the single job, the order is the same one the design document argues for:
cheap and deterministic first, slow and environmental last.

```
lockfile check → lint → format → type → test+coverage → build → [container]
```

Each step should be able to fail on its own and say which property broke:
`uv lock --check` = declaration and lock agree; `ruff check` = rules; `ruff
format --check` = formatting only; `ty`/`mypy` = interfaces; `pytest` = observable
behaviour; `uv build` = the package is producible. A step that fails for two
reasons at once is a step whose failure message will be misread.

## When to split

Split on a real axis, not for tidiness.

| Split when | Because |
| --- | --- |
| Independent platforms (OS × Python version) | failures are genuinely per-cell |
| One stage is much slower and blocks nothing else | total wall-clock drops |
| A stage needs credentials or permissions the others must not have | least privilege |
| A stage must run even after failure (evidence) | `if: always()` needs its own job |
| A stage needs Docker/daemon access | runner capability differs |

Do not split when the reason is "the file is long". Length is not a cost model;
repeated environment setup is.

## `needs` is a graph, and a name that does not exist is an error

`needs: [quality]` means "run after that job, and skip me if it failed". Two
failure modes matter:

1. **A `needs:` naming a job not in this file is rejected by GitHub.** This is why
   a job extracted into its own workflow cannot keep `needs: [quality]` live — the
   dependency has to be expressed another way (a summary comment, a `workflow_run`
   trigger, or a reusable workflow with an explicit `needs` at the call site).
2. **`needs` does not pass files.** It passes *ordering* only. Anything a
   downstream job wants to read must be uploaded and downloaded explicitly.

A minimal, correct multi-job skeleton — note that `quality` stays one job, and
only the container stage is separated:

```yaml
jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v5
        with:
          enable-cache: true
      - run: uv sync --frozen --all-groups
      - run: uv run ruff check .
      - run: uv run pytest --cov
      - run: uv build

  container:
    needs: [quality]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: docker compose config --quiet
      - run: docker compose up --build --wait
      - if: always()
        run: docker compose ps -a
```

## Cache is not an artifact

The distinction is worth memorising, because mixing them produces pipelines that
look fast and lose their evidence.

| | Cache | Artifact |
| --- | --- | --- |
| Purpose | speed up a later run | keep this run's evidence / pass files between jobs |
| Losing it may | cost time | must fail the run |
| Typical content | downloaded dependencies, uv cache | test report, wheel, sdist, version manifest |
| Is release evidence | no | yes |

Consequences: retrieving a release package *from the cache* is a bug; treating a
dependency cache as an audit trail is a bug. `setup-uv` with `enable-cache: true`
is the cache half. `actions/upload-artifact` is the artifact half, and it should
run with `if: always()` so a failed run still ships its report — plus
`if-no-files-found: error`, otherwise a typo in the path uploads nothing and
still reports success.

## Permissions are part of the shape

A checking workflow should not be able to write to the repository:

```yaml
permissions:
  contents: read
```

and checkout should not persist credentials (`persist-credentials: false`). A
release job that genuinely needs to create a release or fetch cloud identity
belongs in its own job with its own narrow `permissions:` — separating it is a
security boundary, not a style preference.

## What parallelism costs

Parallel jobs do not shorten a pipeline for free. Each one:

- pays the setup cost again (checkout, interpreter, `uv sync`);
- needs its own copy of any file produced upstream (artifact round-trip);
- multiplies the number of logs you read when something fails;
- can hide an ordering bug that a single job could not express.

The honest rule: split when the measured wall-clock saving exceeds the setup
cost, or when the split buys a real boundary (permissions, runner capability,
`always()` evidence). Otherwise keep one job and let the step order carry the
dependency.

## Verification

- [ ] A failing gate turns the pipeline red and the message names the property that broke.
- [ ] Every `needs:` names a job that exists in the same file.
- [ ] Files crossing a job boundary travel by `upload-artifact`/`download-artifact`.
- [ ] The artifact upload uses `if: always()` and `if-no-files-found: error`.
- [ ] The checking jobs declare `permissions: contents: read`.
- [ ] Removing any one gate makes a deliberately broken commit fail — a gate that
      cannot fail is decoration.

## Red Flags

- `needs:` referring to a job that lives in another workflow file.
- A downstream job reading files it never downloaded.
- Release wheels taken from the cache.
- `upload-artifact` without `if-no-files-found: error`.
- Splitting into five jobs to make the YAML "cleaner" while total time goes up.
- One job granted `contents: write` because a different job needed it.
