// Project facts, read from disk and returned as data.
//
// This module is a pure reader: it never writes, never spawns, and takes the
// directory to inspect as an argument. That is deliberate — `py-detect` is the
// guard every other generating tool consults, and a guard that can also mutate
// the thing it inspects is not a guard.
//
// The negative criterion lives here as code rather than as advice in a document:
// `1-uv` says "Don't use uv in projects managed by other tools", and
// `FOREIGN_LOCKFILES` is that sentence compiled. A project carrying one of these
// lockfiles comes back with a non-empty `blockers` array, and the tools that
// would otherwise generate uv configuration refuse to.

import { readFileSync, statSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { isConcreteVersion, minimumOfSpecifier, normalizeVersion } from './python-version.js'

/** Lockfiles that mean "another tool already owns this project's dependencies". */
export const FOREIGN_LOCKFILES = ['poetry.lock', 'pdm.lock', 'Pipfile.lock']

/** The lockfile that means uv owns them. */
export const UV_LOCKFILE = 'uv.lock'

/** The quote this plugin's refusal is built on, kept verbatim so a reason can cite it. */
export const UV_SCOPE_QUOTE = "Don't use uv in projects managed by other tools"

/** Where GitHub Actions workflows live, relative to the project root. */
const WORKFLOW_DIR = ['.github', 'workflows']

/** How much of a file this reader will look at. A pyproject past 512 KiB is a mistake, not a config. */
const TEXT_LIMIT = 512 * 1024

/** `readText` returns this when the file is missing, unreadable, or not a regular file. */
const MISSING = Symbol('missing')

/**
 * Read a small text file, tolerating every way it can fail.
 *
 * A detector that throws on `ENOENT` would report "cannot inspect this project"
 * for the ordinary case of a project that has not adopted a given file yet, so
 * absence is a value here, not an exception.
 *
 * @param filePath - absolute path to read.
 * @returns the text, or {@link MISSING}.
 */
async function readText(filePath) {
  try {
    const info = await stat(filePath)
    // A directory named `pyproject.toml` is legal on every filesystem and would
    // make `readFile` throw EISDIR; a FIFO would block forever. Only regular
    // files are read.
    if (!info.isFile()) return MISSING
    if (info.size > TEXT_LIMIT) return (await readFile(filePath, 'utf8')).slice(0, TEXT_LIMIT)
    return await readFile(filePath, 'utf8')
  } catch {
    return MISSING
  }
}

/** Escape a literal string for use inside a regular expression. */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Whether a TOML table header appears in a document. */
function hasSection(toml, header) {
  if (typeof toml !== 'string') return false
  return new RegExp('^\\s*\\[' + escapeRegExp(header) + '\\]\\s*$', 'm').test(toml)
}

/**
 * Whether a table, or any of its sub-tables, appears in a document.
 *
 * `[tool.ty.terminal]` configures ty exactly as `[tool.ty]` does, and a detector
 * that only matches the exact header reports such a project as unconfigured —
 * which is how a project ends up being handed a second type checker next to the
 * one it already had. The same holds for `[tool.ruff.lint]` and
 * `[tool.uv.workspace]`.
 */
function hasTableFamily(toml, prefix) {
  if (typeof toml !== 'string') return false
  return new RegExp('^\\s*\\[\\[?\\s*' + escapeRegExp(prefix) + '(?:\\.|\\])', 'm').test(toml)
}

/** Whether a value is a non-array object (the shape every TOML table parses to). */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A trimmed, non-empty string, or null. */
function asString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** A list of trimmed strings; a lone string counts as a one-item list. */
function asStringList(value) {
  const items = Array.isArray(value) ? value : [value]
  return items.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
}

/** The parsed table with this dotted name, or null when it is absent or not a table. */
function tableOf(tables, name) {
  const table = isPlainObject(tables) ? tables[name] : null
  return isPlainObject(table) ? table : null
}

/** The first non-empty, non-comment line of a file. `.python-version` holds exactly one. */
function firstMeaningfulLine(text) {
  if (typeof text !== 'string') return null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line !== '' && !line.startsWith('#')) return line
  }
  return null
}

// ---------------------------------------------------------------- TOML reading
//
// The plugin only ever *reads* configuration, and a parser dependency (`toml`,
// `@iarna/toml`) is out of the question: this plugin ships on the Node standard
// library alone. What follows is a small tolerant reader — `[table]` and
// `[[array]]` headers, dotted keys, arrays, inline tables, basic and literal
// strings (single- and triple-quoted), numbers, booleans, and dates kept as
// strings. Anything it cannot parse is reported in `error` and skipped; the
// values it did understand survive. That tolerance is the point: a pyproject
// with one broken line must still let the gates run on everything else, because
// refusing to detect is worse than detecting most of a file.

/** Bucket for keys written before the first `[header]`. pyproject.toml has none, other TOML files can. */
const ROOT_TABLE = ''

