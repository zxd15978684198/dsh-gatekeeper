// The `py-pipeline-run` tool: run the quality gates here, not on a runner.
//
// `py-ci-run` hands over `scripts/ci.py` and lets the user run it. This tool is
// the other half of the answer to "the plugin only gives advice": it executes the
// same argv list in this session, so the answer to "would CI pass" stops depending
// on a push.
//
// Two constraints produce the shape below, and both come from the report side:
//
// * The plan is `local.js`'s, not a command list written here. The workflow, the
//   generated script and this tool therefore run identical argv — three gates
//   wearing one name is the failure this plugin exists to prevent.
// * Every command goes through `exec.js`, which is a prefix allowlist with
//   `shell: false`. There is no path from a project file to an arbitrary command:
//   adding one requires editing `ALLOWED_PREFIXES`, on purpose.
//
// `dryRun` defaults to true for the same reason `py-apply` does: a tool that runs
// `docker compose up` because someone forgot a flag is a tool people uninstall.

import { localPlan, PROFILE_NAMES } from '../pipeline/local.js'
import { refusalReason, runCommandAsync } from '../pipeline/exec.js'
import { selectStages } from '../ci-render.js'
import { applyResolved, DEFAULT_STAGE_IDS, STAGE_IDS } from '../pipeline/ir.js'
import { knownStages } from '../pipeline/github.js'
import { detect, uvBlockedReason } from '../detect.js'
import { resolveProject } from '../resolve.js'
import { projectRootFor } from '../session.js'

/** Seconds one stage may take. `docker compose build` and `pip-audit` are the slow ones. */
export const DEFAULT_STAGE_TIMEOUT_SECONDS = 300

/** Seconds the whole run may take, however many stages were asked for. */
export const DEFAULT_TOTAL_BUDGET_SECONDS = 900

/**
 * Why a stage in the plan has no steps to run here.
 *
 * `release` and `deploy` are real stages — they exist in the workflow and in
 * `scripts/ci.py` — but every step they own is `uses` / `local: false` / commented,
 * so a local run has nothing to execute. The plan keeps them so the local matrix
 * and the generated script agree on 13 stages; this is the reason shown instead of
 * pretending they ran.
 */
const CI_ONLY_REASON = '本地无步骤（CI only）'

/** How many trailing lines of a command's output are kept. */
const TAIL_LINES = 20

/** The last `count` lines of a stream, joined; empty input stays empty. */
export function tail(text, count = TAIL_LINES) {
  // A caller passing 0 or a negative count means "keep none" / "I computed this
  // wrong"; either way the honest answer is the tail of the tail, not the whole
  // stream with a lie about how many lines were elided.
  const wanted = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : TAIL_LINES
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  // A trailing newline produces an empty last element; drop it so the tail is
  // actually the last lines of output rather than one blank line short.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length <= wanted) return lines.join('\n')
  if (wanted === 0) return '… ' + lines.length + ' earlier line(s)'
  return '… ' + (lines.length - wanted) + ' earlier line(s)\n' + lines.slice(-wanted).join('\n')
}

/**
 * Why a failed step failed: its own findings, or the tool never got to run.
 *
 * A gate that reports "your code has problems" and a gate that reports "the tool
 * could not start" need different reactions — one wants a fix, the other wants an
 * environment. `pip-audit` on Windows exits 1 both when it finds a vulnerability
 * and when it cannot create its cache directory, so the exit code alone cannot
 * tell them apart. These markers mean the interpreter or the OS stopped it before
 * it audited anything.
 */
export function failureKind(outcome) {
  const text = String(outcome.stdout ?? '') + '\n' + String(outcome.stderr ?? '')
  // `is not recognized` without the "as" also matches PowerShell's
  // `is not recognized as the name of a cmdlet`; `请先 uv sync` is the message
  // `scripts/secret_scan.py` prints when `detect-secrets` is missing (uv exits 2
  // on `Failed to spawn`, which is a different process-level failure).
  const neverRan =
    /Traceback \(most recent call last\)|PermissionError|ModuleNotFoundError|ImportError|OSError|WinError|is not recognized|command not found|No such file or directory|failed to create|Failed to spawn|program not found|not found in PATH|failed to connect to the docker API|daemon is running|Cannot connect to the Docker daemon|docker: not found|请先 uv sync/
  return neverRan.test(text) ? 'environment' : 'findings'
}

