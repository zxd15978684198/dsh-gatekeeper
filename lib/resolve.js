/**
 * What the gates should run with, and where each value came from.
 *
 * The plan's rule is a precedence order: the project's own configuration wins
 * (`existing`), then what probing the project found (`detected`), then the
 * plugin's default (`default`). The second half of the rule is what makes the
 * order trustworthy — every value carries its source, so a dry run can print
 * `ruff.line-length=88 (default)` instead of presenting a guess as the project's
 * decision (V0.10-PLAN.md §5).
 *
 * This module is synchronous on purpose. Its callers are dry-run printers and
 * generators that need the values before rendering anything; turning all of them
 * async to await one pyproject read would buy nothing. That is also why
 * `detect.js` exposes a synchronous `readPyprojectTables`.
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { collectRequirements, readPyprojectTables } from './detect.js'
import { isConcreteVersion, minimumOfSpecifier, normalizeVersion } from './python-version.js'

/** The plugin defaults, in one place, so `default` always means these numbers. */
export const RESOLVE_DEFAULTS = Object.freeze({
  pythonVersion: '3.13',
  ruffLineLength: 88,
  ruffSelect: Object.freeze(['E', 'F', 'I', 'B', 'UP']),
  ruffIgnore: Object.freeze([]),
  typeChecker: 'mypy',
  // `typePaths` has no default on purpose. A project without a source tree must
  // resolve to `[]` so the type gate can skip visibly; defaulting to `src` made
  // an empty `uv init` project fail with `mypy: cannot read file 'src'` (P0-2).
  typePaths: Object.freeze([]),
  testPaths: Object.freeze(['tests']),
  buildMode: 'package',
  // Chapter 8's template fills a missing floor with 90 for a new project. An
  // existing project gets the conservative 80, because a floor above its current
  // coverage turns a green gate red on the first run (V0.10-PLAN.md §12).
  coverageFloorNewProject: 90,
  coverageFloorExistingProject: 80,
})

/**
 * Paths the v0.10 generators always write to.
 *
 * The interface fixes them (V0.10-DAG.md §3.3/3.4/3.8) and they are repeated here
 * rather than imported from `manifest.js`/`secret-scan.js`: those are separate P1
 * nodes that run in parallel, and a value this module reports must not depend on
 * another module's load order.
 */
export const PROJECT_PATHS = Object.freeze({
  manifest: 'release/agent_versions.json',
  validator: 'scripts/validate_version_manifest.py',
  secretHelper: 'scripts/secret_scan.py',
  containerReport: 'scripts/container_report.py',
})

/**
 * The component ids a release manifest may carry, in the order
 * `release/agent_versions.json` documents them (V0.10-DAG.md §3.3). Probing fills
 * only the ids the project actually has; the order keeps two runs stable.
 */
const COMPONENT_IDS = Object.freeze([
  'prompt',
  'chat_model',
  'skills',
  'tools',
  'harness',
  'embedding',
  'knowledge_base',
  'index',
  'evaluation',
])

/** Per-component file cap: a probe should not cost more because a corpus is large. */
const MAX_COMPONENT_FILES = 20

/** Files above this size are listed but not hashed; the digest is a generation-time convenience. */
const MAX_HASH_BYTES = 8 * 1024 * 1024

/** How many filesystem entries one glob segment may match before expansion stops. */
const MAX_GLOB_MATCHES = 200

const TEST_DIR_NAMES = Object.freeze(['tests', 'test', 'testing'])

/** Top-level directories that are not source packages, used only to narrow flat-layout probing. */
const NON_SOURCE_DIRS = new Set([
  'tests', 'test', 'testing', 'scripts', 'docs', 'build', 'dist', 'release', 'packages',
  '.git', '.venv', '.github', '.ruff_cache', '.idea', '.mypy_cache', '.pytest_cache', '__pycache__', 'src',
])

/**
 * The name each resolved key is shown under in a dry run.
 *
 * It is the configuration path a reader already knows (`ruff.line-length`), not
 * the camelCase key: the point of the dry run is that a person can match a line
 * to the file it would be written into.
 */