/**
 * Read and loosely parse a project's `pyproject.toml`.
 *
 * Synchronous on purpose: `resolve.js` has a synchronous contract (its callers
 * are dry-run printers that need the values before rendering), and awaiting the
 * same file twice would only add a promise hop. Callers may still `await` the
 * result — awaiting a value is legal.
 *
 * @param rootDir - the project root to read.
 * @returns `{ path, exists, text, tables, error? }`; never throws. `tables` maps
 *   each dotted table name (`project`, `tool.ruff.lint`, `tool.uv.workspace`, …)
 *   to its parsed key/value pairs; keys before the first header land under `''`.
 */
export function readPyprojectTables(rootDir) {
  const filePath = path.join(path.resolve(String(rootDir ?? '')), 'pyproject.toml')
  const result = { path: filePath, exists: false, text: null, tables: {} }
  let info
  try {
    info = statSync(filePath)
  } catch {
    // Absence is a value: most callers ask this about projects that have not
    // adopted pyproject.toml yet.
    return result
  }
  result.exists = true
  if (!info.isFile()) {
    result.error = 'pyproject.toml is not a regular file'
    return result
  }
  let text
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    return result
  }
  if (text.length > TEXT_LIMIT) text = text.slice(0, TEXT_LIMIT)
  result.text = text
  const parsed = parseTomlDocument(text)
  result.tables = parsed.tables
  if (parsed.error !== null) result.error = parsed.error
  return result
}

/**
 * Parse a TOML document into `{ tables, error }`.
 *
 * `tables` is a flat map of dotted table name to key/value object. The shape is
 * flat because every reader in this plugin asks for a table by its exact dotted
 * name (`tool.coverage.report`); a nested tree would only make the readers do
 * the same `split('.')` walk at every call site.
 */
function parseTomlDocument(text) {
  const tables = {}
  let current = null
  let error = null
  const report = (statement, message) => {
    if (error === null) error = 'line ' + statement.line + ': ' + message
  }
  for (const statement of scanTomlStatements(text)) {
    const arrayHeader = /^\[\[\s*([^[\]]*?)\s*\]\]$/.exec(statement.text)
    const tableHeader = arrayHeader === null ? /^\[\s*([^[\]]*?)\s*\]$/.exec(statement.text) : null
    if (arrayHeader !== null || tableHeader !== null) {
      const name = unquoteTomlKey((arrayHeader ?? tableHeader)[1])
      if (arrayHeader !== null) {
        // Array of tables: append a fresh object, as TOML itself does.
        if (!Array.isArray(tables[name])) tables[name] = []
        current = {}
        tables[name].push(current)
      } else {
        if (!isPlainObject(tables[name])) tables[name] = {}
        current = tables[name]
      }
      continue
    }
    const assignment = splitTomlAssignment(statement.text)
    if (assignment === null) {
      report(statement, 'expected a key/value pair')
      continue
    }
    if (current === null) {
      if (!isPlainObject(tables[ROOT_TABLE])) tables[ROOT_TABLE] = {}
      current = tables[ROOT_TABLE]
    }
    const keyParts = parseTomlKey(assignment.key)
    const value = parseTomlValue(assignment.value)
    if (keyParts === null || value === null) {
      report(statement, 'cannot parse value for `' + assignment.key + '`')
      continue
    }
    setTomlKey(current, keyParts, value)
  }
  return { tables, error }
}

/**
 * Split a document into statements: one table header, or one key/value pair.
 *
 * Statements end at a newline only when brackets and braces are balanced, so a
 * multi-line array stays one statement; comments are dropped and strings (with
 * escape and triple-quote handling) are opaque. Without that split, a `]` inside
 * a string could end a header and `#` inside a string could start a comment.
 */
function scanTomlStatements(text) {
  const statements = []
  let buffer = ''
  let line = 1
  let startLine = 1
  let quote = null
  let depth = 0
  const flush = () => {
    const trimmed = buffer.trim()
    if (trimmed !== '') statements.push({ text: trimmed, line: startLine })
    buffer = ''
    startLine = line
  }
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== null) {
      if (quote.length === 3) {
        if (text.startsWith(quote, i)) {
          buffer += quote
          i += 2
          quote = null
          continue
        }
        buffer += ch
        if (ch === '\n') line += 1
        continue
      }
      buffer += ch
      if (quote === '"' && ch === '\\' && i + 1 < text.length) {
        buffer += text[i + 1]
        i += 1
        continue
      }
      if (ch === quote) quote = null
      if (ch === '\n') line += 1
      continue
    }
    if (ch === '#') {
      while (i + 1 < text.length && text[i + 1] !== '\n') i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      const triple = text.startsWith(ch + ch + ch, i)
      quote = triple ? ch + ch + ch : ch
      buffer += quote
      if (triple) i += 2
      continue
    }
    if (ch === '[' || ch === '{') depth += 1
    else if (ch === ']' || ch === '}') depth = Math.max(0, depth - 1)
    if (ch === '\n') {
      line += 1
      if (depth === 0) flush()
      else buffer += ch
      continue
    }
    buffer += ch
  }
  flush()
  return statements
}

