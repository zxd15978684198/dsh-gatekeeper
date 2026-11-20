// The pyproject.toml fragment `py-bootstrap` proposes.
//
// It is a string here, never a write, and that split is about this function, not
// about the plugin's ambition: rendering is what `py-bootstrap` needs, and
// writing is `py-apply`'s job, where it happens against a five-file allowlist,
// with a `.bak` backup and with `pyproject.toml` appended to table by table
// instead of rewritten.
//
// The CONTENT is chapter 8.3 of the course (the "ruff / ty / pytest / coverage"
// configuration every generated project gets), not this author's taste. Two
// consequences are worth stating because they are reversals of the previous
// version of this file:
//
//   * `select = ["ALL"]` is gone from the default. The default is the chapter's
//     narrow set (`E`, `F`, `I`, `B`, `UP`), because that is what a project can
//     adopt on day one without a wall of ignores. `ruffSelect: ["ALL"]` still
//     renders the wide set, per-file relaxations included, for projects that
//     already carry it.
//   * `--cov-fail-under` is gone from pytest's `addopts`. The floor lives in
//     `[tool.coverage.report] fail_under`, which both `pytest --cov` and
//     `coverage report` read; a floor hidden in `addopts` only applies on the
//     runs that happen to pass `--cov`.
//
// Every option is optional and every old argument still works: the callers
// (`py-bootstrap`, `py-apply`) pass only the version, the paths and the security
// switch, and get the chapter defaults for everything else.
//
// The Python version is a parameter, not a constant. The course targets modern
// interpreters, while the project this plugin was built against pins 3.13 in
// `.python-version`; hardcoding either one would hand half of its users a
// configuration that disagrees with their interpreter.

import { ruffTargetVersion } from './ci-render.js'

/**
 * The coverage floor for a project born today, as `fail_under`.
 *
 * Chapter 8.3 pins 90 for a fresh code base: every file it ships was written
 * against the gate, so the number is a target, not a demand to rewrite history.
 */
export const COVERAGE_FLOOR = 90

/**
 * The conservative floor for a project that already has code.
 *
 * Adopting 90 on an older code base turns the coverage gate into noise on day
 * one; 80 is the number the plan gives existing projects. `resolveProject` (or
 * any caller that knows it is upgrading) passes this, a new project does not.
 */
export const EXISTING_PROJECT_COVERAGE_FLOOR = 80

/**
 * The pytest `testpaths` used when neither the caller, the setting, nor detection
 * narrowed it down.
 */
export const DEFAULT_TEST_PATHS = 'src/tests'

/** The narrow rule set from chapter 8.3: the default for a new project. */
export const DEFAULT_RUFF_SELECT = ['E', 'F', 'I', 'B', 'UP']

/** The wide rule set the pre-v0.10 template rendered instead. */
export const LEGACY_RUFF_SELECT = ['ALL']

/**
 * The ignores the wide set needs to be usable at all.
 *
 * `D` is a docstring rule per definition; `COM812` and `ISC001` are documented
 * formatter conflicts (leaving them on makes `ruff format` and `ruff check`
 * disagree about a line neither will change); `CPY001` is a copyright-header
 * policy, and `select = ["ALL"]` enables it for every file, so a fresh project
 * would fail its own gate on the first run.
 */
export const LEGACY_RUFF_IGNORE = ['D', 'COM812', 'ISC001', 'CPY001']

/**
 * The lower bound `[tool.uv] required-version` gets when the caller says nothing.
 *
 * The template drives `[dependency-groups]`, `uv sync --all-groups` and
 * `uv run --locked`; one uv behaviour for the whole team is the point of the
 * stanza. A generator cannot know which uv is installed, so this is a lower bound
 * only: an upper bound would reject a newer, perfectly compatible uv, and an
 * exact pin would reject every machine that is one patch release ahead.
 */
export const UV_REQUIRED_VERSION = '>=0.5'

