// The skill snapshots, indexed by topic.
//
// The four upstream documents are distributed verbatim, not merged: merging would
// blend Astral's first-hand `uv` facts with a template collection that is already
// behind (the GitHub Actions templates are Node-18 era). Keeping them separate
// means every answer can name where it came from, which is what the `source`
// field on each result is for — the model can see that a sentence is Astral's
// rather than this plugin's.

/** Where the snapshots live, relative to this module. */
const SKILLS_ROOT = new URL('../skills/', import.meta.url)

/**
 * topic -> snapshot file (relative to `skills/`) plus a human title.
 *
 * `uv-basics` and `ci-design` and `gh-workflow` are whole SKILL.md documents;
 * the rest are the individual reference files a reader would otherwise have to
 * open all of. Sixteen entries cover every document that ships, so nothing in
 * `skills/` is dead weight.
 */
export const TOPICS = {
  'uv-basics': {
    file: 'uv/SKILL.md',
    title: 'uv — the basics',
    upstream: 'astral-sh/claude-code-plugins',
  },
  'uv-commands': {
    file: 'modern-python/references/uv-commands.md',
    title: 'uv commands',
    upstream: 'trailofbits/skills (modern-python)',
  },
  pyproject: {
    file: 'modern-python/references/pyproject.md',
    title: 'pyproject.toml configuration',
    upstream: 'trailofbits/skills (modern-python)',
  },
  'ruff-config': {
    file: 'modern-python/references/ruff-config.md',
    title: 'Ruff configuration',
    upstream: 'trailofbits/skills (modern-python)',
  },
  testing: {
    file: 'modern-python/references/testing.md',
    title: 'Testing with pytest',
    upstream: 'trailofbits/skills (modern-python)',
  },
  migration: {
    file: 'modern-python/references/migration-checklist.md',
    title: 'Migrating an existing project to the modern toolchain',
    upstream: 'trailofbits/skills (modern-python)',
  },
  pep723: {
    file: 'modern-python/references/pep723-scripts.md',
    title: 'PEP 723 inline script metadata',
    upstream: 'trailofbits/skills (modern-python)',
  },
  'ci-design': {
    file: 'ci-cd-and-automation/SKILL.md',
    title: 'CI/CD design and quality gates',
    upstream: 'addyosmani/agent-skills',
  },
  'gh-workflow': {
    file: 'github-actions-templates/SKILL.md',
    title: 'GitHub Actions workflow templates',
    upstream: 'wshobson/agents',
  },
  // These three were packaged from the start but had no topic, which made them
  // unreachable: a caller could not ask for the pre-commit setup or the security
  // tooling that the modern-python skill devotes whole references to.
  prek: {
    file: 'modern-python/references/prek.md',
    title: 'Pre-commit hooks with prek',
    upstream: 'trailofbits/skills (modern-python)',
  },
  security: {
    file: 'modern-python/references/security-setup.md',
    title: 'Security hooks and dependency scanning',
    upstream: 'trailofbits/skills (modern-python)',
  },
  dependabot: {
    file: 'modern-python/references/dependabot.md',
    title: 'Automated dependency updates with Dependabot',
    upstream: 'trailofbits/skills (modern-python)',
  },
  // Two documents written for this plugin from the course material, because the
  // four upstream skills stop at "run the tests" and never cover the container
  // stage or the question of how many jobs a pipeline should have. They live here
  // rather than in the upstream snapshots so a re-sync cannot delete them.
  'ci-container': {
    file: 'ci-container-validation/SKILL.md',
    title: 'Container validation in CI',
    upstream: 'written for Gatekeeper (distilled from the 周十七 course)',
  },
  'ci-pipeline': {
    file: 'ci-pipeline-shape/SKILL.md',
    title: 'Pipeline shape: one job or many',
    upstream: 'written for Gatekeeper (distilled from the 周十七 course)',
  },
  // The delivery half. The upstream snapshots stop at build; these two cover what
  // happens after a green pipeline, which is where a generator can do the most
  // damage by guessing.
  'ci-release': {
    file: 'ci-release/SKILL.md',
    title: 'Releasing from CI',
    upstream: 'written for Gatekeeper (distilled from the 周十七 course)',
  },
  'ci-deploy': {
    file: 'ci-deploy/SKILL.md',
    title: 'Deploying from CI',
    upstream: 'written for Gatekeeper (distilled from the 周十七 course)',
  },
}

/** The topic ids, in a stable order, for the tool's `enum`. */
export const TOPIC_IDS = Object.keys(TOPICS)

/**
 * Read one topic's snapshot.
 *
 * @param topic - one of {@link TOPIC_IDS}.
 * @returns `{ topic, title, upstream, source, body, bytes }`.
 * @throws when the topic is unknown (a caller bug, not a user error) or the file
 *   is missing (a packaging bug) — both deserve to be loud.
 */
export async function readReference(topic, readFileImpl = null) {
  const entry = TOPICS[topic]
  if (entry === undefined) {
    throw new Error(
      `py-references: unknown topic ${JSON.stringify(topic)}; valid topics are ${TOPIC_IDS.join(', ')}`,
    )
  }
  const url = new URL(entry.file, SKILLS_ROOT)
  const text = readFileImpl === null
    ? await (await import('node:fs/promises')).readFile(url, 'utf8')
    : await readFileImpl(url)
  return {
    topic,
    title: entry.title,
    upstream: entry.upstream,
    // The path inside the package, so a reader can go to the file itself.
    source: 'skills/' + entry.file,
    bytes: Buffer.byteLength(text, 'utf8'),
    body: text,
  }
}

/**
 * Every topic's size without reading it — used by the panel and by smoke tests.
 *
 * @param statImpl - `fs.promises.stat`, injectable for tests.
 * @returns `[{ topic, file, title, upstream, bytes }]`.
 */
export async function indexTopics(statImpl = null) {
  const stat = statImpl === null
    ? (await import('node:fs/promises')).stat
    : statImpl
  const rows = []
  for (const [topic, entry] of Object.entries(TOPICS)) {
    let bytes = null
    try {
      bytes = (await stat(new URL(entry.file, SKILLS_ROOT))).size
    } catch {
      bytes = null
    }
    rows.push({ topic, file: 'skills/' + entry.file, title: entry.title, upstream: entry.upstream, bytes })
  }
  return rows
}
