// The whitelist executor: the only place this plugin starts a process.
//
// The rule is an allow-list of argv *prefixes*, not a blocklist of dangerous
// strings. A blocklist is a promise that you thought of every spelling; an
// allow-list is a promise you can keep. Every refused command is returned with
// the reason and the list of accepted prefixes, because "denied" without a next
// step is just a locked door.
//
// Nothing here runs unless the caller passed `run: true`. The default path is
// pure reporting.

import { spawn, spawnSync } from 'node:child_process'

/** Seconds a single whitelisted command may take. `docker compose build` is the slow one. */
export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 300

/**
 * Accepted argv prefixes.
 *
 * Each entry is the shortest argv that still identifies the operation. `uv run`
 * is deliberately broad — it is how a project runs its own tools — while a bare
 * `uv` or a shell is not on the list at all.
 */
export const ALLOWED_PREFIXES = [
  { argv: ['uv', '--version'], why: '只读：读本机 uv 版本，用于版本漂移比对' },
  { argv: ['uv', 'sync'], why: '按 uv.lock 安装依赖' },
  { argv: ['uv', 'run'], why: '在项目环境里运行已声明的工具（security 阶段用 --with 临时注入 pip-audit）' },
  // `clean-dist` is the one command that cannot be spelled with a shorter prefix:
  // its `-c` payload carries a `;` and spaces, so matching `uv run` alone would
  // still send the payload through SHELL_INJECTION and refuse the step that every
  // build depends on. `opaque: 1` says the one argument after this prefix is
  // program text, not a shell word: the prefix (`uv run python -c`) and that one
  // argument are skipped by the injection scan, and everything after it is ordinary
  // argv again (here: the `dist` path). This is not a general door for arbitrary
  // arguments — it only applies to entries that opt in, and `spawnSync` still runs
  // with `shell: false`, so the payload is data handed to python, never re-parsed
  // by a shell. Python can of course do anything python can; the allow-list bounds
  // which *programs* may run, it is not a sandbox for the project's own code.
  {
    argv: ['uv', 'run', 'python', '-c'],
    opaque: 1,
    why: '跨平台清 dist：python 是程序不是 shell，-c 之后的串是数据，整串作为单个 argv 传入',
  },
  { argv: ['uv', 'build'], why: '构建 sdist 与 wheel' },
  { argv: ['uv', 'lock', '--check'], why: '只读：锁文件是否与 pyproject 一致' },
  // `uv lock` (no flag) writes uv.lock. It is here because the migration path in
  // the skill starts with it: `uv sync --frozen` cannot pass on a project whose
  // lockfile was never generated, and telling the user to run it themselves while
  // the tool refuses to is a gap, not a safety feature.
  { argv: ['uv', 'lock'], why: '按 pyproject 生成或更新 uv.lock' },
  { argv: ['docker', 'compose', 'config'], why: '只读：合并并校验 compose 文件' },
  { argv: ['docker', 'compose', 'ps'], why: '只读：列出当前服务状态' },
  { argv: ['docker', 'compose', 'build'], why: '构建 compose 里定义的服务镜像' },
  { argv: ['docker', 'compose', 'up'], why: '启动服务并等待 healthy' },
  { argv: ['docker', 'compose', 'down'], why: '拆除服务，跑完必做的清理' },
  // Identity is the property a healthcheck cannot report, and the container skill
  // checks it inside the running service: `compose exec -T api id` must print uid 0
  // nowhere. `-T` is required so a CI runner without a TTY does not allocate one.
  { argv: ['docker', 'compose', 'exec'], why: '只读：在服务容器内执行检查（如非 root 身份）' },
  // A failing container gate is diagnosed from the service logs, and refusing to
  // fetch them turns one failed run into a manual `docker compose` session.
  { argv: ['docker', 'compose', 'logs'], why: '只读：取服务日志，用于定位失败的容器闸门' },
  { argv: ['docker', 'build', '--check'], why: '只读：Dockerfile 静态检查' },
  // Plain `docker build` is the non-compose path the container skill also covers.
  // It stays behind `--check` in the list order only for readability: the matcher
  // is prefix-based, so `docker build --check` still resolves to its own entry.
  { argv: ['docker', 'build'], why: '构建镜像（非 compose 项目）' },
]

/**
 * Shell syntax that must never reach a whitelisted argv.
 *
 * This is the second belt: even an allowed prefix is refused if any argument
 * carries a pipe, redirect, command substitution or backtick. `argv` is executed
 * with `shell: false`, so these are already inert — but a command that *looks*
 * like it pipes is a command whose intent nobody can read, and CI logs are read
 * by people.
 *
 * The scan covers the arguments *after* the matched prefix and after any arguments
 * an entry declared `opaque` (program text, e.g. the payload of `python -c`). The
 * prefix itself is the allow-listed program name, not user data, and an opaque
 * payload is data by construction; scanning either would refuse the command the
 * entry exists to permit, while the parse that matters (`spawnSync` with
 * `shell: false`) never interprets them in the first place.
 */
