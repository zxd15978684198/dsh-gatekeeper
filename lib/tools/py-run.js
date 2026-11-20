// The `py-run` tool: actually run the pipeline, in one stage list and one report.
//
// This replaces two tools that both executed commands — `py-pipeline-run` (the uv
// gates) and `py-container-gate` (docker compose up / build / identity / teardown).
// Both ran argv through the same allowlist, both reported exit codes, and a caller
// wanting "run everything including the container" had to call them in the right
// order and merge two reports. One tool, one stage list, one report.
//
// Every command comes from the same IR (13 stages) the generated workflow and
// `scripts/ci.py` are built from, so what runs locally cannot drift from what runs
// on GitHub. The stage universe is `ir.STAGE_IDS`; the default is the eight gates
// every push is measured against. `profile: "commit"` narrows that to the
// `COMMIT_STAGE_IDS` subset a commit hook can afford, and `from` re-runs a failed
// chain from the stage that broke instead of from the beginning.
//
// Dry run is the default: it prints the plan and executes nothing.
//
// Resolution (mypy/ty, `src` paths, `--all-packages`) is applied where the plan is
// built and executed — `py-pipeline-run` — because that is the only layer that sees
// both the argv and the project values. Applying it here would produce a resolved
// plan this tool cannot hand to the executor, which is exactly the two-spellings
// problem the IR exists to prevent.

import { COMMIT_STAGE_IDS, DEFAULT_STAGE_IDS, STAGE_IDS } from '../pipeline/ir.js'
import { PROFILE_NAMES } from '../pipeline/local.js'
import { createPyContainerGateTool } from './py-container-gate.js'
import { createPyPipelineRunTool } from './py-pipeline-run.js'

/** The stage id that needs Docker rather than a uv command. */
const CONTAINER_STAGE = 'container'

/** Read a comma-separated string or an array as a clean list of stage ids. */
function normalizeStages(value) {
  const raw = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(',') : [])
  return raw.map((entry) => String(entry).trim().toLowerCase()).filter((entry) => entry !== '')
}

/**
 * `full` or `commit`, with a typo rejected instead of silently normalized.
 *
 * A silently-normalized profile is a wrong answer that looks like a success: the
 * caller asking for `commit` on a typo would get the full chain — including the
 * network gates — from what they believed was a fast hook.
 */
function profileOf(value) {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (name === '') return 'full'
  if (!PROFILE_NAMES.includes(name)) {
    throw new Error(
      'py-run: unknown profile "' + value + '"; choose one of: ' + PROFILE_NAMES.join(', ') + '.',
    )
  }
  return name
}

/**
 * The stage chain this call runs, before the two halves are split apart.
 *
 * `commit` is an intersection, not a replacement: a caller that names `test`
 * under the commit profile gets nothing (the hook cannot afford it), not the whole
 * commit set. The generated `scripts/ci.py` narrows the same way, in `local.js`.
 */
function chainOf(profile, requested) {
  const base = requested.length === 0
    ? [...DEFAULT_STAGE_IDS]
    : (requested.includes('all') ? [...DEFAULT_STAGE_IDS] : requested)
  return profile === 'commit' ? base.filter((id) => COMMIT_STAGE_IDS.includes(id)) : base
}

/** A block separator that reads fine both in a terminal and in a tool card. */
function rule(title) {
  return '--- ' + title + ' ---'
}

/**
 * The tool definition. Built per registration, never shared across mounts.
 *
 * @param config - resolved plugin settings (timeouts, gate switches).
 */
