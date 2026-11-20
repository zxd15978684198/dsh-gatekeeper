// Which directory a status read should describe.
//
// The status route is a plain browser GET: it carries no session, so the plugin has
// to ask the Host which directories exist and pick one. Two sources, in order:
//
// 1. the `workingDirectory` service — the live answer, and the only one that
//    follows a workspace switch performed *inside* one session;
// 2. `session.header.cwd` — the directory the session was created with, which is
//    all an older Host offers.
//
// Reading only the header is what made the panel keep describing the directory a
// session *started* in, so changing project looked like the panel had gone stale.
// This is deliberately re-read on every request and never cached: a cached answer
// outliving its directory was the whole defect.

/**
 * Workspace directories of the sessions this host knows, newest first.
 *
 * Every entry is `{ id, dir, updatedAt, index }`, newest first. Several sessions may
 * share a directory, and every one of them is kept so that an exact `?session=`
 * lookup can match any of them. When the Host reports no timestamps at all, the
 * later entry in `agents.list()` wins, because that is the order the Host uses
 * (oldest first).
 *
 * @param ctx - the Cordis context the plugin was mounted with.
 * @returns `{ id, dir, updatedAt, index }[]`, possibly empty.
 */
export function sessionDirs(ctx) {
  const collected = []
  let workingDirectory = null
  try {
    workingDirectory = typeof ctx?.get === 'function' ? ctx.get('workingDirectory') : null
  } catch (error) {
    workingDirectory = null
  }

  try {
    const agents = typeof ctx?.get === 'function' ? ctx.get('agents') : null
    if (agents === null || agents === undefined || typeof agents.list !== 'function') return collected
    const list = agents.list() ?? []
    list.forEach((agent, index) => {
      const session = agent?.session
      let dir = null
      try {
        const viaService = workingDirectory !== null && typeof workingDirectory.get === 'function'
          ? workingDirectory.get(session)
          : undefined
        if (typeof viaService === 'string' && viaService !== '') dir = viaService
      } catch (error) {
        console.warn('gatekeeper: workingDirectory.get() failed for the status route', error)
      }
      if (dir === null) {
        const cwd = session?.header?.cwd
        if (typeof cwd === 'string' && cwd !== '') dir = cwd
      }
      if (dir === null) return
      const raw = Number(session?.header?.updatedAt ?? session?.header?.createdAt ?? 0)
      collected.push({
        id: session?.id ?? session?.header?.id ?? agent?.id ?? null,
        dir,
        updatedAt: Number.isFinite(raw) ? raw : 0,
        index,
      })
    })
  } catch (error) {
    console.warn('gatekeeper: could not read the session list for the status route', error)
  }

  collected.sort((left, right) => (right.updatedAt - left.updatedAt) || (right.index - left.index))
  // No directory deduplication here: two sessions may legitimately share one
  // directory, and dropping the loser would make an exact `?session=` lookup miss
  // and silently answer for a different session. Callers that want a distinct path
  // list dedupe the paths, not the sessions.
  return collected
}

/**
 * Pick the directory to describe.
 *
 * @param options - `{ sessions, requestedPath, requestedSession }`.
 * @returns `{ dir, source }` where source is `query` / `session` / `none`.
 */
export function pickRoot({ sessions, requestedPath, requestedSession }) {
  if (typeof requestedPath === 'string' && requestedPath.trim() !== '') {
    return { dir: requestedPath.trim(), source: 'query' }
  }
  if (typeof requestedSession === 'string' && requestedSession !== '') {
    const match = (sessions ?? []).find((entry) => entry.id === requestedSession)
    if (match !== undefined) return { dir: match.dir, source: 'session' }
  }
  const first = (sessions ?? [])[0]
  if (first !== undefined) return { dir: first.dir, source: 'session' }
  return { dir: null, source: 'none' }
}