const SHELL_INJECTION = /[|;&`]|\$\(|\$\{|>>|>\s*\S/

/** Why a command was refused, or null when it is acceptable. */
export function refusalReason(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return '空命令'
  if (argv.some((part) => typeof part !== 'string')) return 'argv 里有非字符串参数'
  // Longest prefix wins: `uv run python -c` must resolve to its own entry instead of
  // the broader `uv run`, otherwise the entry's `opaque` declaration would never be
  // consulted (`uv run` matches those argv too). Ties cannot happen — one prefix is
  // a strict extension of the other — but `>` keeps the later, more specific-looking
  // entry if a future list ever contains duplicates.
  let best = null
  for (const entry of ALLOWED_PREFIXES) {
    const matches = entry.argv.every((part, index) => argv[index] === part)
    if (matches && (best === null || entry.argv.length > best.argv.length)) best = entry
  }
  if (best === null) {
    return (
      '不在白名单里。允许的前缀：' +
      ALLOWED_PREFIXES.map((entry) => entry.argv.join(' ')).join(' / ')
    )
  }
  const payloadStart = best.argv.length + (best.opaque ?? 0)
  if (argv.slice(payloadStart).some((part) => SHELL_INJECTION.test(part))) {
    return '参数里含 shell 语法（管道、重定向、命令替换）：本执行器只跑 argv，不跑 shell'
  }
  return null
}

/** Whether one argv may run. */
export function isAllowed(argv) {
  return refusalReason(argv) === null
}

/**
 * Split a command line the way a whitelist check needs to see it.
 *
 * Quoted segments survive as one argument; everything else splits on whitespace.
 * Deliberately not a shell parser: it exists to *refuse* more, never to accept
 * more than the prefix list allows.
 */
export function splitCommandLine(text) {
  const source = typeof text === 'string' ? text.trim() : ''
  if (source === '') return []
  const parts = []
  let current = ''
  let quote = null
  for (const character of source) {
    if (quote !== null) {
      if (character === quote) quote = null
      else current += character
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (/\s/.test(character)) {
      if (current !== '') {
        parts.push(current)
        current = ''
      }
      continue
    }
    current += character
  }
  if (current !== '') parts.push(current)
  return parts
}

/**
 * Decide what would run, without running it.
 *
 * @param commands - command lines (strings) or argv arrays.
 * @returns one entry per command: `{ argv, allowed, reason, why }`.
 */
export function planCommands(commands) {
  const list = Array.isArray(commands) ? commands : []
  return list.map((entry) => {
    const argv = Array.isArray(entry) ? entry : splitCommandLine(entry)
    const reason = refusalReason(argv)
    const prefix = ALLOWED_PREFIXES.find((allowed) => argv.every((part, index) => allowed.argv[index] === part))
    return {
      argv,
      run: argv.join(' '),
      allowed: reason === null,
      reason,
      why: prefix?.why ?? null,
    }
  })
}

/**
 * Run one whitelisted argv.
 *
 * `shell: false` always. A non-zero exit is data, not an exception: the caller is
 * a report, and "ruff found four issues" must not read as "the tool crashed".
 *
 * @param argv - an argv array that passed {@link refusalReason}.
 * @param options - `{ cwd, timeoutSeconds }`.
 */
export function runCommand(argv, options = {}) {
  const reason = refusalReason(argv)
  if (reason !== null) {
    return { argv, ok: false, refused: true, reason, exitCode: null, stdout: '', stderr: '', seconds: 0 }
  }
  // `Math.floor(0.5)` is 0, and `spawnSync` reads `timeout: 0` as "no timeout at
  // all" — so a caller tightening the limit to a fraction of a second would turn
  // the guard off instead of making it stricter. Floor at one second.
  const timeout = Number.isFinite(options.timeoutSeconds) && options.timeoutSeconds > 0
    ? Math.min(Math.max(1, Math.floor(options.timeoutSeconds)), 86400)
    : DEFAULT_COMMAND_TIMEOUT_SECONDS
  const started = Date.now()
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : process.cwd(),
    timeout: timeout * 1000,
    encoding: 'utf8',
    shell: false,
    // The environment is inherited on purpose: `uv` and `docker` read
    // UV_CACHE_DIR / DOCKER_HOST from it, and stripping those makes the whitelist
    // pass while the run fails for a reason that looks unrelated.
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
  })
  const seconds = Math.round(((Date.now() - started) / 1000) * 10) / 10
  const timedOut = result.error?.code === 'ETIMEDOUT'
  const missing = result.error?.code === 'ENOENT'
  return {
    argv,
    ok: result.status === 0,
    refused: false,
    reason: missing ? '命令不存在：' + argv[0] : (timedOut ? '超时 ' + timeout + 's' : null),
    exitCode: typeof result.status === 'number' ? result.status : null,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    seconds,
  }
}

/** Run a plan produced by {@link planCommands}, stopping at the first refusal. */
export function runPlan(entries, options = {}) {
  const results = []
  for (const entry of entries) {
    if (!entry.allowed) {
      results.push({ ...entry, ok: false, refused: true, exitCode: null, stdout: '', stderr: '', seconds: 0 })
      break
    }
    results.push(runCommand(entry.argv, options))
  }
  return results
}

/**
 * The same executor, without freezing the host.
 *
 * `runCommand` is `spawnSync`: while `uv sync` installs packages nothing else runs
 * — no other tool call, no streaming, no cancellation. A pipeline that takes two
 * minutes therefore looks like a hung app. This variant starts the process and
 * resolves when it exits, so the event loop keeps turning.
 *
 * The verdict shape is byte-for-byte the one `runCommand` returns, because the
 * callers that read it (`ok`, `refused`, `exitCode`, `seconds`, `reason`, the two
 * streams) should not have to know which executor ran.
 *
 * `signal` is optional and additive: aborting kills the process tree and reports
 * `已取消` rather than blaming the project.
 */
export function runCommandAsync(argv, options = {}) {
  const reason = refusalReason(argv)
  if (reason !== null) {
    return Promise.resolve({ argv, ok: false, refused: true, reason, exitCode: null, stdout: '', stderr: '', seconds: 0 })
  }
  // Same floor as the sync path: the spawner reads a zero timeout as "no timeout
  // at all", so asking for a stricter limit must not disable the guard.
  const timeout = Number.isFinite(options.timeoutSeconds) && options.timeoutSeconds > 0
    ? Math.min(Math.max(1, Math.floor(options.timeoutSeconds)), 86400)
    : DEFAULT_COMMAND_TIMEOUT_SECONDS
  const cwd = typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : process.cwd()
  const signal = options.signal !== null && typeof options.signal === 'object' &&
    typeof options.signal.addEventListener === 'function'
    ? options.signal
    : undefined
  const LIMIT = 4 * 1024 * 1024

  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    let timedOut = false
    let overflowed = false
    let aborted = false
    let stdout = ''
    let stderr = ''
    let child = null
    let timer = null
    let killTimer = null

    const finish = (status, errorCode) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      if (killTimer !== null) clearTimeout(killTimer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      const seconds = Math.round(((Date.now() - started) / 1000) * 10) / 10
      const missing = errorCode === 'ENOENT'
      let why = null
      if (missing) why = '命令不存在：' + argv[0]
      else if (timedOut) why = '超时 ' + timeout + 's'
      else if (aborted) why = '已取消'
      else if (overflowed) why = '输出超过 ' + Math.round(LIMIT / (1024 * 1024)) + 'MB，已中止'
      resolve({
        argv,
        ok: status === 0 && why === null,
        refused: false,
        reason: why,
        exitCode: typeof status === 'number' ? status : null,
        stdout,
        stderr,
        seconds,
      })
    }

    const terminate = () => {
      if (child === null) return
      try {
        child.kill('SIGTERM')
      } catch {
        // Already gone: the close event is on its way.
      }
      // A process that ignores SIGTERM would hold the tool open forever. The force
      // kill is what turns the timeout into a guarantee instead of a suggestion.
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // Nothing left to kill.
        }
      }, 2000)
      if (typeof killTimer.unref === 'function') killTimer.unref()
    }

    const onAbort = () => {
      if (settled) return
      aborted = true
      terminate()
    }

    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        shell: false,
        // Inherited on purpose, exactly like the sync path: `uv` and `docker` read
        // UV_CACHE_DIR / DOCKER_HOST from it.
        env: process.env,
        windowsHide: true,
      })
    } catch (error) {
      finish(null, error?.code)
      return
    }

    timer = setTimeout(() => {
      if (settled) return
      timedOut = true
      terminate()
    }, timeout * 1000)
    if (signal !== undefined) {
      if (signal.aborted === true) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    const take = (name, chunk) => {
      const text = typeof chunk === 'string' ? chunk : String(chunk)
      const current = name === 'stdout' ? stdout : stderr
      if (current.length >= LIMIT) {
        overflowed = true
      } else if (name === 'stdout') {
        stdout += text.slice(0, LIMIT - current.length)
      } else {
        stderr += text.slice(0, LIMIT - current.length)
      }
      if (overflowed) terminate()
    }

    if (child.stdout !== null) {
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => take('stdout', chunk))
    }
    if (child.stderr !== null) {
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => take('stderr', chunk))
    }
    child.on('error', (error) => finish(null, error?.code))
    child.on('close', (code) => finish(typeof code === 'number' ? code : null, null))
  })
}

/** Run a plan produced by {@link planCommands}, awaiting each command in turn. */
export async function runPlanAsync(entries, options = {}) {
  const results = []
  for (const entry of entries) {
    if (!entry.allowed) {
      results.push({ ...entry, ok: false, refused: true, exitCode: null, stdout: '', stderr: '', seconds: 0 })
      break
    }
    results.push(await runCommandAsync(entry.argv, options))
  }
  return results
}
