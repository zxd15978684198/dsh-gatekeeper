// The `py-scaffold` tool: one entry point for "give this project its CI/CD files".
//
// It used to be a thin preview over five sibling tools (`py-bootstrap`, `py-prek`,
// `py-dependabot`, `py-ci-render`, `py-ci-run`) and duplicated their formatting.
// Now every target is produced by the same `py-apply` plan, in preview or in write
// mode, so this module cannot disagree with the tool that actually writes: the
// preview is literally the plan `py-apply` would execute, with the write flag
// flipped. One target list, one preview, one writer.
//
// `release/agent_versions.json` is part of that list, but it is the exception a
// caller has to know about: a first run creates it, every later run reports the
// diff against the probe and writes nothing. A manifest is evidence, not config.

import { APPLY_TARGETS } from '../apply.js'
import { createPyApplyTool } from './py-apply.js'

/** The artefacts this tool can produce, in the order they should be read. */
export const SCAFFOLD_TARGETS = [...APPLY_TARGETS]

/** Read a comma-separated string or an array as a clean list of target ids. */
function normalizeTargets(value) {
  // "Not asked for" and "asked for nothing" are different requests. The first means
  // every artefact; the second means none of them. Upgrading the second to all nine
  // would write files the caller explicitly excluded — `py-apply` already honours
  // an empty list that way, and a consolidated entry point must never be laxer than
  // the tool it delegates to.
  if (value === undefined || value === null) {
    return { targets: [...SCAFFOLD_TARGETS], unknown: [], explicit: false }
  }
  const raw = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(',') : [])
  const wanted = raw
    .map((entry) => String(entry).trim().toLowerCase())
    .filter((entry) => entry !== '')
  const known = SCAFFOLD_TARGETS.filter((entry) => wanted.includes(entry))
  const unknown = wanted.filter((entry) => !SCAFFOLD_TARGETS.includes(entry))
  return { targets: known, unknown, explicit: true }
}

/** Map a planner status onto the action word a caller reasons about. */
function actionOf(status) {
  if (status === 'unchanged') return 'skip'
  if (status === 'refused') return 'skip'
  return String(status ?? 'skip')
}

