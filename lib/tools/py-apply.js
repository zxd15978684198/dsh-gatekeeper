// The `py-apply` tool: the write half of this plugin.
//
// Everything else here answers a question. This one changes the project, so it is
// built around the opposite default: nothing happens unless `dryRun` is explicitly
// false, and even then only a fixed list of files can be touched. The first call in
// a session is therefore always a preview, and the preview is the whole plan —
// every file it would create or change, with a diff for the ones that change.
//
// The payloads are not written here. `pyproject.toml` comes from
// `../pyproject.js`, `.pre-commit-config.yaml` from `../prek.js`,
// `.github/dependabot.yml` from `../dependabot.js`, the workflow from
// `../ci-render.js`, `scripts/ci.py` from `../pipeline/local.js`,
// `release/agent_versions.json` and `scripts/validate_version_manifest.py` from
// `../manifest.js`, `scripts/secret_scan.py` from `../secret-scan.js`, and
// `scripts/container_report.py` from `../container-report.js` — the same functions
// the read-only tools print. Applying one of those and reading it are the same text
// by construction, which is the only way "the preview matched what got written" can
// stay true after someone edits one renderer and forgets the other.
//
// One target is not renderer-owned: `release/agent_versions.json` is evidence. A
// first run creates it; every later run reports the diff between the manifest on
// disk and what the probe sees today, and writes nothing. That is why it is the
// only target whose plan status can be `diff`.

import path from 'node:path'

import { detect, readPyprojectTables } from '../detect.js'
import { projectRootFor } from '../session.js'
import { DEFAULT_TEST_PATHS, devGroupCommand, normalizeProjectName, renderPyprojectBlock } from '../pyproject.js'
import { PLACEHOLDER_REVS, prekNextSteps, renderPreCommitConfig } from '../prek.js'
import { renderDependabotConfig, DEPENDABOT_PATH } from '../dependabot.js'
import { parseVersions, renderWorkflow, selectStages, workflowFileName } from '../ci-render.js'
import { DEFAULT_STAGE_IDS } from '../pipeline/ir.js'
import { knownStages } from '../pipeline/github.js'
import {
  CI_SCRIPT_PATH,
  DEFAULT_PROFILE,
  DEFAULT_TIMEOUT_SECONDS,
  localPlan,
  renderCiScript,
} from '../pipeline/local.js'
import { resolveProject } from '../resolve.js'
import {
  MANIFEST_PATH,
  VALIDATOR_PATH,
  probeComponents,
  renderManifest,
  renderValidator,
} from '../manifest.js'
import { SECRET_HELPER_PATH, renderSecretScanScript } from '../secret-scan.js'
import { CONTAINER_REPORT_PATH, renderContainerReportScript } from '../container-report.js'
import {
  APPLY_TARGETS,
  TARGET_FILES,
  applyRefusal,
  commitWrite,
  isApplyTarget,
  planWrite,
  safeWorkflowName,
  targetRelPath,
} from '../apply.js'

/** The target list the tool documents, with where each file comes from. */
export const TARGET_SUMMARY = [
  { id: 'pyproject', file: 'pyproject.toml', mode: 'append', source: 'resolved project values' },
  { id: 'prek', file: '.pre-commit-config.yaml', mode: 'whole', source: 'py-prek' },
  { id: 'dependabot', file: DEPENDABOT_PATH, mode: 'whole', source: 'py-dependabot' },
  { id: 'workflow', file: '.github/workflows/<name>.yml', mode: 'whole', source: 'py-ci-render' },
  { id: 'ci-script', file: CI_SCRIPT_PATH, mode: 'whole', source: 'py-ci-run' },
  { id: 'manifest', file: MANIFEST_PATH, mode: 'diff-only', source: 'probeComponents + renderManifest' },
  { id: 'validator', file: VALIDATOR_PATH, mode: 'whole', source: 'renderValidator' },
  { id: 'secret-scan', file: SECRET_HELPER_PATH, mode: 'whole', source: 'renderSecretScanScript' },
  { id: 'container-report', file: CONTAINER_REPORT_PATH, mode: 'whole', source: 'renderContainerReportScript' },
]

/** Pending stage ids a bare `stages` argument should not silently include. */
const OPT_IN_STAGES = ['container', 'integration', 'release', 'deploy']

/** The project name used for the workflow file name when none is given. */
function projectNameOf(root) {
  const parts = String(root ?? '').split(/[\\/]/).filter((part) => part !== '')
  return parts.length === 0 ? 'python' : parts[parts.length - 1]
}

