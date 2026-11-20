// IR → the ordered local plan, and the `scripts/ci.py` source that runs it.
//
// The point of this module is that CI and the laptop run the *same* argv list.
// A workflow that says `uv run pytest --cov` and a local script that says
// `pytest` are two different gates wearing one name; generating both from the IR
// is what keeps them honest.
//
// Three entry points share one plan (V0.10-PLAN.md §4):
//
//   full    `python scripts/ci.py`                    the gate set a fresh project gets
//   commit  `python scripts/ci.py --profile commit`   the fast subset a git hook runs
//   resume  `python scripts/ci.py --from <stage>`     start again where a gate failed
//
// A profile is a *stage universe*; `--from` trims its front. Both are facts of the
// IR (COMMIT_STAGE_IDS, canonical order), so they are resolved here and baked into
// the generated file instead of being reconstructed by the reader.
//
// Jobs are a CI concept, but a local run must not pretend to be outside them: the
// plan carries each stage's job, the generated script prints `[job container]
// 需要 docker daemon` before entering one, and `--list` groups by job. Execution
// stays single-threaded in canonical order — "annotate the jobs, do not simulate
// them" (§16), because a second job scheduler on the laptop would be a second
// semantics to keep in sync with the workflow.
//
// The generated script is stdlib-only on purpose: no uv, no shell, no Makefile.
// `uv run --locked python scripts/ci.py` works on the developer's Windows box and
// on the ubuntu runner because an interpreter is the only thing that must exist.

import { COMMIT_STAGE_IDS, applyResolved, groupJobs, resolveStages, runOf } from './ir.js'

/** Per-step wall clock, in seconds. Generous: pip-audit is the slow one. */
export const DEFAULT_TIMEOUT_SECONDS = 900

/** The profile a bare `localPlan(ids)` and a bare `python scripts/ci.py` use. */
export const DEFAULT_PROFILE = 'full'

/** Accepted `--profile` values, in help order. */
export const PROFILE_NAMES = Object.freeze(['full', 'commit'])

/**
 * Stage universe of each profile; `null` means "keep the caller's selection".
 *
 * `full` is not "every stage" — it is the stage set the plan was built from
 * (normally DEFAULT_STAGE_IDS). Keeping it relative is what lets one code path
 * serve `--stage` selection, optional stages and generated workflows.
 */
const PROFILE_STAGE_IDS = Object.freeze({
  full: null,
  commit: Object.freeze([...COMMIT_STAGE_IDS]),
})

/** Where the generated script belongs, relative to the project root. */
export const CI_SCRIPT_PATH = 'scripts/ci.py'

/**
 * Why a stage kept in the plan has no local steps.
 *
 * release/deploy are real stages with real CI jobs, but every one of their steps
 * is a GitHub Action, a `local: false` deploy-environment step, or commented out.
 * The plan keeps them so the local view and the workflow agree on the 13-stage
 * matrix; this string is what both `--list` and `--json` show for them.
 */
const CI_ONLY_REASON = '本地无步骤（CI only）'

/**
 * The selection that produced each plan, kept off the plan itself.
 *
 * A plan is a plain array because it is handed to the host as tool output, and
 * the host's lossless-JSON check rejects any array carrying own keys beyond its
 * indices — `Reflect.ownKeys` counts non-enumerable ones too, so hanging
 * `plan.profile` on the array fails the whole tool result with
 * "value is not lossless JSON". A WeakMap keeps the metadata reachable from
 * {@link planSelection} without adding a single key to the array.
 */
const PLAN_SELECTIONS = new WeakMap()

/**
 * The `{profile, from}` selection behind a plan, or the defaults when the plan
 * did not come from {@link localPlan} (a copy, a literal, `undefined`).
 */
export function planSelection(plan) {
  const selection = plan !== null && typeof plan === 'object' ? PLAN_SELECTIONS.get(plan) : undefined
  return selection ?? { profile: DEFAULT_PROFILE, from: '' }
}