const DISPLAY_NAMES = Object.freeze([
  ['pythonVersion', 'python.version'],
  ['requiresPython', 'project.requires-python'],
  ['testPaths', 'pytest.testpaths'],
  ['hasTests', 'pytest.has_tests'],
  ['hasIntegrationTests', 'pytest.has_integration_tests'],
  ['coverageFloor', 'coverage.fail_under'],
  ['ruffLineLength', 'ruff.line-length'],
  ['ruffSelect', 'ruff.lint.select'],
  ['ruffIgnore', 'ruff.lint.ignore'],
  ['typeChecker', 'type.checker'],
  ['typePaths', 'type.paths'],
  ['buildMode', 'build.mode'],
  ['workspaceMembers', 'workspace.members'],
  ['manifestComponents', 'manifest.components'],
  ['manifestPath', 'manifest.path'],
  ['validatorPath', 'manifest.validator'],
  ['secretBaseline', 'secrets.baseline'],
  ['secretHelperPath', 'secrets.helper'],
  ['containerReportPath', 'container.report'],
  ['imageMaxSizeMb', 'container.image.max_size_mb'],
])

/**
 * Resolve every project-wide gate value, each with the source it came from.
 *
 * `detection` is optional and may be a promise: callers that already ran
 * `detect()` pass the result, callers that only need the values let this module
 * read what it needs itself. A promise is treated as "nothing was passed"
 * rather than awaited, because this function is synchronous and guessing a
 * pending value is worse than reading the same files again.
 *
 * @param options - `{ rootDir, detection }`.
 * @returns a flat object of `{ value, source }` entries, one per gate value
 *   (V0.10-DAG.md §3.2).
 */
export function resolveProject(options = {}) {
  const root = path.resolve(String(options?.rootDir ?? ''))
  const detection = usableDetection(options?.detection)
  const pyproject = readPyprojectTables(root)
  const tables = pyproject.tables
  const project = tableOf(tables, 'project')
  const requirementNames = collectRequirements(tables)

  const pythonVersion = resolvePythonVersion(root, project, detection)
  const requiresPython = resolveRequiresPython(project, detection, pythonVersion)
  const testPaths = resolveTestPaths(root, tables, detection)
  const coverageFloor = resolveCoverageFloor(tables, looksEstablished(root, tables, detection))
  const ruffLineLength = resolveRuffLineLength(tables)
  const ruffSelect = resolveRuffList(tables, 'select', RESOLVE_DEFAULTS.ruffSelect)
  const ruffIgnore = resolveRuffList(tables, 'ignore', RESOLVE_DEFAULTS.ruffIgnore)
  const typeChecker = resolveTypeChecker(root, tables, detection, requirementNames)
  const workspaceMembers = resolveWorkspaceMembers(root, tables, detection)
  const typePaths = resolveTypePaths(root, tables, workspaceMembers.value)
  // Derived, not configured: a project cannot declare "I have tests" in a table,
  // but an empty `tests/` directory is still enough to make `pytest` fail.
  const hasTests = resolveHasTests(root, testPaths.value)
  // Derived from the mark, not from configuration: the optional integration stage
  // is advertised only when the project actually has a marked test to run.
  const hasIntegrationTests = resolveHasIntegrationTests(root, testPaths.value)
  const isWorkspace = detectWorkspace(tables, detection)

  return {
    pythonVersion,
    requiresPython,
    testPaths,
    hasTests,
    hasIntegrationTests,
    coverageFloor,
    ruffLineLength,
    ruffSelect,
    ruffIgnore,
    typeChecker,
    typePaths,
    // A workspace root builds every member (`uv build --all-packages`); a project
    // builds itself. Detected rather than defaulted because `pyproject.toml`'s
    // own `[tool.uv.workspace]` table is the evidence.
    buildMode: isWorkspace ? entry('all-packages', 'detected') : entry(RESOLVE_DEFAULTS.buildMode, 'default'),
    workspaceMembers,
    manifestComponents: entry(resolveManifestComponents(root), 'detected'),
    manifestPath: conventionPath(root, PROJECT_PATHS.manifest),
    validatorPath: conventionPath(root, PROJECT_PATHS.validator),
    secretBaseline: resolveSecretBaseline(root, detection),
    secretHelperPath: conventionPath(root, PROJECT_PATHS.secretHelper),
    containerReportPath: conventionPath(root, PROJECT_PATHS.containerReport),
    imageMaxSizeMb: resolveImageLimit(tables, detection),
  }
}