/**
 * The project name and version the manifest and the generated `[project]` record.
 *
 * `[project]` is the only source: the directory name is a fallback for a project
 * that has no pyproject yet, not a fact about the service. A directory name is a
 * folder name, not a package name, so the fallback is normalized (`My Service`
 * becomes `my-service`) before it can reach a `[project].name` line. A version
 * that is not a literal string (dynamic versioning) gets the visible `0.0.0`
 * placeholder rather than a guess.
 */
function projectFacts(root) {
  const parsed = readPyprojectTables(root)
  const project = parsed.tables?.['project']
  const name = typeof project?.name === 'string' && project.name.trim() !== ''
    ? project.name.trim()
    : normalizeProjectName(projectNameOf(root))
  const version = typeof project?.version === 'string' && project.version.trim() !== ''
    ? project.version.trim()
    : '0.0.0'
  return { name, version, hasProjectTable: project !== undefined }
}

/**
 * The package names behind `[tool.uv.workspace].members`.
 *
 * `members` holds paths (or globs), but a `[tool.uv.sources]` entry needs the
 * package *name*, which only the member's own pyproject knows. A glob names no
 * package, so it is skipped rather than turned into a guessed name; a member whose
 * pyproject has no `[project].name` falls back to its directory name. This is a
 * name lookup, not a dependency claim: the caller only ever writes these as
 * commented templates.
 */
function workspaceMemberNames(rootDir, detection) {
  const declared = Array.isArray(detection?.workspace?.members) ? detection.workspace.members : []
  const names = []
  for (const raw of declared) {
    const member = String(raw).trim().replace(/\/+$/, '')
    if (member === '' || member === '.' || /[*?[\]]/.test(member)) continue
    let name = ''
    try {
      const project = readPyprojectTables(path.resolve(rootDir, member)).tables?.['project']
      if (typeof project?.name === 'string' && project.name.trim() !== '') name = project.name.trim()
    } catch {
      name = ''
    }
    if (name === '') name = path.basename(member)
    if (name !== '' && !names.includes(name)) names.push(name)
  }
  return names
}

/** The renderer's single generic example line, replaced by per-member templates. */
const WORKSPACE_SOURCE_PLACEHOLDER = '# release-guard = { workspace = true }'

/**
 * Turn the frozen renderer's one generic `{ workspace = true }` example into one
 * commented line per detected member package.
 *
 * `renderPyprojectBlock` only sees member *paths*; it cannot name the packages. The
 * comments stay comments because which siblings the root depends on is a human
 * decision — the plugin must not invent an edge in the dependency graph.
 */
function withWorkspaceSourceHints(text, names) {
  if (names.length === 0 || !text.includes(WORKSPACE_SOURCE_PLACEHOLDER)) return text
  const hints = names.map((name) => '# ' + name + ' = { workspace = true }').join('\n')
  return text.replace(WORKSPACE_SOURCE_PLACEHOLDER, hints)
}

/** Normalize `testPaths` (array or comma string) the way every list parameter is read. */
function requestedTestPaths(args) {
  if (typeof args?.testPaths === 'string') {
    return args.testPaths.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
  }
  if (Array.isArray(args?.testPaths)) {
    return args.testPaths.map((entry) => String(entry).trim()).filter((entry) => entry !== '')
  }
  return []
}

/** The stage ids a workflow/ci-script call selects, with the rejection note. */
function stageSelection(args, config) {
  const requestedStages = typeof args?.stages === 'string' ? args.stages.trim() : ''
  const selection = selectStages({
    stages: requestedStages !== '' ? requestedStages : undefined,
    includeSecurity: config.includeSecurityGate,
    includeIntegration: config.includeIntegrationGate,
  })
  return {
    ids: selection.ids.length > 0 ? selection.ids : DEFAULT_STAGE_IDS,
    rejected: selection.rejected,
  }
}

/** Versions for the workflow matrix: explicit argument, plugin setting, project, default. */
function matrixVersions(args, config, resolved) {
  const requested = typeof args?.pythonVersions === 'string' ? args.pythonVersions.trim() : ''
  const fromProject = resolved?.pythonVersion?.value
  return parseVersions(
    requested !== ''
      ? requested
      : (config.matrixPythonVersions !== ''
        ? config.matrixPythonVersions
        : (typeof fromProject === 'string' && fromProject !== '' ? fromProject : config.defaultPythonVersion)),
    config.defaultPythonVersion,
  )
}

