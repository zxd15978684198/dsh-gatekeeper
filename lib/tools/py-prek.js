// The `py-prek` tool: the pre-commit config the modern-python skill describes,
// with prek as the runner instead of pre-commit.
//
// prek is not a different format — the file is `.pre-commit-config.yaml` either
// way — so this tool does the one thing a template cannot: it picks the hooks that
// match the project (no security hooks in a repo with no shell scripts and no
// workflows would be over-installation, but the skill's default is the full set,
// so security is a switch that defaults on, not a guess).
//
// It never writes the file: a hook runner that silently edits `.pre-commit-config.yaml`
// in a repository whose hooks the user has not seen is worse than a missing hook.

import { detect } from '../detect.js'
import { sessionCwdOf } from '../session.js'
import {
  PLACEHOLDER_REVS,
  prekNextSteps,
  prekRationale,
  renderPreCommitConfig,
} from '../prek.js'

/** The text the caller reads. */
export function formatPrek(result) {
  const lines = [
    '# .pre-commit-config.yaml — proposed prek setup for ' + result.root,
    '# Nothing was written to disk: this is text to review and commit yourself.',
    '',
    result.yaml,
  ]
  if (result.unpinnedRevs.length > 0) {
    lines.push('# Replace these placeholders before the first run:')
    for (const entry of result.unpinnedRevs) lines.push('#   ' + entry.repo + '  ' + entry.url)
  }
  return lines.join('\n')
}

/** The tool definition. */
export function createPyPrekTool({ config }) {
  return {
    name: 'py-prek',
    description:
      'Render a `.pre-commit-config.yaml` for prek (the drop-in pre-commit replacement the ' +
      '2-modern-python skill uses): ruff + ruff-format, prek builtin file checks, and the security ' +
      'hooks from references/security-setup.md (shellcheck, detect-secrets, actionlint, zizmor). ' +
      'Returns YAML text plus the commands that install and run it — it never writes the file. ' +
      'Every `rev` is a "<latest>" placeholder because versions cannot be known offline; the ' +
      'releases URLs are returned alongside.',
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
            'Python used by the hook environments, e.g. "3.12". Defaults to the detected version, ' +
            'then to the configured default.',
        },
        includeSecurity: {
          type: 'boolean',
          description:
            'Include the shellcheck / detect-secrets / actionlint / zizmor hooks. Defaults to the ' +
            'configured value (on). Turn it off for a repo with no shell scripts and no workflows.',
        },
        includeBuiltin: {
          type: 'boolean',
          description: 'Include prek\'s `repo: builtin` file checks (whitespace, EOF, YAML, TOML). Defaults to true.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          root: { type: 'string' },
          fileName: { type: 'string' },
          pythonVersion: { type: 'string' },
          includeSecurity: { type: 'boolean' },
          includeBuiltin: { type: 'boolean' },
          yaml: { type: 'string' },
          unpinnedRevs: { type: 'array', items: { type: 'object', additionalProperties: true } },
          nextSteps: { type: 'array', items: { type: 'string' } },
          rationale: { type: 'array', items: { type: 'string' } },
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
        throw new Error('py-prek: this session has no working directory and no path was given.')
      }
      const detection = await detect(root)

      const requestedVersion = typeof args?.pythonVersion === 'string' ? args.pythonVersion.trim() : ''
      const pythonVersion = requestedVersion !== ''
        ? requestedVersion
        : (typeof detection.pythonVersion === 'string' && detection.pythonVersion !== ''
          ? detection.pythonVersion
          : config.defaultPythonVersion)
      const includeSecurity = typeof args?.includeSecurity === 'boolean'
        ? args.includeSecurity
        : config.includeSecurityGate !== false
      const includeBuiltin = typeof args?.includeBuiltin === 'boolean'
        ? args.includeBuiltin
        : true

      const result = {
        root: detection.root ?? root,
        fileName: '.pre-commit-config.yaml',
        pythonVersion,
        includeSecurity,
        includeBuiltin,
        yaml: renderPreCommitConfig({ pythonVersion, includeSecurity, includeBuiltin }),
        unpinnedRevs: PLACEHOLDER_REVS.filter((entry) => (
          entry.repo === 'astral-sh/ruff-pre-commit' || includeSecurity
        )),
        nextSteps: prekNextSteps({ includeSecurity }),
        rationale: prekRationale({ includeSecurity, includeBuiltin }),
        warnings: [],
      }

      if (detection.linters?.preCommit === true) {
        const existing = detection.linterConfigFiles?.find?.((file) => file.includes('pre-commit'))
        result.warnings.push(
          'A pre-commit config already exists' + (existing === undefined ? '' : ' (' + existing + ')') + ': '
          + 'diff it against this proposal instead of replacing it blindly — the hooks you added by hand '
          + 'are exactly what a template loses.',
        )
      }
      if (detection.hasWorkflowDir !== true) {
        result.warnings.push(
          'No .github/workflows directory: actionlint and zizmor will have nothing to check until you add '
          + 'a workflow, and zizmor exits non-zero on an empty match in some versions. Drop those two hooks '
          + '(includeSecurity=false) or add CI first.',
        )
      }

      result.summary = formatPrek(result)
      return result
    },
    presentCall: () => ({ card: 'generic', title: 'prek 钩子配置' }),
  }
}