/**
 * Render a resolved object as dry-run lines: `ruff.line-length=88 (default)`.
 *
 * Keys this table does not know still get a line, with their key as the name: a
 * resolver that grows a value must not have that value vanish from the dry run
 * just because the display table predates it.
 *
 * @param resolved - the object {@link resolveProject} returned.
 * @returns an array of `name=value (source)` strings.
 */
export function describeResolved(resolved) {
  if (!isPlainObject(resolved)) return []
  const lines = []
  const described = new Set()
  for (const [key, name] of DISPLAY_NAMES) {
    if (!(key in resolved)) continue
    described.add(key)
    lines.push(name + '=' + renderValue(valueOf(resolved[key])) + ' (' + renderSource(resolved[key]) + ')')
  }
  for (const [key, value] of Object.entries(resolved)) {
    if (described.has(key)) continue
    lines.push(key + '=' + renderValue(valueOf(value)) + ' (' + renderSource(value) + ')')
  }
  return lines
}

/** One resolved value. */
function entry(value, source) {
  return { value, source }
}

/** A detection result, or `{}` when the caller passed nothing usable (including a promise). */
function usableDetection(detection) {
  if (!isPlainObject(detection)) return {}
  if (typeof detection.then === 'function') return {}
  return detection
}

// --------------------------------------------------------------- python target
//
// `.python-version` is what uv and pyenv actually read, so it outranks
// `requires-python`: a project can declare `>=3.11` and still pin 3.13. Both are
// the project's own statement, so both are `existing`; the source is not a guess,
// it is a file the project already carries.
function resolvePythonVersion(root, project, detection) {
  const declared = asString(project?.['requires-python'])
  const pinnedText = readFileText(path.join(root, '.python-version'))
  const pinned = pinnedText === null ? null : firstMeaningfulLine(pinnedText)
  const pinnedVersion = isConcreteVersion(pinned) ? normalizeVersion(pinned) : null
  const declaredVersion = minimumOfSpecifier(declared ?? asString(detection.requiresPython))
  // `detect()` has already ranked these two; reuse its answer when it has one so
  // the two modules cannot disagree about the same project.
  const detectedVersion = isConcreteVersion(detection.pythonVersion) ? normalizeVersion(detection.pythonVersion) : null
  const version = detectedVersion ?? pinnedVersion ?? declaredVersion
  return version === null ? entry(RESOLVE_DEFAULTS.pythonVersion, 'default') : entry(version, 'existing')
}

function resolveRequiresPython(project, detection, pythonVersion) {
  const declared = asString(project?.['requires-python']) ?? asString(detection.requiresPython)
  if (declared !== null) return entry(declared, 'existing')
  // No declaration, but a version was pinned: a `>=` on that version is the
  // specifier the project's own files imply, not a plugin opinion.
  if (pythonVersion.source !== 'default') return entry('>=' + pythonVersion.value, 'detected')
  return entry('>=' + RESOLVE_DEFAULTS.pythonVersion, 'default')
}

// ------------------------------------------------------------------- test layout
function resolveTestPaths(root, tables, detection) {
  const configured = asStringArray(tableOf(tables, 'tool.pytest.ini_options')?.testpaths)
  if (configured.length > 0) return entry(configured, 'existing')
  const detected = asStringArray(detection.markers?.testDirs)
  if (detected.length > 0) return entry(detected, 'detected')
  const probed = probeTestDirs(root)
  return probed.length > 0 ? entry(probed, 'detected') : entry([...RESOLVE_DEFAULTS.testPaths], 'default')
}