/**
 * Build one payload for a target.
 *
 * @returns `{ relPath, payload, mode, notes, unpinnedRevs }` or
 *   `{ error }` when the target cannot be produced for this project.
 */
function buildPayload({ target, detection, root, args, config, resolved }) {
  const notes = []
  const projectName = projectNameOf(root)

  if (target === 'pyproject') {
    const facts = projectFacts(root)
    const requested = requestedTestPaths(args)
    const testPaths = requested.length > 0
      ? requested
      : (Array.isArray(resolved?.testPaths?.value) && resolved.testPaths.value.length > 0
          ? resolved.testPaths.value
          : (config.testPaths !== DEFAULT_TEST_PATHS
              ? [config.testPaths]
              : (Array.isArray(detection.markers?.testDirs) && detection.markers.testDirs.length > 0
                  ? detection.markers.testDirs
                  : [config.testPaths])))
    const workspaceMembers = Array.isArray(resolved?.workspaceMembers?.value)
      ? resolved.workspaceMembers.value
      : []
    // `workspaceMembers` are paths; the `[tool.uv.sources]` templates need names.
    const memberNames = workspaceMemberNames(root, detection)
    if (memberNames.length > 0) {
      notes.push(
        'Workspace members found: ' + memberNames.join(', ')
        + '. Their `[tool.uv.sources]` entries are written as comments — which siblings the root '
        + 'depends on is not something this tool can see.',
      )
    }
    return {
      relPath: TARGET_FILES.pyproject,
      // `[project]` is only emitted when the file is new: a second `[project]`
      // table is invalid TOML, and a project that has one already has a name.
      payload: withWorkspaceSourceHints(renderPyprojectBlock({
        pythonVersion: resolved.pythonVersion.value,
        requiresPython: resolved.requiresPython.value,
        testPaths,
        includeSecurity: config.includeSecurityGate !== false,
        typeChecker: resolved.typeChecker.value,
        ruffLineLength: resolved.ruffLineLength.value,
        ruffSelect: resolved.ruffSelect.value,
        ruffIgnore: resolved.ruffIgnore.value,
        // `null` from the resolver means "no measured baseline": do not pin a
        // floor the project cannot satisfy, which is why the key is passed even
        // when its value is null.
        coverageFloor: resolved.coverageFloor.value,
        includeWorkspace: workspaceMembers.length > 0 || resolved.buildMode.value === 'all-packages',
        workspaceMembers,
        // The `[project]` table this block appends has to carry a name and a
        // version: uv refuses to parse a pyproject without `project.name`, so a
        // fresh project would break at `uv lock` before the first gate ran.
        projectName: facts.name,
        version: facts.version,
        includeProjectTable: facts.hasProjectTable !== true,
      }), memberNames),
      mode: 'toml-append',
      notes,
      unpinnedRevs: [],
    }
  }

  if (target === 'prek') {
    return {
      relPath: TARGET_FILES.prek,
      payload: renderPreCommitConfig({
        pythonVersion: resolved.pythonVersion.value,
        includeSecurity: config.includeSecurityGate !== false,
        includeBuiltin: true,
      }),
      mode: 'whole',
      notes,
      // The revs are placeholders by design; the caller has to pin them, and the
      // result has to say so or the first `prek run` fails with a moving target.
      unpinnedRevs: PLACEHOLDER_REVS,
    }
  }

  if (target === 'dependabot') {
    return {
      relPath: DEPENDABOT_PATH,
      payload: renderDependabotConfig({
        schedule: 'weekly',
        directory: '/',
        cooldownDays: 7,
        ecosystems: ['pip', 'github-actions'],
      }),
      mode: 'whole',
      notes,
      unpinnedRevs: [],
    }
  }

  if (target === 'workflow') {
    const selection = stageSelection(args, config)
    if (selection.rejected.length > 0) {
      notes.push('Ignored unknown stage(s): ' + selection.rejected.join(', ') + '. Known: ' + knownStages().join(', ') + '.')
    }
    const requestedName = typeof args?.fileName === 'string' ? args.fileName.trim() : ''
    const name = safeWorkflowName(requestedName !== '' ? requestedName : workflowFileName(projectName))
    if (name === null) {
      return { error: 'fileName is not usable as a workflow file name: ' + requestedName }
    }
    return {
      relPath: TARGET_FILES.workflow + '/' + name,
      payload: renderWorkflow({
        pythonVersions: matrixVersions(args, config, resolved),
        stages: selection.ids,
        // The IR owns every command, and the resolved project is what lets it
        // name *this* project's paths, checker and build shape instead of the
        // catalog's documented fallback: an empty project's `type` step would
        // otherwise point at a `src/` that does not exist, and a single package
        // would otherwise build with `--all-packages`.
        resolved,
        // `frozen` installs exactly what uv.lock pins; `locked` also fails when the
        // lockfile is stale, for repositories that rely on it.
        lockMode: args?.lockMode === 'locked' ? 'locked' : 'frozen',
        projectName,
      }),
      mode: 'whole',
      notes,
      unpinnedRevs: [],
    }
  }

  if (target === 'ci-script') {
    const selection = stageSelection(args, config)
    if (selection.rejected.length > 0) {
      notes.push('Ignored unknown stage(s): ' + selection.rejected.join(', ') + '. Known: ' + knownStages().join(', ') + '.')
    }
    // `--from <stage>` version: the plan the script is generated from is the same
    // plan `py-ci-run` prints, and the profile is embedded so the script's default
    // is the full gate order rather than whatever the caller's last run used.
    // Same resolved values as the workflow: `localPlan` applies `applyResolved`
    // per stage, keeps an absent gate as one visible skip step, and the script
    // then runs the exact argv the workflow would.
    const plan = localPlan(selection.ids, {
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      profile: DEFAULT_PROFILE,
      resolved,
    })
    return {
      relPath: CI_SCRIPT_PATH,
      payload: renderCiScript(plan, { projectName, profile: DEFAULT_PROFILE }),
      mode: 'whole',
      notes,
      unpinnedRevs: [],
    }
  }

  if (target === 'manifest') {
    const facts = projectFacts(root)
    const components = probeComponents({ rootDir: root, detection })
    const document = renderManifest({
      projectName: facts.name,
      version: facts.version,
      pythonVersion: resolved.pythonVersion.value,
      // The generator runs no subprocesses, so an unmeasured uv version is written
      // as the renderer's visible `unknown` placeholder, never as a plausible one.
      uvVersion: typeof args?.uvVersion === 'string' ? args.uvVersion.trim() : '',
      // A missing `uv.lock` is not an unknown *name*: there is simply no lockfile
      // to describe. An omitted `lockfile` key means "unknown / not locked here";
      // writing `"uv.lock"` would assert a file nobody saw. 不写 = 未知，不谎报。
      ...(detection.hasUvLock === true ? { lockfile: 'uv.lock' } : {}),
      components,
    })
    // The renderer fills a visible `uv.lock` placeholder for the key it always
    // emits, so drop it when the project has no lockfile at all.
    if (detection.hasUvLock !== true) delete document.runtime.lockfile
    notes.push(
      'Components are evidence, not a list: only paths that exist are written (probed '
      + String(components.length) + ' component(s) now).',
    )
    if (facts.hasProjectTable !== true) {
      notes.push('No [project] table: projectName falls back to "' + facts.name + '", version to "0.0.0".')
    }
    const payload = JSON.stringify(document, null, 2) + '\n'
    return { relPath: MANIFEST_PATH, payload, mode: 'manifest-diff', notes, unpinnedRevs: [] }
  }

  if (target === 'validator') {
    // The same probe the manifest used: the required-component list inside the
    // validator cannot name a component the manifest was not given.
    const components = probeComponents({ rootDir: root, detection })
    notes.push(
      'PROJECT_COMPONENTS comes from the same probe as the manifest: '
      + (components.length > 0 ? components.map((component) => component.id).join(', ') : '(none)') + '.',
    )
    return {
      relPath: VALIDATOR_PATH,
      payload: renderValidator({ components }),
      mode: 'whole',
      notes,
      unpinnedRevs: [],
    }
  }

  if (target === 'secret-scan') {
    notes.push(
      'First use requires a reviewed .secrets.baseline: generate it with '
      + '`uv run --locked detect-secrets scan > .secrets.baseline`, audit it, and never '
      + 'overwrite it with `>` again (`--baseline` updates it in place).',
    )
    return {
      relPath: SECRET_HELPER_PATH,
      payload: renderSecretScanScript(),
      mode: 'whole',
      notes,
      unpinnedRevs: [],
    }
  }

  if (target === 'container-report') {
    const limit = resolved.imageMaxSizeMb.value
    notes.push(
      limit === null || limit === undefined
        ? 'No [tool.gatekeeper.image] max_size_mb configured: the report never fails.'
        : 'Fails only when the image exceeds ' + String(limit) + ' MB.',
    )
    return {
      relPath: CONTAINER_REPORT_PATH,
      payload: renderContainerReportScript({ imageMaxSizeMb: limit }),
      mode: 'whole',
      notes,
      unpinnedRevs: [],
    }
  }

  return { error: 'unknown target: ' + String(target) }
}

