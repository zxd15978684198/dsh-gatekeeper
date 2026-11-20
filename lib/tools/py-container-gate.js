// The `py-container-gate` tool: the container job, and the same gate locally.
//
// A compose file that `yaml.safe_load` accepts proves nothing about whether the
// stack starts. This tool therefore has two halves that must agree: the workflow
// job it renders, and the docker commands it proposes to run here. Both come from
// the `container` stage in the IR, so the local check cannot be a weaker version
// of the CI one.
//
// The stage is six checks plus one report: config, build --check, build, up --wait,
// ps, identity — then `scripts/container_report.py`, which only reports (and only
// turns non-zero when the image limit is configured and exceeded), and `down -v`
// as `always: true` teardown.
//
// Local execution is opt-in twice: `run: true` decides whether anything executes
// at all, and then the whitelist in `exec.js` decides which argv may.

import path from 'node:path'

import { detect, uvBlockedReason } from '../detect.js'
import { resolveStages } from '../pipeline/ir.js'
import { renderWorkflow } from '../pipeline/github.js'
import { refusalReason, runCommandAsync } from '../pipeline/exec.js'
import { projectRootFor } from '../session.js'

/** The container stage's steps, as argv lists, taken straight from the IR. */
export function containerSteps() {
  const stage = resolveStages(['container'])[0]
  if (stage === undefined) return []
  return stage.steps.map((step) => ({
    id: step.id,
    label: step.label,
    argv: [...step.argv],
    run: step.run,
    // `down -v` must run even when an earlier step failed.
    always: step.always === true,
    // A commented step is shown and rendered, never executed: it is the deliberate
    // variant a caller turns on in their own workflow.
    commented: step.commented === true,
    // The report step inspects the image after the identity check; it is part of
    // the gate list but not of "did the build succeed".
    report: step.id === 'container-report',
  }))
}

/** The `container` job's `needs`, taken from the IR rather than repeated here. */
function containerNeeds() {
  const stage = resolveStages(['container'])[0]
  return Array.isArray(stage?.needs) ? [...stage.needs] : ['quality']
}

/** The result text the caller reads. */
export function formatContainerGate(result) {
  if (result.blocked === true) {
    return ['BLOCKED: ' + result.reason, '', 'root: ' + result.root].join('\n')
  }
  const lines = [
    'Container gate for ' + result.root,
    '',
    'CI job `container` (needs: ' + result.needs.join(', ') + '):',
  ]
  for (const step of result.steps) {
    // A commented step is a deliberate variant, not part of the run: showing it
    // without the comment would read as "this happens", which is the opposite.
    const prefix = step.report === true ? '  * $ ' : (step.commented === true ? '  # $ ' : '  $ ')
    lines.push(prefix + step.run)
  }
  lines.push('')
  lines.push(
    result.ran === true
      ? 'Local check: executed (' + result.outcomes.length + ' command(s))'
      : 'Local check: planned only — pass `run: true` to execute',
  )
  for (const outcome of result.outcomes) {
    const mark = outcome.refused === true ? 'REFUSED' : (outcome.ok === true ? 'PASS' : 'FAIL')
    lines.push(
      '  ' + mark + '  ' + outcome.argv.join(' ') +
      (outcome.reason ? '  (' + outcome.reason + ')' : '') +
      (typeof outcome.seconds === 'number' && outcome.seconds > 0 ? '  ' + outcome.seconds + 's' : ''),
    )
  }
  if (result.ran === true) {
    lines.push('')
    lines.push('Result: ' + (result.ok === true ? 'PASS' : 'FAIL') + ' (teardown runs regardless)')
  }
  if (result.warnings.length > 0) {
    lines.push('')
    lines.push('--- notes ---')
    for (const warning of result.warnings) lines.push('- ' + warning)
  }
  return lines.join('\n')
}

