// The `py-ci-render` tool: a Python/uv workflow, generated rather than translated.
//
// `4-github-actions-templates` is a useful collection of shapes, but it is Node-18
// era: its pipelines install JavaScript and reach for `docker/build-push-action@v5`.
// Copying one of those into a Python repository would produce a workflow that runs
// `npm ci` against a `pyproject.toml`. So the file is generated here from the
// Python facts instead, and the only thing borrowed is the shape.
//
// Like `py-bootstrap`, it refuses a foreign-lockfile project: a uv workflow in a
// Poetry repository is not a suggestion, it is a broken pipeline.

import { detect, uvBlockedReason } from '../detect.js'
import { safeWorkflowName } from '../apply.js'
import { parseVersions, renderWorkflow, selectStages, workflowFileName } from '../ci-render.js'
import { DEFAULT_STAGE_IDS, STAGE_IDS } from '../pipeline/ir.js'
import { knownStages, syncFlag } from '../pipeline/github.js'
import { resolveTargetPython } from '../python-version.js'
import { sessionCwdOf } from '../session.js'

/** The stages `all` can never include, spelled once so the note and the docs agree. */
const OPT_IN_STAGES = STAGE_IDS.filter((id) => !DEFAULT_STAGE_IDS.includes(id))

/** The text the caller reads. */
export function formatWorkflow(result) {
  if (result.blocked === true) {
    // Two different refusals reach this branch, and claiming the foreign-lockfile
    // one for a bad file name told the reader something false about their project.
    const heading = result.blockedKind === 'bad-file-name'
      ? 'BLOCKED: the workflow file name was rejected, so nothing is rendered.'
      : 'BLOCKED: this project is managed by another tool, so no uv workflow is rendered.'
    return [
      heading,
      '',
      result.reason,
      '',
      'root: ' + result.root,
    ].join('\n')
  }
  return [
    '# ' + result.fileName + ' — proposed GitHub Actions workflow for ' + result.root,
    '# Nothing was written to disk: this is text to review and commit yourself.',
    '# Python: ' + result.pythonVersions.join(', ')
      + '   security gate: ' + (result.includeSecurity ? 'on' : 'off'),
    '# Stages: ' + result.stages.join(' → ') + '   (uv sync ' + result.syncFlag + ')',
    '# Write it to .github/workflows/' + result.fileName + ' and check it with actionlint if available.',
    '',
    result.yaml,
  ].join('\n')
}

