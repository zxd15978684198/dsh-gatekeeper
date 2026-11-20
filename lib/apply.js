// Writing the configuration the other tools only describe.
//
// This is the module that makes the difference between advice and a working
// project, so it is also the module where restraint matters most. Three rules,
// and they are not negotiable:
//
// 1. A fixed allowlist of files. Not "any path under the project": nine paths,
//    named here, each one a file the bundled skills actually prescribe. A tool
//    that can write anywhere is a tool whose write scope nobody can review.
//
//    `release/agent_versions.json` is a fourth kind of target and the strictest:
//    it exists, it is not replaced, and it is not merged. A manifest is evidence,
//    so a second run reports the diff between the file on disk and what the probe
//    sees today and leaves the decision to a human. `overwrite` does not apply.
//
// 2. Never a blind overwrite. `pyproject.toml` is merged table by table, and the
//    merge distinguishes two kinds of table. Tables this generator owns (see
//    `OWNED_TABLE_HEADERS`) are replaced when their body differs, because a stale
//    copy of a table we wrote is a bug we are able to fix: writing
//    `testpaths = ["src/tests"]` before the tests existed used to be permanent,
//    with `status: unchanged` claiming success. Every other table — `[project]`,
//    `[dependency-groups]`, anything a human added — is left exactly as it is even
//    when it disagrees. The other files are compared first: identical content
//    writes nothing, different content comes back as a conflict with a diff and
//    needs `overwrite: true` to proceed. The reason is the same in both cases —
//    the user's file may already contain a hook, an ignore, or a comment that no
//    generator will ever reproduce, and losing it is an information leak from the
//    user's head to /dev/null.
//
// 3. Backup before write, always, next to the original. A backup that requires
//    the write to have gone well is not a backup.
//
// The CONTENT is not decided here. Every payload comes from the same renderers
// the read-only tools use (`pyproject.js`, `prek.js`, `dependabot.js`,
// `ci-render.js`, `local.js`), so `py-apply` cannot drift from `py-bootstrap`:
// they are the same text, and applying one is committing to the other.

import { copyFile, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { diffManifest } from './manifest.js'

/** The file targets this module may write, by id. */
export const TARGET_FILES = {
  pyproject: 'pyproject.toml',
  prek: '.pre-commit-config.yaml',
  dependabot: '.github/dependabot.yml',
  // The workflow name is part of the target, so it is resolved separately.
  workflow: '.github/workflows',
  'ci-script': 'scripts/ci.py',
  manifest: 'release/agent_versions.json',
  validator: 'scripts/validate_version_manifest.py',
  'secret-scan': 'scripts/secret_scan.py',
  'container-report': 'scripts/container_report.py',
}

/** The target ids, in the order a fresh project would want them. */
export const APPLY_TARGETS = [
  'pyproject',
  'prek',
  'dependabot',
  'workflow',
  'ci-script',
  'manifest',
  'validator',
  'secret-scan',
  'container-report',
]

/** A timestamp safe in a file name on Windows and on Linux. */
export function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

/** Whether `value` is one of {@link APPLY_TARGETS}. */
export function isApplyTarget(value) {
  return typeof value === 'string' && APPLY_TARGETS.includes(value)
}

/**
 * Resolve a workflow file name to something that stays inside the directory.
 *
 * A name carrying `..` or a separator would escape `.github/workflows`, which is
 * exactly the kind of "it is only a file name" argument that turns a generator
 * into a file-writing primitive.
 */
export function safeWorkflowName(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  const withExtension = raw === ''
    ? ''
    : (raw.endsWith('.yml') || raw.endsWith('.yaml') ? raw : raw + '.yml')
  if (withExtension === '') return null
  if (!/^[A-Za-z0-9._-]+$/.test(withExtension)) return null
  if (withExtension.startsWith('.')) return null
  // Windows reserves these device names *with any extension*: `CON.yml` is the
  // console, not a file. Such a workflow can be created locally and then never
  // pushed — `git add` fails with "invalid path" — so the generator refuses the
  // name instead of producing a repository that cannot be committed on Windows.
  const stem = withExtension.replace(/\.ya?ml$/i, '')
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) return null
  return withExtension
}