/** The text the caller reads. */
export function formatApply(result) {
  if (result.blocked === true) {
    return ['BLOCKED: nothing was written.', '', result.reason, '', 'root: ' + result.root].join('\n')
  }
  const head = result.dryRun === true
    ? '# py-apply — DRY RUN, nothing was written (' + result.root + ')'
    : '# py-apply — wrote ' + result.files.filter((file) => file.wrote === true).length
      + ' of ' + result.files.length + ' file(s) (' + result.root + ')'
  const lines = [head, '']
  for (const file of result.files) {
    const mark = {
      create: 'CREATE',
      append: 'APPEND',
      update: 'UPDATE',
      diff: 'DIFF  ',
      unchanged: 'SAME  ',
      conflict: 'STOP  ',
      refused: 'STOP  ',
      skipped: 'SKIP  ',
    }[file.status] ?? file.status.toUpperCase()
    lines.push('[' + mark + '] ' + file.file)
    if (file.status === 'create' && result.dryRun === true) {
      const body = String(file.preview ?? '').split(/\r?\n/)
      lines.push('  would write ' + body.length + ' line(s):')
      for (const line of body.slice(0, 40)) lines.push('  | ' + line)
      if (body.length > 40) lines.push('  | … ' + (body.length - 40) + ' more line(s)')
    }
    if (file.added?.length > 0) lines.push('  appends: ' + file.added.join(', '))
    if (file.replaced?.length > 0) {
      lines.push(
        '  REPLACED (stale generator-owned table): ' + file.replaced.join(', ') +
        ' — the table this plugin wrote earlier disagreed with the current proposal. ' +
        'The previous file is in the .bak backup next to it.',
      )
    }
    if (file.skipped?.length > 0) {
      lines.push('  already present, left untouched: ' + file.skipped.join(', '))
    }
    // `null` is the normal value for a file with nothing to show (unchanged, or a
    // refusal from planning); only a real diff object gets rendered.
    if (file.diff !== undefined && file.diff !== null) {
      lines.push('  diff: +' + file.diff.addedLines + ' / -' + file.diff.removedLines)
      for (const line of file.diff.sample) lines.push('  ' + line)
      if (file.diff.changedPointers !== undefined && file.diff.changedPointers > file.diff.sample.length) {
        lines.push('  … ' + (file.diff.changedPointers - file.diff.sample.length) + ' more changed pointer(s)')
      }
    }
    if (file.status === 'diff') {
      lines.push(
        '  NOT WRITTEN: the manifest already exists and is evidence, so this run reports the ' +
        'change instead of overwriting it. Review the pointers above, then update the version/' +
        'sha256 pairs by hand — `overwrite: true` deliberately does not apply here.',
      )
    }
    if (file.backup !== null && file.backup !== undefined) lines.push('  backup: ' + file.backup)
    if (file.reason !== undefined && file.reason !== null) lines.push('  reason: ' + file.reason)
    for (const note of file.notes ?? []) lines.push('  note: ' + note)
  }
  if (result.conflicts > 0) {
    lines.push('')
    lines.push(
      result.conflicts + ' file(s) already exist with different content and were NOT written. ' +
      'Re-run with overwrite=true after reading the diffs above, or edit them by hand — ' +
      'an overwrite discards whatever the existing file said.',
    )
  }
  const planned = result.files.some((file) => (
    file.status === 'create' || file.status === 'append' || file.status === 'update' || file.status === 'diff'
  ))
  if (planned && result.nextSteps?.length > 0) {
    lines.push('')
    const pyprojectWritten = result.files.some((file) => file.target === 'pyproject')
    lines.push(pyprojectWritten
      ? 'Next, before anyone runs `uv sync --frozen`:'
      : 'Next:')
    for (const step of result.nextSteps) lines.push('  ' + step)
  }
  if (result.dryRun === true) {
    lines.push('')
    lines.push('Nothing was written. Re-run with dryRun=false to apply exactly the plan above.')
  }
  if (result.unpinnedRevs?.length > 0) {
    lines.push('')
    lines.push('Replace these placeholders before the first hook run:')
    for (const entry of result.unpinnedRevs) lines.push('  ' + entry.repo + '  ' + entry.url)
  }
  if (result.warnings?.length > 0) {
    lines.push('')
    lines.push('--- notes ---')
    for (const warning of result.warnings) lines.push('- ' + warning)
  }
  return lines.join('\n')
}

