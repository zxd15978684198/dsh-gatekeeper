// IR → GitHub Actions workflow. The only renderer in this version.
//
// Written as explicit lines rather than a template literal because the YAML is
// full of `${{ ... }}`, and `${` inside a JavaScript template literal is an
// interpolation, not text. That is also why the indentation lives in the string
// literals here and not in a helper: an off-by-one indent is invisible until
// GitHub rejects the file.
//
// Adding GitLab later means a second `renderWorkflow` over the same IR objects,
// not a second catalog.
//
// The renderer owns no ordering and no commands of its own. It walks the stages the
// IR hands it, so the lock check lands before the install step and the install step
// *is* the `sync` stage's command. That is the whole claim of this file: a workflow
// generated here cannot drift from what the local runner would do, because both
// read the same objects. An install line emitted by the renderer, after the stage
// list, is exactly how the two orders used to disagree.
//
// Four step-level facts are read off the objects instead of being re-derived:
//
//   step.always    → `if: always()`; the container teardown must run after a
//                    failed gate or the next run starts on a dirty daemon.
//   step.if        → `if:`, verbatim; the deploy probe's `vars.X != ''` is a
//                    condition only the caller knows, and `release-gh` stays
//                    tag-only even though its job also runs on a dispatch.
//   step.runs      → a `|` block; a multi-line shell block is not an argv list.
//   step.commented → YAML comments, emitted where the step was declared.
//
// The `quality` job still uploads `dist/` when the build stage is selected, and the
// release job downloads that same artifact instead of building a second time.

import {
  DEFAULT_STAGE_IDS,
  applyResolved,
  STAGE_CATALOG,
  groupJobs,
  legacyStageIds,
  parseStageList,
  resolveStages,
} from './ir.js'

/** The `uv sync` flag: `--frozen` (default, historical) or `--locked` (asserts the lock). */
export function syncFlag(lockMode) {
  return lockMode === 'locked' ? '--locked' : '--frozen'
}

/**
 * Split `3.11,3.12` into clean, unique version strings.
 *
 * @param value - a comma string (or array, joined by the caller).
 * @param fallback - used when nothing survives validation.
 */
export function parseVersions(value, fallback = '3.13') {
  const source = typeof value === 'string' && value.trim() !== '' ? value : fallback
  const seen = new Set()
  const versions = []
  for (const part of source.split(',')) {
    const version = part.trim()
    // A Python version is `3.13`, `3.13.1`, or `pypy3.10`; anything else is a
    // typo that would become an unresolvable matrix entry.
    if (!/^(pypy)?\d+\.\d+(\.\d+)?$/.test(version)) continue
    if (seen.has(version)) continue
    seen.add(version)
    versions.push(version)
  }
  return versions.length > 0 ? versions : [fallback]
}

/**
 * Which stages a call selects.
 *
 * `stages` is the v0.6 door: an explicit list (or `all`) wins. Without it the
 * pre-0.6 options decide, so existing callers see exactly what they saw before.
 *
 * @returns `{ ids, rejected, source }`.
 */
export function selectStages(options = {}) {
  const parsed = parseStageList(options.stages)
  if (parsed.ids.length > 0 || parsed.rejected.length > 0) {
    return { ids: parsed.ids, rejected: parsed.rejected, source: 'explicit' }
  }
  return {
    ids: legacyStageIds(options.includeSecurity !== false, options.includeIntegration === true),
    rejected: [],
    source: 'legacy',
  }
}

/**
 * The install command, taken from the `sync` stage and re-flagged for this run.
 *
 * The IR carries the canonical form (`uv sync --locked --all-groups`) because that
 * is the command the runner and the docs agree on; `lockMode` is a decision the
 * *caller* makes, and a renderer that ignored it would ship `--locked` to a caller
 * who asked for the historical `--frozen`. Only that one token is replaced:
 * `--all-groups` is the part that makes the later `uv run` steps find ruff, mypy and
 * pytest, and dropping it turns every gate after this one into "command not found".
 *
 * The step keeps its own label — the command — so the workflow shows the line that
 * will run instead of a second-hand description of it.
 */
function syncStep(step, flag) {
  if (step.id !== 'uv-sync') return step
  const argv = (step.argv ?? []).map((token) =>
    token === '--locked' || token === '--frozen' ? flag : token)
  const run = argv.length > 0 ? argv.join(' ') : step.run
  return { ...step, argv, run, label: run }
}