/**
 * The stream that explains a failed step.
 *
 * A tool's findings usually go to stdout and its environment chatter to stderr, but
 * that is not a rule — `pip-audit` and `docker` both report on stderr. Prefer the
 * stream that names a failure, then the one that is not just uv's install log.
 */
export function failureText(outcome) {
  const stdout = String(outcome.stdout ?? '')
  const stderr = String(outcome.stderr ?? '')
  const saysFailure = (text) => /::error|error:|FAILED|failed|Traceback|not reached/i.test(text)
  if (saysFailure(stdout) && !saysFailure(stderr)) return stdout
  if (saysFailure(stderr) && !saysFailure(stdout)) return stderr
  if (stdout.trim() !== '') return stderr.trim() === '' ? stdout : stdout + '\n' + stderr
  return stderr
}

/** The text the caller reads. */
export function formatPipelineRun(result) {
  if (result.blocked === true) {
    return ['BLOCKED: nothing was run.', '', result.reason, '', 'root: ' + result.root].join('\n')
  }
  const head = result.dryRun === true
    ? '# py-pipeline-run — DRY RUN, nothing was executed (' + result.root + ')'
    : '# py-pipeline-run — ' + (result.ok === true ? 'all gates passed' : 'a gate failed')
      + ' in ' + result.totalSeconds + 's (' + result.root + ')'
  const selection = [
    result.profile ? 'profile: ' + result.profile : '',
    result.from ? 'from: ' + result.from : '',
  ].filter((part) => part !== '').join(', ')
  const lines = [head]
  if (selection !== '') lines.push(selection)
  lines.push('')
  if (result.dryRun === true) {
    const plan = result.plan ?? []
    if (plan.length === 0) lines.push('No runnable step in the selected stages.')
    for (const stage of plan) {
      lines.push(stage.id + ' — ' + stage.title)
      // A plan row with no steps is a CI-only stage; an empty command list would
      // read as "the plan is missing something" rather than "this cannot run here".
      if (stage.ciOnly === true) {
        lines.push('  (' + (stage.reason ?? CI_ONLY_REASON) + ')')
        continue
      }
      for (const step of stage.steps) {
        lines.push('  $ ' + step.run)
      }
    }
    lines.push('')
    lines.push(
      'Nothing was executed. Re-run with dryRun=false to run exactly the commands above, ' +
      'stopping at the first failure.',
    )
  } else {
    for (const stage of result.stages ?? []) {
      // `ci-only` is not a pass: the gate exists, but nothing ran here. Folding it
      // into PASS would make a local run claim gates it never touched.
      const mark = stage.status === 'pass' ? 'PASS'
        : (stage.status === 'fail' ? 'FAIL' : (stage.status === 'ci-only' ? 'CI-ONLY' : 'SKIP'))
      lines.push('[' + mark + '] ' + stage.id + ' — ' + stage.title + '  (' + stage.seconds + 's)'
        + (stage.status === 'ci-only' ? '  — ' + (stage.reason ?? CI_ONLY_REASON) : ''))
      for (const step of stage.steps ?? []) {
        lines.push('  ' + (step.skipped === true ? 'skip' : (step.ok ? 'ok  ' : 'FAIL')) + ' $ ' + step.run
          + (step.exitCode === null || step.exitCode === undefined ? '' : '  [exit ' + step.exitCode + ']')
          + (step.reason === null || step.reason === undefined ? '' : '  — ' + step.reason)
          + (step.kind === 'environment' ? '  — the tool did not run' : ''))
        if (step.ok !== true && step.tail !== '') {
          for (const line of step.tail.split('\n')) lines.push('      ' + line)
        }
      }
      if (stage.status === 'fail') {
        lines.push('')
        // A gate that could not start is not a finding about the project. Saying
        // "gate failed" for it sends the reader to fix code that may be fine.
        const envFailure = (stage.steps ?? []).some((step) => step.ok !== true && step.kind === 'environment')
        if (envFailure) {
          lines.push('Stopped at ' + stage.id + ': the command could not run to completion, so this gate ' +
            'reports nothing about the project. Fix the environment above, then run it again.')
        } else {
          lines.push('Stopped at ' + stage.id + ': nothing after a failing gate runs, so a later stage ' +
            'that never began is not reported as passed.')
        }
        // Name the stages that did not run. Breaking here left the reader with the
        // failing gate and no statement about the rest, which reads as "the rest
        // passed" in a pipeline whose whole point is that it stopped.
        const ranIds = new Set((result.stages ?? []).map((entry) => entry.id))
        const notRun = (result.plan ?? []).map((entry) => entry.id).filter((id) => !ranIds.has(id))
        if (notRun.length > 0) {
          lines.push('[SKIP] ' + notRun.join(', ') + ' — never started, so nothing is known about them.')
        }
        break
      }
    }
    lines.push('')
    lines.push('total ' + result.totalSeconds + 's'
      + (result.stoppedEarly === true ? '  (stopped early: ' + result.stoppedReason + ')' : ''))
    if (Array.isArray(result.ciOnlySkipped) && result.ciOnlySkipped.length > 0) {
      // Said once, after the summary: these stages were not failures and not passes,
      // and a reader who only sums PASS lines must not count them.
      lines.push('CI only (no local step, not a pass): ' + result.ciOnlySkipped.join(', '))
    }
  }
  if (result.refused?.length > 0) {
    lines.push('')
    lines.push('Refused (not in the allowlist):')
    for (const entry of result.refused) lines.push('  $ ' + entry.run + '  — ' + entry.reason)
  }
  if (result.warnings?.length > 0) {
    lines.push('')
    lines.push('--- notes ---')
    for (const warning of result.warnings) lines.push('- ' + warning)
  }
  if (result.dryRun === false) {
    lines.push('')
    lines.push(
      'The generated script runs the same argv: `uv run --locked python scripts/ci.py` ' +
      '(`--profile commit` for the fast subset, `--from <stage>` to resume after a failure).',
    )
  }
  return lines.join('\n')
}

