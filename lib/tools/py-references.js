// The `py-references` tool: the bundled skills, by topic.
//
// Four upstream documents ship with this plugin as verbatim snapshots. Merging
// them would blend Astral's first-hand `uv` facts with a template collection that
// is already behind, so each answer names its source instead — a model can then
// see that a sentence about `uv add` is Astral's, while a sentence about a CI
// action is a year-old template's.

import { TOPICS, TOPIC_IDS, readReference } from '../references.js'

/** The text the caller reads: the document, prefixed by where it came from. */
export function formatReference(reference) {
  return [
    '<!-- topic: ' + reference.topic + ' | ' + reference.source + ' | upstream: ' + reference.upstream + ' -->',
    '# ' + reference.title,
    '',
    reference.body,
  ].join('\n')
}

/** The tool definition. */
export function createPyReferencesTool() {
  return {
    name: 'py-references',
    description:
      'Return the bundled Python skill text for one topic, verbatim, with its source path. ' +
      'Topics: ' + TOPIC_IDS.join(', ') + '. Use it when the question is about how uv, ruff, ' +
      'pytest or CI should be configured and the authoritative wording matters — the answer ' +
      'names which upstream document it came from. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          enum: TOPIC_IDS,
          description:
            'uv-basics (the whole uv skill), uv-commands, pyproject, ruff-config, testing, ' +
            'migration (project migration checklist), pep723 (inline script metadata), ' +
            'prek (pre-commit hooks), security (shellcheck / detect-secrets / actionlint / ' +
            'zizmor / pip-audit / Dependabot), dependabot (update automation), ' +
            'ci-design (gate order and reasoning), gh-workflow (GitHub Actions template shapes).',
        },
      },
      required: ['topic'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          topic: { type: 'string' },
          title: { type: 'string' },
          source: { type: 'string' },
          upstream: { type: 'string' },
          bytes: { type: 'number' },
          body: { type: 'string' },
          summary: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args) {
      const topic = typeof args?.topic === 'string' ? args.topic.trim() : ''
      if (topic === '') {
        throw new Error('py-references: `topic` is required; valid topics are ' + TOPIC_IDS.join(', '))
      }
      const reference = await readReference(topic)
      return { ...reference, title: reference.title, summary: formatReference(reference) }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Read ' + (TOPICS[args?.topic]?.title ?? 'a Python skill reference'),
    }),
  }
}
