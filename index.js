// gatekeeper — the Host half.
//
// Three tools and two read-only routes. `py-audit` reads, `py-scaffold` writes (only
// when told to), `py-run` executes (only when told to) — the split is by what a call
// does to the project, not by which artefact it emits. The twelve original
// single-purpose tools remain as internal modules behind those three.
//
// The refusal is still the point: several of them decline to answer when the project
// belongs to a different dependency manager. That refusal, not the generated text, is
// what this plugin adds over shipping the same skills as documents.
//
// The read-only status route is the panel's whole world: the 13 stages with their CI
// job and needs, the 9 generated artefacts, the git-hook facts, and the values the
// pipeline resolves with where each one came from. It gets all of that from
// `lib/status.js`, which reads `ir.js`/`resolve.js` — the same sources the renderers
// use, so the panel cannot describe a pipeline those renderers would not write.
// Resolving is a disk read, so it happens here and only here.
//
// The structure follows the plugin contract this DSH expects: a named module that
// exports `name`, `inject`, an optional `Config` schema, and `apply(ctx, settings)`.
// Registration is a live operation, so every tool is registered inside its own
// try/catch and unregistered through the disposer `tools.register` returns.

import { readFile } from 'node:fs/promises'

import { detect } from './lib/detect.js'
import { buildConfig, resolveConfig, pickSchemaBuilder } from './lib/schema.js'
import { createStatusStore, describeStatus } from './lib/status.js'
import { sessionDirs, pickRoot } from './lib/sessions.js'
import { indexTopics } from './lib/references.js'
import { resolveProject } from './lib/resolve.js'
import { registerSkills, skillIndex } from './lib/skills.js'
// Three tools, split by what they do to the project rather than by which artefact
// they emit: `py-audit` reads, `py-scaffold` writes, `py-run` executes. The twelve
// single-purpose tools still exist as internal modules — each owns logic worth
// testing on its own — but they are no longer entry points. A model choosing
// between `py-bootstrap`, `py-prek`, `py-dependabot`, `py-ci-render` and
// `py-ci-run` to answer "set up this project's CI" picked four of them and quietly
// omitted the fifth.
import { createPyAuditTool } from './lib/tools/py-audit.js'
import { createPyRunTool } from './lib/tools/py-run.js'
import { createPyScaffoldTool } from './lib/tools/py-scaffold.js'
// Not an entry point: the panel's preview route renders through the same
// implementation `py-scaffold` uses, so a preview can never show a workflow the
// tool would not produce.
import { createPyCiRenderTool } from './lib/tools/py-ci-render.js'

export const name = 'gatekeeper'
export const inject = ['tools']

/** The read-only route the sidebar panel fetches. */
const STATUS_ROUTE = '/gatekeeper/status'

/**
 * The render-preview route.
 *
 * The panel lets the user tick which stages the next workflow should carry. Reading a
 * checkbox and writing a file would be two very different privileges, so the panel
 * only ever *asks*: this route renders the same YAML `py-ci-render` would produce for
 * that selection and hands back the text. Nothing is written anywhere.
 */
const PREVIEW_ROUTE = '/gatekeeper/preview'

/**
 * The settings schema, or `undefined` when there is no schema builder.
 *
 * `@deepseek-ai/schemastery` is an optional peer dependency: a real profile has it,
 * `test/smoke.mjs` does not. A hard import failure would take every tool down
 * with it, so the import is soft and the failure only costs the panel its switches.
 */
let Schema = null
try {
  Schema = pickSchemaBuilder(await import('@deepseek-ai/schemastery'))
} catch {
  Schema = null
}
if (Schema === null) {
  console.warn(
    'gatekeeper: no schema builder (@deepseek-ai/schemastery) — the tools run on ' +
    'their defaults and the sidebar panel will not offer the switches',
  )
}

/** The plugin's configuration schema; `undefined` degrades to defaults only. */
export const Config = buildConfig(Schema)