/**
 * The project-relative path a target writes to.
 *
 * @returns the relative path with forward slashes, or null when the target needs
 *   a workflow name that was not supplied (or was unsafe).
 */
export function targetRelPath(target, options = {}) {
  if (!isApplyTarget(target)) return null
  if (target !== 'workflow') return TARGET_FILES[target]
  const name = safeWorkflowName(options.fileName)
  if (name === null) return null
  return TARGET_FILES.workflow + '/' + name
}

/**
 * Join under a root and prove the result is still under it.
 *
 * `path.join` already normalises `..`, so the check is on the resolved result
 * rather than on the caller's string. That check is lexical, though, and a
 * lexical check cannot see a link: a project that contains `.github` as a
 * junction pointing outside is, string-wise, perfectly normal. So the root is
 * resolved to its real path, and every component *below* it is then `lstat`ed
 * and rejected when it is a symbolic link (junction included). A link below the
 * root is a write target nobody reviewed.
 *
 * The root itself is deliberately not rejected when it is a link. A project
 * reached through a junction is a normal way to work, and the write lands in the
 * directory the caller named, next to its own backup. Only links *inside* the
 * project are the escape.
 *
 * @returns the absolute path, or null when it escapes the root or crosses a link.
 */
export async function safeJoin(root, relPath) {
  if (/[\u0000]/.test(String(relPath))) return null
  let base
  try {
    base = await realpath(path.resolve(root))
  } catch {
    // A root that cannot be resolved (missing, inaccessible) is not writable.
    return null
  }
  const full = path.resolve(base, ...String(relPath).split('/'))
  const withSeparator = base.endsWith(path.sep) ? base : base + path.sep
  if (full !== base && !full.startsWith(withSeparator)) return null
  let cursor = full
  while (cursor !== base) {
    const info = await lstat(cursor).catch(() => null)
    if (info !== null && info.isSymbolicLink()) return null
    cursor = path.dirname(cursor)
  }
  return full
}

/**
 * Read a file, or null when it does not exist.
 *
 * Distinguishing "missing" from "unreadable" matters: a missing file is a create,
 * an unreadable one is a refusal, and reporting the second as the first would
 * happily overwrite a file the process cannot read.
 *
 * A link is never read, and never treated as missing either. `stat` follows a
 * link, so a dangling one reports ENOENT and turns the create branch into a write
 * *through* the link — outside the project. `lstat` sees the link itself, and the
 * existing "not a regular file" refusal is the right answer for it.
 */