function normalizeProfile(profile) {
  const name = typeof profile === 'string' ? profile.trim().toLowerCase() : ''
  return PROFILE_NAMES.includes(name) ? name : DEFAULT_PROFILE
}

function positiveTimeout(value) {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_TIMEOUT_SECONDS
}

function jobNameOf(stage) {
  const name = typeof stage.job === 'string' ? stage.job.trim().toLowerCase() : ''
  return name !== '' ? name : 'quality'
}

/**
 * A step with nothing to spawn: `applyResolved` expresses an absent gate as one
 * echoed message (`runs`) instead of an argv list, so the reason is visible
 * instead of the stage silently vanishing. The local plan keeps such a step and
 * the runner prints its line and moves on — exit 0, because "this project has no
 * sources yet" is not a failure of the code it does have.
 */
function isSkipStep(step) {
  const runs = Array.isArray(step.runs) ? step.runs : []
  const argv = Array.isArray(step.argv) ? step.argv : []
  return runs.length > 0 && argv.length === 0
}

/** Expand `ids` (array or comma list) to a lowercased array, without deduping. */
function idList(ids) {
  const parts = Array.isArray(ids) ? ids : String(ids ?? '').split(',')
  return parts.map((part) => String(part ?? '').trim().toLowerCase()).filter((id) => id !== '')
}

/** Profile stage universe as a Set, or `null` for "whatever the caller asked for". */
function profileUniverse(profile) {
  const ids = PROFILE_STAGE_IDS[normalizeProfile(profile)]
  return ids === null || ids === undefined ? null : new Set(ids)
}

/**
 * What a job needs, derived from its IR steps.
 *
 * This is static analysis, not an execution report: `uses` steps are GitHub
 * Actions only, `local: false` steps only run in a deploy environment, commented
 * steps never run anywhere. It scans the *full* IR rather than the filtered local
 * steps on purpose: a job whose stages are all CI-only (release, deploy) still
 * deserves an honest hint — `[job release] 需要 quality job 的 dist artifact` is
 * why those stages stay in the plan at all. The result is baked into the generated
 * script as the `[job …]` hint, which is what lets `ci.py` stay one stdlib file
 * that knows nothing about the catalog.
 */
function jobRequirement(job) {
  const phrases = []
  const add = (phrase) => {
    if (phrase !== '' && !phrases.includes(phrase)) phrases.push(phrase)
  }
  const tools = new Set()
  const usesRefs = new Set()
  let runnerOnly = false
  let deployOnly = false
  let placeholder = false
  let localSteps = 0
  for (const stage of job.stages ?? []) {
    for (const step of stage.steps ?? []) {
      if (step.commented === true) continue
      const usesRef =
        typeof step.uses === 'string'
          ? step.uses
          : (step.kind === 'uses' ? String(step.run ?? '') : '')
      if (usesRef !== '') {
        usesRefs.add(usesRef)
        runnerOnly = true
        continue
      }
      const argv = Array.isArray(step.argv) ? step.argv : []
      if (argv.length > 0) tools.add(argv[0])
      if (step.verified === false) placeholder = true
      if (step.local === false) {
        deployOnly = true
        continue
      }
      localSteps += 1
      if (argv.includes('pip-audit')) add('需要网络（pip-audit 查 OSV 漏洞库）')
      if (argv.includes('-m') && argv.includes('integration')) add('需要真实数据库/网络的集成环境')
    }
  }
  const downloadsArtifact = [...usesRefs].some((ref) => ref.includes('download-artifact'))
  if (localSteps === 0) add('只在 CI 运行，本地没有等价步骤')
  if (tools.has('docker')) add('需要 docker daemon')
  if (tools.has('gh')) add('需要已认证的 gh CLI（GH_TOKEN）')
  if (tools.has('curl')) add('需要能访问部署目标')
  if (downloadsArtifact) add('需要 quality job 的 dist artifact')
  if (localSteps > 0 && runnerOnly) add('含 GitHub Actions 专用步骤，本地只跑能跑的部分')
  if (localSteps > 0 && deployOnly) add('含只能在部署环境执行的步骤，本地跳过')
  if (placeholder) add('含占位命令，占位符未替换即失败')
  if ((job.needs ?? []).length > 0) add(`CI 里依赖 job ${(job.needs ?? []).join('、')}`)
  if (phrases.length === 0) add('只需要本机工具链（uv 与 Python）')
  return phrases.join('；')
}