/**
 * Whether the gate has tests to run at all.
 *
 * The gate must skip `pytest` on a project whose tests directory is missing or
 * empty: the pipeline is written for a project with tests, and `pytest tests` on
 * a bare `uv init` tree fails instead of saying "nothing to check". Derived from
 * the resolved test paths plus the conventional names, and true only when the
 * directory carries at least one `.py` file (one level of nesting, the depth a
 * normal `tests/unit/` layout uses).
 */
function resolveHasTests(root, testPaths) {
  for (const candidate of [...asStringArray(testPaths), ...TEST_DIR_NAMES]) {
    const relative = trimSlashes(candidate)
    if (relative === '') continue
    if (listFiles(root, relative, { depth: 2, match: /\.py$/i }).length > 0) return entry(true, 'detected')
  }
  return entry(false, 'detected')
}

/**
 * Whether the gate has integration tests, which decide if the optional
 * `integration` stage is meaningful for this project.
 *
 * Pytest marks leave no filesystem trace (no `integration/` directory is
 * required — the marker is applied to ordinary test functions), so the only
 * honest evidence is the mark itself in the test source: `pytest.mark.integration`
 * or the bare `mark.integration` form. Like `hasTests` this is derived, so it is
 * always `detected` and never overrides a project's own configuration.
 */
function resolveHasIntegrationTests(root, testPaths) {
  for (const candidate of [...asStringArray(testPaths), ...TEST_DIR_NAMES]) {
    const relative = trimSlashes(candidate)
    if (relative === '') continue
    for (const file of listFiles(root, relative, { depth: 2, match: /\.py$/i })) {
      const text = readFileText(path.join(root, file))
      if (text !== null && /(?:pytest\.)?mark\.integration\b/.test(text)) return entry(true, 'detected')
    }
  }
  return entry(false, 'detected')
}

/** The test directories a project actually has: `tests/`, `test/`, `src/<pkg>/tests/`. */
function probeTestDirs(root) {
  const found = []
  for (const name of TEST_DIR_NAMES) {
    if (isDirectory(path.join(root, name))) found.push(name)
  }
  const srcDir = path.join(root, 'src')
  if (isDirectory(srcDir)) {
    // One package level only: a deeper sweep would make detection cost track
    // repository size.
    for (const child of readDirSafe(srcDir)) {
      if (!child.isDirectory()) continue
      for (const name of TEST_DIR_NAMES) {
        if (isDirectory(path.join(srcDir, child.name, name))) found.push('src/' + child.name + '/' + name)
      }
    }
  }
  return [...new Set(found)]
}

// -------------------------------------------------------------------- coverage
function resolveCoverageFloor(tables, established) {
  const report = tableOf(tables, 'tool.coverage.report')
  const failUnder = asNumber(report?.fail_under ?? report?.['fail-under'])
  if (failUnder !== null) return entry(failUnder, 'existing')
  // Older templates carried the floor in pytest's addopts. It is the same
  // decision written elsewhere, so it counts as existing configuration instead of
  // being overwritten by a default.
  const addopts = asString(tableOf(tables, 'tool.pytest.ini_options')?.addopts)
  const inAddopts = addopts === null ? null : /--cov-fail-under[=\s]+(\d+(?:\.\d+)?)/.exec(addopts)
  if (inAddopts !== null) return entry(Number(inAddopts[1]), 'existing')
  const assumed = established ? RESOLVE_DEFAULTS.coverageFloorExistingProject : RESOLVE_DEFAULTS.coverageFloorNewProject
  return entry(assumed, 'default')
}

/**
 * Whether this project already has a toolchain, which decides whether a missing
 * coverage floor is filled with 90 (new project) or 80 (existing project).
 *
 * Tool tables are the clearest evidence; code and tests on disk are the fallback
 * for a project that has them without pyproject configuration yet. A bare
 * `uv init` project has neither, which is exactly the case chapter 8 writes 90
 * for.
 */
function looksEstablished(root, tables, detection) {
  if (Object.keys(tables).some((name) => name.startsWith('tool.') || name === 'dependency-groups')) return true
  if (isPlainObject(detection.linters) && Object.values(detection.linters).some((enabled) => enabled === true)) return true
  if (detection.markers?.srcDir === true || asStringArray(detection.markers?.testDirs).length > 0) return true
  return isDirectory(path.join(root, 'src')) || probeTestDirs(root).length > 0
}