export async function readIfPresent(target) {
  try {
    const info = await lstat(target)
    if (info.isSymbolicLink() || !info.isFile()) {
      return { exists: false, reason: 'not a regular file' }
    }
    return { exists: true, text: await readFile(target, 'utf8') }
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, text: null }
    return { exists: false, text: null, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Split a TOML document into chunks, one per table header.
 *
 * A chunk owns the comment block directly above its header, because those
 * comments explain the table and must travel with it. Blank lines are not
 * swallowed: they are separators, and pulling them into a chunk would let the
 * append path emit two chunks with no blank line between them.
 *
 * @returns `[{ header | null, text }]`; `header` is null for the preamble.
 */
export function splitTomlChunks(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const headerIndexes = []
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*\[\[?.+?\]\]?\s*$/.test(lines[index])) headerIndexes.push(index)
  }
  if (headerIndexes.length === 0) return [{ header: null, text: lines.join('\n') }]

  /** Walk back over the comment block that introduces a header. */
  const startOfChunk = (headerIndex) => {
    let start = headerIndex
    while (start > 0 && /^\s*#/.test(lines[start - 1])) start -= 1
    return start
  }

  const chunks = []
  const firstStart = startOfChunk(headerIndexes[0])
  if (firstStart > 0) chunks.push({ header: null, text: lines.slice(0, firstStart).join('\n') })
  headerIndexes.forEach((headerIndex, position) => {
    const start = startOfChunk(headerIndex)
    const end = position + 1 < headerIndexes.length
      ? startOfChunk(headerIndexes[position + 1])
      : lines.length
    chunks.push({ header: lines[headerIndex].trim(), text: lines.slice(start, end).join('\n') })
  })
  return chunks
}

/** The set of table headers a TOML document already declares. */
export function tomlHeaders(text) {
  const headers = new Set()
  for (const chunk of splitTomlChunks(text)) {
    if (chunk.header !== null) headers.add(chunk.header)
  }
  return headers
}

/**
 * Table headers this generator owns and may therefore rewrite.
 *
 * Only `[tool.*]` configuration that this plugin emits itself: the ruff, pytest,
 * coverage and ty blocks. Everything else — `[project]`, `[dependency-groups]`,
 * `[build-system]`, any table a human added — is never touched, because the
 * generator has no business deciding what belongs there.
 *
 * The distinction matters because the two kinds of staleness look identical in
 * the file. A stale `[tool.pytest.ini_options]` is a bug in output we produced
 * and can fix; a `[tool.ruff.lint]` a team tuned over months is their decision,
 * and rewriting it is the failure mode that makes people distrust generators.
 * Prefix matching covers sub-tables like `[tool.ruff.lint.per-file-ignores]`.
 */
export const OWNED_TABLE_PREFIXES = [
  '[tool.ruff]',
  '[tool.ruff.lint]',
  '[tool.ruff.format]',
  '[tool.pytest.ini_options]',
  '[tool.coverage.',
  '[tool.ty.',
]

/** Whether this generator may replace the table with this header. */
export function isOwnedTable(header) {
  if (typeof header !== 'string') return false
  return OWNED_TABLE_PREFIXES.some((prefix) => (
    prefix.endsWith('.') ? header.startsWith(prefix) : header === prefix
  ))
}

/**
 * The marker comment this module writes above tables it appends.
 *
 * It is a line in the document, not metadata, so a re-read sees it as ordinary
 * text — specifically as a comment block attached to the table that follows it,
 * except that `splitTomlChunks` stops at the blank line between them and leaves
 * the marker at the tail of the *previous* chunk. That asymmetry made a second
 * run report `update` forever: the stored chunk ended with the marker, the
 * proposal did not. Comparison drops the marker; replacement drops it too.
 */
const SEPARATOR_LINE = '# --- appended by gatekeeper ---'

/**
 * Normalize a chunk body for comparison.
 *
 * Two differences carry no meaning in TOML and must not count as a change:
 * CRLF vs LF, and trailing blank lines. The separator marker is dropped for the
 * same reason — it is this module's own bookkeeping, not the table's content.
 */
function sameBody(left, right) {
  const normalize = (text) => String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line.trim() !== SEPARATOR_LINE)
    .join('\n')
    .replace(/\s+$/, '')
  return normalize(left) === normalize(right)
}

/**
 * Merge the block's tables into an existing TOML document.
 *
 * Three outcomes per table, and the third is the one that was missing:
 *
 *   - header absent            → append it (`added`)
 *   - header present, owned, body differs → replace it in place (`replaced`)
 *   - header present, otherwise → leave it alone (`skipped`)
 *
 * Replacement keeps the table where it already is, so the file's ordering and any
 * hand-written comments elsewhere in the document survive. The replaced table gets
 * a one-line note naming the backup, so a reader looking at the file later can tell
 * that a machine changed that block and where the previous version went.
 *
 * @returns `{ text, added, replaced, skipped, changed }`.
 */