/**
 * Local execution plan for `ids`.
 *
 * Steps a laptop cannot run are dropped: commented steps never run, `uses` steps
 * are GitHub Actions, `local: false` steps belong to a deploy environment, and a
 * step without argv has nothing to exec. A stage that loses every step is **kept**
 * with `ciOnly: true` instead of disappearing: release and deploy are real stages
 * with real CI jobs, and omitting them made `ci.py --list` disagree with the
 * workflow's 13-stage matrix (11 vs 13). Both the list and the run loop annotate
 * those stages instead of pretending they were never selected — "not applicable
 * here" must not read as "skipped".
 *
 * @param {string[]|string} ids stage ids, or a comma list
 * @param {{timeoutSeconds?: number, profile?: 'full'|'commit', from?: string,
 *   resolved?: object}} [options]
 *   `resolved` is `resolveProject(...)` output when the caller has it: every
 *   stage is passed through `applyResolved` first, so the plan carries the paths,
 *   checker and build shape of *this* project. Omitted, the catalog argv is used
 *   unchanged (the historical behaviour, byte for byte).
 *   `profile` narrows the selection to that profile's universe ('commit' is
 *   COMMIT_STAGE_IDS); `from` drops every stage before that one and throws when it
 *   is not in the plan, because silently running nothing after a failure is worse
 *   than an error.
 * @returns {Array<{id: string, title: string, why: string, job: string,
 *   needs: string[], ciOnly: boolean, reason?: string, steps: Array<{id: string,
 *   label: string, argv: string[], run: string, timeoutSeconds: number,
 *   always: boolean}>}>} a plain array with no own keys besides its indices; the
 *   selection that produced it is available from {@link planSelection}, so a
 *   caller can print it or feed it back to {@link renderCiScript}.
 */