// ------------------------------------------------------------------------ ruff
function resolveRuffLineLength(tables) {
  const configured = asNumber(tableOf(tables, 'tool.ruff')?.['line-length'])
  return configured === null ? entry(RESOLVE_DEFAULTS.ruffLineLength, 'default') : entry(configured, 'existing')
}

/**
 * A ruff list value (`select`, `ignore`).
 *
 * `[tool.ruff.lint]` is the current location; `[tool.ruff]` carried the same keys
 * before ruff split the lint table out, and a project that has not migrated is
 * still configured.
 */
function resolveRuffList(tables, key, fallback) {
  const lint = tableOf(tables, 'tool.ruff.lint')
  const rootRuff = tableOf(tables, 'tool.ruff')
  const fromLint = asStringArray(lint?.[key])
  const fromRoot = asStringArray(rootRuff?.[key])
  const configured = fromLint.length > 0 ? fromLint : fromRoot
  return configured.length > 0 ? entry(configured, 'existing') : entry([...fallback], 'default')
}

// --------------------------------------------------------------- type checker
/**
 * mypy or ty, with the project's explicit configuration outranking a dependency.
 *
 * A table is the project saying "this is my type checker". A requirement can be
 * transitive or a leftover from a migration, so it only decides when neither
 * checker is configured. When both are configured, mypy wins: the chapter-8
 * pipeline runs mypy and V0.10-PLAN.md §5 lists it first, so the value that
 * changes is the one with the least evidence behind it.
 */
function resolveTypeChecker(root, tables, detection, requirementNames) {
  const mypyTable = hasTableFamilyIn(tables, 'tool.mypy')
    || isFile(path.join(root, 'mypy.ini'))
    || detection.mypy?.hasConfigTable === true
  const tyTable = hasTableFamilyIn(tables, 'tool.ty') || detection.linters?.ty === true
  const mypyDependency = requirementNames.includes('mypy') || detection.mypy?.configured === true
  const tyDependency = requirementNames.includes('ty')
  if (mypyTable && !tyTable) return entry('mypy', 'existing')
  if (tyTable && !mypyTable) return entry('ty', 'existing')
  if (tyDependency && !mypyDependency) return entry('ty', 'existing')
  if (mypyDependency) return entry('mypy', 'existing')
  return entry(RESOLVE_DEFAULTS.typeChecker, 'default')
}

/**
 * Where the type checker should look.
 *
 * Every candidate is probed on disk before it becomes a value: the gate runs
 * `mypy <paths>` (or `ty check <paths>`), and a path that is not there fails the
 * gate with `cannot read file`, which reads as a project defect when it is really
 * an empty layout (P0-2). When nothing exists the answer is `[]` with
 * `source: detected`, so the IR can skip the stage visibly instead of pretending
 * a default `src` exists.
 *
 * Precedence follows "the project's own configuration is a statement about
 * itself": paths named in `[tool.mypy].files` or `[tool.ty]` win, then the `src/`
 * layout (root plus workspace/member packages), then a flat layout whose
 * top-level package directory carries `__init__.py`.
 */
function resolveTypePaths(root, tables, workspaceMembers) {
  const configured = existingPaths(root, configuredTypePaths(tables))
  if (configured.length > 0) return entry(configured, 'existing')

  const found = []
  if (isDirectory(path.join(root, 'src'))) found.push('src')
  for (const member of memberSourceDirs(root, workspaceMembers)) found.push(member + '/src')
  if (found.length > 0) return entry([...new Set(found)], 'detected')

  const packages = topLevelPackages(root)
  if (packages.length > 0) return entry(packages, 'detected')
  return entry([], 'detected')
}

/** Paths the project names for its type checker, wherever mypy or ty reads them. */
function configuredTypePaths(tables) {
  const mypy = tableOf(tables, 'tool.mypy')
  const tyRoot = tableOf(tables, 'tool.ty')
  const tySrc = tableOf(tables, 'tool.ty.src')
  return [
    ...asStringArray(mypy?.files),
    ...asStringArray(tySrc?.include ?? tySrc?.files),
    ...asStringArray(tyRoot?.include ?? tyRoot?.files),
  ]
}