/**
 * The `if:` a step needs, composed from the two facts the IR states separately.
 *
 * `always: true` is the teardown rule and `if:` is the caller's own condition; a
 * step that carried both would otherwise silently lose one. `always()` comes first
 * so the two conditions stay readable, the way a person would write them.
 *
 * @returns the expression, or `null` when the step runs unconditionally.
 */
function stepCondition(step) {
  const parts = []
  if (step.always === true) parts.push('always()')
  if (typeof step.if === 'string' && step.if !== '') parts.push(step.if)
  return parts.length === 0 ? null : parts.join(' && ')
}

/**
 * The single line a step runs.
 *
 * Almost every step carries `run` directly. The exception is a skip step: the IR
 * gives it `runs` holding the sentence it echoes, because there is no program to
 * spawn — a skip with an empty `argv` and a silent exit 0 is the one outcome this
 * plugin exists to prevent, so the reason must be visible in the log.
 */
function commandOf(step) {
  if (typeof step.run === 'string') return step.run
  if (Array.isArray(step.runs) && step.runs.length > 0) return step.runs[0]
  return step.uses
}

/** One `- name:` step block. Returns the lines, unpadded. */
function stepLines(step, indent) {
  const pad = ' '.repeat(indent)
  const lines = [pad + '- name: ' + step.label]

  if (step.kind === 'uses') {
    lines.push(pad + '  uses: ' + step.uses)
    if (step.with !== null && step.with !== undefined) {
      const entries = Object.entries(step.with)
      if (entries.length > 0) {
        lines.push(pad + '  with:')
        for (const [key, value] of entries) lines.push(pad + '    ' + key + ': ' + value)
      }
    }
  } else if (Array.isArray(step.runs) && step.runs.length > 1) {
    // A shell block is one step with several lines: separate steps would report as
    // several failures for one cause, and GitHub renders a `|` block identically.
    lines.push(pad + '  run: |')
    for (const command of step.runs) lines.push(pad + '    ' + command)
  } else {
    lines.push(pad + '  run: ' + commandOf(step))
  }

  // `env:` on a step is per-step by design: a token that only the publish step
  // needs must not be exported into the lint step's environment.
  const env = step.env ?? null
  if (env !== null && Object.keys(env).length > 0) {
    lines.push(pad + '  env:')
    for (const [key, value] of Object.entries(env)) lines.push(pad + '    ' + key + ': ' + value)
  }
  const condition = stepCondition(step)
  if (condition !== null) lines.push(pad + '  if: ' + condition)
  return lines
}

/**
 * A step that is generated but inert.
 *
 * Two kinds land here: the step the plugin declines to run (the clean-slate
 * `docker compose down -v` that would destroy a developer's seeded volume) and,
 * historically, the deploy command — which is now a real failing step instead, so a
 * deploy job cannot be all green while nothing was deployed.
 */
function commentedStepLines(step, indent) {
  const pad = ' '.repeat(indent)
  const lines = [
    pad + '# 未在本地验证：取消注释前请自备 registry / 凭据 / 部署命令。',
    pad + '# - name: ' + step.label,
  ]
  const commands = Array.isArray(step.runs) ? step.runs : [step.run ?? step.uses]
  for (const command of commands) lines.push(pad + '#   run: ' + command)
  if (step.note !== undefined) lines.push(pad + '#   # ' + step.note)
  return lines
}

/**
 * The name of a standalone step: the stage title in front, unless the step's own
 * label already carries it.
 *
 * The deploy command is labelled `Deploy (your command)`; prefixing it again would
 * render `Deploy (Deploy (your command))`, which reads like a bug in the generator.
 */
function stepName(stage, step) {
  // A skip step has no argv, only the sentence it echoes. Naming it after that
  // sentence would repeat the stage title (`Type check (type check (no sources))`)
  // and the reason is already the run line; `(skipped)` is the whole story.
  if (typeof step.run !== 'string' && Array.isArray(step.runs) && step.runs.length === 1) {
    return stage.title + ' (skipped)'
  }
  const label = typeof step.label === 'string' && step.label !== '' ? step.label : step.id
  // `type check` against the stage title `Type check`: the title alone is the whole
  // story, and the lower-case label differs only in case.
  if (label.toLowerCase() === stage.title.toLowerCase()) return stage.title
  return label.startsWith(stage.title) ? label : stage.title + ' (' + label + ')'
}

/**
 * The step lines for one job, one step per stage.
 *
 * A stage is one unit of failure, so its plain commands share one `run:` block.
 * Declared order is preserved: a command that carries its own `if:`, `env:`,
 * `always:`, a shell block or an action reference breaks the block and becomes its
 * own step, and a commented step stays where it was declared instead of drifting to
 * the end — the container teardown must still sit after the gate it tears down.
 */