/** The tool definition. */
export function createPyApplyTool({ config }) {
  return {
    name: 'py-apply',
    description:
      'Write the configuration this plugin generates to disk — the write half of py-bootstrap / ' +
      'py-prek / py-dependabot / py-ci-render / py-ci-run / py-manifest, which only print. Writes ' +
      'at most nine fixed targets: pyproject.toml (merged table by table: missing tables are ' +
      'appended, tables this plugin owns — ruff, pytest, coverage, ty — are refreshed when they ' +
      'disagree, and every other table is never touched), .pre-commit-config.yaml, ' +
      '.github/dependabot.yml, .github/workflows/<name>.yml, scripts/ci.py, ' +
      'scripts/validate_version_manifest.py, scripts/secret_scan.py, scripts/container_report.py, ' +
      'and release/agent_versions.json. The manifest is the exception: it is created once and ' +
      'afterwards only diffed against what the probe sees today — never overwritten, even with ' +
      '`overwrite: true`. Defaults to `dryRun: true`, which returns the full plan plus a diff per ' +
      'changed file and touches nothing; pass `dryRun: false` to execute it. An existing file with ' +
      'different content comes back as a conflict and is left alone unless `overwrite: true`. ' +
      'Every write is preceded by a `.bak.<timestamp>` backup. REFUSES with blocked=true when the ' +
      'project has a poetry.lock, pdm.lock or Pipfile.lock.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Project directory. Defaults to the calling session\'s working directory.',
        },
        targets: {
          type: 'array',
          items: { type: 'string', enum: APPLY_TARGETS },
          description:
            'Which files to write. Known: ' + TARGET_SUMMARY.map((entry) => entry.id).join(', ') +
            '. Defaults to all of them except `workflow` (a workflow is a decision about this ' +
            'repository\'s CI, not a default).',
        },
        dryRun: {
          type: 'boolean',
          description:
            'Default true: build the plan and write nothing. Pass false to actually write.',
        },
        overwrite: {
          type: 'boolean',
          description:
            'Write a file that already exists with different content. Default false: such a file ' +
            'comes back as a conflict with a diff. pyproject.toml is never replaced wholesale, and ' +
            'release/agent_versions.json is never replaced at all (an existing manifest is only ' +
            'diffed).',
        },
        pythonVersion: {
          type: 'string',
          description: 'Python version for the pyproject target and the hook environments. Defaults to the detected one.',
        },
        testPaths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'pytest testpaths for the pyproject target. Defaults to the directories detection found ' +
            '(a `testpaths` pointing at a directory that does not exist makes pytest collect nothing ' +
            'and coverage report 0%). A comma-separated string is also accepted.',
        },
        pythonVersions: {
          type: 'string',
          description: 'Comma-separated versions for the workflow matrix, e.g. "3.11,3.12,3.13".',
        },
        stages: {
          type: 'string',
          description:
            'Comma-separated stage ids for the workflow and ci-script targets, or "all". Known: ' +
            knownStages().join(', ') + '. Defaults to this plugin\'s settings.',
        },
        fileName: {
          type: 'string',
          description: 'Workflow file name for the `workflow` target. Defaults to "<project>.yml".',
        },
        lockMode: {
          type: 'string',
          enum: ['frozen', 'locked'],
          description:
            '"frozen" (default) installs exactly what uv.lock pins; "locked" also fails when the ' +
            'lockfile is stale. Use "locked" when the repository already relies on it.',
        },
        uvVersion: {
          type: 'string',
          description:
            'uv version to record in the manifest (`runtime.uv`). Optional: without it the manifest ' +
            'says "unknown" rather than a guessed number, because this tool runs no subprocesses.',
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
          files: { type: 'array', items: { type: 'object', additionalProperties: true } },
          conflicts: { type: 'number' },
          unpinnedRevs: { type: 'array', items: { type: 'object', additionalProperties: true } },
          warnings: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const requested = typeof args?.path === 'string' ? args.path.trim() : ''
      const { root, refused } = projectRootFor(exec, requested)
      if (refused !== null) {
        // `path: ".."` would otherwise move the write root to a sibling or the
        // drive root. The refusal happens before detection, so nothing is planned
        // and nothing is touched.
        const refusal = {
          blocked: true,
          reason: 'Nothing was written: ' + refused + '.',
          root: root ?? '',
          dryRun: true,
          files: [],
          conflicts: 0,
          unpinnedRevs: [],
          warnings: [],
          nextSteps: [],
          summary: '',
        }
        refusal.summary = formatApply(refusal)
        return refusal
      }
      if (typeof root !== 'string' || root === '') {
        throw new Error('py-apply: this session has no working directory and no path was given.')
      }
      const detection = await detect(root)
      const resolvedRoot = detection.root ?? root

      const blockedReason = applyRefusal(detection)
      if (blockedReason !== null) {
        const refusal = { blocked: true, reason: blockedReason, root: resolvedRoot, dryRun: true, files: [], summary: '' }
        refusal.summary = formatApply(refusal)
        return refusal
      }

      // One resolution for every target: the pyproject block, the hook
      // environments, the workflow matrix, the manifest's runtime section and the
      // container limit all read the same `{value, source}` pairs, so a project
      // that pins its version in one place cannot come out inconsistent in another.
      let resolved
      try {
        resolved = resolveProject({ rootDir: resolvedRoot, detection })
      } catch (error) {
        // A resolver failure must not be reported as "nothing to do": the plan was
        // never built, and silence would look like success.
        const refusal = {
          blocked: true,
          reason: 'Nothing was written: resolveProject failed for ' + resolvedRoot + ': '
            + (error instanceof Error ? error.message : String(error)) + '.',
          root: resolvedRoot,
          dryRun: true,
          files: [],
          summary: '',
        }
        refusal.summary = formatApply(refusal)
        return refusal
      }

      // The dry-run default is the point of this tool: forgetting the flag must
      // leave the project unchanged, not half-written.
      const dryRun = args?.dryRun !== false
      const overwrite = args?.overwrite === true
      // An explicit empty list means "write nothing", which is different from
      // "the caller said nothing and gets the default targets". Collapsing the
      // two would turn an explicit opt-out into eight files on disk.
      const gaveTargets = Array.isArray(args?.targets)
      const wanted = gaveTargets
        ? args.targets.filter((entry) => isApplyTarget(entry))
        : APPLY_TARGETS.filter((entry) => entry !== 'workflow')

      const warnings = []
      if (gaveTargets && wanted.length !== args.targets.length) {
        const dropped = args.targets.filter((entry) => !isApplyTarget(entry))
        warnings.push('Ignored unknown target(s): ' + dropped.join(', ') + '. Known: ' + APPLY_TARGETS.join(', ') + '.')
      }
      if (gaveTargets && wanted.length === 0) {
        warnings.push('No known target was named, so nothing will be written. Known: ' + APPLY_TARGETS.join(', ') + '.')
      }
      if (wanted.includes('workflow')) {
        const requestedStages = typeof args?.stages === 'string' ? args.stages.trim().toLowerCase() : ''
        // Match resolved stage ids, not arbitrary substrings: "containers" and
        // "deployment" are typos, and a typo must not silence the warning that
        // the CD half is opt-in.
        const namedStages = requestedStages
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry !== '')
        const mentioned = namedStages.some((entry) => OPT_IN_STAGES.includes(entry))
        if (!mentioned) {
          warnings.push(
            'No CD stage was named: the workflow gets the default quality gates only. The CD half ' +
            '(' + OPT_IN_STAGES.join(', ') + ') must be named explicitly — a release or deploy job ' +
            'that appears by default is one nobody reviewed.',
          )
        }
      }

      const files = []
      const allUnpinned = []
      for (const target of wanted) {
        const built = buildPayload({ target, detection, root: resolvedRoot, args, config, resolved })
        if (built.error !== undefined) {
          // Same shape as a planned entry, so a reader never has to know which
          // branch produced the row.
          files.push({
            target,
            file: built.relPath ?? targetRelPath(target) ?? target,
            status: 'refused',
            added: [],
            skipped: [],
            diff: null,
            notes: [],
            backup: null,
            reason: built.error,
            wrote: false,
          })
          continue
        }
        const plan = await planWrite({
          target,
          root: resolvedRoot,
          relPath: built.relPath,
          payload: built.payload,
          overwrite,
          mode: built.mode,
        })
        const entry = {
          target,
          file: plan.file,
          status: plan.status,
          added: plan.added ?? [],
          replaced: plan.replaced ?? [],
          skipped: plan.skipped ?? [],
          diff: plan.diff ?? null,
          notes: built.notes ?? [],
          backup: null,
          reason: plan.reason ?? null,
          wrote: false,
        }
        if (plan.status === 'create') {
          // Only the create case needs the whole body: the other statuses carry a
          // diff, and dumping a full file for a conflict would bury the diff.
          entry.preview = built.payload
        }
        if ((built.unpinnedRevs ?? []).length > 0) {
          for (const rev of built.unpinnedRevs) allUnpinned.push(rev)
        }
        // `diff` is deliberately not a writable status: a manifest that already
        // exists is reported, never replaced.
        if (dryRun === false && (plan.status === 'create' || plan.status === 'append' || plan.status === 'update')) {
          try {
            const outcome = await commitWrite(plan)
            entry.wrote = outcome.wrote
            entry.backup = outcome.backup
          } catch (error) {
            entry.status = 'refused'
            entry.reason = 'write failed: ' + (error instanceof Error ? error.message : String(error))
          }
        }
        files.push(entry)
      }

      // A stage id the caller misspelled is dropped per file, but that note lives
      // inside one row of a nine-row plan. Lift it to the top level so a typo is
      // visible without reading every row.
      const stageNotes = new Set()
      for (const file of files) {
        for (const note of file.notes ?? []) {
          if (typeof note === 'string' && note.startsWith('Ignored unknown stage(s)')) stageNotes.add(note)
        }
      }
      for (const note of stageNotes) {
        if (!warnings.includes(note)) warnings.push(note)
      }

      const byTarget = new Map(files.map((file) => [file.target, file]))
      const nextSteps = []
      if (byTarget.has('pyproject')) {
        // The dependency group is created by `uv add`, never by this writer; the
        // command is part of the result so a caller cannot apply the pyproject
        // block and forget that `uv.lock` still has to move with it.
        nextSteps.push(
          devGroupCommand({ includeSecurity: config.includeSecurityGate !== false }),
          'uv lock',
          'uv sync --frozen',
        )
        // `[tool.uv.sources]` is the half a generator cannot decide: the members
        // are known, but which of them the root imports is a dependency edge, and
        // a wrong edge breaks `uv lock` in a way that looks like a version bug.
        const members = workspaceMemberNames(resolvedRoot, detection)
        if (members.length > 0) {
          nextSteps.push(
            'If the root depends on a workspace sibling, add it to [tool.uv.sources] in pyproject.toml: '
            + 'the commented `{ workspace = true }` lines name ' + members.join(', ')
            + ' but are templates, not detected dependencies.',
          )
        }
      }
      if (byTarget.has('prek')) {
        nextSteps.push(...prekNextSteps({ includeSecurity: config.includeSecurityGate !== false }))
      }
      if (byTarget.has('secret-scan') && !byTarget.has('prek')) {
        nextSteps.push(
          'Create and audit .secrets.baseline once: `uv run --locked detect-secrets scan > .secrets.baseline`, '
          + 'then `uv run --locked detect-secrets audit .secrets.baseline`; afterwards never overwrite it with '
          + '`>` — use --baseline to update it in place.',
        )
      }
      if (byTarget.has('manifest') || byTarget.has('validator')) {
        nextSteps.push(
          'Run the manifest gate as a check, not a generator: `uv run --locked python '
          + VALIDATOR_PATH + '`；file changes are a human decision (update version + sha256 there).',
        )
      }
      if (byTarget.has('ci-script')) {
        nextSteps.push('Inspect the plan before running it: `uv run --locked python ' + CI_SCRIPT_PATH + ' --list`.')
      }
      if (byTarget.has('container-report')) {
        nextSteps.push(
          'Container report: `uv run --locked python ' + CONTAINER_REPORT_PATH + '` — it only fails when '
          + '[tool.gatekeeper.image] max_size_mb is configured and the image exceeds it.',
        )
      }

      const result = {
        blocked: false,
        root: resolvedRoot,
        dryRun,
        overwrite,
        files,
        nextSteps,
        conflicts: files.filter((file) => file.status === 'conflict').length,
        // Deduplicated: four files that each list the same placeholder would
        // otherwise repeat it four times in the trailer.
        unpinnedRevs: allUnpinned.filter((entry, index) => (
          allUnpinned.findIndex((other) => other.repo === entry.repo) === index
        )),
        warnings,
        resolved: resolved,
      }
      result.summary = formatApply(result)
      return result
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args?.dryRun === false
        ? '把工具链配置写入项目'
        : '预览要写入的项目文件',
    }),
  }
}

/** The directory `scripts/ci.py` belongs in, for callers that need to say so. */
export const CI_SCRIPT_DIR = path.posix.dirname(CI_SCRIPT_PATH)