export function appendMissingTables(existingText, blockText) {
  const existing = String(existingText ?? '')
  const blockChunks = splitTomlChunks(blockText)
  const proposed = new Map()
  for (const chunk of blockChunks) {
    if (chunk.header !== null) proposed.set(chunk.header, chunk)
  }

  const existingChunks = splitTomlChunks(existing)
  const added = []
  const replaced = []
  const skipped = []

  for (const chunk of existingChunks) {
    if (chunk.header === null) continue
    const offer = proposed.get(chunk.header)
    if (offer === undefined) continue
    if (!isOwnedTable(chunk.header)) {
      skipped.push(chunk.header)
      continue
    }
    if (sameBody(chunk.text, offer.text)) continue
    replaced.push(chunk.header)
    chunk.text = offer.text.trimEnd()
  }

  for (const [header, chunk] of proposed) {
    const present = existingChunks.some((entry) => entry.header === header)
    if (!present) added.push(header)
  }

  const out = existingChunks.map((chunk) => chunk.text.trimEnd()).filter((text) => text !== '')
  if (added.length > 0) {
    const tail = blockChunks
      .filter((chunk) => chunk.header !== null && added.includes(chunk.header))
      .map((chunk) => chunk.text.trimEnd())
      .join('\n\n')
    out.push('# --- appended by gatekeeper ---')
    out.push('')
    out.push(tail)
  }

  const changed = added.length > 0 || replaced.length > 0
  if (!changed) {
    return { text: existing, added, replaced, skipped, changed: false }
  }
  return { text: out.join('\n\n').replace(/\s*$/, '') + '\n', added, replaced, skipped, changed: true }
}

/**
 * A compact diff: what changed, without dumping two whole files.
 *
 * Line counts plus the first few changed lines is what a reader needs to decide
 * "yes, that is my file plus the new table" or "no, that removed something".
 */
export function diffSummary(before, after, limit = 12) {
  const left = String(before ?? '').split(/\r?\n/)
  const right = String(after ?? '').split(/\r?\n/)
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  const removed = left.filter((line) => !rightSet.has(line))
  const addedLines = right.filter((line) => !leftSet.has(line))
  return {
    addedLines: addedLines.length,
    removedLines: removed.length,
    // `-` and `+` prefixed, truncated: the reader needs shape, not a patch file.
    sample: [
      ...removed.slice(0, limit).map((line) => '- ' + line),
      ...addedLines.slice(0, limit).map((line) => '+ ' + line),
    ],
  }
}

/**
 * A manifest diff, in the shape {@link diffSummary} returns.
 *
 * `diffManifest` speaks in JSON pointers (`~ agent.tools.version: 1 → 2`), which is
 * the only form in which "which component changed" is readable; a line diff of the
 * pretty-printed JSON says the same thing as a wall of brace-only changes. Both
 * directions count as changes: a new component and a removed one are equally
 * reviewable, and `~` counts on both sides because the old and the new value differ.
 */
function manifestDiffSummary(lines) {
  const addedLines = lines.filter((line) => line.startsWith('+ ') || line.startsWith('~ ')).length
  const removedLines = lines.filter((line) => line.startsWith('- ') || line.startsWith('~ ')).length
  return {
    addedLines,
    removedLines,
    sample: lines.slice(0, 12),
    changedPointers: lines.length,
  }
}

/**
 * Decide what applying a payload to one file would do, without doing it.
 *
 * @param options - `{ target, root, payload, overwrite }`.
 * @returns `{ status, file, absolute, nextText, ... }` where `status` is one of
 *   `create` | `append` | `diff` | `unchanged` | `conflict` | `update` | `refused`.
 */
