---
name: ci-deploy
description: The deploy job a generator should refuse to guess — why `environment:` is the whole value of the frame, why `needs: [release]` is not the same as "the build is good", and which parts of a deploy belong to CI versus the operator.
---

# Deploying from CI

Every other stage in a pipeline answers a question with a command. Deploy does not:
`kubectl set image`, `docker compose pull && up -d`, `flyctl deploy`, `helm upgrade`,
a `curl` against a PaaS API — the right one depends on infrastructure a generator
has never seen.

That is not a reason to leave deploy out. It is a reason to render the **frame** and
leave the command as a slot.

## When to Use

- You are wiring a deploy step and wondering which parts are boilerplate.
- A deploy ran from a commit that was never released.
- You need approvals, a deployment history, or a URL before shipping.
- Someone proposes deploying from the quality job "to save a job".

## The frame, and what each part is for

```yaml
deploy:
  needs: [release]
  if: startsWith(github.ref, 'refs/tags/v') || github.event_name == 'workflow_dispatch'
  environment:
    name: production
    url: ${{ vars.DEPLOY_URL }}
  permissions:
    contents: read
    packages: read
```

- **`environment:`** — the only mechanism that gives you required reviewers,
  environment secrets scoped to that name, a deployment history, and a link in the
  PR timeline. A deploy without it works, and nobody can answer "what is live?"
  afterwards.
- **`url:`** — turns the deployment entry into a clickable link. Cheap, and the first
  thing anyone looks for.
- **`needs: [release]`** — orders deploy after the release job. It does **not** assert
  that the release succeeded in a way that guarantees the artefact is trustworthy:
  it only means the job ran. `needs` is an ordering edge, not a contract about
  content. If you need the artefact, fetch it explicitly.
- **`if:` with `workflow_dispatch`** — an urgent patch must be deployable without
  minting a new tag. This one clause is the difference between a hotfix taking five
  minutes and taking a release cycle.
- **`permissions: contents: read`** — a deploy needs to read, not to write. Keep it
  minimal; the credential for the target belongs in an environment secret.

## Pinning the ref

A deploy that runs on `workflow_dispatch` from `main` is deploying `main`, not what
was released. When the deploy must ship the released bytes:

```yaml
- uses: actions/checkout@v4
  with:
    ref: ${{ github.ref }}
```

Then prove the artefacts exist on that ref before doing anything:

```yaml
- run: gh release view "${{ github.ref_name }}" --json tagName,assets
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

That step is the cheapest guard in the file: it fails loudly if someone dispatched a
deploy from a branch that has no release, instead of deploying the previous build
while reporting success.

## Smoke check after

A deploy that returns 200 from the orchestrator has proved that the API accepted a
manifest. It has not proved the thing serves traffic:

```yaml
- run: curl -fsS --retry 5 --retry-delay 3 "${{ vars.DEPLOY_HEALTH_URL }}"
```

`--retry` with a delay is not politeness — a rolling update takes time, and a single
immediate probe reports a failure that would have resolved in ten seconds.

## What belongs to the operator

- The deploy command itself. Every plausible default is a guess about your
  infrastructure.
- The target environment's secrets. A generator cannot name them.
- Whether the deploy is blue/green, canary, or a hard restart.
- The rollback procedure.

A generator that emits `kubectl set image deployment/app app=...` for a project whose
actual deployment is a compose host has not helped; it has produced a file that looks
authoritative and fails on first use.

## Verification

- [ ] The deploy job has `needs: [release]`, not `needs: [quality]`.
- [ ] `environment:` names a real environment in the repository settings.
- [ ] There is an `if:` that allows `workflow_dispatch`, or hotfixing is impossible.
- [ ] The checkout pins the ref being deployed, when that ref is not the default branch.
- [ ] A step proves the release exists before the deploy command runs.
- [ ] There is a post-deploy check that fails on a bad response.
- [ ] The deploy command is either written by the operator or commented out — never a
      generated guess.

## Red Flags

- **Deploying from the quality job** — a lint failure and a failed deploy then share
  one job, and the deploy gets a token the lint steps did not need.
- **`needs: [quality]` only** — deploys a commit that was never built into an artefact.
- **No `environment:`** — no approvals, no history, no URL, no scoped secrets.
- **`curl` with no `--retry`** — reports a rolling update as a failure.
- **`if:` that only matches tags** — makes every hotfix a release.
- **A generated `kubectl`/`helm` command** — a guess wearing the authority of a template.
