// The `py-detect` tool: one call instead of a directory tour.
//
// A model asked "what is this project's Python setup?" otherwise runs `ls`, reads
// `pyproject.toml`, guesses at the lockfile, and still cannot tell whether CI
// exists. This returns the same facts as one structured object, and it is the
// guard the generating tools consult before they propose anything.

import { detect } from '../detect.js'
import { sessionCwdOf } from '../session.js'

/** One readable section from a detection result. */
export function formatDetection(detection) {
  if (detection === null || typeof detection !== 'object') return 'py-detect: no result'
  if (detection.ok !== true) {
    return [
      'py-detect: could not inspect ' + String(detection.root ?? '?'),
      '  ' + String(detection.error ?? 'unknown error'),
    ].join('\n')
  }

  const manager = detection.packageManager === 'uv'
    ? 'uv (uv.lock present)'
    : (detection.packageManager === 'unknown'
      ? 'unknown (no lockfile; ' + (detection.hasPyproject ? 'pyproject.toml present' : 'no pyproject.toml') + ')'
      : detection.packageManager + ' (foreign: uv must not manage this project)')
  const python = detection.pythonVersion === null
    ? 'not declared'
    : detection.pythonVersion + (detection.pythonVersionSource === null ? '' : ' (' + detection.pythonVersionSource + ')')
  const flag = (value) => (value === true ? 'yes' : 'no')
  const linters = detection.linters ?? {}

  const lines = [
    'project: ' + detection.root,
    'manager: ' + manager,
    'python:  ' + python,
    'pyproject: ' + flag(detection.hasPyproject)
      + '   dependency-groups: ' + flag(detection.hasDependencyGroups),
    'lint:    ruff ' + flag(linters.ruff) + ', mypy ' + flag(linters.mypy) + ', ty ' + flag(linters.ty)
      + ', black ' + flag(linters.black),
    'test:    pytest ' + flag(linters.pytest) + ', pre-commit ' + flag(linters.preCommit),
    'ci:      ' + (detection.workflows?.length > 0
      ? (detection.workflows.map((workflow) => workflow.file).join(', '))
      : (detection.hasWorkflowDir === true ? '.github/workflows exists but holds no YAML' : '.github/workflows does not exist')),
    'confidence: ' + detection.confidence + '   detected: ' + detection.detectedAt,
  ]

  if (Array.isArray(detection.blockers) && detection.blockers.length > 0) {
    lines.push('')
    lines.push('BLOCKED — ' + detection.blockers.length + ' reason(s) to leave uv out of this project:')
    for (const blocker of detection.blockers) lines.push('  - ' + blocker.file + ': ' + blocker.reason)
  }
  if (Array.isArray(detection.notes) && detection.notes.length > 0) {
    lines.push('')
    for (const note of detection.notes) lines.push('note: ' + note)
  }
  return lines.join('\n')
}

/** The tool definition. Built per registration, never shared across mounts. */
export function createPyDetectTool({ store }) {
  return {
    name: 'py-detect',
    description:
      'Inspect the Python project at the session workspace (or a given path) and return its ' +
      'packaging facts as one structured object: which lockfile manages dependencies (uv, or a ' +
      'foreign Poetry/PDM/Pipenv lockfile), the declared Python version, whether pyproject.toml, ' +
      'ruff, mypy, ty, pytest and pre-commit are configured, and which GitHub Actions workflows ' +
      'exist. Read-only. Use this before proposing any Python tooling change, and expect it to ' +
      'say the project is managed by another tool rather than by uv.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Directory to inspect. Defaults to the calling session\'s working directory, which ' +
            'is almost always the right answer; pass a subproject path for a monorepo.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          root: { type: 'string' },
          packageManager: { type: 'string' },
          confidence: { type: 'string' },
          summary: { type: 'string' },
          blockers: { type: 'array', items: { type: 'object', additionalProperties: true } },
          notes: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const requested = typeof args?.path === 'string' ? args.path.trim() : ''
      const root = requested !== '' ? requested : sessionCwdOf(exec)
      if (typeof root !== 'string' || root === '') {
        throw new Error(
          'py-detect: this session has no working directory and no path was given. ' +
          'Pass `path` to say which project to inspect.',
        )
      }
      const detection = await detect(root)
      store.record(detection, exec?.agent?.session?.id ?? null)
      return { ...detection, summary: formatDetection(detection) }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: typeof args?.path === 'string' && args.path.trim() !== ''
        ? 'Inspect Python project at ' + args.path.trim()
        : 'Inspect this Python project',
    }),
  }
}