/** The tool definition. */
export function createPyContainerGateTool({ config }) {
  return {
    name: 'py-container-gate',
    description:
      'Generate the `container` job of a Python CI pipeline (docker compose config --quiet, ' +
      'build --check, build, up -d --wait, ps, identity, a report-only image inspection, down -v) ' +
      'and optionally run those same commands locally against a Dockerfile/compose project. The ' +
      'report step never fails the gate on its own: it prints the image size and only turns ' +
      'non-zero when the project configured a limit in [tool.gatekeeper.image]. The local half ' +
      'only executes with `run: true`, and only whitelisted argv prefixes ever run — no shell, no ' +
      'pipes. The job is emitted behind `needs: quality`, so a container failure cannot be read ' +
      'as a lint failure. Read-only by default: writes no files, starts no container unless ' +
      'asked. Returns `{blocked: true}` for Poetry/PDM/Pipenv projects.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Project directory. Defaults to the calling session\'s working directory.',
        },
        run: {
          type: 'boolean',
          description:
            'Actually execute the docker commands locally. Defaults to false, which only plans ' +
            'them and reports what would run.',
        },
        includeWorkflow: {
          type: 'boolean',
          description: 'Include the rendered workflow excerpt with the container job. Defaults to true.',
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
          needs: { type: 'array', items: { type: 'string' } },
          steps: { type: 'array', items: { type: 'object', additionalProperties: true } },
          ran: { type: 'boolean' },
          ok: { type: 'boolean' },
          outcomes: { type: 'array', items: { type: 'object', additionalProperties: true } },
          workflow: { type: 'string' },
          warnings: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const requested = typeof args?.path === 'string' ? args.path.trim() : ''
      // The same containment check the write path uses. Without it `py-run` would
      // carry a gate for its uv half and none for its docker half — and docker is
      // the half that touches the machine rather than a virtualenv.
      const { root, refused } = projectRootFor(exec, requested)
      if (refused !== null && refused !== undefined) {
        const rejection = { blocked: true, reason: refused, root: '', ran: false, summary: '' }
        rejection.summary = formatContainerGate(rejection)
        return rejection
      }
      if (typeof root !== 'string' || root === '') {
        throw new Error('py-container-gate: this session has no working directory and no path was given.')
      }
      let detection
      try {
        detection = await detect(root)
      } catch (error) {
        // A path that cannot be inspected is a refusal, not a crash. Every sibling
        // tool returns `blocked` here, and `py-run` cannot tell "the project is
        // broken" from "the tool blew up" if this one throws instead.
        const rejection = {
          blocked: true,
          reason: 'cannot inspect ' + root + ': ' + (error instanceof Error ? error.message : String(error)),
          root: '',
          ran: false,
          summary: '',
        }
        rejection.summary = formatContainerGate(rejection)
        return rejection
      }
      const blocked = uvBlockedReason(detection)
      if (blocked.blocked === true) {
        const refusal = { blocked: true, reason: blocked.reason, root: detection.root ?? root, summary: '' }
        refusal.summary = formatContainerGate(refusal)
        return refusal
      }

      const resolvedRoot = detection.root ?? root
      const steps = containerSteps()
      const warnings = []

      // The renderer is the same one `py-ci-render` uses, so the job described
      // here and the job generated there cannot drift. The stage is named
      // explicitly because `container` is opt-in.
      const workflow = args?.includeWorkflow === false
        ? ''
        : renderWorkflow({
          pythonVersions: config.matrixPythonVersions,
          stages: 'container',
          projectName: path.basename(resolvedRoot),
          lockMode: 'frozen',
        })

      const result = {
        blocked: false,
        root: resolvedRoot,
        needs: containerNeeds(),
        steps,
        ran: false,
        ok: false,
        outcomes: [],
        workflow,
        warnings,
      }

      if (detection.markers?.dockerfile !== true && detection.markers?.composeFile !== true) {
        warnings.push(
          'No Dockerfile or compose file at the project root: `docker compose config` will fail here ' +
          'before it can validate anything. Add the files first, or point `path` at the directory that has them.',
        )
      }

      if (args?.run === true) {
        result.ran = true
        const hasReport = detection.container?.reportScript === true
        if (!hasReport) {
          // `scripts/container_report.py` is an apply target; without it the report
          // step would be a hard failure for a reason that has nothing to do with
          // the image. Skipping it (loudly) keeps the gate about the container.
          warnings.push(
            'scripts/container_report.py is missing: the report step is skipped. Generate the ' +
            'file with the apply step to get image size/limit inspection.',
          )
        }
        // The teardown is separated out because it must run regardless of what came
        // before; a container left up makes the next `up --wait` fail for a reason
        // that is not this project's fault.
        const gateSteps = steps.filter(
          (step) => step.always !== true && step.commented !== true && (step.report !== true || hasReport),
        )
        const teardown = steps.filter((step) => step.always === true)
        let failed = false
        for (const step of gateSteps) {
          const refusal = refusalReason(step.argv)
          if (refusal !== null) {
            result.outcomes.push({
              argv: step.argv, refused: true, ok: false, reason: refusal, exitCode: null, seconds: 0,
            })
            failed = true
            break
          }
          const outcome = await runCommandAsync(step.argv, { cwd: resolvedRoot, timeoutSeconds: 300, signal: exec?.signal })
          result.outcomes.push({
            argv: step.argv,
            refused: false,
            ok: outcome.ok,
            reason: outcome.reason,
            exitCode: outcome.exitCode,
            seconds: outcome.seconds,
          })
          if (outcome.ok !== true) {
            failed = true
            break
          }
        }
        for (const step of teardown) {
          if (refusalReason(step.argv) !== null) continue
          const outcome = await runCommandAsync(step.argv, { cwd: resolvedRoot, timeoutSeconds: 300, signal: exec?.signal })
          result.outcomes.push({
            argv: step.argv,
            refused: false,
            ok: outcome.ok,
            reason: outcome.reason,
            exitCode: outcome.exitCode,
            seconds: outcome.seconds,
            teardown: true,
          })
        }
        if (failed === true) {
          warnings.push('At least one step failed; `docker compose down -v` still ran, so no container is left behind.')
        }
        // A dry run proves nothing, so `ok` stays false there; here it means the
        // whole chain — teardown included — exited zero.
        result.ok = failed !== true && result.outcomes.every((outcome) => outcome.ok === true)
      } else {
        // The dry run still proves the whitelist accepts every step, which is the
        // property that would otherwise only surface at execution time.
        for (const step of steps) {
          const refusal = refusalReason(step.argv)
          if (refusal !== null) warnings.push('would be refused: ' + step.run + ' — ' + refusal)
        }
      }

      const projectWorkflows = Array.isArray(detection.workflows) ? detection.workflows : []
      if (projectWorkflows.length === 0) {
        warnings.push('No workflow under .github/workflows: this job is meant to be added to one (py-ci-render does that).')
      } else {
        const existing = projectWorkflows.map((workflow) => workflow.file).join(', ')
        warnings.push('Existing workflow(s): ' + existing + '. Merge the container job into one of them rather than adding a file.')
      }

      result.summary = formatContainerGate(result)
      return result
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args?.run === true ? 'Container gate (executing)' : 'Plan the container gate',
    }),
  }
}