/** Project-relative paths from a config list that exist as a file or a directory. */
function existingPaths(root, candidates) {
  const kept = []
  for (const candidate of candidates) {
    const relative = trimSlashes(candidate)
    if (relative === '') continue
    const absolute = path.join(root, relative)
    if (isDirectory(absolute) || isFile(absolute)) kept.push(relative)
  }
  return [...new Set(kept)]
}

/** Directories that may carry their own `src/`: declared members plus a plain `packages/*` layout. */
function memberSourceDirs(root, workspaceMembers) {
  const dirs = [...workspaceMembers]
  for (const child of readDirSafe(path.join(root, 'packages'))) {
    if (child.isDirectory()) dirs.push(joinRelative('packages', child.name))
  }
  return [...new Set(dirs)].filter((dir) => isDirectory(path.join(root, dir, 'src')))
}

/** Top-level directories that are importable packages, not tooling or test trees. */
function topLevelPackages(root) {
  return readDirSafe(root)
    .filter((child) => child.isDirectory())
    .map((child) => child.name)
    .filter((name) => !NON_SOURCE_DIRS.has(name.toLowerCase()))
    .filter((name) => isFile(path.join(root, name, '__init__.py')))
}

// ------------------------------------------------------------------- workspace
/** Whether the project is a uv workspace root. */
function detectWorkspace(tables, detection) {
  if (detection.workspace?.isWorkspace === true) return true
  if (tableOf(tables, 'tool.uv.workspace') !== null) return true
  const sources = tableOf(tables, 'tool.uv.sources')
  return sources !== null && Object.values(sources).some((value) => isPlainObject(value) && value.workspace === true)
}

/**
 * The workspace member directories, globs expanded.
 *
 * uv's `members` accepts globs, and a value a gate cannot name as a path is not a
 * value the gate can use, so a glob is expanded against the filesystem here.
 * `**` is not expanded recursively: uv workspaces in practice list one level of
 * globs, and a recursive walk would make detection cost track repository size.
 */
function resolveWorkspaceMembers(root, tables, detection) {
  const fromDetection = asStringArray(detection.workspace?.members)
  const declared = fromDetection.length > 0
    ? fromDetection
    : asStringArray(tableOf(tables, 'tool.uv.workspace')?.members)
  if (declared.length === 0) return entry([], 'default')
  const expanded = expandMembers(root, declared)
  // A member that is declared but missing on disk is still what the project says
  // its workspace is; dropping it would hide a stale configuration.
  return entry(expanded.length > 0 ? expanded : declared.map(trimSlashes), 'detected')
}

function expandMembers(root, declared) {
  const members = []
  for (const member of declared) {
    if (!/[*?]/.test(member)) {
      members.push(trimSlashes(member))
      continue
    }
    members.push(...expandGlob(root, member))
  }
  return [...new Set(members.filter((member) => member !== ''))].sort()
}

/** Expand one project-relative glob pattern to the directories that match it. */
function expandGlob(root, pattern) {
  let bases = ['']
  for (const segment of trimSlashes(pattern).split('/')) {
    if (segment === '' || segment === '.') continue
    if (!/[*?]/.test(segment)) {
      bases = bases.map((base) => joinRelative(base, segment))
      continue
    }
    const matcher = globSegmentMatcher(segment)
    const matched = []
    for (const base of bases) {
      for (const child of readDirSafe(path.join(root, base))) {
        if (child.isDirectory() && matcher.test(child.name)) matched.push(joinRelative(base, child.name))
      }
    }
    bases = matched.slice(0, MAX_GLOB_MATCHES)
  }
  return bases.filter((base) => base !== '' && isDirectory(path.join(root, base)))
}

function globSegmentMatcher(segment) {
  const escaped = escapeRegExp(segment).replace(/\\\*/g, '[^/]*').replace(/\\\?/g, '[^/]')
  return new RegExp('^' + escaped + '$')
}

