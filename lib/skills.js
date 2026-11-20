// The sixteen documents, registered as real DSH skills.
//
// The earlier versions of this plugin treated a "mode" as a string written into
// the composer: pick one and a paragraph of instructions appeared in the draft.
// That is a costume, not the mechanism. A DSH skill is a named document in the
// skill catalog: it shows up as `/name`, the host loads the body into the turn,
// and the model reads the real text. So each packaged document becomes a skill
// registered through `ctx.skills.register()`, and the composer chip inserts the
// invocation token (`/python-uv-basics`) instead of prose.
//
// Names are prefixed so they never collide with a user's own skills: the
// catalog is a shared namespace and `pyproject` would be a hostile name to take.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { TOPICS, TOPIC_IDS } from './references.js'

/** Prefix on every skill this plugin registers. */
export const SKILL_PREFIX = 'python-'

/**
 * The skill name for one topic: `uv-basics` -> `python-uv-basics`.
 *
 * @param topic - one of `TOPIC_IDS`.
 * @returns the catalog name.
 */
export function skillName(topic) {
  return SKILL_PREFIX + topic
}

/**
 * A one-line description for the catalog listing.
 *
 * It has to stand alone: a reader picking from a list sees this line and the
 * name, nothing else. Each one names the artifact the document configures, so
 * "which one do I want" is answerable without opening any of them.
 */
const BLURBS = {
  'uv-basics': 'uv: project layout, lockfile, `uv sync` / `uv run`, and when uv must stay out of a Poetry or PDM project.',
  'uv-commands': 'uv command reference: add/remove/sync/lock/run/tool/python, with the flags that matter.',
  pyproject: 'The pyproject.toml tables a modern Python project needs: project metadata, dependency groups, ruff, pytest, ty.',
  'ruff-config': 'Ruff: the rule set, ignores, formatter settings, and how to adopt it without drowning in violations.',
  testing: 'pytest and coverage: testpaths, `--cov`, the 80% floor, and the coverage tables that make a failure readable.',
  migration: 'Moving an existing project onto uv, ruff, ty and pytest without breaking its release path.',
  pep723: 'PEP 723 inline script metadata: a single file that declares its own dependencies and runs with `uv run`.',
  'ci-design': 'Quality gates in CI: which gate runs first, why order matters, and what each failure is supposed to tell you.',
  'gh-workflow': 'GitHub Actions templates for Python, rewritten around setup-uv and `uv sync --frozen`.',
  prek: 'Pre-commit hooks with prek: the config format, install, auto-update, and why the revs ship unpinned.',
  security: 'Security tooling: shellcheck, detect-secrets, actionlint, zizmor, pip-audit, and Dependabot, with where each belongs.',
  dependabot: 'Dependabot for pip and GitHub Actions: weekly schedule, the 7-day cooldown, and dependency grouping.',
  'ci-container': 'Container validation in CI: what each compose/build gate proves, `--wait` and healthchecks, non-root identity, and how to read the first failing service.',
  'ci-pipeline': 'Pipeline shape: why one job first, when to split, `needs` as an ordering-only graph, and cache versus artifact.',
  'ci-release': 'Turning a green pipeline into a release: provenance attestation, SBOM, tag-gated publishing, and what a generator must leave commented out.',
  'ci-deploy': 'The deploy job a generator should refuse to guess: `environment:` and its scoped secrets, `needs` as ordering only, and the post-deploy probe.',
}

/** When a reader should reach for this document rather than another. */
const WHEN = {
  'uv-basics': 'the project uses uv, or you need to know whether it may.',
  'uv-commands': 'you know the goal but not the uv subcommand or flag.',
  pyproject: 'you are creating or repairing pyproject.toml.',
  'ruff-config': 'you are choosing lint rules or formatter behaviour.',
  testing: 'you are setting up pytest, coverage, or a coverage floor.',
  migration: 'the project already exists and runs on another toolchain.',
  pep723: 'the deliverable is one script, not a project.',
  'ci-design': 'you are deciding what CI should enforce, in what order.',
  'gh-workflow': 'you need a workflow file for a Python project.',
  prek: 'you are adding local hooks before a commit.',
  security: 'you are adding secret scanning, static analysis, or dependency scanning.',
  dependabot: 'you want dependency updates to arrive as reviewed pull requests.',
  'ci-container': 'the pipeline builds an image or brings up a compose stack.',
  'ci-pipeline': 'you are deciding how many jobs the workflow should have, or how files move between them.',
  'ci-release': 'a tag should produce a wheel, an SBOM, or a GitHub Release.',
  'ci-deploy': 'the pipeline should reach an environment after release.',
}

/**
 * Build the registration input for one topic.
 *
 * `content` is the packaged document verbatim — the same bytes `py-references`
 * returns, so the two paths can never disagree about what the guidance says.
 *
 * @param topic - one of `TOPIC_IDS`.
 * @param readFileImpl - `fs.readFileSync`-shaped, injectable for tests.
 */
export function skillRegistration(topic, readFileImpl = readFileSync) {
  const entry = TOPICS[topic]
  if (entry === undefined) {
    throw new Error(`gatekeeper: unknown topic ${JSON.stringify(topic)}`)
  }
  const path = fileURLToPath(new URL('../skills/' + entry.file, import.meta.url))
  const content = readFileImpl(path, 'utf8')
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error(`gatekeeper: ${path} is empty; the package is incomplete`)
  }
  return {
    name: skillName(topic),
    description: BLURBS[topic] ?? entry.title,
    whenToUse: WHEN[topic],
    content,
    // The document is upstream's, shipped byte for byte; `source: 'runtime'`
    // tells the catalog this row came from a plugin rather than from disk.
    source: 'runtime',
    invocation: { modelInvocable: true, userInvocable: true },
  }
}

/**
 * Register every packaged document as a skill.
 *
 * One bad document must not take the other fifteen down with it, so each
 * registration is tried on its own and a failure is reported, not thrown: the
 * tools are the plugin's primary surface and they do not depend on this.
 *
 * @param skills - the host `ctx.skills` service.
 * @param readFileImpl - injectable reader.
 * @returns `{ registered: string[], failed: { topic, reason }[] }`.
 */
export function registerSkills(skills, readFileImpl = readFileSync) {
  const registered = []
  const failed = []
  for (const topic of TOPIC_IDS) {
    try {
      skills.register(skillRegistration(topic, readFileImpl))
      registered.push(skillName(topic))
    } catch (error) {
      failed.push({ topic, reason: String(error?.message ?? error) })
    }
  }
  return { registered, failed }
}

/** What the status route reports about the catalog half. */
export function skillIndex() {
  return TOPIC_IDS.map((topic) => ({
    topic,
    name: skillName(topic),
    token: '/' + skillName(topic),
    title: TOPICS[topic].title,
  }))
}
