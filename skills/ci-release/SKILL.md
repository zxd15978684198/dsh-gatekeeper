---
name: ci-release
description: Turning a green pipeline into a shipped release — what `uv build`, a provenance attestation, an SBOM and a GitHub Release each prove, why they belong on a tag rather than on every push, and which parts a generator must leave to you.
---

# Releasing from CI

A pipeline that only lints and tests is a gate. The moment it publishes, it is a
release process — and a release process has a property a gate does not: **what it
emits cannot be withdrawn.** A wrong lint rule costs a re-run; a wrong wheel on an
index costs a version number nobody can reuse.

So the question is never "can CI publish?" but "what must be true before it does?"

## When to Use

- A tag push should produce artefacts, and you want to know which ones are trustworthy.
- You are deciding between publishing on every merge and publishing on a tag.
- Someone asks why an SBOM or an attestation is worth the step.
- A release job failed and you need to know whether anything escaped.

## The release chain, in order

Each step exists because the one before it cannot prove what it proves.

| Step | Command / action | What it proves | What it does **not** prove |
| --- | --- | --- | --- |
| Build | `uv build` | The sdist and wheel build from **what is committed** | That they install, or that they import |
| Attest | `actions/attest-build-provenance@v2` (`subject-path: dist/*`) | These exact bytes came from this workflow, this repo, this commit | That the bytes are correct |
| SBOM | `anchore/sbom-action@v0` (`format: spdx-json`) | What third-party code is inside the artefact | That any of it is safe |
| Upload | `actions/upload-artifact@v4` (`if-no-files-found: error`) | The run itself carries the files, for inspection later | That they were published anywhere |
| Publish | `pypa/gh-action-pypi-publish@release/v1` | The artefact is now on the index | That it works |
| Release | `gh release create "$TAG" dist/* --generate-notes --verify-tag` | A human page exists, pointing at attested bytes | — |

`--verify-tag` matters: without it `gh release create` will happily create the tag
itself, so a typo in the workflow produces a release from a ref that never existed.

## Why the trigger is a tag, not a push

A publish step on `push: branches: [main]` has exactly two behaviours, both wrong:

1. It fails, because there is no version number to publish under.
2. It succeeds, and uploads a version derived from a placeholder — usually
   `0.0.0` or a local version segment — that can never be withdrawn.

`if: startsWith(github.ref, 'refs/tags/v')` is therefore not an optimisation. It is
the entire difference between a release process and a machine that publishes
accidents. The same rule applies one step up: the release **job** carries the
condition, so the runner never even provisions a container for a push that cannot
release.

## Permissions are per job, not per workflow

The workflow-level `permissions: contents: read` is the floor. A release job raises
it — and only for itself:

```yaml
permissions:
  contents: write       # create the release
  id-token: write       # OIDC, for the attestation
  attestations: write   # write the attestation
  packages: write       # push an image, if you opted in
```

A token that can write releases handed to the lint job is a token that a compromised
dependency in the lint job can use to write releases. Job-scoped permissions are the
cheapest security boundary in the whole pipeline.

`persist-credentials: false` on `actions/checkout` is the other half: without it the
token stays in `.git/config` and every later step inherits it.

## What a generator must not decide for you

Two steps need a secret this repository has never seen:

- **Publishing to PyPI** — `pypa/gh-action-pypi-publish` needs either a trusted
  publisher configured on the index or a `PYPI_API_TOKEN`. It is idempotent in the
  useful direction: re-publishing an existing version fails, which is correct.
- **Pushing an image** — `docker/login-action` plus
  `docker/build-push-action` need a registry and a credential. The tags are a
  policy decision, not a default.

A generated pipeline should emit these **commented out** and say so. A template that
guesses `ghcr.io/${{ github.repository }}:latest` is guessing about your registry
layout, and the first person to uncomment it ships something with a name nobody
chose.

## Verification

- [ ] The release job is gated on `startsWith(github.ref, 'refs/tags/v')`.
- [ ] `permissions:` on the release job is the minimum it needs; the workflow floor
      is `contents: read`.
- [ ] `actions/checkout` has `persist-credentials: false` unless a step genuinely
      needs the token in git config.
- [ ] The build step runs **in the release job**, not on a `dist/` from another job
      that was never passed.
- [ ] The attestation covers the files that are actually published (`subject-path`
      matches the publish step's input).
- [ ] `gh release create` uses `--verify-tag`.
- [ ] Publishing and image pushing are commented out until someone supplies the
      credential — and the comment says which secret is needed.

## Red Flags

- **Publishing on `push: main`** — either always fails or ships a phantom version.
- **`permissions: write-all`** at the workflow level — the reason job scoping exists.
- **`subject-path: dist` instead of `dist/*`** — attests a directory entry, not the
  files, so the provenance matches nothing anyone downloads.
- **An SBOM generated but never uploaded** — evidence nobody can read is not evidence.
- **`--generate-notes` without `--verify-tag`** — creates a tag from whatever ref ran.
- **"We'll add the attestation later"** — provenance only covers builds that ran
  with it; retrofitting means re-releasing under a new version.