/** This package's own version, read from its manifest so a release never edits a string twice. */
async function readVersion() {
  try {
    const text = await readFile(new URL('./package.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(text)
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** Write one JSON response, uncached. */
function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // A panel showing yesterday's facts is worse than a panel showing none.
    'cache-control': 'no-store',
  })
  response.end(body)
}

/**
 * How long a cached detection may be reused before the route re-reads the disk.
 *
 * The panel polls, so this is the only thing standing between "the user added a
 * ruff section" and "the panel still says there is none". Short enough to feel
 * live, long enough that polling does not turn into a filesystem loop.
 */
const CACHE_TTL_MS = 15000

/**
 * The last status request the Host answered, kept for diagnosis.
 *
 * A panel that shows the wrong directory can be wrong on either side of the wire:
 * the Host may resolve badly, or the panel may ask about a session it merely
 * guessed. This records what actually arrived, so `?debug=1` answers "did the
 * panel tell us which session it is showing" without opening a browser console.
 */
let lastRequest = null

/**
 * Ask the Host what its skill catalog actually contains.
 *
 * The composer turns `/name` into a chip only when the name is a member of the
 * live lexicon, and that lexicon is the Host catalog filtered to the session. So
 * "the token does not highlight" has two possible homes: the Host never listed
 * our skill, or the browser's per-session copy of the list is stale. This probe
 * answers the first half from the inside — a `?probe=1` read is the only way to
 * see it without opening a browser console.
 *
 * @param ctx - the mounted plugin context.
 * @param root - the directory whose project skills should be included.
 */
async function probeSkills(ctx, root) {
  const out = { available: false, python: [], total: 0 }
  let skills = undefined
  try {
    skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
  } catch (error) {
    out.error = String(error?.message ?? error)
    return out
  }
  if (skills === undefined || skills === null || typeof skills.list !== 'function') {
    out.error = 'this Host has no skills service'
    return out
  }
  out.available = true
  try {
    const list = await skills.list(root === null || root === undefined ? {} : { cwd: root })
    const names = (list ?? []).map((skill) => String(skill?.name ?? '')).filter((name) => name !== '')
    out.total = names.length
    out.python = names.filter((name) => name.startsWith('python-')).sort()
    out.cwd = root ?? null
  } catch (error) {
    out.error = String(error?.message ?? error)
  }
  return out
}

/** The whole status document the panel renders. */
async function buildStatus({ ctx, store, config, version, searchParams }) {
  const requestedPath = searchParams.get('path')
  const requestedSession = searchParams.get('session')
  const wantsRefresh = searchParams.get('refresh') === '1'
  const sessions = sessionDirs(ctx)

  // Which directory to describe. A live session beats a remembered detection: the
  // store is what used to win here, and that is exactly how the panel got stuck on
  // the first project it ever saw.
  const picked = pickRoot({ sessions, requestedPath, requestedSession })
  const requestedSessionId = typeof requestedSession === 'string' && requestedSession !== '' ? requestedSession : null
  const sessionMatched = requestedSessionId !== null && sessions.some((entry) => entry.id === requestedSessionId)
  let root = picked.dir
  let source = picked.source
  if (root === null) {
    const latest = store.latest()
    if (latest !== null && latest.detection?.root) {
      root = latest.detection.root
      source = 'detection'
    }
  }

  const cached = root === null ? null : store.read(root)
  let detection = cached?.detection ?? null
  const age = cached === null ? Number.POSITIVE_INFINITY : Date.now() - Date.parse(cached.recordedAt)
  // Re-detect when the panel asks, when this directory has no entry, or when the
  // entry is old enough that files may have changed under it.
  const needsDetect = root !== null && (wantsRefresh || detection === null || !(age <= CACHE_TTL_MS))
  if (needsDetect) {
    detection = await detect(root)
    store.record(detection, cached?.sessionId ?? null)
  }

  // The panel's static layer (stages, jobs, artefacts, hooks) is derived in
  // `lib/status.js` from the detection alone, which is what the store caches. The
  // resolved values are the part that needs a fresh look at the disk, so they are
  // computed here, once per request, and only when there is a project to resolve
  // against: no directory selected yet is a legitimate panel state, not an error.
  let resolved = null
  if (detection !== null && typeof detection.root === 'string' && detection.root !== '') {
    try {
      resolved = resolveProject({ rootDir: detection.root, detection })
    } catch (error) {
      console.warn('gatekeeper: resolving the pipeline values failed', error)
    }
  }
  const panel = describeStatus({ detection, resolved })

  return {
    plugin: {
      name,
      version,
      // What the panel must say instead of showing switch controls.
      schema: Schema !== null,
      degraded: Schema === null,
    },
    root: detection?.root ?? root,
    source,
    detection,
    recordedAt: needsDetect ? new Date().toISOString() : cached?.recordedAt ?? null,
    settings: {
      defaultPythonVersion: config.defaultPythonVersion,
      matrixPythonVersions: config.matrixPythonVersions,
      testPaths: config.testPaths,
      includeSecurityGate: config.includeSecurityGate,
      includeIntegrationGate: config.includeIntegrationGate,
      tools: config.tools,
    },
    topics: await indexTopics(),
    // The panel's static layer, then its pieces flattened for older panels (and for
    // anyone reading one field rather than the whole document).
    panel,
    stages: panel.stages,
    jobs: panel.jobs,
    applyTargets: panel.applyTargets,
    gitHooks: panel.gitHooks,
    resolved,
    resolveLines: panel.resolveLines,
    stageDefaults: { stages: panel.defaultStages, optional: panel.optionalStages },
    // Facts, not gates: the six container checks are reported and the limit is the
    // panel's to display, never the runner's to enforce.
    container: detection?.container ?? null,
    // The catalog half: one real skill per packaged document. The panel renders
    // these as `/python-<topic>` tokens, and the Host is what actually loads the
    // body — the panel only ever inserts the token.
    skills: skillIndex(),
    // `?probe=1` adds what the Host catalog really holds, which is the first half
    // of any "the token does not highlight" report.
    skillProbe: searchParams.get('probe') === '1' ? await probeSkills(ctx, detection?.root ?? root) : null,
    sessions: [...new Set(sessions.map((entry) => entry.dir))],
    // Which session the panel asked about, and whether the Host knew it. Without
    // this a stale-pin bug looks exactly like a resolution bug from the outside:
    // both show the wrong directory. `sessions` stays a plain path list for older
    // panels; `sessionList` is what the panel matches its own id against, so it
    // keeps every session even when two of them share a directory.
    sessionList: sessions.map((entry) => ({ id: entry.id, dir: entry.dir })),
    requestedSession: requestedSessionId,
    sessionMatched,
    request: lastRequest,
  }
}

/**
 * Mount the plugin.
 *
 * @param ctx - the Cordis context DSH hands the plugin.
 * @param settings - the configuration row, when the composition supplies one.
 */
export function apply(ctx, settings = {}) {
  // Resolved once per mount; the volatile-update hook below re-resolves in place,
  // because every behaviour reads this object at call time.
  const config = resolveConfig(settings)
  const store = createStatusStore()

  let version = '0.0.0'
  readVersion().then((value) => { version = value }).catch(() => {})

  // ------------------------------------------------------------------- tools
  //
  // Each factory is built lazily INSIDE its own register, so a tool switched on
  // later gets a fresh definition rather than a stale captured one.
  const toolFactories = {
    audit: () => createPyAuditTool({ config, store }),
    scaffold: () => createPyScaffoldTool({ config }),
    run: () => createPyRunTool({ config }),
  }
  /** name -> disposer for the tools currently mounted by this plugin. */
  const mounted = new Map()
  const syncTools = () => {
    for (const [key, factory] of Object.entries(toolFactories)) {
      const wanted = config.tools[key] === true
      const disposer = mounted.get(key)
      if (wanted && disposer === undefined) {
        try {
          mounted.set(key, ctx.tools.register(factory()))
        } catch (error) {
          // A tool whose registration throws must not take the others with it.
          console.error('gatekeeper: registering the ' + key + ' tool failed', error)
        }
      } else if (!wanted && disposer !== undefined) {
        mounted.delete(key)
        try {
          disposer()
        } catch (error) {
          console.error('gatekeeper: unregistering the ' + key + ' tool failed', error)
        }
      }
    }
  }
  syncTools()

  // ------------------------------------------------------------------ skills
  //
  // The sixteen documents become real skills in the catalog, so `/python-uv-basics`
  // resolves the same way `/ai-tutorial-craft` does: the Host loads the body into
  // the turn. This is the half that makes the composer token meaningful — without
  // it the token would be a name nothing answers to.
  //
  // `ctx.skills` is read defensively: a Host that predates the skills service still
  // still gets every working tool, and the panel says so instead of pretending.
  let registeredSkills = []
  try {
    const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
    if (skills !== undefined && skills !== null && typeof skills.register === 'function') {
      const result = registerSkills(skills)
      registeredSkills = result.registered
      for (const failure of result.failed) {
        console.warn(
          'gatekeeper: registering the ' + failure.topic + ' skill failed — ' + failure.reason,
        )
      }
    } else {
      console.warn(
        'gatekeeper: this Host has no skills service; the sixteen documents stay ' +
        'reachable through py-references but do not appear as /python-* commands',
      )
    }
  } catch (error) {
    console.error('gatekeeper: registering skills failed', error)
  }

  // ------------------------------------------------------------- status route
  //
  // Optional: an older host without `webServer` simply has no panel, and the tools
  // are unaffected. Registration returns a disposer, which the fiber runs on unload.
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (inner) => {
        const webServer = inner.webServer
        if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return
        const disposer = webServer.register({
          kind: 'exact',
          path: STATUS_ROUTE,
          handler: async (request, response) => {
            if (request.method !== 'GET') {
              response.writeHead(405, { allow: 'GET' })
              response.end()
              return
            }
            try {
              const url = new URL(request.url ?? STATUS_ROUTE, 'http://localhost')
              const asked = url.searchParams.get('session')
              // `peek=1` is the diagnostic read: it must observe without becoming
              // the observation, or asking "what did the panel last send" would
              // always answer "your own question".
              if (url.searchParams.get('peek') !== '1') {
                lastRequest = {
                  at: new Date().toISOString(),
                  session: asked === null || asked === '' ? null : asked,
                  path: url.searchParams.get('path'),
                  refresh: url.searchParams.get('refresh') === '1',
                  userAgent: String(request.headers?.['user-agent'] ?? '').slice(0, 120),
                }
              }
              sendJson(response, 200, JSON.stringify(await buildStatus({
                ctx, store, config, version, searchParams: url.searchParams,
              })))
            } catch (error) {
              console.warn('gatekeeper: building the panel status failed', error)
              sendJson(response, 500, JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
              }))
            }
          },
        })
        if (typeof inner.effect === 'function') {
          inner.effect(() => disposer, 'gatekeeper: status route')
        }

        // The preview route reuses the py-ci-render tool itself, so the panel can never
        // show a workflow the tool would not produce.
        const renderTool = createPyCiRenderTool({ config })
        const previewDisposer = webServer.register({
          kind: 'exact',
          path: PREVIEW_ROUTE,
          handler: async (request, response) => {
            if (request.method !== 'GET') {
              response.writeHead(405, { allow: 'GET' })
              response.end()
              return
            }
            try {
              const url = new URL(request.url ?? PREVIEW_ROUTE, 'http://localhost')
              const stages = url.searchParams.get('stages') ?? ''
              const root = url.searchParams.get('path') ?? ''
              if (root === '') {
                sendJson(response, 400, JSON.stringify({ error: 'preview needs a path' }))
                return
              }
              const result = await renderTool.execute({ stages, path: root }, undefined)
              sendJson(response, 200, JSON.stringify({
                blocked: result.blocked === true,
                reason: result.reason ?? null,
                stages: result.stages ?? [],
                fileName: result.fileName ?? '',
                yaml: result.yaml ?? '',
                warnings: result.warnings ?? [],
              }))
            } catch (error) {
              console.warn('gatekeeper: rendering a preview failed', error)
              sendJson(response, 500, JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
              }))
            }
          },
        })
        if (typeof inner.effect === 'function') {
          inner.effect(() => previewDisposer, 'gatekeeper: preview route')
        }
      })
    }
  } catch (error) {
    console.warn('gatekeeper: could not publish the status route', error)
  }

  // A volatile edit is written into the same object the loader handed us and then
  // announced, so re-resolving in place is what makes a switch take effect without
  // a restart.
  if (typeof ctx.on === 'function') {
    ctx.on('loader/volatile-update', () => {
      try {
        Object.assign(config, resolveConfig(settings))
        syncTools()
      } catch (error) {
        console.error('gatekeeper: applying a configuration change failed', error)
      }
    })
  }
}