export async function planWrite({ target, root, relPath, payload, overwrite = false, mode = 'whole' }) {
  const absolute = await safeJoin(root, relPath)
  if (absolute === null) {
    return {
      status: 'refused',
      reason: 'resolved path escapes the project root: ' + relPath,
      file: relPath,
      absolute: null,
    }
  }
  const current = await readIfPresent(absolute)
  if (current.reason !== undefined && current.reason !== 'not a regular file') {
    return { status: 'refused', reason: current.reason, file: relPath, absolute }
  }
  if (current.reason === 'not a regular file') {
    return {
      status: 'refused',
      reason: relPath + ' exists and is not a regular file (a directory or a link to one)',
      file: relPath,
      absolute,
    }
  }

  if (current.exists === false) {
    return {
      status: 'create',
      file: relPath,
      absolute,
      nextText: payload,
      added: [],
      skipped: [],
      changed: true,
    }
  }

  if (mode === 'toml-append') {
    const merged = appendMissingTables(current.text, payload)
    if (!merged.changed) {
      return {
        status: 'unchanged',
        file: relPath,
        absolute,
        nextText: current.text,
        added: [],
        replaced: [],
        skipped: merged.skipped,
        changed: false,
      }
    }
    return {
      status: merged.replaced.length > 0 ? 'update' : 'append',
      file: relPath,
      absolute,
      nextText: merged.text,
      added: merged.added,
      replaced: merged.replaced,
      skipped: merged.skipped,
      changed: true,
      diff: diffSummary(current.text, merged.text),
    }
  }

  if (mode === 'manifest-diff') {
    // Evidence is reviewed, never regenerated over a human's edits: a manifest
    // that the probe silently rewrote would lose exactly the record of "the files
    // changed, approve the new digests" that the validator exists to enforce.
    // `overwrite` is deliberately ignored here; it applies to renderer-owned files.
    let existing
    try {
      existing = JSON.parse(current.text)
    } catch (error) {
      return {
        status: 'refused',
        reason: relPath + ' is not valid JSON, so there is nothing to diff against: '
          + (error instanceof Error ? error.message : String(error)),
        file: relPath,
        absolute,
      }
    }
    let next
    try {
      next = JSON.parse(payload)
    } catch (error) {
      return {
        status: 'refused',
        reason: 'internal error: the generated manifest is not valid JSON: '
          + (error instanceof Error ? error.message : String(error)),
        file: relPath,
        absolute,
      }
    }
    const diff = diffManifest(existing, next)
    if (!diff.changed) {
      return {
        status: 'unchanged',
        file: relPath,
        absolute,
        nextText: current.text,
        added: [],
        skipped: [],
        changed: false,
      }
    }
    return {
      status: 'diff',
      file: relPath,
      absolute,
      // Not written: `diff` is a report, and `commitWrite` has no branch for it.
      nextText: payload,
      added: [],
      skipped: [],
      changed: true,
      diff: manifestDiffSummary(diff.lines),
    }
  }

  if (current.text === payload) {
    return {
      status: 'unchanged',
      file: relPath,
      absolute,
      nextText: current.text,
      added: [],
      skipped: [],
      changed: false,
    }
  }
  return {
    status: overwrite === true ? 'update' : 'conflict',
    file: relPath,
    absolute,
    nextText: payload,
    added: [],
    skipped: [],
    changed: true,
    // Both statuses carry the diff: a conflict is only actionable if the reader
    // can see what would be lost.
    diff: diffSummary(current.text, payload),
  }
}

/**
 * Carry out a plan that reached a writable status.
 *
 * Order is backup-then-write, and the directory is created when missing: a
 * generator told to write `.github/dependabot.yml` should not fail because
 * `.github` does not exist yet.
 *
 * The `create` branch does not trust `plan.status`. Anything may have appeared at
 * that path between plan and commit — an editor, another agent, a second process —
 * and a plain `writeFile` would destroy it without a backup, because the plan said
 * "nothing is there". `flag: 'wx'` makes the write fail with EEXIST instead, which
 * the caller already reports as a refusal.
 */
export async function commitWrite(plan) {
  if (plan.status === 'create') {
    await mkdir(path.dirname(plan.absolute), { recursive: true })
    await writeFile(plan.absolute, plan.nextText, { encoding: 'utf8', flag: 'wx' })
    return { wrote: true, backup: null }
  }
  if (plan.status === 'append' || plan.status === 'update') {
    const backup = plan.absolute + '.bak.' + stamp()
    await copyFile(plan.absolute, backup)
    await writeFile(plan.absolute, plan.nextText, 'utf8')
    return { wrote: true, backup }
  }
  return { wrote: false, backup: null }
}

/** Why `py-apply` refuses a project, or null when it may write. */
export function applyRefusal(detection) {
  if (Array.isArray(detection?.foreignLockfiles) && detection.foreignLockfiles.length > 0) {
    return (
      'This project is managed by ' + detection.foreignLockfiles.join(', ') + '. The 1-uv skill is ' +
      'explicit: ' + '\'' + "Don't use uv in projects managed by other tools" + '\'' + '. Writing a uv ' +
      'pyproject.toml, a uv workflow or a `uv run` CI script here would produce a repository where ' +
      'two dependency managers disagree about the same lockfile. Nothing was written.'
    )
  }
  return null
}
