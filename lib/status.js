// Detections held for the sidebar panel, one entry per directory.
//
// This is in-memory on purpose. It describes a directory at a moment, not a
// durable fact about the user: persisting it would let a panel show yesterday's
// answer as today's, and the store is rebuilt on every plugin mount anyway.
//
// It is keyed by directory rather than being a single "last detection" slot,
// which used to make the panel stick to the first project it ever saw. A user who
// switches workspace expects the panel to follow; keeping one entry per root lets
// the status route hand back the entry for *the* current root, and lets a return
// visit render instantly from cache instead of re-reading the disk.
//
// v0.10 adds the panel's static layer: which of the 9 generated files exist, the
// 13-stage matrix with its job assignment, the job groups the workflow renders,
// and the git-hook facts. All of it is derived from `pipeline/ir.js` and the
// detection object, so a panel that renders these cannot drift from the workflow
// the plugin generates.

import { existsSync } from 'node:fs'
import path from 'node:path'

import { DEFAULT_STAGE_IDS, groupJobs, OPTIONAL_STAGE_IDS, resolveStages, STAGE_IDS, stageMatrix } from './pipeline/ir.js'
import { describeResolved } from './resolve.js'

/** How many directories to remember before evicting the oldest entry. */
const MAX_ENTRIES = 8

/**
 * The 9 files `py-apply` writes, in the fixed order the panel lists them.
 *
 * `exists` answers from the detection facts when `detect` already knows the answer
 * and returns `null` when it does not (the plugin's own outputs are not gate inputs,
 * so detection does not stat every one of them); the caller fills a `null` with one
 * filesystem probe against the entry's root. Ids match `py-apply` / `py-scaffold`
 * exactly — a panel showing a tenth id would send the user to a tool that refuses it.
 */
export const APPLY_TARGETS = [
  { id: 'pyproject', path: 'pyproject.toml', exists: (d) => d?.hasPyproject === true },
  { id: 'prek', path: '.pre-commit-config.yaml', exists: () => null },
  { id: 'dependabot', path: '.github/dependabot.yml', exists: () => null },
  { id: 'workflow', path: '.github/workflows', exists: (d) => (Array.isArray(d?.workflows) ? d.workflows.length > 0 : null) },
  { id: 'ci-script', path: 'scripts/ci.py', exists: () => null },
  { id: 'manifest', path: 'release/agent_versions.json', exists: (d) => (typeof d?.validator?.manifest === 'boolean' ? d.validator.manifest : null) },
  { id: 'validator', path: 'scripts/validate_version_manifest.py', exists: (d) => (typeof d?.validator?.script === 'boolean' ? d.validator.script : null) },
  { id: 'secret-scan', path: 'scripts/secret_scan.py', exists: (d) => (typeof d?.secrets?.helper === 'boolean' ? d.secrets.helper : null) },
  { id: 'container-report', path: 'scripts/container_report.py', exists: (d) => (typeof d?.container?.reportScript === 'boolean' ? d.container.reportScript : null) },
]

/**
 * Which of the 9 generated files exist in a detection's directory.
 *
 * Detection answers for the six files the gates read; the other three are probed
 * once here, at record time, and cached with the entry. The panel must not claim
 * "missing" for a file nobody looked for, so unknowns become real probes.
 */
export function applyTargetRows(detection = null) {
  const source = detection !== null && typeof detection === 'object' ? detection : {}
  const root = typeof source.root === 'string' ? source.root : ''
  return APPLY_TARGETS.map((target) => {
    const known = target.exists(source)
    const present = known === null || known === undefined
      ? (root !== '' ? existsSync(path.join(root, target.path)) : false)
      : known === true
    return { id: target.id, path: target.path, present }
  })
}

/**
 * One row per stage, with the job fields the panel shows.
 *
 * Normalized here rather than in the panel so the panel never learns the IR's
 * internal step shape; when a stage moves to another job, only `ir.js` changes.
 */
