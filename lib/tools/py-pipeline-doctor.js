// The `py-pipeline-doctor` tool: read the workflows a project already has, and
// say what is wrong with them.
//
// This is the half of the plugin that works on projects it did not generate. A
// workflow written three years ago by hand has the same failure modes as one this
// plugin emits, and the rules in `audit.js` are deliberately written against the
// file, not against the IR — so they apply to both.
//
// Two output modes:
//   * the default is a report (`run: false`), which writes nothing;
//   * `run: true` also executes the whitelisted commands the findings implicate,
//     so "YAML is valid but the command is misspelled" is observable rather than
//     inferred.
//
// `apply: true` writes the fixes that are mechanical (adding a missing
// `timeout-minutes`, `permissions:`, `concurrency:`) and leaves a `.bak.<stamp>`
// next to the original. It never rewrites a command or an action ref.

import { readFile, writeFile, copyFile } from 'node:fs/promises'
import path from 'node:path'

import { detect, uvBlockedReason } from '../detect.js'
import { auditRepository, parseWorkflow, RULES } from '../pipeline/audit.js'
import { planCommands, runPlanAsync } from '../pipeline/exec.js'
import { sessionCwdOf } from '../session.js'

/** The commands a whole-pipeline check is worth running, in the order that fails fastest. */
export const PROBE_COMMANDS = [
  ['uv', 'lock', '--check'],
  ['uv', 'sync', '--frozen', '--all-groups'],
  ['uv', 'run', '--locked', 'ruff', 'check', '.'],
  ['uv', 'run', '--locked', 'pytest', '--collect-only', '-q'],
]

/** A timestamp that is safe in a file name on Windows and on Linux. */
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/**
 * The mechanical fixes, as text insertions.
 *
 * Each fix knows which rule it answers and what to add; none of them rewrites an
 * existing line, because a doctor that reformats a working file is a doctor people
 * stop running.
 */
export function plannedFixes(parsed) {
  const fixes = []
  if (!parsed.hasPermissions) {
    fixes.push({
      rule: 'permissions-missing',
      anchor: 'jobs:',
      lines: ['permissions:', '  contents: read', ''],
      note: '插到 `jobs:` 之前：声明最小权限，不让 job 继承仓库默认的写权限。',
    })
  }
  if (!parsed.hasConcurrency) {
    fixes.push({
      rule: 'no-concurrency',
      anchor: 'jobs:',
      lines: ['concurrency:', '  group: ci-${{ github.ref }}', '  cancel-in-progress: true', ''],
      note: '插到 `jobs:` 之前：连推时取消上一轮，省掉并行跑三次全量。',
    })
  }
  for (const job of parsed.jobs) {
    if (job.hasTimeout) continue
    const anchor = '  ' + job.name + ':'
    fixes.push({
      rule: 'job-timeout-missing',
      anchor,
      lines: null,
      // Inserted after `runs-on:` — the one line every job has and whose position
      // is stable across hand-written workflows.
      afterPrefix: '    runs-on:',
      insert: '    timeout-minutes: 20',
      note: 'job `' + job.name + '`：加一行 timeout-minutes，别让挂住的测试烧满 6 小时。',
    })
  }
  return fixes
}

/**
 * Apply the mechanical fixes to one workflow's text.
 *
 * @returns `{ text, applied }` — `applied` lists the rule ids that changed a line.
 */
export function applyFixes(text) {
  const source = typeof text === 'string' ? text : ''
  const lines = source.split(/\r?\n/)
  const applied = []

  // Read the current state with the same parser the audit uses, so "already
  // present" and "missing" cannot disagree between the report and the fix.
  const parsed = parseWorkflow(source)
  const fixes = plannedFixes(parsed)

  for (const fix of fixes.filter((entry) => entry.lines !== null)) {
    const index = lines.findIndex((line) => line.trim() === fix.anchor)
    if (index === -1) continue
    // Already there just above? Then this fix has been applied before.
    const before = lines.slice(Math.max(0, index - 4), index).join('\n')
    if (before.includes(fix.lines[0])) continue
    lines.splice(index, 0, ...fix.lines)
    if (!applied.includes(fix.rule)) applied.push(fix.rule)
  }

  for (const fix of fixes.filter((entry) => entry.lines === null)) {
    let jobIndex = -1
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index] === fix.anchor && /^ {2}\S/.test(lines[index])) {
        jobIndex = index
        break
      }
    }
    if (jobIndex === -1) continue
    let insertAt = -1
    for (let index = jobIndex; index < lines.length; index += 1) {
      if (lines[index].startsWith(fix.afterPrefix)) {
        insertAt = index + 1
        break
      }
      if (index > jobIndex && /^ {2}\S/.test(lines[index]) && lines[index] !== fix.anchor) break
    }
    if (insertAt === -1) continue
    lines.splice(insertAt, 0, fix.insert)
    if (!applied.includes(fix.rule)) applied.push(fix.rule)
  }

  return { text: lines.join('\n'), applied }
}

