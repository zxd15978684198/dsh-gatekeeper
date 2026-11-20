---
name: ci-container-validation
description: Validating a containerised Python service in CI — what `docker compose config --quiet`, `docker build --check`, `up --wait`, `ps -a` and `alembic check` each prove, how healthchecks relate to `--wait`, how the image's default user is reported, and how to read the first failing service. Use when a pipeline builds images or orbits a compose stack.
---

# Container validation in CI

A container build that "works on my machine" fails in CI for reasons that are
almost never the Dockerfile. This document is about the five gates a container
stage should run, in order, plus the generated image report, and — more
importantly — what each one does *and does not* prove. A gate whose evidence you cannot state is a gate you
will disable the first time it blocks you.

## When to Use

- A Python service ships as an image, and CI must prove the image runs.
- A compose file declares more than one service (`db`, `migrate`, `api`, `seed`).
- A gate went red and you need to know which command actually failed.
- Someone proposes `--no-cache` or "retry" as a fix.

## The five gates, in order

Run them in this order. Each one is cheaper to diagnose than the next, so a
failure should stop the sequence as early as possible.

```
docker compose config --quiet      ← is the file even valid as a composition?
docker build --check .             ← is the Dockerfile valid to the builder?
docker compose up --build --wait   ← do the services reach their declared condition?
docker compose ps -a               ← what is the observed end state?
uv run python scripts/container_report.py  ← what is the image, and whose user is it?
```

### 1. `docker compose config --quiet` — composition validity only

It resolves variables, merges the override file, validates references, and exits
non-zero on a structural problem. It proves nothing about images, ports being
free, or whether the services can talk to each other. Its whole value is that it
fails in under a second and without a network.

This is also the only gate that is safe to run with no Docker daemon running in a
strict sense, and the one to trust as a pre-commit hook.

### 2. `docker build --check .` — Dockerfile lint by the builder itself

The builder's own static analysis: unknown instructions, deprecated syntax,
`COPY` sources that will not exist, stage names that do not match. It needs the
build context, so it still fails when the source tree is not checked out.

It does **not** run your tests, does not install dependencies, and cannot tell
you whether the resulting image starts.

### 3. `docker compose up --build --wait` — convergence, not correctness

`--wait` blocks until every service is either `running` or `healthy` *as declared*,
then exits 0; if a service fails or a healthcheck never passes, it exits non-zero.

The critical subtlety: **`--wait` only waits for what the service declares.** A
`db` with a `pg_isready` healthcheck is gated properly. An `api` with no
healthcheck is considered ready the moment the container starts — even if the
process crashes two seconds later. If you want `--wait` to mean something for a
service, that service needs a `healthcheck` (and, for a database, a
`start_period` so first-time initialisation is not counted as failure).

`up` recreates containers whose configuration changed. It is not `restart`, and
it does not clear named volumes — which is why a stale volume from a previous run
can make this gate fail in a way that a clean checkout never reproduces.

### 4. `docker compose ps -a` — the observed end state

`-a` is not optional. Without it, exited services are hidden, and the two states
you most need to distinguish both live there:

| State | Means |
| --- | --- |
| `Up (healthy)` | healthcheck passing now |
| `Exited (0)` | one-shot job finished successfully (`migrate`, `seed`) |
| `Exited (1)` | one-shot job failed — read its logs |
| `Up (unhealthy)` | running but failing its healthcheck |

Read this output as the evidence artifact of the container stage. In CI, print it
with `if: always()` so you still see it when an earlier step failed.

### 5. `scripts/container_report.py` — the image, and whose user it is

The generated stage does not enter the container to ask who it is: identity lives
in the image config. The report reads `Config.User` (via `docker inspect`) and
flags a default root user, next to image size, layer count, leaked development
dependencies, a missing `.dockerignore` and a single-stage build. Expected: a
non-zero user (`USER=10001`), not "以 root 运行（Dockerfile 没有非 root 的 USER）".