/** Requirement strings shared by the groups and by `devGroupCommand`. */
const TEST_REQUIREMENTS = ['pytest>=8.3,<10.0', 'pytest-cov>=6.0,<8.0']
const RUFF_REQUIREMENT = 'ruff>=0.11,<1.0'
const MYPY_REQUIREMENT = 'mypy>=1.15,<2.0'
const DETECT_SECRETS_REQUIREMENT = 'detect-secrets>=1.5,<2.0'

/**
 * Python files the toolchain writes itself.
 *
 * They are excluded from the formatter in `[tool.ruff.format]` — their layout is
 * the template's, and a formatter version bump would reflow a file nobody edits —
 * and their line width is exempt from `E501`, because the template controls the
 * wrapping and adding a rule nobody can fix by hand only teaches readers that red
 * output is normal.
 */
const GENERATED_SCRIPTS = [
  'scripts/ci.py',
  'scripts/secret_scan.py',
  'scripts/validate_version_manifest.py',
  'scripts/container_report.py',
]

function normalizeTypeChecker(value) {
  return value === 'ty' ? 'ty' : 'mypy'
}

function normalizeRuffSelection(ruffSelect, ruffIgnore) {
  const select = Array.isArray(ruffSelect) && ruffSelect.length > 0
    ? ruffSelect.map((rule) => String(rule).trim()).filter((rule) => rule !== '')
    : [...DEFAULT_RUFF_SELECT]
  const extraIgnore = Array.isArray(ruffIgnore)
    ? ruffIgnore.map((rule) => String(rule).trim()).filter((rule) => rule !== '')
    : []
  const wide = select.includes('ALL')
  return {
    select,
    wide,
    ignore: wide
      ? [...LEGACY_RUFF_IGNORE, ...extraIgnore.filter((rule) => !LEGACY_RUFF_IGNORE.includes(rule))]
      : extraIgnore,
  }
}

/**
 * The PEP 735 groups the gates need, in the shape chapter 8.3 writes them.
 *
 * `dev` aggregates the others with `include-group` rather than repeating the
 * same package names, so `uv sync --all-groups` and the gates can never drift
 * from each other.
 *
 * `audit` is kept as a key for the callers that already read it, but the v0.10
 * audit gate does not install `pip-audit` from the project's resolution: it runs
 * `uv run --with pip-audit`, because the vulnerability database sniffing tool
 * should not force a resolution change on the project it is auditing.
 *
 * @returns `{ dev, lint, test, security, audit }`, each value a list of
 *   requirements (except the `include-group` entries in `dev`).
 */
export function dependencyGroups({
  includeSecurity = true,
  includeTypeCheck = true,
  typeChecker = 'mypy',
} = {}) {
  const checker = normalizeTypeChecker(typeChecker)
  const lint = includeTypeCheck
    ? [checker === 'ty' ? 'ty' : MYPY_REQUIREMENT, RUFF_REQUIREMENT]
    : [RUFF_REQUIREMENT]
  const security = includeSecurity ? [DETECT_SECRETS_REQUIREMENT] : []
  return {
    dev: ['{ include-group = "lint" }', '{ include-group = "test" }']
      .concat(includeSecurity ? ['{ include-group = "security" }'] : []),
    lint,
    test: [...TEST_REQUIREMENTS],
    security,
    audit: includeSecurity ? ['pip-audit'] : [],
  }
}

/** The same requirements as one flat list, for callers that only need the names. */
export function devDependencies(options = {}) {
  const groups = dependencyGroups(options)
  return [...new Set([...groups.lint, ...groups.test, ...groups.security, ...groups.audit])]
}

/**
 * A requirement as a shell word.
 *
 * `pytest>=8.3,<10.0` is not a valid unquoted bash word: `>` would be read as a
 * redirection and `<` as an input redirect, so a "copy this command" line would
 * fail before uv even ran. Requirements without shell metacharacters stay bare,
 * which keeps the common case readable.
 */
