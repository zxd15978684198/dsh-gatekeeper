// The `py-dependabot` tool: the Dependabot config the modern-python skill ships.
//
// The value this adds over "copy the template" is knowing whether it is already
// there and which ecosystems the project actually has: a repo with no workflows
// still gets the github-actions entry (it will have them), but a Python project
// with no `pyproject.toml`, `uv.lock` or `requirements.txt` should be told that
// the pip entry will match nothing rather than silently producing an inert file.

import { detect } from '../detect.js'
import { sessionCwdOf } from '../session.js'
import {
  DEPENDABOT_PATH,
  dependabotNextSteps,
  dependabotRationale,
  renderDependabotConfig,
} from '../dependabot.js'

/** The text the caller reads. */
export function formatDependabot(result) {
  const lines = [
    '# ' + result.fileName + ' — proposed Dependabot config for ' + result.root,
    '# Nothing was written to disk: this is text to review and commit yourself.',
    '# schedule: ' + result.schedule + '   cooldown: ' + result.cooldownDays + ' days'
      + '   ecosystems: ' + result.ecosystems.join(', '),
    '',
    result.yaml,
  ]
  if (result.nextSteps.length > 0) {
    lines.push('# Then:')
    for (const step of result.nextSteps) lines.push('#   ' + step)
  }
  return lines.join('\n')
}

/** The tool definition. */
export function createPyDependabotTool({ config }) {
  return {
    name: 'py-dependabot',
    description:
      'Render `.github/dependabot.yml` for a Python project: weekly pip + github-actions updates ' +
      'with the 7-day cooldown that mitigates supply-chain attacks, and grouping so minor/patch ' +
      'bumps arrive as one PR per dependency type. Returns YAML text and the follow-up steps — it ' +
      'never writes the file. Complements the `uv run pip-audit` gate: pip-audit reports CVEs you ' +
      'have now, Dependabot prevents accumulating them.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Project directory. Defaults to the calling session\'s working directory.',
        },
        schedule: {
          type: 'string',
          enum: ['daily', 'weekly', 'monthly'],
          description: 'Update check interval. Defaults to weekly, the skill template\'s choice.',
        },
        directory: {
          type: 'string',
          description: 'Ecosystem directory for the pip entry, e.g. "/" or "/backend". Defaults to "/".',
        },
        cooldownDays: {
          type: 'number',
          description:
            'Days a new release must be public before Dependabot proposes it. Defaults to 7. Pass 0 to ' +
            'omit the cooldown block (not recommended: it removes the supply-chain protection).',
        },
        ecosystems: {
          type: 'array',
          items: { type: 'string', enum: ['pip', 'github-actions'] },
          description: 'Which ecosystems to configure. Defaults to both.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          root: { type: 'string' },
          fileName: { type: 'string' },
          schedule: { type: 'string' },
          cooldownDays: { type: 'number' },
          ecosystems: { type: 'array', items: { type: 'string' } },
          yaml: { type: 'string' },
          nextSteps: { type: 'array', items: { type: 'string' } },
          rationale: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const requested = typeof args?.path === 'string' ? args.path.trim() : ''
      const root = requested !== '' ? requested : sessionCwdOf(exec)
      if (typeof root !== 'string' || root === '') {
        throw new Error('py-dependabot: this session has no working directory and no path was given.')
      }
      const detection = await detect(root)

      const schedule = typeof args?.schedule === 'string' ? args.schedule : 'weekly'
      const directory = typeof args?.directory === 'string' && args.directory.trim() !== ''
        ? args.directory.trim()
        : '/'
      const cooldownDays = Number.isInteger(args?.cooldownDays) ? args.cooldownDays : 7
      const ecosystems = Array.isArray(args?.ecosystems) && args.ecosystems.length > 0
        ? args.ecosystems
        : ['pip', 'github-actions']

      const result = {
        root: detection.root ?? root,
        fileName: DEPENDABOT_PATH,
        schedule,
        cooldownDays,
        ecosystems,
        yaml: renderDependabotConfig({ schedule, directory, cooldownDays, ecosystems }),
        nextSteps: dependabotNextSteps({ cooldownDays }),
        rationale: dependabotRationale({ cooldownDays }),
        warnings: [],
      }

      if (detection.packageManager !== 'uv' && detection.hasPyproject !== true) {
        result.warnings.push(
          'No pyproject.toml or uv.lock here: the pip ecosystem matches requirements*.txt, so the ' +
          'production group may be empty until dependencies exist.',
        )
      }
      if (cooldownDays === 0) {
        result.warnings.push(
          'cooldownDays=0 removes the supply-chain protection the skill describes at length: a malicious ' +
          'release can be proposed the day it ships.',
        )
      }
      if (detection.hasWorkflowDir !== true) {
        result.warnings.push(
          'No .github/workflows directory yet: the github-actions entry is inert until a workflow exists. ' +
          'It is still worth committing, so the first workflow is already covered.',
        )
      }

      result.summary = formatDependabot(result)
      return result
    },
    presentCall: () => ({ card: 'generic', title: 'Dependabot 配置' }),
  }
}