/** Split `key = value` at the first top-level `=`. */
function splitTomlAssignment(source) {
  let depth = 0
  let quote = null
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (quote !== null) {
      if (quote === '"' && ch === '\\') {
        i += 1
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '[' || ch === '{') depth += 1
    else if (ch === ']' || ch === '}') depth = Math.max(0, depth - 1)
    else if (ch === '=' && depth === 0) return { key: source.slice(0, i).trim(), value: source.slice(i + 1).trim() }
  }
  return null
}

/** Split a dotted key into its parts, unquoting each. Null when a part is empty. */
function parseTomlKey(keyText) {
  const parts = []
  let buffer = ''
  let quote = null
  for (let i = 0; i < keyText.length; i += 1) {
    const ch = keyText[i]
    buffer += ch
    if (quote !== null) {
      if (quote === '"' && ch === '\\' && i + 1 < keyText.length) {
        buffer += keyText[i + 1]
        i += 1
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '.') {
      parts.push(unquoteTomlKey(buffer.slice(0, -1)))
      buffer = ''
    }
  }
  parts.push(unquoteTomlKey(buffer))
  return parts.some((part) => part === '') ? null : parts
}

/** A key segment with its quotes removed; unquoted segments are returned as written. */
function unquoteTomlKey(text) {
  const trimmed = text.trim()
  if (trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed[trimmed.length - 1] === trimmed[0]) {
    const value = parseTomlValue(trimmed)
    return typeof value === 'string' ? value : trimmed.slice(1, -1)
  }
  return trimmed
}

/** Write a dotted key into a table object, creating intermediate tables. */
function setTomlKey(target, parts, value) {
  let cursor = target
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!isPlainObject(cursor[parts[i]])) cursor[parts[i]] = {}
    cursor = cursor[parts[i]]
  }
  cursor[parts[parts.length - 1]] = value
}

/**
 * Parse one TOML value. Null means "this is not a value I can read", which is
 * the only failure the statement parser treats as an error; an unknown scalar is
 * kept verbatim instead, because the caller can still show what was written.
 */
function parseTomlValue(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return null
  if (text.startsWith('"""') || text.startsWith("'''")) {
    const delimiter = text.slice(0, 3)
    const close = text.lastIndexOf(delimiter)
    const body = close > 2 ? text.slice(3, close) : text.slice(3)
    const trimmed = body.startsWith('\n') ? body.slice(1) : body
    return delimiter === '"""' ? decodeTomlEscapes(trimmed) : trimmed
  }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return decodeTomlEscapes(text.slice(1, -1))
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1)
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) return null
    const items = []
    for (const part of splitTomlList(text.slice(1, -1))) {
      const item = parseTomlValue(part)
      if (item === null) return null
      items.push(item)
    }
    return items
  }
  if (text.startsWith('{')) {
    if (!text.endsWith('}')) return null
    const table = {}
    for (const part of splitTomlList(text.slice(1, -1))) {
      const assignment = splitTomlAssignment(part)
      const keyParts = assignment === null ? null : parseTomlKey(assignment.key)
      const value = assignment === null ? null : parseTomlValue(assignment.value)
      if (keyParts === null || value === null) return null
      setTomlKey(table, keyParts, value)
    }
    return table
  }
  if (text === 'true') return true
  if (text === 'false') return false
  const hex = /^0x([0-9A-Fa-f](?:_?[0-9A-Fa-f])*)$/.exec(text)
  if (hex !== null) return Number.parseInt(hex[1].replace(/_/g, ''), 16)
  const octal = /^0o([0-7](?:_?[0-7])*)$/.exec(text)
  if (octal !== null) return Number.parseInt(octal[1].replace(/_/g, ''), 8)
  const binary = /^0b([01](?:_?[01])*)$/.exec(text)
  if (binary !== null) return Number.parseInt(binary[1].replace(/_/g, ''), 2)
  if (/^[+-]?(?:0|[1-9](?:_?[0-9])*)(?:\.[0-9](?:_?[0-9])*)?(?:[eE][+-]?[0-9]+)?$/.test(text)) return Number(text.replace(/_/g, ''))
  // Dates and times stay strings: nothing here needs a Date, and convert-then-
  // re-render would change their spelling for no reason.
  if (/^\d{4}-\d{2}-\d{2}(?:[Tt ].*)?$/.test(text) || /^\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text)) return text
  // Unknown constructions survive as text rather than vanishing.
  return text
}