// ---------------------------------------------------------- manifest components
/**
 * The version-manifest components this project actually has.
 *
 * The rule is to write only what exists (V0.10-PLAN.md §5): a manifest that
 * invents `prompts/supervisor.md` for a project without a prompt is worse than a
 * manifest with fewer entries, because the next tool will try to hash the file it
 * was told about. `embedding` is the one component with no artifact of its own —
 * it is declared inside the index manifest, so its entry carries no path.
 */
function resolveManifestComponents(root) {
  const byId = new Map()
  const add = (id, relative) => {
    const list = byId.get(id) ?? []
    if (list.length >= MAX_COMPONENT_FILES) return
    list.push(componentEntry(root, id, relative))
    byId.set(id, list)
  }
  // A prompt is a text artifact, so every prompt file is evidence of the
  // `prompt` component; the manifest records each by path and digest.
  for (const file of listFiles(root, 'prompts', { depth: 1, match: /\.md$/i })) add('prompt', file)
  // The knowledge corpus is the evidence of `knowledge_base`.
  for (const file of listFiles(root, 'knowledge', { depth: 2, match: /\.(md|txt|json|ya?ml)$/i })) add('knowledge_base', file)
  const indexManifest = firstExisting(root, ['index/index_manifest.json', 'index/manifest.json'])
  if (indexManifest !== null) add('index', indexManifest)
  const evaluation = firstExisting(root, ['eval/eval_cases.json'])
    ?? listFiles(root, 'eval', { depth: 1, match: /\.json$/i })[0]
    ?? null
  if (evaluation !== null) add('evaluation', evaluation)
  for (const file of listFiles(root, 'skills', { depth: 2, match: /(^|\/)SKILL\.md$/i })) add('skills', file)
  for (const file of listFiles(root, 'src', { depth: 3, match: /(^|\/)tools?\.py$/i })) add('tools', file)
  if (indexManifest !== null && declaresEmbedding(root, indexManifest)) {
    byId.set('embedding', [{ id: 'embedding', version: 'embedding-1.0.0' }])
  }
  return COMPONENT_IDS.filter((id) => byId.has(id)).flatMap((id) => byId.get(id))
}

/** One manifest component entry, with a digest when the file is small enough to hash. */
function componentEntry(root, id, relative) {
  const component = { id, path: relative, version: id + '-1.0.0' }
  const digest = sha256OfFile(path.join(root, relative))
  if (digest !== null) component.sha256 = digest
  return component
}

/** SHA-256 of a project file, or null when it cannot be read or is too large to hash. */
function sha256OfFile(filePath) {
  try {
    const info = statSync(filePath)
    if (!info.isFile() || info.size > MAX_HASH_BYTES) return null
    return createHash('sha256').update(readFileSync(filePath)).digest('hex')
  } catch {
    return null
  }
}

/** Whether the index manifest declares an embedding model. */
function declaresEmbedding(root, relative) {
  const text = readFileText(path.join(root, relative))
  if (text === null) return false
  try {
    const parsed = JSON.parse(text)
    return isPlainObject(parsed) && ('embedding_model' in parsed || 'embedding_dimension' in parsed)
  } catch {
    return false
  }
}

/**
 * Files under a project-relative directory, up to `depth` levels, sorted.
 *
 * `match` is tested against the project-relative path, which is also what ends up
 * in the resolved value: the value must name a path a later tool can open.
 */
function listFiles(root, relativeDir, options = {}) {
  const depth = options.depth ?? 1
  const match = options.match ?? null
  const found = []
  const walk = (relative, remaining) => {
    for (const child of readDirSafe(path.join(root, relative))) {
      const childRelative = joinRelative(relative, child.name)
      if (child.isDirectory()) {
        if (remaining > 1) walk(childRelative, remaining - 1)
        continue
      }
      if (!child.isFile()) continue
      if (match !== null && !match.test(childRelative)) continue
      found.push(childRelative)
    }
  }
  walk(relativeDir, depth)
  return found.sort()
}