export function localPlan(ids, options = {}) {
  const timeoutSeconds = positiveTimeout(options.timeoutSeconds)
  const profile = normalizeProfile(options.profile)
  const universe = profileUniverse(profile)
  const requested = idList(ids)
  const selected = universe === null ? requested : requested.filter((id) => universe.has(id))

  const stages = []
  const resolved = options.resolved
  for (const rawStage of resolveStages(selected)) {
    // `resolved` is the whole point of the second renderer path: without it the
    // plan would run the catalog's documented fallback (`mypy src`,
    // `--all-packages`) against a project those commands do not describe. The IR
    // owns the substitution so the workflow and this plan cannot spell the same
    // command two ways.
    const substituted = resolved !== undefined && resolved !== null
      ? applyResolved(rawStage, resolved)
      : rawStage
    // `applyResolved` encodes an absent gate (no type paths / no tests) as one
    // message-only step. The plan keeps the command that CI still documents — the
    // workflow's argv and `scripts/ci.py` are grepped as the same string — and
    // carries `skip` so this runner prints the reason instead of spawning it.
    const absentMessage = substituted.steps.length === 1 && isSkipStep(substituted.steps[0])
      ? (Array.isArray(substituted.steps[0].runs) ? substituted.steps[0].runs[0] : '')
      : null
    const stage = substituted
    const steps = (absentMessage === null ? stage.steps : rawStage.steps)
      .filter((step) => step.commented !== true)
      .filter((step) => step.kind !== 'uses')
      .filter((step) => step.local !== false)
      .filter((step) => Array.isArray(step.argv) && step.argv.length > 0)
      .map((step) => {
        const skip = absentMessage !== null
        const argv = [...step.argv]
        return {
          id: step.id,
          label: step.label,
          argv,
          run: typeof step.run === 'string' ? step.run : runOf(argv),
          timeoutSeconds,
          always: step.always === true,
          // Only present for an absent gate. The argv stays, so the allowlist,
          // `--list` and the generated script keep naming the gate; the runner
          // reads `skip` and never spawns it.
          ...(skip ? { skip: true, skipReason: absentMessage } : {}),
        }
      })
    // The stage entry keeps every field callers already iterate (`py-pipeline-run`
    // reads id/title/steps) and adds the job membership the generator and the
    // generated list need. `ciOnly` is the one field that changes meaning: the
    // stage is in the plan because CI runs it, not because there is nothing to do.
    const entry = {
      id: stage.id,
      title: stage.title,
      why: stage.why,
      job: jobNameOf(stage),
      needs: [...(stage.needs ?? [])],
      ciOnly: steps.length === 0,
      steps,
    }
    if (entry.ciOnly) entry.reason = CI_ONLY_REASON
    stages.push(entry)
  }

  const fromRequested = typeof options.from === 'string' ? options.from.trim().toLowerCase() : ''
  const fromIndex = fromRequested === '' ? 0 : indexOfFrom(stages, fromRequested)
  const plan = stages.slice(fromIndex)
  // Never `plan.profile = ...`: an array with own keys is not lossless JSON, so
  // handing this plan back as tool output fails the whole result. The metadata
  // lives beside the array instead.
  PLAN_SELECTIONS.set(plan, {
    profile,
    from: fromRequested === '' ? '' : stages[fromIndex].id,
  })
  return plan
}

/**
 * Index of the first stage to run when resuming; throws when `from` names a stage
 * this plan never reaches.
 */
function indexOfFrom(stages, from) {
  const index = stages.findIndex((stage) => stage.id === from)
  if (index === -1) {
    const known = stages.map((stage) => stage.id).join(', ')
    throw new Error(`--from ${from}: that stage is not part of this plan; this plan has: ${known || '(nothing)'}`)
  }
  return index
}

/**
 * Human-readable plan, one numbered stage per line.
 *
 * The only place that shows the plan without running it; `py-ci-run` prints this
 * for a dry run, and it doubles as the fallback when `--list` is not available.
 */
export function describePlan(plan, options = {}) {
  const stages = Array.isArray(plan) ? plan : []
  const selection = planSelection(plan)
  const profile = normalizeProfile(options.profile ?? selection.profile)
  const from = selection.from ? `, from=${selection.from}` : ''
  const lines = [`local plan (profile=${profile}${from})`]
  if (stages.length === 0) lines.push('(no stage selected)')
  stages.forEach((stage, index) => {
    const ciOnly = stage.ciOnly === true ? '  [CI only，本地无步骤]' : ''
    lines.push(`${index + 1}. ${stage.title} (${stage.id})${ciOnly}`)
    for (const step of stage.steps) lines.push(`   $ ${step.run}`)
  })
  return lines.join('\n')
}

/** One line per stage, for embedding in summaries and next-step hints. */
export function planLines(plan) {
  const stages = Array.isArray(plan) ? plan : []
  return stages.map((stage) => ({
    id: stage.id,
    title: stage.title,
    // A CI-only stage has no local command; the flag is what lets a caller show
    // "runs in CI only" instead of an empty command list.
    ciOnly: stage.ciOnly === true,
    commands: stage.steps.map((step) => step.run ?? runOf(step.argv ?? [])),
  }))
}