/** Split an array or inline-table body at top-level commas. */
function splitTomlList(body) {
  const parts = []
  let buffer = ''
  let depth = 0
  let quote = null
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (quote !== null) {
      buffer += ch
      if (quote === '"' && ch === '\\' && i + 1 < body.length) {
        buffer += body[i + 1]
        i += 1
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      buffer += ch
      continue
    }
    if (ch === '[' || ch === '{') depth += 1
    else if (ch === ']' || ch === '}') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      parts.push(buffer)
      buffer = ''
      continue
    }
    buffer += ch
  }
  if (buffer.trim() !== '') parts.push(buffer)
  return parts.map((part) => part.trim()).filter((part) => part !== '')
}

/** Decode TOML's basic-string escapes. */
function decodeTomlEscapes(value) {
  return value.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|[\s\S])/g, (match, escape) => {
    switch (escape) {
      case 'b':
        return '\b'
      case 't':
        return '\t'
      case 'n':
        return '\n'
      case 'f':
        return '\f'
      case 'r':
        return '\r'
      case 'e':
        return '\u001b'
      case '"':
        return '"'
      case '\\':
        return '\\'
      default: {
        if (escape[0] === 'u' || escape[0] === 'U') {
          const code = Number.parseInt(escape.slice(1), 16)
          return Number.isFinite(code) ? String.fromCodePoint(code) : match
        }
        return match
      }
    }
  })
}

/**
 * Package names declared anywhere in a pyproject's dependency tables.
 *
 * `resolve.js` decides between mypy and ty partly from the dependencies, and it
 * can only import from this module (the two P1 files are the only ones it owns),
 * so the extraction lives here next to the tables it reads.
 *
 * @param tables - the `tables` map from {@link readPyprojectTables}.
 * @returns sorted, normalized package names (`mypy`, `ruff`, `detect-secrets`, …).
 */
export function collectRequirements(tables) {
  const names = new Set()
  const add = (value) => {
    for (const item of Array.isArray(value) ? value : [value]) addRequirementName(names, item)
  }
  const project = tableOf(tables, 'project')
  add(project?.dependencies)
  const optional = tableOf(tables, 'project.optional-dependencies')
  if (optional !== null) for (const group of Object.values(optional)) add(group)
  const groups = tableOf(tables, 'dependency-groups')
  if (groups !== null) for (const group of Object.values(groups)) add(group)
  add(tableOf(tables, 'tool.uv')?.['dev-dependencies'])
  add(tableOf(tables, 'build-system')?.requires)
  return [...names].sort()
}

/** Record one PEP 508 requirement string's package name. */
function addRequirementName(names, item) {
  if (typeof item !== 'string') return
  const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(item)
  if (match === null) return
  names.add(match[1].toLowerCase().replace(/[_.]+/g, '-'))
}

/** Whether a project-relative path names a regular file. */
async function pathIsFile(root, relative) {
  try {
    const info = await stat(path.join(root, relative))
    return info.isFile()
  } catch {
    return false
  }
}

/**
 * The container image size limit a pyproject declares, or null.
 *
 * `[tool.gatekeeper.image].max_size_mb` is the only place the limit lives: it
 * travels with the project, so there is no second configuration source.
 */
