// The `py-bootstrap` tool: propose the pyproject configuration, refuse the wrong project.
//
// The refusal is the point. A skill can tell an agent "don't use uv in projects
// managed by other tools" and the agent may still do it; this tool runs the same
// sentence as a predicate over the project's own lockfiles, so on a Poetry project
// there is no uv configuration to be had at all. That is a structural guarantee
// where the skill only offers advice.
//
// The second point is that nothing here is a guess: every value the snippet carries
// — interpreter, ruff line length and rule set, type checker and paths, coverage
// floor, test paths — is read by `resolveProject` from this project's own files and
// shown with its source. The same 18 resolved values drive `scripts/ci.py`, the
// workflow and `py-run`, so the block this tool proposes and the gates that run
// cannot spell the project two ways.

import { basename } from 'node:path'

import { detect, uvBlockedReason } from '../detect.js'
import { stageMatrix } from '../pipeline/ir.js'
import {
  DEFAULT_TEST_PATHS,
  devGroupCommand,
  normalizeProjectName,
  pyprojectPrerequisites,
  pyprojectRationale,
  renderPyprojectBlock,
} from '../pyproject.js'
import { normalizeVersion, resolveTargetPython } from '../python-version.js'
import { describeResolved, resolveProject } from '../resolve.js'
import { sessionCwdOf } from '../session.js'

/**
 * Pick the concrete interpreter version to target, preferring what the project pins.
 *
 * Kept as a thin wrapper so the exported name (and any caller of it) keeps
 * working, but the decision itself lives in `python-version.js` — the previous
 * version of this function accepted only a concrete version and quietly fell
 * back to the plugin default when it saw `>=3.9`, which is how a project that
 * supports 3.9 got a `py313` target.
 */
export function targetPythonVersion(detection, fallback) {
  return resolveTargetPython(detection, fallback).version ?? fallback
}

/**
 * The 9-step gate list from the course's chapter 8, one bullet per command.
 *
 * Derived from the same IR the workflow and `scripts/ci.py` are rendered from, so
 * a next-step list that says "run these commands" cannot drift from the generated
 * pipeline. `lint` is two commands (format is a separate report), which is why
 * eight default stages carry nine steps.
 */
function gateSteps() {
  const steps = []
  for (const row of stageMatrix()) {
    if (row.defaultIncluded !== true) continue
    for (const command of row.commands) {
      steps.push((steps.length + 1) + '. ' + row.id + ': ' + command)
    }
  }
  return steps
}

/** The text a caller reads when the block was produced. */
export function formatBootstrap(result) {
  if (result.blocked === true) {
    return [
      'BLOCKED: this project is managed by another tool, so no uv configuration is proposed.',
      '',
      result.reason,
      '',
      'root: ' + result.root,
      'What to do instead: migrate the project to uv first (py-references topic "migration"),',
      'or keep the current tool — the rest of this plugin still works there.',
    ].join('\n')
  }
  const lines = [
    '# Proposed pyproject.toml configuration for ' + result.root,
    '# Nothing was written to disk: this is text to review and copy.',
    '# Python target: ' + result.pythonVersion
      + (result.pythonVersionSource === null ? ' (plugin default)' : ' (from ' + result.pythonVersionSource + ')'),
    '',
    result.snippet,
    '',
    '--- dependency group (one command; it updates pyproject.toml and uv.lock together) ---',
    result.devGroupCommand,
    ...(Array.isArray(result.nextSteps) && result.nextSteps.length > 0
      ? ['', '--- after the group exists ---', ...result.nextSteps.map((step) => '- ' + step)]
      : []),
    '',
    '--- prerequisites ---',
    ...result.prerequisites.map((item) => '- ' + item),
    '',
    '--- what this project resolves to (why the numbers above) ---',
    ...result.resolvedLines.map((item) => '- ' + item),
    '',
    '--- why each stanza ---',
    ...result.rationale.map((item) => '- ' + item.stanza + ': ' + item.why),
  ]
  if (Array.isArray(result.warnings) && result.warnings.length > 0) {
    lines.push('')
    lines.push('--- notes ---')
    for (const warning of result.warnings) lines.push('- ' + warning)
  }
  return lines.join('\n')
}