/** The result text. */
export function formatDoctor(result) {
  if (result.blocked === true) {
    return ['BLOCKED: ' + result.reason, '', 'root: ' + result.root].join('\n')
  }
  const lines = ['Pipeline audit for ' + result.root]
  if (result.files.length === 0) {
    lines.push('')
    lines.push('No workflow files under .github/workflows — nothing to audit.')
  } else {
    lines.push('files: ' + result.files.map((file) => file.file).join(', '))
    lines.push('')
    lines.push(
      'findings: ' + result.counts.error + ' error, ' + result.counts.warn + ' warn, ' +
      result.counts.info + ' info',
    )
    for (const finding of result.findings) {
      lines.push('')
      lines.push('[' + finding.severity + '] ' + finding.id + ' — ' + finding.title)
      lines.push('  ' + finding.message)
    }
  }
  if (result.ran === true) {
    lines.push('')
    lines.push('--- whitelisted probes ---')
    for (const outcome of result.outcomes) {
      const mark = outcome.refused === true ? 'REFUSED' : (outcome.ok === true ? 'PASS' : 'FAIL')
      lines.push('  ' + mark + '  ' + outcome.argv.join(' ') + (outcome.reason ? '  (' + outcome.reason + ')' : ''))
    }
  }
  if (result.applied.length > 0) {
    lines.push('')
    lines.push('--- applied ---')
    for (const entry of result.applied) lines.push('  ' + entry.file + ': ' + entry.rules.join(', '))
    for (const backup of result.backups) lines.push('  backup: ' + backup)
  }
  if (result.warnings.length > 0) {
    lines.push('')
    for (const warning of result.warnings) lines.push('note: ' + warning)
  }
  return lines.join('\n')
}

