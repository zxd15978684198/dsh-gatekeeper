# Bundled skill snapshots

This directory started as four upstream skill packages, copied verbatim at
vendoring time. They are **snapshots, not a merge**: `py-references` returns one
document at a time and names its source, so a caller can tell Astral's first-hand
`uv` guidance apart from a CI template collection that has since fallen behind.

The v0.10 Gatekeeper course口径 was applied in place to `modern-python/`,
`ci-cd-and-automation/` and `github-actions-templates/` (ruff at 88 columns with
`E`/`F`/`I`/`B`/`UP`, mypy strict, the coverage floor in
`[tool.coverage.report]`), so those trees are maintained here now instead of
being re-copied from upstream. The two files under `modern-python/templates/`
are not upstream copies at all — see the note under the table.

Each snapshot corresponds to one skill in the author's private `my-skills/项目管理/` tree at
the time of vendoring. Re-sync with `node scripts/sync-skills.mjs --from <dir>`.

| Snapshot | Upstream skill | Files kept | Bytes |
| --- | --- | --- | --- |
| `uv/` | `1-uv` | `SKILL.md` | 3,952 |
| `modern-python/` | `2-modern-python` | `SKILL.md`, 9 × `references/*.md`, 2 × `templates/*` | 56,729 |
| `ci-cd-and-automation/` | `3-ci-cd-and-automation` | `SKILL.md` | 11,332 |
| `github-actions-templates/` | `4-github-actions-templates` | `SKILL.md` | 7,076 |

Total upstream as vendored: 79,089 bytes across 15 files. The v0.10 edits changed
the byte counts of the three upstream-derived skill trees.

The 2 × `templates/*` files are no longer vendored: `templates/pre-commit-config.yaml`
is rendered by `renderPreCommitConfig()` in `lib/prek.js`, and
`templates/dependabot.yml` by `renderDependabotConfig()` in `lib/dependabot.js`.
Regenerate them from the renderers and diff, never from the upstream snapshot:
the upstream files still carry the Yelp remote hook and a Python 3.12 pin.

## Four documents written for this plugin

The four upstream skills cover dependencies, configuration, hooks and workflow
templates, and then stop at "run the tests". They say nothing about the container
stage, about how many jobs a pipeline should have, or about the two steps that come
after a green build — publishing and deploying. Those four documents live here:

| Snapshot | Written from | Why it is not upstream |
| --- | --- | --- |
| `ci-container-validation/SKILL.md` | the 周十七 course, Day02 (image security, non-root, cache semantics) and Day03 §7/§13/§14 | no upstream skill covers compose/build gates |
| `ci-pipeline-shape/SKILL.md` | the 周十七 course, Day01 §10.12/§11.16/§11.17 | no upstream skill covers job decomposition |
| `ci-release/SKILL.md` | the 周十七 course, Day01 §10.12/§10.13 plus the GitHub attestation and SBOM actions | no upstream skill covers provenance, SBOM or tag-gated publishing |
| `ci-deploy/SKILL.md` | the 周十七 course, Day03 §14 plus the `environment:` contract | no upstream skill covers deploy, and a generated deploy command would be a guess |

With the two template files, this directory holds 19 files (15 vendored, 4
written for this plugin); the byte figures above are as vendored, before the
v0.10 updates.

All four follow the same frontmatter shape as the snapshots (`name`, `description`)
so the catalog listing treats them identically. They are *not* in
`scripts/sync-skills.mjs`'s copy list, so re-syncing the four upstream skills
cannot delete them.

## What was left behind, and why

- **Chinese explainer documents** (`中文解释-uv.md` 16K, the two 28–32K explainers).
  They restate the English skill for a human reader. Shipping them would double the
  package to make `py-references` return the same advice twice, and a model asking
  for `uv-basics` wants the file that `uv` itself maintains.
- **`2-modern-python/agents/openai.yaml` and `assets/trail-of-bits-mark.svg` (113K).**
  Both belong to the skill's own packaging (an agent manifest and a logo), not to its
  content. The 113K SVG alone outweighs every reference document combined.
- **`scripts/` and `.github/` from the upstream skills.** The templates are kept as
  text for the caller to read; nothing here executes them.

## Mapping to `py-references` topics

| Topic | File |
| --- | --- |
| `uv-basics` | `uv/SKILL.md` |
| `uv-commands` | `modern-python/references/uv-commands.md` |
| `pyproject` | `modern-python/references/pyproject.md` |
| `ruff-config` | `modern-python/references/ruff-config.md` |
| `testing` | `modern-python/references/testing.md` |
| `migration` | `modern-python/references/migration-checklist.md` |
| `pep723` | `modern-python/references/pep723-scripts.md` |
| `ci-design` | `ci-cd-and-automation/SKILL.md` |
| `gh-workflow` | `github-actions-templates/SKILL.md` |
| `prek` | `modern-python/references/prek.md` |
| `security` | `modern-python/references/security-setup.md` |
| `dependabot` | `modern-python/references/dependabot.md` |
| `ci-container` | `ci-container-validation/SKILL.md` |
| `ci-pipeline` | `ci-pipeline-shape/SKILL.md` |
| `ci-release` | `ci-release/SKILL.md` |
| `ci-deploy` | `ci-deploy/SKILL.md` |

The two templates (`templates/dependabot.yml`, `templates/pre-commit-config.yaml`) ship
but have no topic: they are rendered by `lib/prek.js` / `lib/dependabot.js`, read by
`py-bootstrap`'s rationale and by a human, and are not served as a document. Every
*document* that ships is reachable by topic, so nothing in `skills/` is dead weight.

## Updating a snapshot

```pwsh
node scripts/sync-skills.mjs --from "../my-skills/项目管理"
node test/smoke.mjs
```

The sync script copies only the files listed above, refuses to run when the source
directory is missing, and prints a byte count per file so a silent truncation shows
up as a changed number. It never deletes: a file removed upstream stays here until
someone removes it deliberately, because a reference that disappears from under a
running session is worse than a stale one.

The two templates are not re-copied as snapshots: after editing `lib/prek.js` or
`lib/dependabot.js`, regenerate `modern-python/templates/*` from the renderers and
diff them. A raw upstream copy would restore the old Yelp hook file.