// -------------------------------------------------------------------- artifacts
/**
 * Whether a project already carries a v0.10 artifact.
 *
 * The path is fixed by the interface, so the value is the path either way; the
 * source distinguishes "this project has it" from "the generator will create it",
 * which is what lets the panel report "3 of 7 artifacts present" without
 * inspecting the filesystem itself.
 */
function conventionPath(root, relative) {
  return isFile(path.join(root, relative)) ? entry(relative, 'existing') : entry(relative, 'default')
}

function resolveSecretBaseline(root, detection) {
  const present = detection.secrets?.baseline === true || isFile(path.join(root, '.secrets.baseline'))
  return present ? entry(true, 'existing') : entry(false, 'detected')
}

function resolveImageLimit(tables, detection) {
  const detected = asNumber(detection.container?.imageLimit)
  if (detected !== null && detected > 0) return entry(detected, 'existing')
  const imageTable = tableOf(tables, 'tool.gatekeeper.image')
  const configured = asNumber(imageTable?.['max_size_mb'] ?? imageTable?.['max-size-mb'])
  if (configured !== null && configured > 0) return entry(configured, 'existing')
  // No limit declared means no limit is enforced: the image check reports, it
  // does not block (V0.10-PLAN.md §16).
  return entry(null, 'default')
}

// ------------------------------------------------------------------- utilities
/** The value inside a resolved entry, tolerating a caller that stored it bare. */
function valueOf(resolvedEntry) {
  return isPlainObject(resolvedEntry) && 'value' in resolvedEntry ? resolvedEntry.value : resolvedEntry
}

/** The source of a resolved entry, or `unknown` rather than a made-up one. */
function renderSource(resolvedEntry) {
  const source = isPlainObject(resolvedEntry) ? resolvedEntry.source : null
  return source === 'existing' || source === 'detected' || source === 'default' ? source : 'unknown'
}

/** Render a resolved value for a dry-run line. */
function renderValue(value) {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    // Manifest components render as ids: the digest and path are what the
    // manifest file is for, not one line of a dry run.
    if (value.every((item) => isPlainObject(item) && typeof item.id === 'string')) {
      return '[' + value.map((item) => item.id).join(', ') + ']'
    }
    return '[' + value.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(', ') + ']'
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

/** The parsed table with this dotted name, or null when it is absent or not a table. */
function tableOf(tables, name) {
  const table = isPlainObject(tables) ? tables[name] : null
  return isPlainObject(table) ? table : null
}

/** Whether a table, or any of its sub-tables, was parsed. */
function hasTableFamilyIn(tables, prefix) {
  return Object.keys(tables).some((name) => name === prefix || name.startsWith(prefix + '.'))
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A trimmed, non-empty string, or null. */
function asString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** A list of trimmed strings; a lone string counts as a one-item list. */
function asStringArray(value) {
  const items = Array.isArray(value) ? value : [value]
  return items.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
}

/** A finite number, or null (`"90"` counts, `true` does not). */
function asNumber(value) {
  const number = typeof value === 'string' ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) ? number : null
}

/** The first existing file among project-relative candidates. */
function firstExisting(root, candidates) {
  for (const relative of candidates) {
    if (isFile(path.join(root, relative))) return relative
  }
  return null
}

/** Escape a literal string for use inside a regular expression. */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function readFileText(filePath) {
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

/** The first non-empty, non-comment line. `.python-version` holds exactly one. */
function firstMeaningfulLine(text) {
  if (typeof text !== 'string') return null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line !== '' && !line.startsWith('#')) return line
  }
  return null
}

/** Directory entries, sorted and tolerant of a missing directory. */
function readDirSafe(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

function isFile(filePath) {
  try {
    return statSync(filePath).isFile()
  } catch {
    return false
  }
}

function isDirectory(filePath) {
  try {
    return statSync(filePath).isDirectory()
  } catch {
    return false
  }
}

/** Project-relative paths always use `/`, whatever the host separator is. */
function joinRelative(base, name) {
  return base === '' ? name : base + '/' + name
}

function trimSlashes(value) {
  return value.replace(/^\/+|\/+$/g, '')
}