function jobStepLines(stages, indent, jobIf) {
  const lines = []
  for (const stage of stages) {
    // The buffer holds the commands that can share one `run:` block.
    let buffer = []
    const flush = () => {
      if (buffer.length === 0) return
      if (lines.length > 0) lines.push('')
      const labels = buffer.map((step) => step.label).join(' + ')
      // A one-step stage whose label repeats its title would read `Type check (type
      // check)`; the title alone is the whole story there. A skip step is also a
      // one-step stage, and `stepName` is what knows how to name it.
      const label = buffer.length === 1
        ? stepName(stage, buffer[0])
        : stage.title + ' (' + labels + ')'
      for (const line of stepLines({
        label,
        runs: buffer.map((step) => commandOf(step)),
      }, indent)) lines.push(line)
      buffer = []
    }
    for (const step of stage.steps) {
      const commented = step.commented === true
      // `runs` and `always` are per-step YAML, so such a step cannot share the
      // stage's `run:` line — the teardown would lose its `if: always()` and the
      // deploy command would lose its second line.
      const standalone = commented
        || step.kind === 'uses'
        || step.if !== undefined
        || step.env !== undefined
        || step.always === true
        || (Array.isArray(step.runs) && step.runs.length > 1)
      if (!standalone) {
        buffer.push(step)
        continue
      }
      flush()
      if (lines.length > 0) lines.push('')
      if (commented) {
        for (const line of commentedStepLines({
          label: stage.title + ' (' + step.label + ')',
          runs: [step.run ?? step.uses],
          note: step.note,
        }, indent)) lines.push(line)
        continue
      }
      // A step condition identical to the job's would only restate the job gate, so
      // it is dropped there: two places holding the same rule drift apart later.
      // `always()` is never dropped — the job gate cannot express "run even if the
      // job failed".
      const stepIf = step.if === jobIf ? undefined : step.if
      for (const line of stepLines(
        { ...step, if: stepIf, label: stepName(stage, step) },
        indent,
      )) lines.push(line)
    }
    flush()
  }
  return lines
}

/**
 * Render a Python/uv GitHub Actions workflow.
 *
 * @param options - `{ pythonVersions, projectName, stages, lockMode, optIn,
 *   includeSecurity, includeIntegration, resolved }`. `optIn` names the optional
 *   steps the caller has agreed to (`publish`, `image`); anything else stays out.
 *   `resolved` is `resolveProject` output: when given, each selected stage is
 *   passed through the IR's `applyResolved` first, so an empty project emits the
 *   IR's skip sentences and a workspace builds with `--all-packages`.
 * @returns the workflow as YAML text.
 */
