/**
 * One place where "which Python version should the generated config target"
 * is answered.
 *
 * The bug this module exists to prevent: `requires-python` is a *specifier*
 * (`>=3.9`), not a version. Two callers used to read the field raw and put it
 * where a version belongs — `detect` reported `pythonVersion: ">=3.9"`, and
 * `py-bootstrap` silently fell back to the plugin default when it saw a
 * specifier, generating `target-version = "py313"` for a project whose own
 * metadata said 3.9 is still supported. Both are the same mistake: treating a
 * constraint as a value. Everything now goes through {@link resolveTargetPython}.
 */

/** `3.13`, `3.13.1`, `pypy3.10` — a value Ruff's `target-version` can use. */
export const CONCRETE_VERSION_RE = /^(pypy)?\d+\.\d+(\.\d+)?$/

/** True when `value` names one interpreter, not a range of them. */
export function isConcreteVersion(value) {
  return typeof value === 'string' && CONCRETE_VERSION_RE.test(value.trim())
}

/**
 * `3.13.1` -> `3.13`, `cpython-3.13.0` -> `3.13`, `pypy3.10` -> `pypy3.10`.
 *
 * Ruff and the workflow matrix both want `major.minor`; a patch segment in
 * `target-version` is invalid, and a `cpython-` prefix is not a Python version
 * at all.
 */
export function normalizeVersion(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '') return null
  const pypy = /^pypy-?(\d+)\.(\d+)/i.exec(text)
  if (pypy !== null) return 'pypy' + pypy[1] + '.' + pypy[2]
  const dig = /(\d+)\.(\d+)/.exec(text)
  if (dig === null) return null
  return dig[1] + '.' + dig[2]
}

/**
 * The lowest Python a specifier still accepts.
 *
 * `>=3.9` -> `3.9`, `>=3.10,<4` -> `3.10`, `~=3.9.1` -> `3.9`, `==3.11.*` ->
 * `3.11`, `^3.9` -> `3.9`. Returning the lower bound is deliberate: the point
 * of `target-version` is "what must the code parse as", and a project that
 * claims 3.9 support must be linted at 3.9 or the gate passes code 3.9 cannot
 * run.
 *
 * @returns `{ version, source: 'specifier' }`-shaped version string, or null.
 */
export function minimumOfSpecifier(specifier) {
  if (typeof specifier !== 'string') return null
  const text = specifier.trim()
  if (text === '') return null
  if (isConcreteVersion(text)) return normalizeVersion(text)
  const found = text.match(/\d+\.\d+/g)
  if (found === null || found.length === 0) return null
  const sorted = found.slice().sort(compareVersions)
  return sorted[0]
}

function compareVersions(a, b) {
  const [aMajor, aMinor] = a.split('.').map(Number)
  const [bMajor, bMinor] = b.split('.').map(Number)
  if (aMajor !== bMajor) return aMajor - bMajor
  return aMinor - bMinor
}

/**
 * Decide the version the generated configuration targets.
 *
 * Order: what the project pins (`.python-version`) -> the lower bound of
 * `requires-python` -> the plugin default. The source is returned alongside so
 * the caller can say where the number came from instead of presenting a
 * default as a fact.
 *
 * @param detection - a `detect()` result, possibly partial.
 * @param fallback - `config.defaultPythonVersion`.
 * @returns `{ version, source }` where source is `'python-version'`,
 *   `'pyproject.toml'`, `'default'`, or `null` when nothing was usable.
 */
export function resolveTargetPython(detection, fallback) {
  const concrete = isConcreteVersion(detection?.pythonVersion)
  if (concrete) {
    const source = typeof detection?.pythonVersionSource === 'string'
      ? detection.pythonVersionSource
      : null
    return { version: normalizeVersion(detection.pythonVersion), source }
  }
  const fromSpecifier = minimumOfSpecifier(detection?.requiresPython)
  if (fromSpecifier !== null) return { version: fromSpecifier, source: 'pyproject.toml' }
  const fallbackVersion = isConcreteVersion(fallback) ? normalizeVersion(fallback) : null
  return { version: fallbackVersion, source: fallbackVersion === null ? null : 'default' }
}

/**
 * A warning for the case where the target had to be guessed.
 *
 * Silence here is what made the original bug hard to see: the generated config
 * contradicted the project's own `requires-python` and nothing said so.
 */
export function targetPythonWarning(resolved) {
  if (resolved === null || resolved.version === null) {
    return 'No Python version could be read from .python-version or requires-python, so the plugin '
      + 'default was used. Set a target explicitly to avoid generating a config the project cannot run.'
  }
  if (resolved.source === 'default') {
    return 'The project does not pin a Python version, so the plugin default '
      + resolved.version + ' was used. If this project supports an older version, pass the target '
      + 'explicitly or add `requires-python` to pyproject.toml.'
  }
  return null
}
