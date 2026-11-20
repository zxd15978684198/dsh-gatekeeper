// The `py-ci-run` tool: the same gates, runnable on the laptop.
//
// A workflow is a promise and `scripts/ci.py` is the same promise kept locally:
// both are generated from the IR, so `uv run python scripts/ci.py --stage test`
// runs the exact argv the `Test` step of the workflow runs. That equivalence is
// the only reason to generate a script rather than tell people to run `pytest`.
//
// Read-only, like everything else here: the script is returned as text.

import { detect, uvBlockedReason } from '../detect.js'
import { DEFAULT_STAGE_IDS } from '../pipeline/ir.js'
import {
  CI_SCRIPT_PATH,
  ciRunNextSteps,
  localPlan,
  planLines,
  renderCiScript,
} from '../pipeline/local.js'
import { knownStages, selectStages } from '../pipeline/github.js'
import { resolveProject } from '../resolve.js'
import { sessionCwdOf } from '../session.js'

/** The text the caller reads. */
export function formatCiRun(result) {
  if (result.blocked === true) {
    return ['BLOCKED: ' + result.reason, '', 'root: ' + result.root].join('\n')
  }
  const lines = [
    'Local pipeline for ' + result.root,
    'stages: ' + result.stages.map((stage) => stage.id).join(' → '),
    '',
  ]
  result.stages.forEach((stage, index) => {
    lines.push(String(index + 1) + '. ' + stage.title + ' (' + stage.id + ')')
    for (const command of stage.commands) lines.push('     $ ' + command)
  })
  if (result.script !== '') {
    lines.push('')
    lines.push('--- ' + result.scriptPath + ' ---')
    lines.push(result.script)
  }
  return lines.join('\n')
}

/** The tool definition. */
export function createPyCiRunTool({ config }) {
  return {
    name: 'py-ci-run',
    description:
      'Generate `scripts/ci.py`, a standard-library Python runner that executes the same pipeline ' +
      'stages in the same order as the generated GitHub workflow (ruff check/format, ty, pytest ' +
      '--cov, uv build, pip-audit, and the docker compose gate when `container` is selected), on ' +
      'Windows and on ubuntu with one command: `uv run python scripts/ci.py --stage all`. Also ' +
      'returns the plan as text (--list form). Returns the script as TEXT and writes nothing; ' +
      'REFUSES when the project is managed by Poetry/PDM/Pipenv, because the uv commands would not ' +
      'run there. Use `stages` to pick a subset (e.g. "lint,test"); the release and deploy stages ' +
      'are excluded from the local plan because a laptop has no registry credential and must not ' +
      'ship anything.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Project directory. Defaults to the calling session\'s working directory.',
        },
        stages: {
          type: 'string',
          description:
            'Comma-separated stage ids, or "all". Known: ' + knownStages().join(', ') + '. "all" ' +
            'means the default stages only; integration, container, release and deploy must be ' +
            'named explicitly. Defaults to this plugin\'s settings (security on, integration off).',
        },
        includeScript: {
          type: 'boolean',
          description: 'Return the generated scripts/ci.py source. Defaults to true.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          blocked: { type: 'boolean' },
          reason: { type: 'string' },
          root: { type: 'string' },
          stages: { type: 'array', items: { type: 'object', additionalProperties: true } },
          scriptPath: { type: 'string' },
          script: { type: 'string' },
          nextSteps: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const requested = typeof args?.path === 'string' ? args.path.trim() : ''
      const root = requested !== '' ? requested : sessionCwdOf(exec)
      if (typeof root !== 'string' || root === '') {
        throw new Error('py-ci-run: this session has no working directory and no path was given.')
      }
      const detection = await detect(root)
      const blocked = uvBlockedReason(detection)
      if (blocked.blocked === true) {
        const refusal = { blocked: true, reason: blocked.reason, root: detection.root ?? root, summary: '' }
        refusal.summary = formatCiRun(refusal)
        return refusal
      }

      const requestedStages = typeof args?.stages === 'string' ? args.stages.trim() : ''
      const selection = selectStages({
        stages: requestedStages !== '' ? requestedStages : undefined,
        includeSecurity: config.includeSecurityGate,
        includeIntegration: config.includeIntegrationGate,
      })
      const ids = selection.ids.length > 0 ? selection.ids : DEFAULT_STAGE_IDS
      // The script is written from the same plan this tool prints, so the project's
      // resolved facts (type paths, test presence, build mode) must reach localPlan
      // here too: py-apply renders with `resolved`, and a plan without it would make
      // `scripts/ci.py` byte-different from what this tool promises.
      let plan
      try {
        plan = localPlan(ids, { resolved: resolveProject({ rootDir: detection.root ?? root, detection }) })
      } catch {
        plan = localPlan(ids)
      }
      const projectName = detection.root === undefined
        ? 'python'
        : detection.root.split(/[\\/]/).filter((part) => part !== '').pop() ?? 'python'
      const includeScript = args?.includeScript !== false

      const result = {
        blocked: false,
        root: detection.root ?? root,
        stages: planLines(plan),
        scriptPath: CI_SCRIPT_PATH,
        script: includeScript ? renderCiScript(plan, { projectName }) : '',
        nextSteps: ciRunNextSteps({ scriptPath: CI_SCRIPT_PATH }),
        warnings: [],
      }

      if (detection.packageManager !== 'uv') {
        result.warnings.push(
          'No uv.lock here: `uv run` will create or update one. Run `uv lock` and commit it first, ' +
          'or the local run and CI will resolve different versions.',
        )
      }
      const projectWorkflows = Array.isArray(detection.workflows) ? detection.workflows : []
      if (projectWorkflows.length > 0) {
        result.warnings.push(
          'Existing workflow(s): ' + projectWorkflows.map((workflow) => workflow.file).join(', ') +
          '. Keep scripts/ci.py and that workflow in step, or the two will drift.',
        )
      }
      if (detection.linters?.pytest !== true) {
        result.warnings.push('pytest is not configured here, so the test stage will fail on a missing dev dependency.')
      }
      if (selection.rejected.length > 0) {
        result.warnings.push(
          'Ignored unknown stage(s): ' + selection.rejected.join(', ') + '. Known: ' + knownStages().join(', ') + '.',
        )
      }
      // The local plan keeps what a laptop can genuinely do and drops the rest, so a
      // caller who asked for the CD stages must be told what was left out and why
      // rather than assume the whole stage ran.
      const plannedIds = plan.map((stage) => stage.id)
      const askedCd = ids.filter((id) => id === 'release' || id === 'deploy')
      const skippedCd = askedCd.filter((id) => !plannedIds.includes(id))
      if (skippedCd.length > 0) {
        result.warnings.push(
          'The local plan drops ' + skippedCd.join(' and ') + ' entirely: every step in that stage ' +
          'needs a credential, an environment or a remote this machine does not have.',
        )
      }
      if (askedCd.includes('release') && plannedIds.includes('release')) {
        result.warnings.push(
          'The local plan keeps only `uv build` from release. Attesting, the SBOM, the artifact ' +
          'upload, publishing and creating the GitHub Release all require CI.',
        )
      }

      result.summary = formatCiRun(result)
      if (result.warnings.length > 0) {
        result.summary += '\n\n--- notes ---\n' + result.warnings.map((warning) => '- ' + warning).join('\n')
      }
      return result
    },
    presentCall: (args) => ({
      card: 'generic',
      title: typeof args?.stages === 'string' && args.stages.trim() !== ''
        ? 'Local pipeline: ' + args.stages.trim()
        : 'Generate the local pipeline script',
    }),
  }
}