/** The tool definition. */
export function createPyBootstrapTool({ config }) {
  return {
    name: 'py-bootstrap',
    description:
      'Propose the pyproject.toml configuration a modern Python project needs: PEP 735 ' +
      '[dependency-groups], [tool.ruff] with target-version/line-length and a deliberate rule ' +
      'set, the project\'s type checker ([tool.mypy] or [tool.ty]), [tool.pytest.ini_options], ' +
      '[tool.coverage.*], and a [tool.uv] required-version. Every value is resolved from the ' +
      'project itself (existing configuration first, then file/directory detection, then the ' +
      'plugin default) and returned with its source, so the snippet never invents a path or a ' +
      'floor the project does not have. Returns text only — it never writes to disk. REFUSES and ' +
      'returns blocked=true when the project carries a poetry.lock, pdm.lock or Pipfile.lock, ' +
      'because uv must not manage a project owned by another tool. Read the refusal reason to the ' +
      'user instead of working around it.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Project directory. Defaults to the calling session\'s working directory.',
        },
        pythonVersion: {
          type: 'string',
          description:
            'Interpreter version to target (e.g. "3.13"). Defaults to the project\'s ' +
            '.python-version, then its requires-python, then the plugin default, so leave it ' +
            'unset unless the caller asked for a specific version.',
        },
        testPaths: {
          type: 'string',
          description:
            'Comma-separated pytest testpaths. Defaults to the paths the project already ' +
            'configures or that were detected on disk (' + DEFAULT_TEST_PATHS + ' when nothing ' +
            'exists).',
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
          pythonVersion: { type: 'string' },
          typeChecker: { type: 'string' },
          snippet: { type: 'string' },
          devGroupCommand: { type: 'string' },
          nextSteps: { type: 'array', items: { type: 'string' } },
          resolvedLines: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const requested = typeof args?.path === 'string' ? args.path.trim() : ''
      const root = requested !== '' ? requested : sessionCwdOf(exec)
      if (typeof root !== 'string' || root === '') {
        throw new Error('py-bootstrap: this session has no working directory and no path was given.')
      }
      const detection = await detect(root)

      // The guard runs before anything is generated: on a foreign project there is
      // no partial result to argue with.
      const blocked = uvBlockedReason(detection)
      if (blocked.blocked === true) {
        const refusal = {
          blocked: true,
          reason: blocked.reason,
          root: detection.root ?? root,
          packageManager: detection.packageManager,
          summary: '',
        }
        refusal.summary = formatBootstrap(refusal)
        return refusal
      }

      const resolvedRoot = detection.root ?? root
      // 18 values, each `{value, source}` — the same object `scripts/ci.py` and the
      // workflow are built from. Nothing below re-derives a value by hand.
      const resolved = resolveProject({ rootDir: resolvedRoot, detection })

      // An explicit argument is the one value the project's files cannot outrank.
      const requestedVersion = typeof args?.pythonVersion === 'string' ? args.pythonVersion.trim() : ''
      const pythonVersion = requestedVersion !== ''
        ? (normalizeVersion(requestedVersion) ?? requestedVersion)
        : resolved.pythonVersion.value
      const versionSource = requestedVersion !== ''
        ? 'argument'
        : (resolved.pythonVersion.source === 'default' ? null : resolved.pythonVersion.source)

      const requestedTestPaths = typeof args?.testPaths === 'string' ? args.testPaths.trim() : ''
      const resolvedTestPaths = Array.isArray(resolved.testPaths.value)
        ? resolved.testPaths.value.join(',')
        : String(resolved.testPaths.value)
      const testPaths = (requestedTestPaths !== '' ? requestedTestPaths : resolvedTestPaths)
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')

      const typeChecker = resolved.typeChecker.value
      const warnings = []
      if (versionSource === null) {
        warnings.push(
          'No .python-version or requires-python was found: targeting the plugin default ' +
          pythonVersion + '. Pin it in .python-version so a laptop and CI agree on the interpreter.',
        )
      }
      if (detection.hasDependencyGroups === true) {
        warnings.push(
          'This pyproject already has a [dependency-groups] table. Merge the dev group into the ' +
          'existing one instead of appending a second table.',
        )
      }
      if (detection.hasLegacyDevDependencies === true) {
        warnings.push(
          'This pyproject uses [tool.uv] dev-dependencies, the pre-PEP-735 spelling. Move those ' +
          'entries into [dependency-groups] dev rather than keeping both.',
        )
      }
      if (typeChecker === 'ty') {
        // mypy is the default, so the only checker that needs an instruction is ty:
        // its configuration lives in its own table, and a project without one still
        // resolves every file path from src detection.
        warnings.push(
          'This project resolves to the ty type checker. Write the settings in a [tool.ty] table ' +
          '(e.g. `[tool.ty.environment] python = "' + pythonVersion + '"`) so `uv run ty check` ' +
          'checks the same files locally and in CI; no [tool.mypy] block is emitted.',
        )
      }

      const result = {
        blocked: false,
        root: resolvedRoot,
        packageManager: detection.packageManager,
        pythonVersion,
        pythonVersionSource: versionSource,
        testPaths,
        typeChecker,
        snippet: renderPyprojectBlock({
          pythonVersion,
          testPaths,
          includeSecurity: config.includeSecurityGate,
          // An existing [project] table must not be duplicated, so the requirement is
          // emitted as a line to merge rather than as a second table.
          includeProjectTable: detection.hasPyproject !== true,
          // A new file needs a `[project].name` (uv refuses to parse it otherwise),
          // and the directory is the only name source a project without a pyproject
          // has — normalized, because a folder name is not a package name.
          projectName: normalizeProjectName(basename(resolvedRoot)),
          requiresPython: resolved.requiresPython.value,
          typeChecker,
          ruffLineLength: resolved.ruffLineLength.value,
          ruffSelect: resolved.ruffSelect.value,
          ruffIgnore: resolved.ruffIgnore.value,
          coverageFloor: resolved.coverageFloor.value,
          includeWorkspace: detection.workspace?.isWorkspace === true,
          workspaceMembers: resolved.workspaceMembers.value,
        }),
        rationale: pyprojectRationale({
          includeSecurity: config.includeSecurityGate,
          typeChecker,
          ruffSelect: resolved.ruffSelect.value,
          ruffIgnore: resolved.ruffIgnore.value,
          includeWorkspace: detection.workspace?.isWorkspace === true,
        }),
        // One command, never a pasted table: `uv add --group` writes pyproject.toml
        // and uv.lock in the same step, a hand-written table does not.
        devGroupCommand: devGroupCommand({
          includeSecurity: config.includeSecurityGate,
          typeChecker,
        }),
        // The table alone does not produce a lockfile: these are the steps between
        // "declared" and "installed", and leaving them out is how a project ends up
        // with a pyproject and no uv.lock.
        nextSteps: [
          ...gateSteps(),
          'Install the commit hook once per clone: `uv tool install prek`, then `prek install`.',
          'Create the secret baseline once: `uv run --locked detect-secrets scan > .secrets.baseline`, ' +
          'then audit every item with `uv run --locked detect-secrets audit .secrets.baseline`.',
          'Later update false positives with `uv run --locked detect-secrets scan --baseline ' +
          '.secrets.baseline` — never redirect over the file with `>`, which would discard the ' +
          'audit history.',
        ],
        resolvedLines: describeResolved(resolved),
        prerequisites: pyprojectPrerequisites(),
        warnings,
      }
      result.summary = formatBootstrap(result)
      return result
    },
    presentCall: () => ({ card: 'generic', title: 'Propose pyproject configuration' }),
  }
}