function parseImageLimit(tables) {
  const imageTable = tableOf(tables, 'tool.gatekeeper.image')
  if (imageTable === null) return null
  const raw = imageTable['max_size_mb'] ?? imageTable['max-size-mb']
  const value = typeof raw === 'string' ? Number(raw) : raw
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Whether `git commit` will run a hook, and whether that hook is prek's.
 *
 * `.git` is a directory in a normal clone and a *file* in a linked worktree, so
 * both shapes are followed (through `gitdir:` and then `commondir`, which is
 * where a worktree's real hooks live). `core.hooksPath` is not consulted: a
 * project that moved its hooks elsewhere is outside what this plugin claims to
 * know, and guessing would produce a false "not installed".
 */
async function inspectGitHooks(root) {
  for (const hooksDir of await gitHooksDirs(root)) {
    const hook = await readText(path.join(hooksDir, 'pre-commit'))
    if (hook === MISSING) continue
    return { installed: true, pointsToPrek: /prek/i.test(hook) }
  }
  return { installed: false, pointsToPrek: false }
}

/** The candidate directories that hold a repository's hooks. */
async function gitHooksDirs(root) {
  const dotGit = path.join(root, '.git')
  let info
  try {
    info = await stat(dotGit)
  } catch {
    return []
  }
  if (info.isDirectory()) return [path.join(dotGit, 'hooks')]
  if (!info.isFile()) return []
  const pointer = await readText(dotGit)
  const match = pointer === MISSING ? null : /^\s*gitdir\s*:\s*(.+?)\s*$/m.exec(pointer)
  if (match === null) return []
  const gitDir = path.resolve(root, match[1].trim())
  const dirs = [path.join(gitDir, 'hooks')]
  const common = await readText(path.join(gitDir, 'commondir'))
  const commonName = common === MISSING ? null : firstMeaningfulLine(common)
  if (commonName !== null) dirs.push(path.join(path.resolve(gitDir, commonName), 'hooks'))
  return dirs
}

/** The v0.10 fact blocks in their "nothing was found" shape. */
function emptyExtendedFacts() {
  return {
    workspace: { isWorkspace: false, members: [], sources: [] },
    buildBackend: null,
    mypy: { configured: false, hasConfigTable: false },
    secrets: { baseline: false, helper: false },
    validator: { script: false, manifest: false },
    container: { reportScript: false, imageLimit: null },
    gitHooks: { installed: false, pointsToPrek: false },
    // `ok: false` means "this directory could not be read", not "there is nothing
    // to say". The blocks below are what a tool reads to describe an existing
    // project, so leaving them out makes the failure a `TypeError` in the caller
    // instead of the one actionable line ("cannot inspect …") it was about to
    // print. They are filled with the same shapes the success path returns, empty.
    workflows: [],
    linterConfigFiles: [],
    foreignLockfiles: [],
    linters: {},
    markers: {},
    notes: [],
    hasPyproject: false,
    pythonVersion: null,
    pythonVersionSource: null,
    requiresPython: null,
    pinnedVersion: null,
    hasUvLock: false,
    hasDependencyGroups: false,
    hasLegacyDevDependencies: false,
    hasWorkflowDir: false,
  }
}

/**
 * The `requires-python` value from a pyproject document.
 *
 * This is a scan, not a table read: a `requires-python` line under `[project]` is
 * a quoted string, the same shape in every pyproject that has one, and this
 * one-value function does not need the full reader below. The scan is anchored to
 * `[project]` so `[tool.uv]`'s own `requires-python` (a different field with
 * different meaning) cannot be mistaken for it.
 */
export function parseRequiresPython(toml) {
  if (typeof toml !== 'string') return null
  const header = /^\s*\[project\]\s*$/m.exec(toml)
  if (header === null) return null
  const rest = toml.slice(header.index + header[0].length)
  // The `[project]` table ends at the next table header, or at the end of the
  // document. Slicing the table out first is what keeps `[tool.uv]`'s own
  // `requires-python` out of the answer.
  const nextHeader = /^\s*\[[^\]]*\]\s*$/m.exec(rest)
  const table = nextHeader === null ? rest : rest.slice(0, nextHeader.index)
  const match = /^\s*requires-python\s*=\s*["']([^"']+)["']/m.exec(table)
  return match === null ? null : match[1].trim()
}

/**
 * Summarize one workflow file: what it triggers on and which toolchains it already uses.
 *
 * The point of the summary is that `py-ci-render` should not hand a project a
 * second, conflicting CI pipeline without the caller seeing that it already has
 * one. Reading the existing files is the cheapest way to make that visible.
 */
export function summarizeWorkflow(file, text) {
  const source = typeof text === 'string' ? text : ''
  return {
    file,
    usesSetupUv: /uses:\s*astral-sh\/setup-uv@/.test(source),
    usesSetupPython: /uses:\s*actions\/setup-python@/.test(source),
    // A JavaScript toolchain in a Python project's CI is the exact smell this
    // plugin exists to catch.
    usesNodeToolchain: /uses:\s*actions\/setup-node@/.test(source) || /npm (ci|install|test|run)\b/.test(source),
    triggersPush: /^\s{0,4}push\s*:/m.test(source),
    triggersPullRequest: /^\s{0,4}pull_request\s*:/m.test(source),
  }
}

/**
 * Read a project's Python toolchain facts.
 *
 * Never throws for a missing directory: `ok: false` plus `error` is the answer,
 * because "there is no project here" is a fact the caller must be able to see
 * rather than an incident.
 *
 * @param rootDir - the directory to inspect, usually the calling session's workspace.
 * @returns a plain object; see `schema.js` for the documented shape.
 */
export async function detect(rootDir) {
  const root = path.resolve(String(rootDir ?? ''))
  const detectedAt = new Date().toISOString()

  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    return {
      ok: false,
      root,
      detectedAt,
      error: error instanceof Error ? error.message : String(error),
      packageManager: 'unknown',
      blockers: [],
      confidence: 'none',
      // The shape of every fact block is kept even on failure, so a consumer can
      // read `detection.workspace.isWorkspace` without a guard on `ok`.
      ...emptyExtendedFacts(),
    }
  }

  // File vs directory matters: `uv.lock` as a directory is not a lockfile, and
  // `src/` as a file is not a source tree.
  const files = new Set()
  const dirs = new Set()
  for (const entry of entries) {
    if (entry.isFile() || entry.isSymbolicLink()) files.add(entry.name.toLowerCase())
    else if (entry.isDirectory()) dirs.add(entry.name.toLowerCase())
  }
  const exists = (name) => files.has(name.toLowerCase())

  const pyproject = readPyprojectTables(root)
  const pyprojectText = pyproject.text
  const tables = pyproject.tables

  // Build backend, read here because the package-manager check below is the first
  // reader: a project with no lockfile yet is still uv's if it builds with
  // `uv_build` or carries a `[tool.uv]` table.
  const buildSystem = tableOf(tables, 'build-system')
  const declaredBuildBackend = asString(buildSystem?.['build-backend'])
  const buildRequires = asStringList(buildSystem?.requires)
  let buildBackend = null
  if (declaredBuildBackend !== null) {
    if (/^uv_build(?:\.|$)/.test(declaredBuildBackend)) buildBackend = 'uv_build'
    else if (/^hatchling(?:\.|$)/.test(declaredBuildBackend)) buildBackend = 'hatchling'
    else if (/^setuptools(?:\.|$)/.test(declaredBuildBackend)) buildBackend = 'setuptools'
  } else if (buildRequires.some((requirement) => /^uv_build(?:\.|$)/.test(requirement))) {
    buildBackend = 'uv_build'
  }

  // ------------------------------------------------------------ package manager
  //
  // Lockfile order encodes precedence: a uv lockfile is the strongest evidence
  // uv owns the project, and it wins over a stale foreign lockfile left behind by
  // a migration in progress. The blockers array still reports that leftover file,
  // so "uv.lock plus a poetry.lock this project forgot to delete" reads as uv with
  // a warning rather than as an ambiguous project.
  //
  // A fresh `uv init` project has no `uv.lock` — the lockfile appears at the
  // first `uv sync`/`uv lock` — so the lockfile alone would label the exact
  // project this plugin should take over as `unknown`. Two stronger markers are
  // checked alongside it: uv's own build backend and a `[tool.uv]` table.
  const uvBackend = buildBackend === 'uv_build' || /requires\s*=\s*\[[^\]]*["']uv_build/m.test(pyprojectText ?? '')
  const uvTablePresent = hasTableFamily(pyprojectText, 'tool.uv')
  const foreignLockfiles = FOREIGN_LOCKFILES.filter((name) => exists(name))
  let packageManager = 'unknown'
  if (exists(UV_LOCKFILE) || uvBackend || uvTablePresent) packageManager = 'uv'
  else if (exists('poetry.lock')) packageManager = 'poetry'
  else if (exists('pdm.lock')) packageManager = 'pdm'
  else if (exists('Pipfile.lock')) packageManager = 'pipenv'

  // -------------------------------------------------------------- python version
  //
  // `.python-version` is what uv and pyenv actually read, so it outranks the
  // pyproject declaration: a project can declare `>=3.11` and still pin 3.13.
  //
  // `pythonVersion` is always a *value* (`3.13`), never a specifier: it used to
  // carry `>=3.9` straight through from `requires-python`, and every consumer
  // that expected a version either produced nonsense or silently fell back to
  // the default. The specifier is kept separately in `requiresPython`, and the
  // lower bound of it becomes the target when nothing pins one.
  const pythonVersionFile = await readText(path.join(root, '.python-version'))
  const pinnedVersion = pythonVersionFile === MISSING ? null : firstMeaningfulLine(pythonVersionFile)
  const requiresPython = parseRequiresPython(pyprojectText)
  const pinnedAsVersion = isConcreteVersion(pinnedVersion) ? normalizeVersion(pinnedVersion) : null
  const requiresAsVersion = minimumOfSpecifier(requiresPython)
  const pythonVersion = pinnedAsVersion ?? requiresAsVersion ?? null
  const pythonVersionSource = pinnedAsVersion !== null
    ? '.python-version'
    : (requiresAsVersion !== null ? 'pyproject.toml' : null)

  // ------------------------------------------------------------------ test layout
  //
  // The pytest snippet used to hardcode `testpaths = ["src/tests"]` unless the
  // caller overrode it. `uv init --package` puts tests in `src/<pkg>/tests` only
  // if you create them there, and virtually every other layout — `tests/`,
  // `test/`, `src/<pkg>/tests/` — then gets a testpaths pointing at a directory
  // that does not exist. pytest warns, collects nothing from the intended place,
  // and coverage measures 0%, so the gate fails on a project that is perfectly
  // fine. Detect the directories instead of guessing one.
  const TEST_DIR_NAMES = ['tests', 'test', 'testing']
  const testDirs = []
  const collectTestDirs = (prefix, names) => {
    for (const name of TEST_DIR_NAMES) {
      if (!names.has(name)) continue
      testDirs.push(prefix === '' ? name : prefix + '/' + name)
    }
  }
  collectTestDirs('', dirs)
  // Nested layout: `src/<package>/tests`. One level only — a deeper sweep would
  // make detection cost track repository size.
  if (dirs.has('src')) {
    try {
      const srcEntries = await readdir(path.join(root, 'src'), { withFileTypes: true })
      for (const entry of srcEntries) {
        if (!entry.isDirectory()) continue
        const nested = new Set()
        try {
          const inside = await readdir(path.join(root, 'src', entry.name), { withFileTypes: true })
          for (const child of inside) if (child.isDirectory()) nested.add(child.name.toLowerCase())
        } catch {
          continue
        }
        await collectTestDirs('src/' + entry.name, nested)      }
    } catch {
      // A src/ we cannot read just means no nested test layout is reported.
    }
  }

  // --------------------------------------------------------------------- linters
  //
  // `hasTableFamily` rather than exact headers: `[tool.ruff.lint]`,
  // `[tool.ty.terminal]` and `[tool.pytest.ini_options]` are how these tools are
  // actually configured most of the time, and a project that has one of those is
  // not a project missing the tool.
  const hasPyproject = pyprojectText !== null
  const linters = {
    ruff: hasTableFamily(pyprojectText, 'tool.ruff') || exists('ruff.toml') || exists('.ruff.toml'),
    mypy: hasTableFamily(pyprojectText, 'tool.mypy') || exists('mypy.ini'),
    ty: hasTableFamily(pyprojectText, 'tool.ty'),
    pytest: hasTableFamily(pyprojectText, 'tool.pytest') || exists('pytest.ini'),
    black: hasTableFamily(pyprojectText, 'tool.black'),
    preCommit: exists('.pre-commit-config.yaml') || exists('.pre-commit-config.yml'),
  }
  const linterConfigFiles = [
    'ruff.toml', '.ruff.toml', 'mypy.ini', 'pytest.ini', '.pre-commit-config.yaml',
  ].filter((name) => exists(name))

  // -------------------------------------------------------------- dependency groups
  //
  // `[dependency-groups]` (PEP 735) is what uv syncs with `--all-groups`; the
  // legacy `[tool.uv] dev-dependencies` table is the older spelling. Telling the
  // two apart is what lets `py-bootstrap` avoid proposing a second mechanism.
  const hasDependencyGroups = hasSection(pyprojectText, 'dependency-groups')
  const hasLegacyDevDependencies = hasTableFamily(pyprojectText, 'tool.uv') && /dev-dependencies\s*=/.test(pyprojectText ?? '')

  // ------------------------------------------------------------------- workflows
  const workflows = []
  let hasWorkflowDir = false
  try {
    const workflowEntries = await readdir(path.join(root, ...WORKFLOW_DIR), { withFileTypes: true })
    hasWorkflowDir = true
    for (const entry of workflowEntries) {
      if (!entry.isFile()) continue
      if (!/\.ya?ml$/i.test(entry.name)) continue
      const relative = path.posix.join(...WORKFLOW_DIR, entry.name)
      const text = await readText(path.join(root, ...WORKFLOW_DIR, entry.name))
      workflows.push(summarizeWorkflow(relative, text === MISSING ? '' : text))
    }
  } catch {
    hasWorkflowDir = false
  }

  // --------------------------------------------------------------- v0.10 facts
  //
  // The gates need to know what the project already has, not just what it lacks:
  // a workspace root builds with `--all-packages`, an existing `[tool.mypy]` means
  // the type gate runs mypy, an installed commit hook means the local gate will
  // actually fire. Reading it once here keeps `resolve.js` from re-deriving a fact
  // from a second read that could disagree with this one.
  const workspaceTable = tableOf(tables, 'tool.uv.workspace')
  const declaredMembers = asStringList(workspaceTable?.members)
  const uvSources = tableOf(tables, 'tool.uv.sources')
  const workspaceSources = uvSources === null
    ? []
    : Object.entries(uvSources).filter(([, value]) => isPlainObject(value) && value.workspace === true).map(([name]) => name)
  const workspace = {
    // Members stay as written, globs included: expanding a glob is a filesystem
    // question, and the one place that answers it is `resolve.js`, where the paths
    // are actually used.
    isWorkspace: workspaceTable !== null || workspaceSources.length > 0,
    members: declaredMembers,
    sources: [
      ...(workspaceTable !== null ? ['tool.uv.workspace'] : []),
      ...(declaredMembers.length > 0 ? ['tool.uv.workspace.members'] : []),
      ...(workspaceSources.length > 0 ? ['tool.uv.sources'] : []),
    ],
  }

  const requirementNames = collectRequirements(tables)
  const hasMypyTable = hasTableFamily(pyprojectText, 'tool.mypy')
  const mypy = {
    // Any of the three means a mypy gate would find its settings in this project.
    configured: hasMypyTable || exists('mypy.ini') || requirementNames.includes('mypy'),
    // Kept apart from `configured`: a pyproject table is something a generator may
    // merge into, while an `mypy.ini` is a file it must leave alone.
    hasConfigTable: hasMypyTable,
  }

  // Artifacts the v0.10 gates read, run, or install. Each boolean is "the project
  // already carries this", which is what makes "generate only what is missing"
  // possible instead of overwriting a project's own work.
  const secrets = {
    baseline: exists('.secrets.baseline'),
    helper: await pathIsFile(root, 'scripts/secret_scan.py'),
  }
  const validator = {
    script: await pathIsFile(root, 'scripts/validate_version_manifest.py'),
    manifest: await pathIsFile(root, 'release/agent_versions.json'),
  }
  const container = {
    reportScript: await pathIsFile(root, 'scripts/container_report.py'),
    imageLimit: parseImageLimit(tables),
  }
  const gitHooks = await inspectGitHooks(root)

  // ------------------------------------------------------------------- blockers
  //
  // One entry per foreign lockfile, and the reason carries the source sentence.
  // A caller reading only `blockers[0].reason` still learns why.
  const blockers = foreignLockfiles.map((file) => ({
    code: 'foreign-lockfile',
    file,
    reason:
      `"${file}" means another tool manages this project's dependencies. ` +
      `The 1-uv skill is explicit — "${UV_SCOPE_QUOTE}" — so this plugin will not ` +
      'generate uv configuration or a uv-based workflow here. Either migrate the ' +
      'project to uv first (the 2-modern-python migration checklist covers it), or ' +
      'keep the existing tool and skip these tools.',
  }))

  // A project with a pyproject but no lockfile is still a Python project; one with
  // nothing at all may be an empty directory or a monorepo root, and the caller
  // should ask rather than assume.
  const markers = [
    hasPyproject, exists('requirements.txt'), exists('setup.py'), exists('setup.cfg'),
    exists('Pipfile'), exists('uv.lock'), exists('poetry.lock'), exists('pdm.lock'),
  ].filter(Boolean).length
  const confidence = markers >= 2 ? 'high' : (markers === 1 ? 'medium' : 'low')

  const notes = []
  if (!hasPyproject) notes.push('No pyproject.toml at this directory: the tools suggest creating one before adding tool configuration.')
  if (dirs.has('src')) notes.push('A src/ directory is present: the pytest snippet points testpaths at src/tests, adjust if your tests live elsewhere.')
  if (workflows.length > 0 && !workflows.some((workflow) => workflow.usesSetupUv)) {
    notes.push('Existing workflows do not use astral-sh/setup-uv: compare them with what py-ci-render proposes before adding another pipeline.')
  }
  if (confidence === 'low') notes.push('Nothing that identifies a Python project was found at this directory. If this is a monorepo, pass the subproject path instead.')

  return {
    ok: true,
    root,
    detectedAt,
    packageManager,
    foreignLockfiles,
    hasPyproject,
    pythonVersion,
    pythonVersionSource,
    requiresPython,
    pinnedVersion,
    hasUvLock: exists(UV_LOCKFILE),
    hasDependencyGroups,
    hasLegacyDevDependencies,
    linters,
    linterConfigFiles,
    workflows,
    hasWorkflowDir,
    blockers,
    confidence,
    notes,
    markers: {
      pyproject: hasPyproject,
      requirementsTxt: exists('requirements.txt'),
      setupPy: exists('setup.py'),
      setupCfg: exists('setup.cfg'),
      srcDir: dirs.has('src'),
      testsDir: dirs.has('tests') || testDirs.length > 0,
      testDirs: [...new Set(testDirs)],
      toxIni: exists('tox.ini'),
      noxfile: exists('noxfile.py'),
      // Container evidence is a marker rather than a blocker: a project with a
      // Dockerfile is not "blocked", it is a project the container gate can
      // actually check.
      dockerfile: exists('Dockerfile') || exists('dockerfile') || exists('Dockerfile.dev'),
      composeFile: ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml', 'docker-compose.yaml']
        .some((name) => exists(name)),
    },
    // v0.10 facts. Each is an observation, not a gate value: `resolve.js` turns
    // them into `{ value, source }` pairs.
    workspace,
    buildBackend,
    mypy,
    secrets,
    validator,
    container,
    gitHooks,
  }
}

/**
 * Whether a detection permits generating uv configuration.
 *
 * A single predicate for all the generating tools, so they cannot drift apart on
 * what "blocked" means.
 *
 * @param detection - a {@link detect} result.
 * @returns `{ blocked, reason }`; `blocked` is false when generation is safe.
 */
export function uvBlockedReason(detection) {
  const blockers = Array.isArray(detection?.blockers) ? detection.blockers : []
  if (blockers.length === 0) return { blocked: false, reason: null }
  return {
    blocked: true,
    reason: blockers.map((blocker) => blocker.reason).join('\n'),
  }
}