/** The tool definition. */
export function createPyCiRenderTool({ config }) {
  return {
    name: 'py-ci-render',
    description:
      'Render a complete GitHub Actions workflow for a Python + uv project: actions/checkout@v4, ' +
      'astral-sh/setup-uv@v5 with enable-cache, `uv sync --frozen --all-groups`, then the selected ' +
      'stages (default: lint, type, test, build, security). Opt-in stages add the CD half — ' +
      '`container` (a compose/build gate behind `needs: [quality]`), `release` (uv build, provenance ' +
      'attestation, SBOM, artifact upload, GitHub Release on a version tag; PyPI publish and image ' +
      'push as commented opt-ins) and `deploy` (a tagged/dispatched job with an `environment:` and ' +
      '`needs: [release]`, whose actual command ships commented because it belongs to you). Returns ' +
      'YAML text only — it never writes .github/workflows. REFUSES with blocked=true when the ' +
      'project has a poetry.lock, pdm.lock or Pipfile.lock, because uv is not that project\'s ' +
      'dependency manager.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Project directory. Defaults to the calling session\'s working directory.',
        },
        pythonVersions: {
          type: 'string',
          description:
            'Comma-separated Python versions for a test matrix (e.g. "3.11,3.12,3.13"). A single ' +
            'version renders a single-version job. Defaults to the plugin setting.',
        },
        fileName: {
          type: 'string',
          description: 'Workflow file name to suggest. Defaults to "<project>.yml".',
        },
        stages: {
          type: 'string',
          description:
            'Comma-separated stage ids, or "all". Known: ' + knownStages().join(', ') + '. "all" ' +
            'means the default stages only; ' + OPT_IN_STAGES.join(', ') + ' must be named ' +
            'explicitly. Defaults to this plugin\'s settings (security on, integration off).',
        },
        lockMode: {
          type: 'string',
          enum: ['frozen', 'locked'],
          description:
            '"frozen" (default) installs exactly what uv.lock pins without checking it; "locked" ' +
            'also fails when uv.lock is out of date. Pick "locked" if the repository already uses it.',
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
          fileName: { type: 'string' },
          yaml: { type: 'string' },
          summary: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const requested = typeof args?.path === 'string' ? args.path.trim() : ''
      const root = requested !== '' ? requested : sessionCwdOf(exec)
      if (typeof root !== 'string' || root === '') {
        throw new Error('py-ci-render: this session has no working directory and no path was given.')
      }
      const detection = await detect(root)

      const blocked = uvBlockedReason(detection)
      if (blocked.blocked === true) {
        const refusal = {
          blocked: true,
          reason: blocked.reason,
          root: detection.root ?? root,
          summary: '',
        }
        refusal.summary = formatWorkflow(refusal)
        return refusal
      }

      // The matrix follows the project, not the plugin default. Before this, a
      // project pinning 3.14 got a workflow that tested 3.13 — a matrix the repo's
      // own `requires-python` rejects, so `uv sync` fails on the first job.
      const requestedVersions = typeof args?.pythonVersions === 'string' ? args.pythonVersions.trim() : ''
      const resolvedPython = resolveTargetPython(detection, config.defaultPythonVersion)
      const pythonVersions = parseVersions(
        requestedVersions !== ''
          ? requestedVersions
          : (config.matrixPythonVersions !== ''
            ? config.matrixPythonVersions
            : (resolvedPython.version ?? config.defaultPythonVersion)),
        config.defaultPythonVersion,
      )
      const projectName = detection.root === undefined
        ? 'python'
        : detection.root.split(/[\\/]/).filter((part) => part !== '').pop() ?? 'python'
      const requestedFileName = typeof args?.fileName === 'string' ? args.fileName.trim() : ''
      // The same guard `py-apply` uses, so the two tools cannot disagree about a
      // name: a rendered workflow whose name `py-apply` refuses to write would be
      // a suggestion the plugin itself will not accept.
      const fileName = safeWorkflowName(
        requestedFileName !== '' ? requestedFileName : workflowFileName(projectName),
      )
      if (fileName === null) {
        const refusal = {
          blocked: true,
          blockedKind: 'bad-file-name',
          reason: 'fileName is not usable as a workflow file name: ' + requestedFileName
            + ' (expected a plain name such as "ci", "ci.yml" or "python.yml").',
          root: detection.root ?? root,
          summary: '',
        }
        refusal.summary = formatWorkflow(refusal)
        return refusal
      }
      const requestedLockMode = args?.lockMode === 'locked' ? 'locked' : 'frozen'
      const result = {
        blocked: false,
        root: detection.root ?? root,
        packageManager: detection.packageManager,
        pythonVersions,
        includeSecurity: config.includeSecurityGate === true,
        includeIntegration: config.includeIntegrationGate === true,
        stages: [],
        syncFlag: syncFlag(requestedLockMode),
        fileName,
        yaml: '',
        warnings: [],
      }

      const requestedStages = typeof args?.stages === 'string' ? args.stages.trim() : ''
      const selection = selectStages({
        stages: requestedStages !== '' ? requestedStages : undefined,
        includeSecurity: config.includeSecurityGate,
        includeIntegration: config.includeIntegrationGate,
      })
      const ids = selection.ids.length > 0 ? selection.ids : DEFAULT_STAGE_IDS
      result.stages = ids

      result.yaml = renderWorkflow({
        pythonVersions,
        stages: ids,
        lockMode: requestedLockMode,
        projectName,
      })

      if (selection.rejected.length > 0) {
        result.warnings.push(
          'Ignored unknown stage(s): ' + selection.rejected.join(', ') +
          '. Known: ' + knownStages().join(', ') + '.',
        )
      }

      if (detection.packageManager !== 'uv') {
        result.warnings.push(
          'No uv.lock at this project. `uv sync --frozen` fails without a lockfile, so run ' +
          '`uv lock` and commit uv.lock before this workflow can pass.',
        )
      }
      const projectWorkflows = Array.isArray(detection.workflows) ? detection.workflows : []
      if (projectWorkflows.length > 0) {
        result.warnings.push(
          'Existing workflow(s): ' + projectWorkflows.map((workflow) => workflow.file).join(', ') +
          '. A second pipeline that duplicates a passing one is worse than no pipeline.',
        )
      }
      result.summary = formatWorkflow(result)
      if (result.warnings.length > 0) {
        result.summary += '\n\n--- notes ---\n' + result.warnings.map((warning) => '- ' + warning).join('\n')
      }
      return result
    },
    presentCall: (args) => ({
      card: 'generic',
      title: typeof args?.fileName === 'string' && args.fileName.trim() !== ''
        ? 'Render workflow ' + args.fileName.trim()
        : 'Render a Python/uv workflow',
    }),
  }
}