An empty `Config.User` means root, and `"0"` / `"root"` are the same thing. A
`docker compose exec -T api id` remains a useful *manual* probe (`-T` disables TTY
allocation, without which `exec` fails in CI), and it proves the *process* user —
but it is not a gate step: compose service names are project-private, and a
guessed name would fail the gate for a reason unrelated to the project's code.
The report proves the *image* default without entering anything.

Two things neither check proves: that the host is rootless, and that the image's
files are read-only. Those are separate claims, verified separately (a failed
`touch /app/x` is the evidence for the latter).

## The generated image report

The five commands above prove the stack runs; `scripts/container_report.py` records what the image
*is*. It runs as the last step of the container stage and reports six items: image size, layer
count, whether the default user is root, whether development dependencies leak into the running
container, whether `.dockerignore` exists, and whether the build is multi-stage. It defaults to
**report-only** and exits 0 even when it finds something.

Size is the one item that can turn the stage red: declare a ceiling as
`[tool.gatekeeper.image] max_size_mb` in `pyproject.toml` and the report exits 1 when the measured
image exceeds it. Without that setting there is no threshold, so the report never invents one — it
prints the number and skips the failure. (`container_report.py` only needs the standard library and
works on Python 3.8+.)

## Migration as a separate gate

A `migrate` service that runs `alembic upgrade head` before `api` starts is
tempting, and wrong as a *validation* strategy: if it is part of the `up`
sequence, a broken migration and a broken application both surface as "the stack
did not come up". Run the migration check as its own step:

```
docker compose run --rm migrate alembic check
```

`alembic check` compares the models to the migration history and exits non-zero
when they disagree. That is a different failure from "the migration ran but the
schema is wrong", which only a query against the real table can catch — see the
verification section.

## Reading the first failing service

Compose reports the whole stack. The useful line is the *first* service that
failed, not the last. In practice:

1. `docker compose ps -a` — which service is not healthy and not `Exited (0)`.
2. `docker compose logs --no-color <service>` for that one service only.
3. The first `ERROR`/`FATAL`/traceback in that log, not the last.
4. Reproduce with that service alone: `docker compose up -d --wait <service>`.

Common first causes, in order of frequency: a missing secret file (the container
exits before logging anything), a volume initialised with a different password
than the current one, a dependency that is `Up` but not yet `healthy` because the
service it needs has no healthcheck, and a host port already bound.

## What the gates are worth

| Gate | Proves | Does not prove |
| --- | --- | --- |
| `config --quiet` | the file is a valid composition | images exist, ports free, services reachable |
| `build --check` | the Dockerfile is valid to the builder | image starts, tests pass |
| `up --wait` | declared conditions reached | correctness, business behaviour |
| `ps -a` | observed final state | that the state is the intended one |
| `container_report.py` (默认用户) | the image's default user is not root | the process user, read-only root |

Cache is the fifth thing people mistake for evidence. A cached build proves the
cache hit, nothing more: not that the base image is patched, not that the tag
still points at the same digest, not that dependencies are current, not that this
source passed tests. Use `--pull` when you want a fresh base image; do not make
`--no-cache` the default, because you lose the cache and still prove nothing.

## Verification

A container stage is trustworthy when these hold on a clean checkout:

- [ ] `docker compose config --quiet` exits 0 with no daemon-side effects.
- [ ] `docker build --check .` exits 0 on a clean context.
- [ ] `docker compose up --build --wait` exits 0 and every long-running service
      that matters declares a `healthcheck`.
- [ ] `docker compose ps -a` shows `Exited (0)` for one-shot jobs and no
      `Unhealthy`.
- [ ] `scripts/container_report.py` reports a non-zero default user (no `root`), and
      `docker compose exec -T api id` — when you run it by hand — agrees.
- [ ] One deliberately broken thing (missing secret, renamed env var) turns the
      stage red, and the log names the right service. A gate nobody has seen fail
      is a gate nobody can trust.

## Red Flags

- `--wait` used on services that declare no healthcheck, then read as "the app is up".
- `--no-cache` added to make a flaky build "reliable".
- Container stage retried instead of read.
- `ps` without `-a`, so an `Exited (1)` is invisible.
- The migration step folded into `up`, so two different failures share one red X.
- Cache or a green build cited as security evidence.