/** What to tell the user once `scripts/ci.py` exists. */
export function ciRunNextSteps({ scriptPath = CI_SCRIPT_PATH } = {}) {
  const run = `uv run --locked python ${scriptPath}`
  return [
    `手动全量:     ${run}`,
    `commit 快子集: ${run} --profile commit`,
    `从失败项重跑:  ${run} --from <stage>`,
    `先看计划:     ${run} --list`,
  ]
}

/**
 * Generate `scripts/ci.py`.
 *
 * The generated file must run without the plugin installed, so everything it
 * needs from the IR — stage order, steps, jobs, needs, profile sets — is resolved
 * here and embedded as one JSON payload. Job hints in particular are computed at
 * generation time in {@link jobRequirement}, not hardcoded in the Python source.
 */
export function renderCiScript(plan, options = {}) {
  const stages = Array.isArray(plan) ? plan : []
  const projectName =
    typeof options.projectName === 'string' && options.projectName.trim() !== ''
      ? options.projectName.trim()
      : 'this project'
  const profile = normalizeProfile(options.profile ?? planSelection(plan).profile)

  const plannedIds = stages.map((stage) => stage.id)
  const commitIds = plannedIds.filter((id) => COMMIT_STAGE_IDS.includes(id))
  const jobs = groupJobs(resolveStages(plannedIds)).map((job) => ({
    name: job.name,
    needs: [...job.needs],
    hint: jobRequirement(job),
    stages: job.stages.map((stage) => stage.id),
  }))
  const jobOf = new Map()
  for (const job of jobs) for (const id of job.stages) jobOf.set(id, job.name)
  // A skip step explains an absent gate; it has a message, not a program. The
  // generated runner has to know that before it tries to spawn an empty argv.
  const hasSkips = stages.some((stage) => stage.steps.some((step) => step.skip === true))
  const skipBranch = hasSkips
    ? '    if step.get("skip"):\n        print("    (skip) " + str(step.get("skipReason") or "无本地步骤"), flush=True)\n        return True, 0.0, 0\n'
    : ''

  const payload = JSON.stringify(
    {
      projectName,
      defaultProfile: profile,
      profiles: { full: plannedIds, commit: commitIds },
      jobs,
      stages: stages.map((stage) => ({
        id: stage.id,
        title: stage.title,
        why: stage.why,
        job: jobOf.get(stage.id) ?? jobNameOf(stage),
        needs: [...(stage.needs ?? [])],
        // Additive on purpose: every field above is what older readers already
        // consume. `ciOnly` marks a stage the local plan cannot run but the matrix
        // still contains (release/deploy); `--list` annotates it and the run loop
        // skips it with one line instead of failing or silently vanishing.
        ciOnly: stage.ciOnly === true,
        reason: stage.ciOnly === true ? (stage.reason ?? CI_ONLY_REASON) : '',
        steps: stage.steps.map((step) => {
          const argv = Array.isArray(step.argv) ? [...step.argv] : []
          return {
            id: step.id,
            label: step.label,
            argv,
            run: typeof step.run === 'string' ? step.run : runOf(argv),
            timeoutSeconds: positiveTimeout(step.timeoutSeconds),
            always: step.always === true,
            ...(step.skip === true ? { skip: true } : {}),
            ...(step.skip === true ? { skipReason: step.skipReason ?? '' } : {}),
          }
        }),
      })),
    },
    null,
    2,
  )

  const command = `uv run --locked python ${CI_SCRIPT_PATH}`
  const helpText = [
    `Run ${projectName}'s gates locally, in the same order and with the same argv`,
    'as the generated GitHub workflow: a green local run and a green CI run then',
    'mean the same thing, and a red one fails at the same step.',
    '',
    'Three canonical commands:',
    `  ${command}                   手动全量：profile=full 的所有阶段，失败即停`,
    `  ${command} --profile commit   commit 快子集：提交前/钩子里跑的那几项`,
    `  ${command} --from <stage>     修好一项后从该阶段续跑（前面的阶段不跑）`,
    '',
    'Inspect before running:',
    `  ${command} --list             计划总览：按 job 分组，并标注每个 job 需要什么`,
    '  标了 (CI only) 的阶段只存在于 CI（本地没有等价步骤）；执行到会打印跳过、不算失败。',
    '',
    `profiles: full = ${plannedIds.join(', ') || '(none)'}`,
    `          commit = ${commitIds.join(', ') || '(none)'}`,
    `jobs: ${jobs.map((job) => job.name).join(', ') || '(none)'}`,
  ].join('\n')

  return `#!/usr/bin/env python3
# ruff: noqa: E501
# Generated by Gatekeeper / py-ci-run — regenerate instead of editing.
#
# Run ${projectName}'s gates locally the way CI runs them.
#
#   手动全量      ${command}
#   commit 快子集 ${command} --profile commit
#   从失败项重跑  ${command} --from <stage>
#   先看计划      ${command} --list
#
# 只依赖标准库（Python 3.9+），Windows / Linux / macOS 都能跑：解释器是唯一的
# 前置条件，uv/gh/docker 只在实际执行到相应 job 时才需要。失败即停；只有标了
# always 的步骤（容器清理）会在失败的 stage 内继续执行。
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time

PAYLOAD = json.loads(r"""${payload}""")

PROJECT_NAME = PAYLOAD["projectName"]
DEFAULT_PROFILE = PAYLOAD["defaultProfile"]
PROFILES = PAYLOAD["profiles"]
JOBS = PAYLOAD["jobs"]
STAGES = PAYLOAD["stages"]
STAGE_BY_ID = {stage["id"]: stage for stage in STAGES}
JOB_BY_NAME = {job["name"]: job for job in JOBS}

HELP_TEXT = ${JSON.stringify(helpText)}

DEFAULT_TIMEOUT = ${DEFAULT_TIMEOUT_SECONDS}


def _utf8_stdio() -> None:
    """Windows consoles default to a legacy code page; child output is UTF-8."""
    os.environ.setdefault("PYTHONUTF8", "1")
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):
            pass


def _die(message: str):
    print(message, file=sys.stderr)
    raise SystemExit(2)


def _profile_stage_ids(name: str) -> list[str]:
    if name not in PROFILES:
        _die(f"unknown profile: {name}\\nknown profiles: {', '.join(PROFILES)}")
    ids = list(PROFILES[name] or [])
    if not ids:
        # An empty commit profile means the script was generated from a stage
        # selection that excluded lock/lint/manifest; running the fast subset as an
        # empty success would lie about having checked anything.
        _die(
            f"profile {name} selects no stage in this script. "
            "Regenerate scripts/ci.py from the full plan, or use --profile full."
        )
    return ids


def _choose_stages(profile: str, stage_arg: str) -> list[dict]:
    universe = _profile_stage_ids(profile)
    picked = []
    for part in str(stage_arg).split(","):
        name = part.strip().lower()
        if name == "":
            continue
        if name == "all":
            picked.extend(universe)
            continue
        if name not in STAGE_BY_ID:
            _die(f"unknown stage: {name}\\nknown stages: {', '.join(STAGE_BY_ID)}")
        picked.append(name)
    if not picked:
        picked = list(universe)
    outside = sorted({name for name in picked if name not in universe})
    if outside:
        _die(
            f"stage(s) {', '.join(outside)} are not part of the {profile} profile\\n"
            f"{profile} profile: {', '.join(universe)}\\n"
            "run --list to see the plan, or drop --profile to select from the full plan"
        )
    chosen = set(picked)
    return [stage for stage in STAGES if stage["id"] in chosen]


def _apply_from(stages: list[dict], from_arg: str) -> list[dict]:
    target = str(from_arg or "").strip().lower()
    if target == "":
        return stages
    if target not in STAGE_BY_ID:
        _die(f"--from {target}: unknown stage\\nknown stages: {', '.join(STAGE_BY_ID)}")
    ids = [stage["id"] for stage in stages]
    if target not in ids:
        _die(
            f"--from {target}: that stage is not part of this selection\\n"
            f"selected: {', '.join(ids) if ids else '(none)'}"
        )
    return stages[ids.index(target):]


def _job_of(stage: dict) -> str:
    job = stage.get("job")
    return str(job) if job else "quality"


def _job_hint(name: str) -> str:
    job = JOB_BY_NAME.get(name)
    if job is None:
        return ""
    return str(job.get("hint") or "")


def _grouped_by_job(stages: list[dict]) -> list[tuple[dict, list[dict]]]:
    # Order follows the workflow's job order, not the plan's, so --list reads the
    # same way as the generated YAML.
    groups = []
    seen = set()
    for job in JOBS:
        members = [stage for stage in stages if _job_of(stage) == job["name"]]
        if not members:
            continue
        groups.append((job, members))
        seen.add(job["name"])
    leftovers = [stage for stage in stages if _job_of(stage) not in seen]
    if leftovers:
        groups.append(({"name": "other", "hint": ""}, leftovers))
    return groups


def _print_plan(stages: list[dict], profile: str, from_stage: str) -> None:
    header = f"plan for {PROJECT_NAME}: profile={profile}"
    if from_stage:
        header += f" from={from_stage}"
    print(header)
    commit_ids = PROFILES.get("commit") or []
    if commit_ids:
        print(f"commit profile: {', '.join(commit_ids)}")
    if not stages:
        print("\\n(no stage selected)")
        return
    print("")
    index = 0
    for job, members in _grouped_by_job(stages):
        hint = str(job.get("hint") or "")
        line = f"[job {job['name']}]"
        if hint:
            line += f" {hint}"
        print(line)
        for stage in members:
            index += 1
            tags = f"  [job {_job_of(stage)}]"
            if stage["id"] in commit_ids:
                tags += "  [commit]"
            if stage.get("ciOnly"):
                tags += "  (CI only)"
            print(f"  {index}. {stage['title']} ({stage['id']}){tags}")
            for step in stage["steps"]:
                print(f"       $ {step['run']}")
        print("")


def _announce_job(name: str, state: dict) -> None:
    if state.get("name") == name:
        return
    state["name"] = name
    hint = _job_hint(name)
    print("")
    print(f"[job {name}]" + (f" {hint}" if hint else ""), flush=True)


def _run_step(step: dict, root: str, timeout: float):
    print(f"\\n==> {step['label']}\\n    $ {step['run']}", flush=True)
${skipBranch}    started = time.monotonic()
    try:
        completed = subprocess.run(
            step["argv"],
            cwd=root,
            timeout=timeout,
            check=False,
            text=True,
            encoding="utf-8",
            errors="replace",
            shell=False,
        )
        code = completed.returncode
    except FileNotFoundError:
        print(f"    command not found: {step['argv'][0]}", file=sys.stderr)
        code = 127
    except subprocess.TimeoutExpired:
        print(f"    timed out after {timeout}s", file=sys.stderr)
        code = 124
    elapsed = time.monotonic() - started
    print(f"    -> exit {code} in {elapsed:.1f}s", flush=True)
    return code == 0, elapsed, code


def main(argv=None) -> int:
    _utf8_stdio()
    parser = argparse.ArgumentParser(
        prog="scripts/ci.py",
        description=HELP_TEXT,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--stage", default="all", help="all, or a comma list such as lock,lint")
    parser.add_argument(
        "--profile",
        default=None,
        help="full (default) or commit (the fast subset a git hook runs)",
    )
    parser.add_argument(
        "--from",
        dest="from_stage",
        default="",
        help="start at this stage; earlier stages are skipped",
    )
    parser.add_argument("--list", action="store_true", help="print the plan, grouped by job, and exit")
    parser.add_argument("--root", default=".", help="project root to run in (default: this directory)")
    parser.add_argument("--timeout", type=float, default=0, help="per-step seconds; 0 keeps each step's own")
    parser.add_argument("--stop-after", default="", help="stop once this stage id has run")
    parser.add_argument("--json", action="store_true", help="machine-readable result on stdout")
    args = parser.parse_args(argv)

    profile = (args.profile or DEFAULT_PROFILE).strip().lower()
    if profile not in PROFILES:
        _die(f"unknown profile: {profile}\\nknown profiles: {', '.join(PROFILES)}")
    from_stage = str(args.from_stage or "").strip().lower()
    stages = _apply_from(_choose_stages(profile, args.stage), from_stage)
    if args.list:
        _print_plan(stages, profile, from_stage)
        return 0
    if not stages:
        print(f"no stage selected for profile {profile}", file=sys.stderr)
        return 0

    stop_after = str(args.stop_after or "").strip().lower()
    if stop_after:
        if stop_after not in STAGE_BY_ID:
            _die(f"--stop-after {stop_after}: unknown stage\\nknown stages: {', '.join(STAGE_BY_ID)}")
        if stop_after not in [stage["id"] for stage in stages]:
            print(
                f"note: --stop-after {stop_after} is not part of this selection; it never triggers",
                file=sys.stderr,
            )

    root = os.path.abspath(args.root)
    results = []
    skipped = []
    total = 0.0
    overall = 0
    failed = False
    failed_stage = ""
    job_state = {}

    for stage in stages:
        # Nothing new starts once a gate fails: fail fast, and a stage that never
        # began is also never torn down.
        if failed:
            break
        _announce_job(_job_of(stage), job_state)
        # A CI-only stage has no local command. Say so once and move on: it is not
        # a failure, and it must not be reported as a pass either.
        if stage.get("ciOnly"):
            print("", flush=True)
            print(f"==> {stage['id']}  CI only，本地跳过", flush=True)
            skipped.append(stage["id"])
            if stop_after and stage["id"] == stop_after:
                break
            continue
        stage_ok = True
        for step in stage["steps"]:
            if not stage_ok and not step.get("always"):
                continue
            timeout = args.timeout if args.timeout > 0 else float(step.get("timeoutSeconds", DEFAULT_TIMEOUT))
            ok, elapsed, code = _run_step(step, root, timeout)
            total += elapsed
            results.append(
                {
                    "stage": stage["id"],
                    "job": _job_of(stage),
                    "step": step["id"],
                    "ok": ok,
                    "code": code,
                    "seconds": round(elapsed, 1),
                }
            )
            if not ok:
                stage_ok = False
                failed = True
                failed_stage = stage["id"]
                overall = overall or (code or 1)
        if stop_after and stage["id"] == stop_after:
            break

    print("\\n--- summary ---")
    for item in results:
        mark = "PASS" if item["ok"] else "FAIL"
        print(f"{mark}  {item['stage']}/{item['step']}  {item['seconds']}s")
    if not results:
        print("(nothing ran)")
    if skipped:
        print(f"CI-only skipped: {', '.join(skipped)}")
    print(f"total {total:.1f}s")
    if failed and failed_stage:
        resume = "uv run --locked python ${CI_SCRIPT_PATH} --from " + failed_stage
        if profile != DEFAULT_PROFILE:
            resume += f" --profile {profile}"
        print(f"\\nresume after fixing: {resume}")
    if args.json:
        print(
            json.dumps(
                {
                    "ok": overall == 0,
                    "profile": profile,
                    "from": from_stage,
                    "failedStage": failed_stage,
                    "ciOnlySkipped": skipped,
                    "results": results,
                    "seconds": round(total, 1),
                }
            )
        )
    return overall


if __name__ == "__main__":
    raise SystemExit(main())
`
}