function shellWord(requirement) {
  return /[<>|&;()$`\\"'\s*?[\]]/.test(requirement) ? '"' + requirement + '"' : requirement
}

/**
 * The one sanctioned way to create the `dev` group: `uv add --group`.
 *
 * Kept alongside the rendered `[dependency-groups]` table: `uv add` writes
 * `pyproject.toml` and `uv.lock` in the same step, so a caller that prefers the
 * command over the table still cannot produce a pyproject its lockfile has never
 * seen. The table in `renderPyprojectBlock` is for the "append the whole block"
 * flow, and both spellings list the same requirements.
 */
export function devGroupCommand(options = {}) {
  return 'uv add --group dev ' + devDependencies(options).map(shellWord).join(' ')
}

/**
 * The shape PEP 508 gives a distribution name, without the 128-character cap.
 *
 * Every reader of `[project]` — uv, build backends, `importlib.metadata` — parses
 * the file as metadata, so a generated name has to be in this shape or the file
 * is rejected before any gate can run.
 */
const PROJECT_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

/** The name a `[project]` table gets when neither the project nor the caller names one. */
export const DEFAULT_PROJECT_NAME = 'python-project'

/**
 * Turn a directory name into a usable `[project].name`.
 *
 * A directory name is not a package name. `My Service`, `2026_demo` and
 * `employee-service` are all plausible folder names and only the last one is a
 * valid PEP 621 name, so the fallback a caller takes from the directory is
 * normalized instead of pasted: lowercased, and every run of non-alphanumerics
 * becomes one `-` — the same shape `uv init` gives a directory name. An input
 * that normalizes to nothing (an all-CJK folder, say) falls back to a visible
 * placeholder, because an empty name is a TOML parse error, not a default.
 *
 * This is for names that do not exist yet. A project that already declares
 * `[project].name` keeps its spelling: `My.Service` is valid, and rewriting it
 * would rename the distribution on every render.
 *
 * @param value - the preferred name; anything other than a non-empty string is ignored.
 * @returns a lowercase, hyphen-separated name matching PEP 508's shape.
 */
export function normalizeProjectName(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') return DEFAULT_PROJECT_NAME
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? DEFAULT_PROJECT_NAME : slug
}

/**
 * One TOML basic string.
 *
 * `version` arrives from the project's own pyproject, where it was already a
 * string literal, but a caller can pass anything; escaping the two characters
 * TOML reserves keeps a bad input a parse error in that field alone instead of in
 * the whole file.
 */
function tomlBasicString(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/**
 * Render the TOML block.
 *
 * @param options - the legacy `{ pythonVersion, requiresPython, testPaths,
 *   includeSecurity, includeTypeCheck, includeProjectTable }` plus
 *   `{ typeChecker, ruffLineLength, ruffSelect, ruffIgnore, coverageFloor,
 *   includeWorkspace, workspaceMembers, projectName, version }`.
 * @returns a TOML fragment that can be appended to a pyproject.toml.
 */
export function renderPyprojectBlock(options = {}) {
  const pythonVersion = typeof options.pythonVersion === 'string' && options.pythonVersion.trim() !== ''
    ? options.pythonVersion.trim()
    : '3.13'
  // The requirement is what a reader has to keep in sync with `.python-version`;
  // a bare `3.12` target says nothing about the range the project accepts.
  const requiresPython = typeof options.requiresPython === 'string' && options.requiresPython.trim() !== ''
    ? options.requiresPython.trim()
    : '>=' + pythonVersion
  const testPaths = Array.isArray(options.testPaths) && options.testPaths.length > 0
    ? options.testPaths
    : [DEFAULT_TEST_PATHS]
  const includeSecurity = options.includeSecurity !== false
  const includeTypeCheck = options.includeTypeCheck !== false
  const includeProjectTable = options.includeProjectTable === true
  // PEP 621 requires `name`. A generated `[project]` table without it does not
  // fail later in the pipeline, it fails at `uv lock`: "required project.name
  // field is not set" is a parse error, so every gate after the first `uv sync`
  // never runs. A caller that already has a valid name (an existing
  // `[project].name`) gets it back byte for byte; anything else — a bare directory
  // name, an empty string — is normalized. `version` is the field the metadata
  // parser wants next; `0.0.0` is the same visible placeholder the manifest uses
  // for a dynamic version.
  const requestedName = typeof options.projectName === 'string' ? options.projectName.trim() : ''
  const projectName = requestedName !== '' && PROJECT_NAME_PATTERN.test(requestedName)
    ? requestedName
    : normalizeProjectName(requestedName)
  const version = typeof options.version === 'string' && options.version.trim() !== ''
    ? options.version.trim()
    : '0.0.0'
  const typeChecker = normalizeTypeChecker(options.typeChecker)
  const ruffLineLength = Number.isInteger(options.ruffLineLength) && options.ruffLineLength > 0
    ? options.ruffLineLength
    : 88
  const selection = normalizeRuffSelection(options.ruffSelect, options.ruffIgnore)
  // `coverageFloor: null` means "do not pin a floor", which is different from
  // "not given": an existing project with no measured baseline should not get a
  // number it cannot satisfy.
  const requestedFloor = 'coverageFloor' in options ? options.coverageFloor : COVERAGE_FLOOR
  const coverageFloor = Number.isFinite(requestedFloor) ? Math.round(requestedFloor) : null
  const includeWorkspace = options.includeWorkspace === true
  const workspaceMembers = Array.isArray(options.workspaceMembers)
    ? options.workspaceMembers.map((member) => String(member).trim()).filter((member) => member !== '')
    : []
  const groups = dependencyGroups({ includeSecurity, includeTypeCheck, typeChecker })

  const lines = []
  lines.push('# --- gatekeeper: proposed configuration (chapter 8.3 defaults) ---')
  lines.push('# Tables only: existing ones are never rewritten, missing ones are appended.')
  lines.push('')
  if (includeProjectTable) {
    // Only when the file has no [project] table at all: a second one is invalid TOML.
    lines.push('[project]')
    // Name and version first, then the interpreter range: the two fields uv's
    // metadata parser requires come before the one it only validates against.
    lines.push('name = ' + tomlBasicString(projectName))
    lines.push('version = ' + tomlBasicString(version))
    lines.push('requires-python = "' + requiresPython + '"')
    lines.push('')
  } else {
    lines.push('# [project] already exists — its name and version are left alone, and')
    lines.push('# requires-python should stay in sync with this block:')
    lines.push('# requires-python = "' + requiresPython + '"')
    lines.push('')
  }

  // Chapter 8.3 writes the groups as a table; `dev` re-exports the others with
  // `include-group`, so `uv sync --all-groups` is the only command anyone needs to
  // remember and the groups cannot disagree about which ruff version they pin.
  lines.push('# PEP 735 groups: `uv sync --all-groups` installs every one of these.')
  lines.push('# `dev` aggregates the others with `include-group` so they cannot drift apart.')
  lines.push('[dependency-groups]')
  lines.push('dev = [')
  for (const entry of groups.dev) lines.push('    ' + entry + ',')
  lines.push(']')
  lines.push('lint = [' + groups.lint.map((entry) => '"' + entry + '"').join(', ') + ']')
  lines.push('test = [' + groups.test.map((entry) => '"' + entry + '"').join(', ') + ']')
  if (groups.security.length > 0) {
    lines.push('security = [' + groups.security.map((entry) => '"' + entry + '"').join(', ') + ']')
  }
  lines.push('')

  lines.push('# `line-length` is the formatter\'s own default (88), so the lint and format')
  lines.push('# steps cannot disagree about a line that is one character long.')
  lines.push('# `target-version` is the project\'s interpreter, not the plugin author\'s.')
  lines.push('[tool.ruff]')
  lines.push('line-length = ' + ruffLineLength)
  lines.push('target-version = "' + ruffTargetVersion(pythonVersion) + '"')
  lines.push('src = ["src"]')
  lines.push('')
  lines.push('[tool.ruff.lint]')
  if (selection.wide) {
    lines.push('# The wide set: everything on, then the formatter conflicts and the')
    lines.push('# policy rules off. Only sane with the per-file relaxations below.')
    lines.push('select = ["ALL"]')
    lines.push('ignore = [')
    lines.push('    "D",       # pydocstyle: docstring requirements, enable selectively')
    lines.push('    "COM812",  # formatter conflict: missing trailing comma')
    lines.push('    "ISC001",  # formatter conflict: implicit string concatenation')
    lines.push('    # A copyright header is an organisation policy, not a property of code:')
    lines.push('    # `select = ["ALL"]` turns it on for every file, so leaving it in makes a')
    lines.push('    # fresh project fail its own gate on the first run.')
    lines.push('    "CPY001",  # missing copyright notice')
    for (const rule of selection.ignore.slice(LEGACY_RUFF_IGNORE.length)) {
      lines.push('    "' + rule + '",')
    }
    lines.push(']')
  } else {
    lines.push('# Narrow on purpose: E/F/I/B/UP catch the mistakes that cost money (undefined')
    lines.push('# names, unused imports, import order, bugbear footguns, pyupgrade drift). Add')
    lines.push('# rules with `extend-select` when a project needs them, not by adopting ALL')
    lines.push('# and then ignoring the storm it brings.')
    lines.push('select = [' + selection.select.map((rule) => '"' + rule + '"').join(', ') + ']')
    if (selection.ignore.length > 0) {
      lines.push('ignore = [' + selection.ignore.map((rule) => '"' + rule + '"').join(', ') + ']')
    }
  }
  lines.push('')
  lines.push('[tool.ruff.lint.per-file-ignores]')
  if (selection.wide) {
    // `select = ["ALL"]` is only usable with the per-file relaxations: the
    // `scripts/ci.py` this very plugin writes — a script whose whole job is
    // printing progress — is otherwise reported by its own lint gate, and every
    // test file trips `S101`/`PLR2004`. A generated project that fails the gate
    // the same plugin installed teaches the reader to ignore red output.
    lines.push('# Tests: assertions and literal values are the point of a test.')
    lines.push('"**/tests/**/*.py" = [')
    lines.push('    "S101",     # assert usage')
    lines.push('    "PLR2004",  # magic values')
    lines.push('    "ANN",      # type annotations optional')
    lines.push(']')
    lines.push('# Scripts: print is the output channel, and subprocess is the work.')
    lines.push('"scripts/**/*.py" = [')
    lines.push('    "T20",      # print statements')
    lines.push('    "INP001",   # implicit namespace package')
    lines.push('    "S603",     # subprocess without shell=False review')
    lines.push('    "PTH100",   # os.path.abspath in a standalone runner')
    lines.push('    "SIM105",   # try/except/pass around best-effort cleanup')
    lines.push('    "E501",     # line width is the template\'s, see below')
    lines.push(']')
    lines.push('# Re-exports: an __init__ that imports names on purpose.')
    lines.push('"__init__.py" = [')
    lines.push('    "F401",     # unused imports (re-exports)')
    lines.push(']')
  } else {
    // Deliberately not silenced as a category: only line width, and only in the
    // files whose line breaks come from a template. Everything ruff does catch
    // here (`F821`, unused names, bad f-strings) is a real defect in the script.
    lines.push('# Generated scripts control their own wrapping: line width is the template\'s')
    lines.push('# job, and the formatter already steps aside for them below.')
    lines.push('"scripts/**/*.py" = ["E501"]')
  }
  lines.push('')
  lines.push('[tool.ruff.format]')
  lines.push('quote-style = "double"')
  lines.push('indent-style = "space"')
  lines.push('docstring-code-format = true')
  // These files are generated, not edited: one embedded JSON payload plus a fixed
  // runner. `ruff format` rewrites them according to the *target version* (PEP 758
  // unparenthesized `except` on py314, wrapped calls, line splits inside the
  // payload literal), so any hand-written shape is correct for one Python version
  // and wrong for the next, and the gate runs `ruff format --check`. Lint still
  // applies to them; only formatting steps aside.
  lines.push('exclude = [')
  for (const script of GENERATED_SCRIPTS) lines.push('    "' + script + '",')
  lines.push(']')
  lines.push('')

  if (includeTypeCheck) {
    if (typeChecker === 'ty') {
      lines.push('# ty is in the lint group because the type gate runs it.')
      lines.push('# `error-on-warning` makes the gate fail on warnings, not only hard errors;')
      lines.push('# `python-version` belongs under `[tool.ty.environment]` — `[tool.ty]`')
      lines.push('# python-version is the anti-pattern the course calls out.')
      lines.push('[tool.ty.terminal]')
      lines.push('error-on-warning = true')
      lines.push('')
      lines.push('[tool.ty.environment]')
      lines.push('python-version = "' + pythonVersion + '"')
    } else {
      lines.push('# mypy checks against the target interpreter, not the one running it;')
      lines.push('# `strict = true` is the bundle of the twelve flags that make types useful.')
      lines.push('[tool.mypy]')
      lines.push('python_version = "' + pythonVersion + '"')
      lines.push('strict = true')
    }
    lines.push('')
  }

  // pytest reads `[tool.pytest.ini_options]`; the course's short `[tool.pytest]` is
  // not a table pytest 8 looks at, so following it literally would produce a
  // configuration file whose settings are silently ignored.
  lines.push('[tool.pytest.ini_options]')
  lines.push('testpaths = [' + testPaths.map((entry) => '"' + entry + '"').join(', ') + ']')
  lines.push('# `-ra` prints the skip/xfail reasons; `--strict-markers` turns a typo\'d')
  lines.push('# marker into an error instead of a silently deselected test. No coverage')
  lines.push('# flags here: the floor lives in `[tool.coverage.report]`, which also applies')
  lines.push('# to a bare `coverage report`.')
  lines.push('addopts = "-ra --strict-markers"')
  lines.push('')
  lines.push('[tool.coverage.run]')
  lines.push('# Branch coverage: an `if` nobody has taken the other way is not covered.')
  lines.push('branch = true')
  lines.push('# First-party code only; without this the number includes the test files')
  lines.push('# themselves and flatters every project.')
  lines.push('source = ["src"]')
  lines.push('')
  lines.push('[tool.coverage.report]')
  lines.push('# The uncovered line numbers are what make a failure actionable.')
  lines.push('show_missing = true')
  if (coverageFloor !== null) {
    lines.push('# The floor, in the one place that `pytest --cov` and `coverage report` both read.')
    lines.push('fail_under = ' + coverageFloor)
  } else {
    lines.push('# fail_under is not pinned: this project has no measured baseline to defend.')
  }
  lines.push('')

  lines.push('# One uv behaviour for the whole team. A lower bound only: the generator')
  lines.push('# cannot know which uv is installed, and an upper bound would reject a newer,')
  lines.push('# compatible one.')
  lines.push('[tool.uv]')
  lines.push('required-version = "' + UV_REQUIRED_VERSION + '"')

  if (includeWorkspace) {
    lines.push('')
    lines.push('# Workspace root: members are resolved from this file, not from a second list.')
    lines.push('[tool.uv.workspace]')
    if (workspaceMembers.length > 0) {
      lines.push('members = [')
      for (const member of workspaceMembers) lines.push('    "' + member + '",')
      lines.push(']')
    } else {
      lines.push('# No members were detected; a workspace root without members is valid and')
      lines.push('# means "nothing dogfooded from this checkout yet". Fill in the globs:')
      lines.push('# members = ["packages/*", "services/*"]')
    }
    lines.push('')
    // `workspace = true` is the whole reason `[tool.uv.sources]` exists: it tells
    // uv that a dependency is a sibling in this checkout, so the lockfile records a
    // workspace reference instead of an index version. The entries are commented
    // because `workspaceMembers` are paths, and a source entry needs the package
    // *name* — which lives in the member's own pyproject.toml.
    lines.push('# Declare the workspace siblings this root depends on, by package name:')
    lines.push('# release-guard = { workspace = true }')
    lines.push('[tool.uv.sources]')
  }

  lines.push('')
  lines.push('# uv reads requires-python from [project]; .python-version is the fallback when it is absent.')
  return lines.join('\n')
}

/**
 * Why each stanza is there, in the order it appears.
 *
 * The rationale is returned alongside the snippet rather than left implicit:
 * a configuration nobody can explain is a configuration nobody will maintain.
 */
export function pyprojectRationale(options = {}) {
  const includeSecurity = options.includeSecurity !== false
  const includeTypeCheck = options.includeTypeCheck !== false
  const typeChecker = normalizeTypeChecker(options.typeChecker)
  const includeWorkspace = options.includeWorkspace === true
  const selection = normalizeRuffSelection(options.ruffSelect, options.ruffIgnore)
  const rationale = [
    {
      stanza: '[dependency-groups]',
      why:
        'PEP 735 groups are what `uv sync --all-groups` installs, and `dev` re-exports the ' +
        'others with `include-group`, so lint, test and security never drift apart. They also ' +
        'keep pytest and ruff out of the runtime dependency set, so `pip install .` does not ' +
        'drag the test runner into production.',
    },
    {
      stanza: '[tool.ruff]',
      why:
        '`line-length = 88` is `ruff format`\'s own default, so the linter and the formatter ' +
        'cannot disagree about a line width; `target-version` tells Ruff which syntax it may ' +
        'rewrite toward (leaving it unset makes `UP` suggest upgrades the interpreter cannot ' +
        'run); `src = ["src"]` is what lets the isort rules resolve `src/`-layout first-party ' +
        'imports.',
    },
    {
      stanza: '[tool.ruff.lint]',
      why: selection.wide
        ? '`select = ["ALL"]` with the formatter-conflict and policy ignores is the pre-v0.10 ' +
          'wide set, kept for projects that already carry it. It is only usable together with ' +
          'the per-file ignores below: a new project should start narrow instead.'
        : '`select = ["E", "F", "I", "B", "UP"]` is the chapter 8.3 set: undefined names, unused ' +
          'imports, import order, bugbear footguns and pyupgrade drift, which are the rule ' +
          'families that catch mistakes instead of style. ALL is the wide escape hatch ' +
          '(`ruffSelect: ["ALL"]`), and it needs the per-file ignores a new project has not ' +
          'earned yet.',
    },
    {
      stanza: '[tool.ruff.lint.per-file-ignores]',
      why: selection.wide
        ? 'The wide set is only usable with the chapter\'s virtual relaxations: tests need ' +
          'assertions and magic values, `scripts/*.py` exists to print and to spawn ' +
          'subprocesses, and `__init__.py` re-exports on purpose. A generated project that ' +
          'fails the gate the same plugin installed teaches the reader to ignore red output.'
        : 'Only `E501` is relaxed, and only for the generated scripts: their wrapping is the ' +
          'template\'s, so line width is not a defect a contributor could fix. Everything else ' +
          'ruff catches there (undefined names, broken f-strings) is a real defect.',
    },
    {
      stanza: '[tool.ruff.format]',
      why:
        'Formatting is configured in one place, so `ruff format --check` in CI and a local ' +
        '`ruff format .` agree on quotes and indentation. The `exclude` list holds the four ' +
        'generated scripts: their layout is a function of the ruff and Python versions that ' +
        'wrote them, so formatting them would make the gate fail on a brand-new project for ' +
        'a file nobody edits. Lint still applies to them.',
    },
  ]
  if (includeTypeCheck) {
    rationale.push(typeChecker === 'ty'
      ? {
        stanza: '[tool.ty.terminal] / [tool.ty.environment]',
        why:
          'ty is in the lint group because the type gate runs it. `error-on-warning` makes the ' +
          'gate fail on warnings instead of only on hard errors, and `python-version` under ' +
          '`[tool.ty.environment]` is the supported key — `[tool.ty] python-version` is the ' +
          'anti-pattern the course calls out.',
      }
      : {
        stanza: '[tool.mypy]',
        why:
          '`python_version` makes the checker reason about the interpreter the project ' +
          'targets, not the one running it (otherwise it silently accepts syntax the target ' +
          'rejects). `strict = true` is the bundle — `disallow_untyped_defs`, ' +
          '`no_implicit_optional`, `warn_return_any` and the rest — so the gate does not depend ' +
          'on a dozen flags a reader has to keep in sync.',
      })
  }
  rationale.push(
    {
      stanza: '[tool.pytest.ini_options]',
      why:
        '`testpaths` keeps a bare `pytest` on the suite instead of collecting vendored or ' +
        'generated tests. `-ra` prints the skip/xfail reasons; `--strict-markers` turns a ' +
        'typo\'d marker into an error instead of a silently deselected test. The key is ' +
        '`[tool.pytest.ini_options]` — pytest 8 does not read a plain `[tool.pytest]` table, ' +
        'even though the course abbreviates it that way.',
    },
    {
      stanza: '[tool.coverage.run]',
      why:
        '`branch = true` is the difference between "this line ran" and "both sides of this ' +
        '`if` ran"; a covered line whose branch is never taken is a lie line coverage tells. ' +
        '`source = ["src"]` scopes the measurement to first-party code, so the test files do ' +
        'not flatter the number.',
    },
    {
      stanza: '[tool.coverage.report]',
      why:
        '`show_missing` prints the uncovered line numbers, which is what makes a failing ' +
        'coverage gate actionable. `fail_under` is the floor, in the one place both ' +
        '`pytest --cov` and `coverage report` read — keeping it out of `addopts` is what makes ' +
        'a local `pytest` and the CI stage agree instead of enforcing the floor only on the ' +
        'runs that happen to pass `--cov`.',
    },
    {
      stanza: '[tool.uv]',
      why:
        '`required-version` pins one uv behaviour for the team: the commands this toolchain ' +
        'writes (`uv sync --all-groups`, `uv run --locked`) resolve the same way on every ' +
        'machine. The value is a lower bound on purpose — the generator does not know which uv ' +
        'is installed, and an upper bound would reject a newer, compatible one.',
    },
  )
  if (includeWorkspace) {
    rationale.push({
      stanza: '[tool.uv.workspace] / [tool.uv.sources]',
      why:
        '`members` makes the root the one place a workspace is defined; `[tool.uv.sources]` ' +
        'with `{ workspace = true }` is what makes internal dependencies resolve to the ' +
        'checkout instead of the index, so a change in one member is visible in the locked ' +
        'graph without a release. The source entries are commented because `workspaceMembers` ' +
        'are paths and a source entry needs the package name.',
    })
  }
  if (includeSecurity) {
    rationale.push({
      stanza: 'security group',
      why:
        '`detect-secrets` is a dev dependency because the commit hook and the security gate ' +
        'run the project-locked scanner, so a hook and CI cannot disagree about which version ' +
        'decided a string is a secret. `pip-audit` is deliberately not in this group: the audit ' +
        'gate installs it ephemerally (`uv run --with pip-audit`) so querying the ' +
        'vulnerability database does not pin the audited project.',
    })
  }
  return rationale
}

/** What must be true before the block can be applied. */
export function pyprojectPrerequisites() {
  return [
    'A pyproject.toml exists at the project root (create one with `uv init` if not) — the block ' +
    'appends [dependency-groups] and [tool.*] tables, it never rewrites [project].',
    'uv is installed and satisfies the [tool.uv] required-version this block writes: `uv --version`.',
    'No poetry.lock, pdm.lock or Pipfile.lock in the project — uv is not the dependency manager there.',
    'The interpreter in .python-version (or requires-python) satisfies the target this block names.',
    'Python 3.11 or newer: the course targets modern interpreters only.',
    'After appending, run `uv lock` then `uv sync --frozen` so all four groups land in uv.lock.',
    'The 90% floor assumes a code base written today; an existing project starts at 80 ' +
    '(EXISTING_PROJECT_COVERAGE_FLOOR) or keeps its own number.',
  ]
}
