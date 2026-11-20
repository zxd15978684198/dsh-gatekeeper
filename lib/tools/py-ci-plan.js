// The `py-ci-plan` tool: the quality-gate order, and the Python command for each gate.
//
// This is the part of `3-ci-cd-and-automation` that survives translation: the ORDER
// of the gates (cheap and fast first) is a design decision, while its example
// commands are all Node. Returning the order together with the uv equivalents is
// what saves a caller from reading a Node document and translating it in its head.

import { CI_GATES, ciPlan } from '../ci-render.js'
import { detect } from '../detect.js'
import { STAGE_IDS, DEFAULT_STAGE_IDS } from '../pipeline/ir.js'
import { selectStages } from '../pipeline/github.js'
import { sessionCwdOf } from '../session.js'

/** Render the plan as the text the caller reads. */
export function formatPlan(gates, notes) {
  const lines = ['Quality gates, cheapest first:']
  gates.forEach((gate, index) => {
    lines.push('')
    const optional = gate.optional === true ? '  [opt-in stage]' : ''
    lines.push(String(index + 1) + '. ' + gate.title + '   (replaces ' + gate.replaces + ')' + optional)
    if (gate.trigger !== undefined) lines.push('     only on: ' + gate.trigger)
    for (const command of gate.commands) {
      const marks = []
      // Both marks change what the reader must do, so neither may be silent: an
      // opt-in command is not emitted by default, and an unverified one is a slot
      // they have to fill in.
      if (command.optIn === true) marks.push('opt-in')
      if (command.unverified === true) marks.push('you write this')
      lines.push('     $ ' + command.run + (marks.length > 0 ? '   [' + marks.join(', ') + ']' : ''))
    }
    lines.push('     why: ' + gate.rationale)
  })
  if (notes.length > 0) {
    lines.push('')
    for (const note of notes) lines.push('note: ' + note)
  }
  return lines.join('\n')
}

/** The tool definition. */
export function createPyCiPlanTool({ config }) {
  return {
    name: 'py-ci-plan',
    description:
      'Return the CI/CD pipeline for a Python project in the order it should run — lint, type, ' +
      'test, build, security audit, then the opt-in CD stages (container, release, deploy) — with ' +
      'the exact command for each gate (uv run ruff check / ruff format --check, uv run ty check, ' +
      'uv run pytest --cov, uv build, uv run pip-audit, uv build + attestation + SBOM for release) ' +
      'and the reason each gate sits where it does. Commands that are opt-in or that you must ' +
      'write yourself are marked. Read-only; it does not render a workflow file (use py-ci-render).',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Optional project directory. When given, the plan notes how this project differs ' +
            '(no uv, existing workflows). Defaults to the session workspace.',
        },
        stages: {
          type: 'string',
          description:
            'Optional comma-separated stage ids, or "all". Defaults to the plugin settings ' +
            '(security on, integration off, and never container/release/deploy).',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          gates: { type: 'array', items: { type: 'object', additionalProperties: true } },
          notes: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const notes = []
      // An explicit `stages` list is the only door that reaches the CD stages; without
      // it the pre-0.6 switches decide, so an unchanged caller sees an unchanged plan.
      const requestedStages = typeof args?.stages === 'string' ? args.stages.trim() : ''
      const selection = selectStages({
        stages: requestedStages !== '' ? requestedStages : undefined,
        includeSecurity: config.includeSecurityGate,
        includeIntegration: config.includeIntegrationGate,
      })
      const wanted = selection.ids.length > 0 ? selection.ids : DEFAULT_STAGE_IDS
      const all = ciPlan(true, true)
      // `ciPlan` returns the default gates; the opt-in stages are appended from the
      // same catalog so the plan and the rendered workflow cannot disagree.
      const gates = STAGE_IDS
        .filter((id) => wanted.includes(id))
        .map((id) => all.find((gate) => gate.id === id) ?? CI_GATES.find((gate) => gate.id === id))
        .filter((gate) => gate !== undefined)
      if (selection.rejected.length > 0) {
        notes.push('Ignored unknown stage(s): ' + selection.rejected.join(', ') + '. Known: ' + STAGE_IDS.join(', ') + '.')
      }

      // The plan works without a project, so a missing workspace is not an error —
      // it just means there is nothing project-specific to say.
      const requested = typeof args?.path === 'string' ? args.path.trim() : ''
      const root = requested !== '' ? requested : sessionCwdOf(exec)
      if (typeof root === 'string' && root !== '') {
        const detection = await detect(root)
        if (detection.ok === true) {
          if (detection.blockers.length > 0) {
            notes.push(
              'This project is managed by ' + detection.packageManager + ', not uv. The commands ' +
              'below assume uv; either migrate first or substitute the equivalent ' +
              detection.packageManager + ' invocation. See py-detect for the reasons.',
            )
          } else if (detection.packageManager !== 'uv') {
            notes.push('No uv.lock at this project: `uv sync --frozen` needs one, so run `uv lock` before CI depends on it.')
          }
          if (detection.linters?.ruff !== true) notes.push('Ruff is not configured yet: the lint gate needs a [tool.ruff] table (py-bootstrap proposes one).')
          if (detection.linters?.pytest !== true) notes.push('pytest is not configured yet: the test gate needs pytest in the dev group.')
          const projectWorkflows = Array.isArray(detection.workflows) ? detection.workflows : []
          if (projectWorkflows.length > 0) {
            notes.push(
              'This project already has ' + projectWorkflows.length + ' workflow(s): ' +
              projectWorkflows.map((workflow) => workflow.file).join(', ') +
              '. Extend one of those instead of adding a second pipeline.',
            )
          }
        } else {
          notes.push('Could not inspect ' + root + ': ' + String(detection.error ?? 'unknown error'))
        }
      }

      const result = {
        gates,
        notes,
        includeSecurity: config.includeSecurityGate,
      }
      result.summary = formatPlan(gates, notes)
      return result
    },
    presentCall: () => ({ card: 'generic', title: 'Plan CI quality gates' }),
  }
}