export function stageRows() {
  return stageMatrix().map((row) => ({
    id: row.id,
    title: row.title,
    defaultIncluded: row.defaultIncluded === true,
    optional: row.optional === true,
    kind: row.kind ?? 'gate',
    verified: row.verified !== false,
    job: row.job ?? 'quality',
    needs: [...(row.needs ?? [])],
    commands: [...row.commands],
  }))
}

/**
 * The job groups the generated workflow renders, in canonical order.
 *
 * Built through the IR's own resolution instead of a hand-written map, because
 * `groupJobs` is what `github.js` renders from — two mappings would drift the
 * moment a stage moved between jobs.
 */
export function jobGroups() {
  return groupJobs(resolveStages([...STAGE_IDS])).map((group) => ({
    name: group.name,
    needs: [...group.needs],
    stages: group.stages.map((stage) => ({ id: stage.id, title: stage.title })),
  }))
}

/**
 * The resolve summary a panel shows: the `{value, source}` pairs as display
 * lines, so a user can see why the generated workflow says `ruffFormat: ...`.
 *
 * The lines come from `resolve.js`'s own `describeResolved`, not a second
 * formatter: the audit, the CLI and the panel must read the same sentence for the
 * same value, or a user has to decide which one to believe.
 *
 * Accepts the raw `resolveProject` result or null (project not audited yet).
 */
export function resolveSummary(resolved) {
  if (resolved === null || typeof resolved !== 'object') return []
  return describeResolved(resolved)
}

/**
 * Everything the panel needs that is not in `detection` itself.
 *
 * @param detection - a `detect()` result (booleans + paths, no file contents).
 * @param resolved - optional `resolveProject` result; omitted, the panel still
 *                   gets targets/stages/jobs/hooks.
 */
export function describeStatus({ detection = null, resolved = null } = {}) {
  const source = detection !== null && typeof detection === 'object' ? detection : {}
  return {
    root: typeof source.root === 'string' ? source.root : '',
    gitHooks: source.gitHooks ?? { installed: false, pointsToPrek: false },
    applyTargets: applyTargetRows(source),
    stages: stageRows(),
    jobs: jobGroups(),
    defaultStages: [...DEFAULT_STAGE_IDS],
    optionalStages: [...OPTIONAL_STAGE_IDS],
    resolve: resolved !== null && typeof resolved === 'object' ? resolved : null,
    resolveLines: resolveSummary(resolved),
  }
}

/**
 * Create the store shared by the tools and the status route.
 *
 * @returns `{ record, read, latest, clear }`.
 */
export function createStatusStore() {
  /**
   * Insertion order is recency: `Map` keeps it, so the first key is the oldest.
   *
   * @type {Map<string, { detection: object, recordedAt: string, sessionId: string|null, panel: object }>}
   */
  const entries = new Map()

  return {
    /**
     * Remember one detection, for the directory it describes.
     *
     * The panel extras are computed once at record time: they are pure functions of
     * the detection, so a read can hand them over without an extra filesystem walk.
     *
     * @param detection - a `detect()` result.
     * @param sessionId - which session produced it, when the caller knows.
     */
    record(detection, sessionId = null) {
      if (detection === null || typeof detection !== 'object') return
      const root = detection.root
      if (typeof root !== 'string' || root === '') return
      entries.delete(root)
      entries.set(root, {
        detection,
        recordedAt: new Date().toISOString(),
        sessionId: typeof sessionId === 'string' && sessionId !== '' ? sessionId : null,
        panel: describeStatus({ detection }),
      })
      for (const key of entries.keys()) {
        if (entries.size <= MAX_ENTRIES) break
        entries.delete(key)
      }
    },
    /**
     * The entry for one directory; with no argument, the most recent one.
     *
     * @param root - directory to look up, optional.
     */
    read(root = undefined) {
      if (typeof root !== 'string' || root === '') {
        let last = null
        for (const entry of entries.values()) last = entry
        return last
      }
      return entries.get(root) ?? null
    },
    /** The most recent entry, whatever directory it describes. */
    latest() {
      let last = null
      for (const entry of entries.values()) last = entry
      return last
    },
    /** Forget everything — used when the plugin unmounts. */
    clear() {
      entries.clear()
    },
  }
}