export function createPyRunTool({ config }) {
  const pipelineRunTool = createPyPipelineRunTool({ config })
  const containerGateTool = createPyContainerGateTool({ config })

  return {
    name: 'py-run',
    description:
      'Run the quality gates of a Python + uv project in this session, in pipeline order, and ' +
      'report each stage\'s exit code. The stage universe comes from the same 13-stage IR the ' +
      'generated workflow and scripts/ci.py are built from: lock, sync, lint, type, manifest, ' +
      'test, security (scripts/secret_scan.py), build, and the opt-in integration, audit ' +
      '(pip-audit), container (docker compose + a report-only image inspection), release and ' +
      'deploy. The default is the eight gates a push is measured against; `profile: "commit"` ' +
      'narrows that to lock + lint + manifest for a fast commit hook; `from` resumes a failed ' +
      'run at the stage that broke. Commands with a project-dependent argv (mypy/ty and its ' +
      'paths, `uv build --all-packages`) are resolved from this project before they are run, ' +
      'so the dry run and the execution cannot spell the same gate two ways. Dry run by ' +
      'default: it prints the exact plan and executes nothing. Stops at the first failing gate; ' +
      'a command that could not run at all is reported as an environment failure, not as a ' +
      'verdict on the project.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Project directory. Defaults to the calling session\'s working directory. Commands ' +
            'run with this as their cwd, never with the plugin\'s own directory.',
        },
        stages: {
          type: 'array',
          items: { type: 'string', enum: [...STAGE_IDS] },
          description:
            'Stages to run, in canonical pipeline order. Defaults to the eight default gates (' +
            DEFAULT_STAGE_IDS.join(', ') + '). "all" means the same eight; the optional stages ' +
            '(' + STAGE_IDS.filter((id) => !DEFAULT_STAGE_IDS.includes(id)).join(', ') + ') must ' +
            'be named explicitly. A comma-separated string is accepted too. "container" needs ' +
            'Docker and runs the compose checks plus the report step instead of a uv command.',
        },
        profile: {
          type: 'string',
          enum: [...PROFILE_NAMES],
          description:
            'Gate profile. "full" (default) is the selection above — the full push pipeline. ' +
            '"commit" is the fast subset a commit hook can afford (' +
            COMMIT_STAGE_IDS.join(', ') + '): network gates, docker and the delivery stages are ' +
            'not in it, so naming them under this profile runs nothing for them.',
        },
        from: {
          type: 'string',
          description:
            'Resume from this stage: every stage before it is skipped, and a stage id that is ' +
            'not part of this plan is an error (silently running nothing after a failure is ' +
            'worse than a red line). Same flag as `scripts/ci.py --from`.',
        },
        dryRun: {
          type: 'boolean',
          description:
            'Default true: print the plan and run nothing. Pass false to execute. Nothing in ' +
            'a dry run touches the project.',
        },
        stopAfter: {
          type: 'string',
          description:
            'Stop after this stage id — run only the fast gates, e.g. "test". Everything after ' +
            'it is skipped, not reported as passed.',
        },
        timeoutSeconds: {
          type: 'number',
          description:
            'Per-stage timeout in seconds. Defaults to 300. A timeout stops waiting for the ' +
            'command; it does not kill the processes that command started.',
        },
        totalBudgetSeconds: {
          type: 'number',
          description:
            'Overall budget in seconds. Defaults to 900. A stage that would exceed it is ' +
            'skipped and reported as skipped rather than silently truncated.',
        },
        includeWorkflow: {
          type: 'boolean',
          description:
            'Only for the container stage: include the rendered `container` job in the report.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          mode: { type: 'string' },
          summary: { type: 'string' },
          ok: { type: 'boolean' },
          root: { type: 'string' },
          profile: { type: 'string' },
          from: { type: 'string' },
          stages: { type: 'array', items: { type: 'object', additionalProperties: true } },
          stoppedEarly: { type: 'boolean' },
          stoppedReason: { type: 'string' },
          totalSeconds: { type: 'number' },
          container: { type: 'object', additionalProperties: true },
        },
        required: ['mode', 'summary'],
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const path = typeof args?.path === 'string' ? args.path : undefined
      const dryRun = args?.dryRun !== false
      // Both of these throw on a typo instead of falling back: a "commit" run that
      // silently became the full chain is the opposite of a fast hook.
      const profile = profileOf(args?.profile)
      const from = typeof args?.from === 'string' ? args.from.trim().toLowerCase() : ''
      if (from !== '' && !STAGE_IDS.includes(from)) {
        throw new Error(
          'py-run: unknown stage in from "' + args.from + '"; known stages: ' + STAGE_IDS.join(', ') + '.',
        )
      }

      const requested = normalizeStages(args?.stages)
      const chain = chainOf(profile, requested)
      if (requested.length > 0 && chain.length === 0) {
        // Every named stage was outside the profile universe. This is a real
        // request/answer mismatch, so it is reported rather than run as "nothing".
        const excluded = requested.filter((id) => !COMMIT_STAGE_IDS.includes(id))
        throw new Error(
          'py-run: profile "' + profile + '" does not include ' + excluded.join(', ') +
          '; the commit profile is ' + COMMIT_STAGE_IDS.join(', ') + '.',
        )
      }

      const containerIndex = STAGE_IDS.indexOf(CONTAINER_STAGE)
      const fromIndex = from === '' ? -1 : STAGE_IDS.indexOf(from)
      const stopAfter = typeof args?.stopAfter === 'string' ? args.stopAfter.trim().toLowerCase() : ''
      const stopIndex = stopAfter !== '' && STAGE_IDS.includes(stopAfter) ? STAGE_IDS.indexOf(stopAfter) : -1

      const containerRequested = chain.includes(CONTAINER_STAGE)
      const uvRequested = chain.filter((stage) => stage !== CONTAINER_STAGE)
      // `from` is a position in the canonical chain, not a per-half filter: a run
      // resuming at `release` must not then run `container`, which sits before it.
      const containerRuns = containerRequested
        && (fromIndex === -1 || fromIndex <= containerIndex)
        && (stopIndex === -1 || stopIndex >= containerIndex)
      const uvRuns = uvRequested.length > 0 && from !== CONTAINER_STAGE

      const parts = []
      const report = {
        mode: 'run',
        dryRun,
        profile,
        from,
        root: '',
        ok: false,
        stages: [],
        stoppedEarly: false,
        stoppedReason: '',
        totalSeconds: 0,
      }
      if (profile !== 'full' || from !== '') {
        parts.push('# py-run — ' + (dryRun ? 'DRY RUN' : 'run') + ', profile: ' + profile
          + (from === '' ? '' : ', from: ' + from))
        parts.push('')
      }

      let uvOk = true
      let containerOk = true
      let ranHalf = false

      if (uvRuns) {
        ranHalf = true
        // No stages argument keeps the plugin settings' selection (security /
        // integration toggles) in charge; naming stages is the caller's override.
        const pipeline = await pipelineRunTool.execute(
          {
            path,
            stages: requested.length > 0 ? uvRequested : undefined,
            dryRun,
            profile,
            // `from` is only handed to this half when it names one of its stages;
            // `from: "container"` is handled by skipping this half entirely.
            from: from === '' || from === CONTAINER_STAGE ? undefined : from,
            stopAfter: stopAfter !== '' ? stopAfter : undefined,
            timeoutSeconds: typeof args?.timeoutSeconds === 'number' ? args.timeoutSeconds : undefined,
            totalBudgetSeconds:
              typeof args?.totalBudgetSeconds === 'number' ? args.totalBudgetSeconds : undefined,
          },
          exec,
        )
        report.root = String(pipeline?.root ?? '')
        uvOk = pipeline?.ok === true || pipeline?.dryRun === true
        report.stages = Array.isArray(pipeline?.stages) ? pipeline.stages : []
        report.stoppedEarly = pipeline?.stoppedEarly === true
        report.stoppedReason = String(pipeline?.stoppedReason ?? '')
        report.totalSeconds = Number(pipeline?.totalSeconds ?? 0)
        report.pipeline = pipeline
        parts.push(String(pipeline?.summary ?? 'py-run: the pipeline returned nothing'))
      }

      if (containerRuns) {
        ranHalf = true
        const container = await containerGateTool.execute(
          {
            path,
            // The gate's `run` flag is the same decision as `dryRun: false`; keeping
            // one name at this layer means a caller cannot pass run:true and dryRun:true
            // and get an answer that contradicts itself.
            run: dryRun === false,
            includeWorkflow: args?.includeWorkflow === true,
          },
          exec,
        )
        report.container = container
        report.root = String(container?.root ?? report.root)
        containerOk = container?.ok === true
        parts.push(rule('container gate'), String(container?.summary ?? ''))
      }

      if (!ranHalf) {
        // Reached only when the selection narrowed to stages this profile has none
        // of; the explicit error above covers a named selection, this covers a
        // profile that filtered the whole default chain.
        parts.push('No stage in profile "' + profile + '" is runnable here.')
      }

      if (dryRun && ranHalf) {
        parts.push(
          '',
          rule('dry run'),
          'Nothing was executed. Pass dryRun: false to run this plan.',
        )
      }

      // A dry run proves nothing about the project, so it cannot be `ok` — the
      // `pipeline` half reports `ok: false` for exactly that reason.
      report.ok = dryRun !== true && uvOk && containerOk
      return {
        ...report,
        summary: parts.join('\n'),
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args?.dryRun === false ? 'Run the pipeline' : 'Plan the pipeline',
    }),
  }
}
