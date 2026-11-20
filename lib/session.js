// Where the calling session's workspace comes from.
//
// This is a small module because the answer is not obvious and getting it wrong is
// invisible: `process.cwd()` is the directory the DSH *host* was launched from,
// which for a web deployment is the installation directory rather than the user's
// project. `dsh-tool-fs` reads the workspace from the execution the host hands each
// call, and so does this.

import path from 'node:path'

/**
 * The session workspace attached to one tool call.
 *
 * @param exec - the execution object `tools.register` passes to `execute`.
 * @param fallback - what to return when the execution carries no workspace.
 * @returns the session workspace, or `fallback` (undefined by default).
 */
export function sessionCwdOf(exec, fallback = undefined) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : fallback
}

/**
 * The project a write/run tool is allowed to act on.
 *
 * A `path` argument exists so a caller can name the session's own project
 * explicitly; it is not a way to point the write half at an arbitrary directory.
 * Without this check `path: ".."` — one character — moves the root to a sibling or
 * to the drive root, and `path: "C:\\Windows\\Temp\\x"` creates four files there.
 * Anything outside the session workspace is refused rather than resolved.
 *
 * A project root that is itself a symlink stays allowed: the caller named it, and
 * writes still land in the tree it points at, which is what "the project" means.
 *
 * @returns `{ root, refused }` — `refused` is a sentence for the caller, or null.
 */
export function projectRootFor(exec, requested) {
  const sessionRoot = sessionCwdOf(exec)
  const wanted = typeof requested === 'string' ? requested.trim() : ''
  if (wanted === '') {
    if (sessionRoot === undefined) {
      return { root: undefined, refused: 'this session has no working directory and no path was given' }
    }
    return { root: sessionRoot, refused: null }
  }
  // A relative `path` is relative to the session project, not to `process.cwd()`
  // — the host's cwd is the installation directory, so resolving against it would
  // silently land somewhere the caller never meant.
  const absolute = path.isAbsolute(wanted)
    ? path.resolve(wanted)
    : path.resolve(sessionRoot === undefined ? process.cwd() : sessionRoot, wanted)
  if (sessionRoot === undefined) return { root: absolute, refused: null }
  const base = path.resolve(sessionRoot)
  if (absolute === base) return { root: absolute, refused: null }
  if (!absolute.startsWith(base + path.sep)) {
    return {
      root: absolute,
      refused: 'the path ' + absolute + ' is outside this session\'s working directory (' + base + '); '
        + 'omit `path` to act on the session project',
    }
  }
  return { root: absolute, refused: null }
}