export function renderWorkflow(options = {}) {
  const pythonVersions = parseVersions(
    Array.isArray(options.pythonVersions)
      ? options.pythonVersions.join(',')
      : options.pythonVersions,
    '3.13',
  )
  const selection = selectStages(options)
  const optIn = Array.isArray(options.optIn) ? options.optIn : []
  const flag = syncFlag(options.lockMode)
  // `lockMode` is a rendering decision, applied once here so every stage object
  // below already carries the command that will actually run. A caller that then
  // asks the IR for the command sees the same string the YAML does.
  const stages = resolveStages(
    selection.ids.length > 0 ? selection.ids : DEFAULT_STAGE_IDS,
    optIn,
  ).map((stage) => {
    const withFlag = { ...stage, steps: stage.steps.map((step) => syncStep(step, flag)) }
    // The empty-project skips and the `buildMode`-dependent build argv are IR
    // decisions, not rendering ones: `applyResolved` is the single place that makes
    // them, so the workflow and the local plan skip and build for the same resolved
    // values instead of this renderer re-deriving them and drifting.
    return options.resolved ? applyResolved(withFlag, options.resolved) : withFlag
  })
  const matrix = pythonVersions.length > 1
  const jobs = groupJobs(stages)
  const hasBuild = stages.some((stage) => stage.id === 'build')

  const lines = []
  lines.push('# Generated by gatekeeper / py-ci-render.')
  // The install command is not quoted here: it is rendered once, by the `sync`
  // stage below. A comment restating it used to be how the two drifted apart.
  lines.push('# Python + uv, not the Node-era template: the sync step installs exactly what')
  lines.push('# uv.lock pins, so CI and local runs resolve the same versions.')
  lines.push('name: CI')
  lines.push('')
  lines.push('on:')
  lines.push('  push:')
  lines.push('    branches: [main]')
  // A tag trigger is only worth declaring when something reacts to it. Without the
  // release or deploy job this line would advertise a trigger that does nothing.
  const tagged = stages.some((stage) => stage.id === 'release' || stage.id === 'deploy')
  if (tagged) lines.push('    tags: [\'v*\']')
  lines.push('  pull_request:')
  lines.push('  workflow_dispatch:')
  // The manual input exists for one reason: an urgent patch must be deployable
  // without minting a tag. Emitting it when nothing reads it is noise.
  const deploys = stages.some((stage) => stage.id === 'deploy')
  if (deploys) {
    lines.push('    inputs:')
    lines.push('      environment:')
    lines.push('        description: Deploy target; only used by the deploy job.')
    lines.push('        required: false')
    // `type` is not optional to GitHub: a `workflow_dispatch` input without one is
    // rejected at workflow-parse time, so the whole file fails to load and every job
    // in it disappears. `choice` would need an `options` list we cannot know, so this
    // is a plain string the deploy job reads with `inputs.environment`.
    lines.push('        type: string')
    lines.push('        default: production')
  }
  // The workflow-level permission is the floor. A job that needs to write (release,
  // deploy) raises it for that job only: a token that can write releases must not
  // be handed to the lint job.
  lines.push('')
  lines.push('permissions:')
  lines.push('  contents: read')
  lines.push('')
  lines.push('concurrency:')
  lines.push('  group: ci-${{ github.ref }}')
  lines.push('  cancel-in-progress: true')
  lines.push('')
  lines.push('jobs:')

  const present = new Set(jobs.map((entry) => entry.name))
  // Whether `workflow_dispatch.inputs.environment` exists, decided once above and read
  // again below so the deploy job's `environment.name` can use it.
  const deployInput = deploys

  for (const job of jobs) {
    lines.push('  ' + job.name + ':')
    if (job.name === 'quality') {
      lines.push('    name: ' + (matrix ? 'Quality gates (Python ${{ matrix.python-version }})' : 'Quality gates'))
    } else {
      const title = job.stages.map((stage) => stage.title).join(' + ')
      lines.push('    name: ' + title)
    }
    lines.push('    runs-on: ubuntu-latest')
    // A job with no deadline inherits GitHub's six-hour default, and a hung test
    // run then burns the whole window. The audit rule flags this in other people's
    // workflows, so this plugin's own output must not trip it.
    lines.push('    timeout-minutes: 20')
    // `needs:` may only name a job that exists in this file — GitHub rejects the
    // workflow otherwise. Rendering `stages: 'container'` alone would produce
    // exactly that, so a dependency outside the selection becomes a comment: the
    // output stays valid, and the reader still learns the job is meant to sit
    // behind quality once merged into a full workflow.
    const missing = job.needs.filter((name) => !present.has(name))
    const kept = job.needs.filter((name) => present.has(name))
    if (kept.length > 0) lines.push('    needs: [' + kept.join(', ') + ']')
    if (missing.length > 0) {
      lines.push('    # needs: [' + missing.join(', ') + '] — 那个 job 不在本文件里；')
      lines.push('    # 合并进完整 workflow 时再取消注释，否则 GitHub 会因为找不到依赖而拒绝整份文件。')
    }
    // A job-wide `if:` is what keeps a release off every push to main. It is a
    // property of the stage (its trigger), not of the renderer. The `|| dispatch`
    // half is there because `deploy` needs `release`: a skipped dependency skips its
    // dependant, so without it an urgent dispatch would never deploy.
    const jobIf = job.stages.map((stage) => stage.if).find((value) => typeof value === 'string' && value !== '')
    if (jobIf !== undefined) lines.push('    if: ' + jobIf)
    // `environment:` is the only way to get approvals, deployment history and a URL
    // on a deploy; it is declared on the job, so it is rendered here rather than on
    // a step.
    const environment = job.stages.map((stage) => stage.environment).find((value) => typeof value === 'string' && value !== '')
    if (environment !== undefined) {
      lines.push('    environment:')
      // A dispatch input nobody reads is a knob that does nothing. When the workflow
      // also declares `workflow_dispatch.inputs.environment`, the job name is that
      // input with the generated default as the fallback, so an urgent patch can pick
      // the target without editing the file. `inputs.*` is empty on tag pushes, and an
      // empty string is falsy in a GitHub expression, so `||` lands on the default.
      const name = deployInput
        ? "${{ inputs.environment || '" + environment + "' }}"
        : environment
      lines.push('      name: ' + name)
      lines.push('      url: ${{ vars.DEPLOY_URL }}')
    }
    // Job-level permissions merge over the workflow floor.
    const permissions = {}
    for (const stage of job.stages) Object.assign(permissions, stage.permissions ?? {})
    if (Object.keys(permissions).length > 0) {
      lines.push('    permissions:')
      for (const [key, value] of Object.entries(permissions)) lines.push('      ' + key + ': ' + value)
    }
    if (job.name === 'quality' && matrix) {
      lines.push('    strategy:')
      lines.push('      fail-fast: false')
      lines.push('      matrix:')
      lines.push('        python-version: [' + pythonVersions.map((version) => '"' + version + '"').join(', ') + ']')
    }
    lines.push('    steps:')

    // Every job checks out once, here. A stage that wants a *specific* rev (the
    // deploy job pins the released tag) declares it as its own `actions/checkout`
    // step, and that step is dropped below so the job never checks out twice.
    const allSteps = job.stages.flatMap((stage) => stage.steps)
    const checkout = allSteps.find((step) => step.uses === 'actions/checkout@v4')
    if (checkout !== undefined && checkout.with !== null && checkout.with !== undefined) {
      lines.push('      - uses: actions/checkout@v4')
      lines.push('        with:')
      for (const [key, value] of Object.entries(checkout.with)) lines.push('          ' + key + ': ' + value)
    } else {
      lines.push('      - uses: actions/checkout@v4')
    }
    lines.push('')

    const stepStages = job.stages.map((stage) => ({
      ...stage,
      steps: stage.steps.filter((step) => step.uses !== 'actions/checkout@v4'),
    }))
    // Only a job that actually calls `uv` installs it, and the decision is read off
    // the steps that will be rendered rather than off the job's name. The release job
    // is the case this exists for: it downloads the `dist` the gates already built
    // and hands it to official actions, so installing the toolchain there was minutes
    // spent on `download-artifact`. A commented step never runs and does not count.
    const commands = stepStages
      .flatMap((stage) => stage.steps)
      .filter((step) => step.commented !== true)
    const needsUv = commands.some((step) => /\buv\s/.test(step.run ?? step.uses ?? ''))
    if (needsUv) {
      lines.push('      - name: Install uv')
      lines.push('        uses: astral-sh/setup-uv@v5')
      lines.push('        with:')
      lines.push('          enable-cache: true')
      // A matrix expression outside a matrix job is an undefined variable; the
      // single-version case pins the version literally instead.
      if (matrix && job.name === 'quality') {
        lines.push('          python-version: ${{ matrix.python-version }}')
      } else {
        lines.push('          python-version: "' + pythonVersions[0] + '"')
      }
      lines.push('')
    }

    // The install step is not emitted here: it is the `sync` stage, rendered by the
    // loop below in IR order. Emitting it from the renderer is what made CI run
    // `lock → install` and the local runner run `install → lock` while both claimed
    // to execute the same plan.
    for (const line of jobStepLines(stepStages, 6, jobIf)) lines.push(line)

    // A gate that produces nothing leaves a failing run with no evidence to
    // inspect. The build stage is the one that produces files, so it is the one
    // that ships them. The name and path are the contract with the release job's
    // `download-artifact`: `dist` / `dist/`.
    if (job.name === 'quality' && hasBuild) {
      lines.push('')
      lines.push('      - name: Upload distributions')
      lines.push('        uses: actions/upload-artifact@v4')
      lines.push('        with:')
      lines.push('          name: dist')
      lines.push('          path: dist/')
      lines.push('          if-no-files-found: error')
    }
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * The file name a repository would give this workflow, used in the panel summary.
 *
 * @param projectName - a directory or package name.
 */
export function workflowFileName(projectName) {
  const clean = String(projectName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    // A leading dot makes the file hidden, and GitHub ignores hidden files in
    // `.github/workflows/` entirely — the workflow simply never runs. A directory
    // like `.e2e-live` would otherwise produce `.e2e-live.yml` and a pipeline that
    // exists but is never scheduled.
    .replace(/^[.\-_]+/, '')
    .replace(/^-+|-+$/g, '')
  return (clean === '' ? 'ci' : clean) + '.yml'
}

/** Stage ids the renderer knows, for tool schemas and error messages. */
export function knownStages() {
  return Object.keys(STAGE_CATALOG)
}