/** The tool definition. */
export function createPyPipelineDoctorTool({ config }) {
  return {
    name: 'py-pipeline-doctor',
    description:
      'Audit the GitHub Actions workflows a Python project already has, with 13 static rules: ' +
      'mixed pin policy, missing job timeout, no artifact upload, `if: always()` + ' +
      '`if-no-files-found: error`, `uv sync`/`uv run` without --locked, `pip install` inside CI, ' +
      'no concurrency group, no permissions block, no coverage floor, uv version drift, a ' +
      'container file with no container job, and a plaintext secret in a run block. Read-only by ' +
      'default. `run: true` also executes a few whitelisted commands (uv lock --check, uv sync, ' +
      'ruff, pytest --collect-only) so a workflow that parses but is wrong becomes visible. ' +
      '`apply: true` writes only the mechanical fixes (timeout-minutes, permissions, ' +
      'concurrency) and leaves a .bak.<timestamp> next to each file. Returns `{blocked: true}` ' +
      'for Poetry/PDM/Pipenv projects.',
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
            'Also execute the whitelisted probe commands, so a wrong command is observed rather ' +
            'than inferred. Defaults to false.',
        },
        apply: {
          type: 'boolean',
          description:
            'Write the mechanical fixes (timeout-minutes / permissions / concurrency). Defaults ' +
            'to false; a .bak.<timestamp> is written beside every changed file.',
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
          files: { type: 'array', items: { type: 'object', additionalProperties: true } },
          findings: { type: 'array', items: { type: 'object', additionalProperties: true } },
          counts: { type: 'object', additionalProperties: true },
          ran: { type: 'boolean' },
          outcomes: { type: 'array', items: { type: 'object', additionalProperties: true } },
          applied: { type: 'array', items: { type: 'object', additionalProperties: true } },
          backups: { type: 'array', items: { type: 'string' } },
          rules: { type: 'array', items: { type: 'object', additionalProperties: true } },
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
        throw new Error('py-pipeline-doctor: this session has no working directory and no path was given.')
      }
      // `detect` never throws for a missing directory; it answers `ok: false` and
      // leaves the optional fact blocks (`workflows`, `linters`, `markers`) out
      // entirely. Defaulting here keeps every read below safe, so an audit of a
      // path that does not exist is still a report instead of a crash.
      const detection = (await detect(root)) ?? {}
      const blocked = uvBlockedReason(detection)
      if (blocked.blocked === true) {
        const refusal = { blocked: true, reason: blocked.reason, root: detection.root ?? root, summary: '' }
        refusal.summary = formatDoctor(refusal)
        return refusal
      }
      const resolvedRoot = detection.root ?? root
      const warnings = []

      // The doctor reads the workflows itself rather than trusting `detect`'s
      // summary: the summary keeps trigger facts, the audit needs the whole text.
      // `workflows` is one of the optional blocks `detect` omits when the directory
      // does not exist, so it is read as "no workflows" rather than assumed to be
      // a list.
      const workflowFiles = (Array.isArray(detection.workflows) ? detection.workflows : [])
        .filter((workflow) => workflow !== null && typeof workflow === 'object' && typeof workflow.file === 'string')
        .map((workflow) => workflow.file)
      const workflows = []
      for (const file of workflowFiles) {
        try {
          const text = await readFile(path.join(resolvedRoot, ...file.split('/')), 'utf8')
          workflows.push({ file, text })
        } catch (error) {
          warnings.push('Could not read ' + file + ': ' + (error instanceof Error ? error.message : String(error)))
        }
      }

      const pyprojectText = await (async () => {
        try {
          return await readFile(path.join(resolvedRoot, 'pyproject.toml'), 'utf8')
        } catch {
          return null
        }
      })()

      let localUvVersion = null
      try {
        const outcomes = await runPlanAsync(planCommands([['uv', '--version']]), { cwd: resolvedRoot, timeoutSeconds: 20, signal: exec?.signal })
        const text = outcomes[0]?.stdout ?? ''
        const match = /uv\s+(\d+\.\d+\.\d+)/.exec(text)
        localUvVersion = match === null ? null : match[1]
      } catch {
        localUvVersion = null
      }
      if (localUvVersion === null) {
        warnings.push('Could not read the local uv version (the `uv --version` probe is not whitelisted); uv-version-drift reports `info` only.')
      }

      const audit = auditRepository({
        rootDir: resolvedRoot,
        workflows,
        pyprojectText,
        localUvVersion,
      })

      const result = {
        blocked: false,
        root: resolvedRoot,
        files: audit.files,
        findings: audit.findings,
        counts: audit.counts,
        ran: false,
        outcomes: [],
        applied: [],
        backups: [],
        rules: RULES.map((rule) => ({ id: rule.id, severity: rule.severity, title: rule.title })),
        warnings,
      }

      if (args?.run === true) {
        result.ran = true
        result.outcomes = (await runPlanAsync(planCommands(PROBE_COMMANDS), { cwd: resolvedRoot, timeoutSeconds: 300, signal: exec?.signal }))
          .map((outcome) => ({
            argv: outcome.argv,
            refused: outcome.refused === true,
            ok: outcome.ok === true,
            reason: outcome.reason ?? null,
            exitCode: outcome.exitCode ?? null,
            seconds: outcome.seconds ?? 0,
          }))
      }

      if (args?.apply === true) {
        for (const workflow of workflows) {
          const fixed = applyFixes(workflow.text)
          if (fixed.applied.length === 0) continue
          const target = path.join(resolvedRoot, ...workflow.file.split('/'))
          const backup = target + '.bak.' + stamp()
          try {
            // Backup first: a fix that loses the original is worse than no fix.
            await copyFile(target, backup)
            await writeFile(target, fixed.text, 'utf8')
            result.applied.push({ file: workflow.file, rules: fixed.applied })
            result.backups.push(backup)
          } catch (error) {
            warnings.push('Could not write ' + workflow.file + ': ' + (error instanceof Error ? error.message : String(error)))
          }
        }
        if (result.applied.length === 0) {
          warnings.push('Nothing mechanical to fix: the remaining findings need a human decision (a gate to add, a secret to rotate).')
        }
      }

      result.summary = formatDoctor(result)
      return result
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args?.apply === true
        ? 'Audit the pipeline and apply mechanical fixes'
        : 'Audit the existing pipeline',
    }),
  }
}