/** Pad a value to a fixed width for the action table. */
function pad(value, width) {
  const text = String(value ?? '')
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

/**
 * The dry-run preview: an action per target, the exact path, and the diffs.
 *
 * Built from the plan `py-apply` already produced rather than from a second round
 * of renderer calls, which is what keeps "the preview matched what got written"
 * true by construction.
 */
function formatPreview(applied, { targets, unknown }) {
  const lines = [
    '# py-scaffold — DRY RUN, nothing was written (' + String(applied?.root ?? '') + ')',
    'targets: ' + (targets.length > 0 ? targets.join(', ') : '(none)'),
  ]
  if (unknown.length > 0) lines.push('ignored unknown target(s): ' + unknown.join(', '))
  if (applied?.blocked === true) {
    lines.push('')
    lines.push('BLOCKED: ' + String(applied.reason ?? 'this project cannot be scaffolded'))
    return lines.join('\n')
  }
  const files = Array.isArray(applied?.files) ? applied.files : []
  if (files.length > 0) {
    lines.push('')
    lines.push('  ' + pad('target', 17) + pad('action', 10) + 'file')
    for (const file of files) {
      lines.push('  ' + pad(file.target, 17) + pad(actionOf(file.status), 10) + String(file.file ?? ''))
    }
  }
  const withNotes = files.filter((file) => Array.isArray(file.notes) && file.notes.length > 0)
  if (withNotes.length > 0) {
    lines.push('')
    for (const file of withNotes) {
      for (const note of file.notes) lines.push('- ' + file.target + ': ' + note)
    }
  }
  const withDiff = files.filter((file) => file.diff !== undefined && file.diff !== null)
  for (const file of withDiff) {
    lines.push('')
    lines.push(file.target + ' diff (+' + file.diff.addedLines + ' / -' + file.diff.removedLines + '):')
    for (const line of file.diff.sample) lines.push('  ' + line)
    if (file.diff.changedPointers !== undefined && file.diff.changedPointers > file.diff.sample.length) {
      lines.push('  … ' + (file.diff.changedPointers - file.diff.sample.length) + ' more changed pointer(s)')
    }
  }
  if (applied?.conflicts > 0) {
    lines.push('')
    lines.push(
      String(applied.conflicts) + ' file(s) already exist with different content; they are reported '
      + 'above and will NOT be written unless you pass overwrite: true.',
    )
  }
  if (Array.isArray(applied?.nextSteps) && applied.nextSteps.length > 0 && files.length > 0) {
    lines.push('')
    lines.push('Next:')
    for (const step of applied.nextSteps) lines.push('  ' + step)
  }
  lines.push('')
  lines.push(
    'Nothing was written. Call py-scaffold again with dryRun: false to apply exactly this plan; '
    + 'any file that already exists with different content comes back as a conflict unless '
    + 'overwrite: true (the manifest is only ever diffed, never overwritten).',
  )
  return lines.join('\n')
}

/** The tool definition. Built per registration, never shared across mounts. */
export function createPyScaffoldTool({ config }) {
  const applyTool = createPyApplyTool({ config })

  return {
    name: 'py-scaffold',
    description:
      'Generate the CI/CD configuration a Python + uv project needs, as a dry-run preview by ' +
      'default: pyproject.toml (ruff with its per-file ignores, pytest with a coverage floor, ' +
      'ty), .pre-commit-config.yaml for prek, .github/dependabot.yml, the GitHub Actions ' +
      'workflow, scripts/ci.py (the local runner that executes the same gate order), ' +
      'scripts/validate_version_manifest.py, scripts/secret_scan.py, scripts/container_report.py, ' +
      'and release/agent_versions.json. Each target comes back with its action — create, append, ' +
      'update, skip, conflict or diff — and the exact path. The manifest is the exception: an ' +
      'existing one is only diffed, never overwritten. Nothing is written unless you pass ' +
      '`dryRun: false`, and then only those nine fixed paths are touched — never your source ' +
      'files. Preview first, show the user, then write.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Project directory. Defaults to the calling session\'s working directory.',
        },
        targets: {
          type: 'array',
          items: { type: 'string', enum: SCAFFOLD_TARGETS },
          description:
            'Which artefacts to produce. Known: ' + SCAFFOLD_TARGETS.join(', ') + '. Defaults to ' +
            'all nine. Pass a subset to preview one piece without regenerating the rest.',
        },
        dryRun: {
          type: 'boolean',
          description:
            'Default true: return the plan without touching the disk. Pass false to write. ' +
            'Writing is the only side effect this tool has, and it is opt-in on purpose.',
        },
        overwrite: {
          type: 'boolean',
          description:
            'Only meaningful with `dryRun: false`. Replace files that already exist with ' +
            'different content. Off by default: an existing file comes back as a conflict and ' +
            'is left alone, and every write is preceded by a .bak.<timestamp> backup. The ' +
            'manifest is never overwritten.',
        },
        pythonVersion: {
          type: 'string',
          description:
            'Python version to target (e.g. "3.12"). Defaults to the version the project ' +
            'declares, then to the plugin default; ruff\'s target-version follows it.',
        },
        testPaths: {
          type: 'string',
          description:
            'Comma-separated pytest testpaths. Defaults to the directories detected in the ' +
            'project, so a src/<pkg>/tests layout is not mistaken for a missing test suite.',
        },
        pythonVersions: {
          type: 'string',
          description:
            'Comma-separated versions for the workflow\'s test matrix. Defaults to the ' +
            'project\'s own Python version.',
        },
        stages: {
          type: 'string',
          description:
            'Comma-separated gate ids for the workflow and the runner, or "all". Known: lock, ' +
            'sync, lint, type, manifest, test, security, build, integration, audit, container, ' +
            'release, deploy. Defaults to this plugin\'s default gate order.',
        },
        fileName: {
          type: 'string',
          description: 'Workflow file name, e.g. "ci.yml". Defaults to the project name.',
        },
        lockMode: {
          type: 'string',
          enum: ['frozen', 'locked'],
          description:
            '"frozen" (default) installs exactly what uv.lock pins; "locked" also fails when ' +
            'the lockfile is stale. Use "locked" when the repository already relies on it.',
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
          root: { type: 'string' },
          targets: { type: 'array', items: { type: 'string' } },
          blocked: { type: 'boolean' },
          wrote: { type: 'boolean' },
          files: { type: 'array', items: { type: 'object', additionalProperties: true } },
          nextSteps: { type: 'array', items: { type: 'string' } },
        },
        required: ['mode', 'summary'],
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const path = typeof args?.path === 'string' ? args.path : undefined
      const dryRun = args?.dryRun !== false
      const { targets, unknown, explicit } = normalizeTargets(args?.targets)

      // Explicitly asking for no artefact is a refusal, not a silent request for all
      // nine. Writing files the caller excluded is worse than writing none.
      if (explicit && targets.length === 0) {
        return {
          mode: 'preview',
          summary: [
            'py-scaffold: nothing to do',
            'targets: ' + (unknown.length > 0 ? unknown.join(', ') : '(empty)') +
              ' — none of these is an artefact this tool produces.',
            'known targets: ' + SCAFFOLD_TARGETS.join(', '),
            'Nothing was written.',
          ].join('\n'),
          root: '',
          targets: [],
          blocked: false,
          wrote: false,
          files: [],
          nextSteps: [],
        }
      }

      // Both modes go through `py-apply`: the preview is the plan it would execute,
      // the write is that plan executed. Re-implementing either here would be a
      // second implementation to keep in step — exactly what consolidating is for.
      const applied = await applyTool.execute(
        {
          path,
          targets,
          dryRun,
          overwrite: args?.overwrite === true,
          pythonVersion: typeof args?.pythonVersion === 'string' ? args.pythonVersion : '',
          testPaths: typeof args?.testPaths === 'string' ? args.testPaths : undefined,
          pythonVersions: typeof args?.pythonVersions === 'string' ? args.pythonVersions : '',
          stages: typeof args?.stages === 'string' ? args.stages : '',
          fileName: typeof args?.fileName === 'string' ? args.fileName : '',
          lockMode: typeof args?.lockMode === 'string' ? args.lockMode : '',
        },
        exec,
      )

      const files = Array.isArray(applied?.files) ? applied.files : []
      if (dryRun) {
        return {
          ...applied,
          mode: 'preview',
          targets,
          wrote: false,
          files,
          summary: formatPreview(applied, { targets, unknown }),
        }
      }
      // `wrote` reports what reached the disk, not what was attempted. A blocked
      // write (Poetry/PDM/Pipenv) must not claim success — the caller branches on
      // this field, and `blocked: true` beside `wrote: true` is a contradiction.
      const wroteSomething = applied?.blocked !== true && files.some((file) => file?.wrote === true)
      return {
        ...applied,
        mode: 'write',
        targets,
        files,
        wrote: wroteSomething,
        summary: String(applied?.summary ?? 'py-scaffold: the write returned nothing')
          .replace(/^# py-apply/, '# py-scaffold'),
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args?.dryRun === false
        ? 'Write the CI/CD configuration'
        : 'Preview the CI/CD configuration',
    }),
  }
}