/** `full` or `commit`, with a typo rejected instead of silently normalized. */
function profileName(value) {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (name === '') return 'full'
  if (!PROFILE_NAMES.includes(name)) {
    throw new Error(
      'py-pipeline-run: unknown profile "' + value + '"; choose one of: ' + PROFILE_NAMES.join(', ') + '.',
    )
  }
  return name
}

/**
 * Replace every template argv with this project's resolved values.
 *
 * `local.js` calls `runOf(argv)` on the unresolved template, so a plan printed
 * before this step would show `{typePaths}` and a command executed after it would
 * show the real paths — the two-spellings drift the whole IR is meant to prevent.
 * Resolution therefore happens once, here, before the plan is printed or executed.
 */
function resolvePlan(plan, resolvedValues) {
  for (const stage of plan) {
    // `applyResolved` walks `step.by` / `step.argvBy`; a stage without a resolver
    // comes back untouched, so calling it unconditionally is safe and keeps the
    // "every stage went through the same step" property.
    applyResolved(stage, resolvedValues)
  }
  return plan
}

/** The tool definition. */
export function createPyPipelineRunTool({ config }) {
  return {
    name: 'py-pipeline-run',
    description:
      'Run the quality gates of a Python + uv project in this session — the execution half of ' +
      'py-ci-plan / py-ci-render. The stage universe is the same 13-stage IR the workflow and ' +
      '`scripts/ci.py` are generated from: lock, sync, lint (ruff check + format --check), type ' +
      '(mypy or ty, with the project\'s paths), manifest (the version-manifest validator), test ' +
      '(pytest with coverage), security (`scripts/secret_scan.py`), build (`uv build` with the ' +
      'project\'s mode), and the opt-in integration, audit (`pip-audit`), container ' +
      '(`docker compose`), release and deploy. Commands with a project-dependent argv — which ' +
      'type checker, which paths, `--all-packages` or `--package`, the coverage floor — are ' +
      'resolved from this project before they are shown or run, so the dry run and the execution ' +
      'cannot spell one gate two ways. Every command comes from the same IR, so the three cannot ' +
      'disagree. Runs only through an argv allowlist with `shell: false`; a command outside it ' +
      'comes back refused with the accepted prefixes, never executed. `profile: "commit"` narrows ' +
      'the selection to the fast commit subset, `from` resumes a failed chain at the stage that ' +
      'broke. Defaults to `dryRun: true`, which prints the exact plan and runs nothing; pass ' +
      '`dryRun: false` to execute. Stops at the first failing gate, prints the tail of its ' +
      'output, and enforces a per-stage timeout of 300s and a total budget of 900s.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Project directory to run in. Defaults to the calling session\'s working directory.',
        },
        stages: {
          type: 'array',
          items: { type: 'string', enum: [...STAGE_IDS] },
          description:
            'Stage ids to run, in order. Known: ' + knownStages().join(', ') + '. "all" means the ' +
            'default stages (' + DEFAULT_STAGE_IDS.join(', ') + '); the opt-in stages must be named ' +
            'explicitly. Omitting it uses this plugin\'s settings. A comma-separated string is also ' +
            'accepted.',
        },
        profile: {
          type: 'string',
          enum: [...PROFILE_NAMES],
          description:
            'Gate profile. "full" (default) is the selection above. "commit" is the fast subset a ' +
            'commit hook can afford (lock, lint, manifest): stages outside it run nothing.',
        },
        from: {
          type: 'string',
          description:
            'Resume from this stage id: everything before it is skipped. A stage that is not part ' +
            'of this plan is an error rather than a silent no-op.',
        },
        dryRun: {
          type: 'boolean',
          description: 'Default true: print the plan and run nothing. Pass false to execute.',
        },
        stopAfter: {
          type: 'string',
          description:
            'Stage id to stop after, e.g. "test" to run only the fast gates. Default: run the ' +
            'selection to the end (or to the first failure).',
        },
        timeoutSeconds: {
          type: 'number',
          description: 'Per-stage timeout in seconds. Defaults to 300.',
        },
        totalBudgetSeconds: {
          type: 'number',
          description:
            'Overall budget in seconds. Defaults to 900; a stage that would exceed it is skipped ' +
            'and reported as skipped rather than silently truncated.',
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
          dryRun: { type: 'boolean' },
          ok: { type: 'boolean' },
          plan: { type: 'array', items: { type: 'object', additionalProperties: true } },
          stages: { type: 'array', items: { type: 'object', additionalProperties: true } },
          ciOnlySkipped: { type: 'array', items: { type: 'string' } },
          refused: { type: 'array', items: { type: 'object', additionalProperties: true } },
          totalSeconds: { type: 'number' },
          stoppedEarly: { type: 'boolean' },
          stoppedReason: { type: 'string' },
          warnings: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const requested = typeof args?.path === 'string' ? args.path.trim() : ''
      const { root, refused: outsideSession } = projectRootFor(exec, requested)
      if (outsideSession !== null) {
        // The stages here are real commands run in the resolved directory; a `path`
        // that escapes the session workspace would run them somewhere the caller
        // never named. Refused before detection, so nothing is planned.
        const refusal = {
          blocked: true,
          reason: 'Nothing was run: ' + outsideSession + '.',
          root: root ?? '',
          dryRun: true,
          ok: false,
          plan: [],
          stages: [],
          refused: [],
          totalSeconds: 0,
          stoppedEarly: false,
          stoppedReason: '',
          warnings: [],
        }
        refusal.summary = formatPipelineRun(refusal)
        return refusal
      }
      if (typeof root !== 'string' || root === '') {
        throw new Error('py-pipeline-run: this session has no working directory and no path was given.')
      }
      const detection = await detect(root)
      const resolvedRoot = detection.root ?? root

      // Refused before anything starts, for the same reason the generating tools
      // are: every stage here is a `uv run`, and on a Poetry project the first one
      // does not merely fail — `uv run` creates a `.venv` inside a project that
      // manages its own environment. Running a foreign project's pipeline is not
      // this tool's job, and the refusal names the rule instead of guessing.
      const blocked = uvBlockedReason(detection)
      if (blocked.blocked === true) {
        const refusal = {
          blocked: true,
          reason: 'Nothing was run: the pipeline below is a `uv run` pipeline, and this project is '
            + 'not uv-managed.\n\n' + blocked.reason,
          root: resolvedRoot,
          dryRun: args?.dryRun !== false,
          ok: false,
          plan: [],
          stages: [],
          refused: [],
          totalSeconds: 0,
          stoppedEarly: false,
          stoppedReason: '',
          warnings: [],
        }
        refusal.summary = formatPipelineRun(refusal)
        return refusal
      }

      const dryRun = args?.dryRun !== false
      // `parseStageList` accepts both shapes, so hand it whatever arrived: an array
      // is the documented form, but a comma-separated string was the only form this
      // tool used to honour. Reading `args.stages` as a string only meant a caller
      // passing `['lint','test']` had every stage silently ignored and the default
      // selection run instead — the worst kind of bug, because the output looks
      // like a success.
      const rawStages = args?.stages
      const requestedStages =
        Array.isArray(rawStages)
          ? rawStages
          : typeof rawStages === 'string' && rawStages.trim() !== ''
            ? rawStages
            : undefined
      const selection = selectStages({
        stages: requestedStages,
        includeSecurity: config.includeSecurityGate,
        includeIntegration: config.includeIntegrationGate,
      })
      // A caller who NAMED stages gets exactly those stages, or nothing. Falling back
      // to the default chain here used to run MORE than was asked for: `stages:
      // 'securty'` (a typo) executed lint → type → test → build → security, and the
      // lint findings arrived looking like the security result. An unknown id is a
      // mistake to report, not a request to run the whole pipeline.
      if (requestedStages !== undefined && selection.ids.length === 0) {
        const refusal = {
          blocked: true,
          reason:
            'Nothing was run: ' +
            selection.rejected.map((id) => '"' + id + '"').join(', ') +
            ' is not a stage this pipeline knows.\n\nKnown stages: ' +
            knownStages().join(', ') +
            '.\n"all" selects the default stages (' +
            DEFAULT_STAGE_IDS.join(', ') +
            '); the opt-in stages must be named explicitly. Omitting `stages` runs ' +
            "this plugin's default selection.",
          root: resolvedRoot,
          dryRun: args?.dryRun !== false,
          ok: false,
          plan: [],
          stages: [],
          refused: [],
          totalSeconds: 0,
          stoppedEarly: false,
          stoppedReason: '',
          warnings: [],
        }
        refusal.summary = formatPipelineRun(refusal)
        return refusal
      }

      const ids = selection.ids.length > 0 ? selection.ids : DEFAULT_STAGE_IDS
      const profile = profileName(args?.profile)
      const from = typeof args?.from === 'string' ? args.from.trim().toLowerCase() : ''
      // Values are resolved once, from the project, and then applied to the plan —
      // the dry run and the execution must show/run the same argv.
      const resolvedValues = resolveProject({ rootDir: resolvedRoot, detection })
      let plan
      try {
        plan = localPlan(ids, { profile, from, resolved: resolvedValues })
      } catch (error) {
        // `local.js` refuses a `from` that is not in this plan. Surfacing it as a
        // blocked result keeps the tool contract (a reason the caller can act on)
        // instead of an exception that reads like the plugin crashed.
        const refusal = {
          blocked: true,
          reason: 'Nothing was run: ' + (error?.message ?? String(error)),
          root: resolvedRoot,
          dryRun: args?.dryRun !== false,
          profile,
          from,
          ok: false,
          plan: [],
          stages: [],
          refused: [],
          totalSeconds: 0,
          stoppedEarly: false,
          stoppedReason: '',
          warnings: [],
        }
        refusal.summary = formatPipelineRun(refusal)
        return refusal
      }
      resolvePlan(plan, resolvedValues)

      const warnings = []
      if (profile === 'commit') {
        const excluded = ids.filter((id) => !plan.some((stage) => stage.id === id))
        if (excluded.length > 0) {
          warnings.push(
            'The commit profile runs ' + plan.map((stage) => stage.id).join(', ') + ' only; ' +
            'not in this profile: ' + excluded.join(', ') + '.',
          )
        }
      }
      if (selection.rejected.length > 0) {
        warnings.push('Ignored unknown stage(s): ' + selection.rejected.join(', ') +
          '. Known: ' + knownStages().join(', ') + '.')
      }
      if (detection.packageManager !== 'uv') {
        warnings.push(
          'No uv.lock here: `uv sync --frozen` cannot pass without one. Run the apply step or ' +
          '`uv lock` first.',
        )
      }
      // Every argv is checked up front, in the dry run too. A plan that lists a
      // command the executor would refuse is a plan that lies about what the next
      // step does.
      const refused = []
      for (const stage of plan) {
        for (const step of stage.steps) {
          // A skip step names a gate this project has nothing to feed; its argv is
          // documentation, never spawned, so the allowlist has nothing to vet.
          if (step.skip === true) continue
          const reason = refusalReason(step.argv)
          if (reason !== null) refused.push({ stage: stage.id, run: step.run, reason })
        }
      }

      // Same floor as `runCommand`: `Math.floor(0.5)` is 0, and a 0 there means "no
      // timeout at all" — asking for a stricter limit must not disable it.
      const stageTimeout = Number.isFinite(args?.timeoutSeconds) && args.timeoutSeconds > 0
        ? Math.min(Math.max(1, Math.floor(args.timeoutSeconds)), 86400)
        : DEFAULT_STAGE_TIMEOUT_SECONDS
      const totalBudget = Number.isFinite(args?.totalBudgetSeconds) && args.totalBudgetSeconds > 0
        ? Math.min(Math.max(1, Math.floor(args.totalBudgetSeconds)), 86400)
        : DEFAULT_TOTAL_BUDGET_SECONDS

      if (dryRun === true) {
        const result = {
          blocked: false,
          root: resolvedRoot,
          dryRun: true,
          profile,
          from,
          ok: false,
          plan,
          stages: [],
          // Reported here too: the dry run lists the plan, and the caller needs the
          // same "these cannot run locally" split without diffing steps by hand.
          ciOnlySkipped: plan.filter((stage) => stage.ciOnly === true).map((stage) => stage.id),
          refused,
          totalSeconds: 0,
          stoppedEarly: false,
          stoppedReason: '',
          warnings,
        }
        result.summary = formatPipelineRun(result)
        return result
      }

      const stopAfter = typeof args?.stopAfter === 'string' ? args.stopAfter.trim() : ''
      const stageResults = []
      // CI-only stages are collected separately so a caller can tell "nothing to run
      // here" from "everything passed" without parsing the summary text.
      const ciOnlySkipped = []
      let spent = 0
      let failed = false
      let stoppedEarly = false
      let stoppedReason = ''
      if (refused.length > 0) {
        // Refuse before the first process starts, not halfway through: a plan with
        // one unapproved step is not a plan.
        const refusal = {
          blocked: false,
          root: resolvedRoot,
          dryRun: false,
          ok: false,
          plan,
          stages: [],
          refused,
          totalSeconds: 0,
          stoppedEarly: true,
          stoppedReason: 'the plan contains a command outside the allowlist',
          warnings,
        }
        refusal.summary = formatPipelineRun(refusal)
        return refusal
      }

      for (const stage of plan) {
        if (failed) break
        // A stage with no local steps is CI-only (release, deploy). The plan keeps it
        // so the local matrix and the workflow agree on 13 stages, but there is
        // nothing to run: `pass` would claim a gate that never ran, and `fail` would
        // blame the project for CI's absence.
        if (stage.ciOnly === true) {
          ciOnlySkipped.push(stage.id)
          stageResults.push({
            id: stage.id,
            title: stage.title,
            status: 'ci-only',
            reason: stage.reason ?? CI_ONLY_REASON,
            seconds: 0,
            steps: [],
          })
          // `--stop-after` on a CI-only stage still ends the run: the caller asked to
          // stop having reached it, and reaching it is all a local run can do.
          if (stopAfter !== '' && stage.id === stopAfter) break
          continue
        }
        // The first stage always gets its turn: a budget smaller than one stage
        // would otherwise report "0 stages ran" for a plan that never started.
        if (spent >= totalBudget && stage.id !== plan[0]?.id) {
          stoppedEarly = true
          stoppedReason = 'total budget of ' + totalBudget + 's reached before the ' + stage.id + ' stage'
          break
        }
        // However long the stage is allowed to take, it cannot outlive the budget.
        const stepTimeout = Math.max(1, Math.min(stageTimeout, Math.ceil(totalBudget - spent)))
        const stageStarted = Date.now()
        const stepResults = []
        let stageOk = true
        for (const step of stage.steps) {
          if (!stageOk && step.always !== true) continue
          // An absent gate (no type paths, no tests) is a skip, not a run and not a
          // failure: `applyResolved` kept the CI argv so the plan and the workflow
          // spell one command, and `skip` says this project has nothing to run.
          if (step.skip === true) {
            stepResults.push({
              id: step.id,
              label: step.label,
              run: step.run,
              status: 'skip',
              ok: true,
              refused: false,
              exitCode: 0,
              seconds: 0,
              reason: step.skipReason ?? '无步骤可跑（skip）',
              kind: null,
              tail: '',
              skipped: true,
            })
            continue
          }
          // Awaited, not blocked on: `spawnSync` here used to freeze the whole host
          // for as long as `uv sync` took, which is indistinguishable from a hang.
          const outcome = await runCommandAsync(step.argv, {
            cwd: resolvedRoot,
            timeoutSeconds: stepTimeout,
            signal: exec?.signal,
          })
          // Both streams matter and they carry different things: ruff writes its
          // findings to stdout while uv writes "Creating virtual environment /
          // Installed 45 packages" to stderr. Preferring stderr whenever it is
          // non-empty therefore hides every lint error in a cold checkout, where
          // uv has something to say. Keep whichever stream actually explains the
          // failure, and fall back to the other one.
          const tailText = outcome.ok === true ? '' : tail(failureText(outcome))
          stepResults.push({
            id: step.id,
            run: step.run,
            ok: outcome.ok === true,
            refused: outcome.refused === true,
            exitCode: outcome.exitCode,
            seconds: outcome.seconds,
            reason: outcome.reason ?? null,
            // Only a failure has a kind; a passing step has nothing to explain.
            kind: outcome.ok === true ? null : failureKind(outcome),
            tail: tailText,
          })
          if (outcome.ok !== true) {
            stageOk = false
            failed = true
          }
          spent += Number.isFinite(outcome.seconds) ? outcome.seconds : 0
        }
        const seconds = Math.round(((Date.now() - stageStarted) / 1000) * 10) / 10
        stageResults.push({
          id: stage.id,
          title: stage.title,
          status: stageOk ? 'pass' : 'fail',
          seconds,
          steps: stepResults,
        })
        if (stopAfter !== '' && stage.id === stopAfter) break
      }
      // Stages the run never reached are reported as skipped rather than omitted:
      // "9 stages, 4 results" reads as a bug, and a silent zero reads as a pass.
      for (const stage of plan) {
        if (stageResults.some((entry) => entry.id === stage.id)) continue
        stageResults.push({ id: stage.id, title: stage.title, status: 'skip', seconds: 0, steps: [] })
      }

      const result = {
        blocked: false,
        root: resolvedRoot,
        dryRun: false,
        profile,
        from,
        ok: failed !== true,
        plan,
        stages: stageResults,
        // Additive: old consumers ignore it; a caller that counts stages uses it to
        // avoid counting a CI-only stage as either a pass or a skip.
        ciOnlySkipped,
        refused,
        totalSeconds: Math.round(spent * 10) / 10,
        stoppedEarly,
        stoppedReason,
        warnings,
      }
      result.summary = formatPipelineRun(result)
      return result
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args?.dryRun === false ? '在本地跑质量闸门' : '预览要跑的质量闸门命令',
    }),
  }
}

/** Every stage id this tool can run, for callers that want to validate input. */
export const RUNNABLE_STAGES = [...STAGE_IDS]
