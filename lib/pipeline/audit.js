// Static audit of a GitHub Actions workflow, for Python projects.
//
// The rules below are the failure modes this plugin has actually met: a floating
// action tag next to a SHA-pinned one, a job with no deadline, `uv sync` without
// `--locked`, a `pip install` in a uv repository. Each one is a *static* read of
// the file — deliberately no network, no action-tag lookup and no registry
// probing — because a linter that reports "this action version does not exist"
// every time GitHub moves is a linter people turn off.
//
// What that costs is stated rather than hidden: `uv-version-drift` compares the
// workflow's declared uv version with the local one, and reports `info` when it
// cannot read either. `container-stage-missing` only fires when a Dockerfile or a
// compose file is present, so a library is never told it lacks a container job.

import { existsSync } from 'node:fs'
import path from 'node:path'

/** Severity order, used to sort findings and to decide the exit code. */
export const SEVERITY_ORDER = ['error', 'warn', 'info']

/** The rules, as data, so the panel and the docs can list them without parsing code. */
export const RULES = [
  {
    id: 'pin-policy-mixed',
    severity: 'warn',
    title: '固定的策略不一致',
    why:
      '同一个文件里既有 SHA 钉死的 action，又有浮动大版本。前者保证可复现，后者保证自动升级；' +
      '混在一起意味着「哪些会偷偷变」取决于读者记忆，而不是文件本身。',
  },
  {
    id: 'job-timeout-missing',
    severity: 'warn',
    title: 'job 没有 timeout-minutes',
    why: 'GitHub 的默认上限是 6 小时。一个挂住的测试会烧满整个窗口才失败。',
  },
  {
    id: 'no-artifact',
    severity: 'error',
    title: '没有 upload-artifact',
    why: '测试挂了却没有任何产物可看，等于让人重新跑一遍。至少把构建产物或测试报告传上去。',
  },
  {
    id: 'artifact-always-error',
    severity: 'warn',
    title: 'if: always() 配 if-no-files-found: error',
    why:
      '`always()` 让上传步骤在失败时也跑；`error` 让它在没有文件时把 job 判红。' +
      '两者相遇，一次失败会多出第二个失败，掩盖真正的原因。',
  },
  {
    id: 'sync-unlocked',
    severity: 'error',
    title: 'uv sync 缺 --locked',
    why: '没有 `--locked` 的 `uv sync` 会就地改写锁文件：CI 装的东西和仓库里提交的不是一套。',
  },
  {
    id: 'run-unlocked',
    severity: 'warn',
    title: 'uv run 缺 --locked',
    why: '`uv run` 同样可能触发重新解析。本地无所谓，CI 里等于把「锁住了」这个承诺丢掉。',
  },
  {
    id: 'pip-install',
    severity: 'error',
    title: 'CI 里出现 pip install',
    why: '由 uv 管理的项目在 CI 里 `pip install` 会绕过锁文件，装出一套从未被测试过的组合。',
  },
  {
    id: 'no-concurrency',
    severity: 'warn',
    title: '没有 concurrency 组',
    why: '连推三次就并行跑三次全量测试。`cancel-in-progress: true` 是几乎免费的省时项。',
  },
  {
    id: 'permissions-missing',
    severity: 'warn',
    title: '没有声明的 permissions',
    why:
      '不声明就继承仓库默认，可能是 write。`permissions: contents: read` 一行，' +
      '把「这个 job 本来就不需要写权限」变成文件里的事实。',
  },
  {
    id: 'coverage-floor-missing',
    severity: 'warn',
    title: '没有覆盖率下限',
    why: '覆盖率没有下限时，一个 0% 的新模块和一个 95% 的老模块看起来一样绿。',
  },
  {
    id: 'uv-version-drift',
    severity: 'info',
    title: 'workflow 的 uv 版本与本地不一致',
    why: '不是错误：CI 锁旧版本可以是故意的。但差异要写下来，否则「本地能过 CI 不过」会先被当成玄学。',
  },
  {
    id: 'container-stage-missing',
    severity: 'info',
    title: '有容器文件但没有容器 job',
    why: 'Dockerfile 或 compose 文件存在却不在 CI 里构建，等于把它交给「下次部署时才发现」处理。',
  },
  {
    id: 'secret-in-run',
    severity: 'error',
    title: 'run 里有明文口令',
    why: '写进 workflow 的口令会永远留在 git 历史里，删掉文件也删不掉。',
  },
]

/** The rule ids, in declaration order. */
export const RULE_IDS = RULES.map((rule) => rule.id)

/**
 * Read a workflow file into the shape the rules want.
 *
 * This is not a YAML parser and does not pretend to be: it tracks indentation,
 * `jobs:` children, `steps:` list items, and the `uses` / `run` / `with` keys the
 * rules ask about. Anything it cannot see becomes "absent", which is the safe
 * direction — a rule that cannot read a file must not invent a finding.
 *
 * @param text - the workflow source.
 */
export function parseWorkflow(text) {
  const source = typeof text === 'string' ? text : ''
  const lines = source.split(/\r?\n/)

  // Everything before `jobs:` describes the workflow as a whole.
  const jobsIndex = lines.findIndex((line) => /^jobs:\s*$/.test(line))
  const head = jobsIndex === -1 ? lines : lines.slice(0, jobsIndex)
  const body = jobsIndex === -1 ? [] : lines.slice(jobsIndex + 1)

  const hasConcurrency = head.some((line) => /^concurrency:/.test(line))
  const hasPermissions = head.some((line) => /^permissions:/.test(line))

  const jobs = []
  let current = null
  /** Which nested block a line belongs to: `steps`, `with`, or null. */
  let block = null

  for (const raw of body) {
    if (raw.trim() === '' || /^\s*#/.test(raw)) continue
    const indent = raw.length - raw.trimStart().length

    // `  name:` at two spaces opens a job.
    const jobMatch = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(raw)
    if (jobMatch !== null) {
      current = { name: jobMatch[1], lines: [], runs: [], uses: [], with: [] }
      jobs.push(current)
      block = null
      continue
    }
    if (current === null) continue
    current.lines.push(raw)

    if (/^ {4}steps:\s*$/.test(raw)) {
      block = 'steps'
      continue
    }
    if (block === 'steps') {
      const uses = /^ {6,}-?\s*uses:\s*(\S+)/.exec(raw)
      if (uses !== null) current.uses.push(uses[1].replace(/^['"]|['"]$/g, ''))
      const run = /^ {8,}run:\s*(.*)$/.exec(raw)
      if (run !== null) current.runs.push(run[1])
      // A block scalar continues until the indentation drops back out of `run:`.
      const scalar = /^ {6,}-?\s*run:\s*[|>]\s*$/.test(raw)
      if (scalar) current.runs.push('|SCALAR|')
      const withKey = /^ {8,}(if-no-files-found|name|path):\s*(.+)$/.exec(raw)
      if (withKey !== null) current.with.push(withKey[1] + '=' + withKey[2].trim())
      if (/^ {8,}\S/.test(raw) && !/^ {8,}-/.test(raw) && !/^ {10,}/.test(raw) && block === 'steps') {
        // A `with:` child of a step is at six-to-ten spaces; only the run check
        // above cares, so nothing to do here.
      }
    }
  }

  return {
    text: source,
    lines,
    hasConcurrency,
    hasPermissions,
    jobs: jobs.map((job) => ({
      ...job,
      runText: job.runs.join('\n'),
      hasTimeout: job.lines.some((line) => /^ {4}timeout-minutes:/.test(line)),
      hasSteps: job.lines.some((line) => /^ {4}steps:\s*$/.test(line)),
    })),
    raw: source,
  }
}

/** Every `uses: owner/action@ref` in a workflow, tagged with what kind of ref it is. */
export function actionPins(parsed) {
  const pins = []
  for (const job of parsed.jobs) {
    for (const use of job.uses) {
      if (use.startsWith('./') || use.startsWith('docker://')) continue
      const at = use.lastIndexOf('@')
      if (at === -1) continue
      const ref = use.slice(at + 1)
      // A 40-hex ref is a commit; anything else is a branch or a major tag.
      const kind = /^[0-9a-f]{40}$/i.test(ref) ? 'sha' : 'floating'
      pins.push({ action: use.slice(0, at), ref, kind })
    }
  }
  return pins
}

/** The uv version a workflow declares, if it declares one. */
export function declaredUvVersion(parsed) {
  const match = /version:\s*['"]?(\d+\.\d+\.\d+)['"]?/.exec(parsed.text)
  return match === null ? null : match[1]
}

/** Read the project's coverage floor: the command line first, then pyproject. */
function coverageFloor(text, pyprojectText) {
  const cli = /--cov-fail-under[= ](\d+)/.exec(text)
  if (cli !== null) return Number(cli[1])
  if (typeof pyprojectText === 'string') {
    const table = /\[tool\.coverage[^\]]*\]([\s\S]*?)(?=\n\[|$)/.exec(pyprojectText)
    const scoped = table === null ? pyprojectText : table[0]
    const failUnder = /fail_under\s*=\s*(\d+)/.exec(scoped)
    if (failUnder !== null) return Number(failUnder[1])
  }
  return null
}

/** Does the project have any file that implies a container? */
function containerEvidence(rootDir) {
  if (typeof rootDir !== 'string' || rootDir === '') return { has: false, file: null }
  const candidates = ['Dockerfile', 'dockerfile', 'compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml']
  for (const name of candidates) {
    const candidate = path.join(rootDir, name)
    if (existsSync(candidate)) return { has: true, file: name }
  }
  return { has: false, file: null }
}

/**
 * Run every rule over one workflow.
 *
 * @param options - `{ text, file, rootDir, pyprojectText, localUvVersion }`.
 * @returns `{ file, findings, counts }`; findings are sorted by severity.
 */
export function auditWorkflow(options = {}) {
  const text = typeof options.text === 'string' ? options.text : ''
  const file = typeof options.file === 'string' && options.file !== '' ? options.file : '.github/workflows/ci.yml'
  const parsed = parseWorkflow(text)
  const pins = actionPins(parsed)
  const findings = []
  const add = (ruleId, message, line) => {
    const rule = RULES.find((entry) => entry.id === ruleId)
    findings.push({
      id: rule.id,
      severity: rule.severity,
      title: rule.title,
      message,
      file,
      line: line ?? null,
    })
  }

  // ------------------------------------------------------------ pin policy
  const kinds = new Set(pins.map((pin) => pin.kind))
  if (kinds.has('sha') && kinds.has('floating')) {
    const floating = pins.filter((pin) => pin.kind === 'floating').map((pin) => pin.action + '@' + pin.ref)
    const pinned = pins.filter((pin) => pin.kind === 'sha').map((pin) => pin.action)
    add(
      'pin-policy-mixed',
      '固定策略不一致：' + pinned.join(', ') + ' 用 commit SHA，而 ' + floating.join(', ') +
      ' 用浮动大版本。选一种，或把差异写进注释说明为什么。',
    )
  }

  // --------------------------------------------------------------- per job
  for (const job of parsed.jobs) {
    if (!job.hasTimeout) {
      add('job-timeout-missing', 'job `' + job.name + '` 没有 timeout-minutes，挂住时会用到 GitHub 的 6 小时上限。')
    }
    const alwaysUpload = /if:\s*\S*always\(\)/.test(job.runText) || job.lines.some((line) => /if:\s*\S*always\(\)/.test(line))
    const errorNoFiles = job.with.some((entry) => entry === 'if-no-files-found=error')
    if (alwaysUpload && errorNoFiles) {
      add(
        'artifact-always-error',
        'job `' + job.name + '` 的上传步骤用 `if: always()`，同时 `if-no-files-found: error`；' +
        '一次失败会再生出一次失败。改成 `warn` 或去掉 `always()`。',
      )
    }
  }

  // A workflow-level rule, not a per-job one: one artefact somewhere is enough
  // evidence to open after a failure, and requiring one per job would flag a
  // workflow that uploads exactly the right thing.
  const anyUpload = parsed.jobs.some((job) => job.uses.some((use) => use.startsWith('actions/upload-artifact@')))
  if (!anyUpload) {
    add('no-artifact', '整个 workflow 没有 upload-artifact：失败时没有任何产物可查。')
  }

  // --------------------------------------------------------------- uv gates
  for (const match of text.matchAll(/uv\s+sync(\s[^\n]*)?/g)) {
    const rest = match[1] ?? ''
    if (!/--(?:locked|frozen)\b/.test(rest)) {
      add('sync-unlocked', '`uv sync' + rest.trimEnd() + '` 缺 --locked：CI 会就地改写锁文件。')
      break
    }
  }
  // A `uv sync --frozen`/`--locked` in the same workflow already pins the
  // environment for the whole job, so a later `uv run ruff` inherits a resolved
  // set instead of resolving one. Flagging those would mean this plugin's own
  // output fails its own audit — and the rule would then be teaching people to
  // ignore it. The rule still fires when nothing in the file asserts a lock.
  const pinsLockUpFront = /uv\s+sync\s[^\n]*--(?:locked|frozen)\b/.test(text)
  for (const match of text.matchAll(/uv\s+run(\s[^\n]*)?/g)) {
    const rest = match[1] ?? ''
    // `uv run --locked` and `uv run --frozen` are both assertions; a bare
    // `uv run pytest` may re-resolve.
    if (!pinsLockUpFront && !/--(?:locked|frozen)\b/.test(rest)) {
      add('run-unlocked', '`uv run' + rest.trimEnd().slice(0, 60) + '` 缺 --locked：CI 里可能重新解析依赖。')
      break
    }
  }
  if (/\bpip3?\s+install\b/.test(text)) {
    add('pip-install', 'CI 里出现 `pip install`：它会绕过 uv.lock，装出未经验证的组合。')
  }

  // -------------------------------------------------------- workflow-level
  if (!parsed.hasConcurrency) {
    add('no-concurrency', '没有 concurrency 组：连推三次会并行跑三次全量。')
  }
  if (!parsed.hasPermissions) {
    add('permissions-missing', '没有声明的 permissions：`permissions: contents: read` 一行就够。')
  }
  if (/pytest|--cov/.test(text) && coverageFloor(text, options.pyprojectText) === null) {
    add('coverage-floor-missing', '跑 pytest 但没有覆盖率下限：加 `--cov-fail-under=80` 或 pyproject 的 `fail_under`。')
  }

  // ------------------------------------------------------------ uv drift
  const declared = declaredUvVersion(parsed)
  const local = typeof options.localUvVersion === 'string' && options.localUvVersion !== ''
    ? options.localUvVersion
    : null
  if (declared !== null && local !== null && declared !== local) {
    add('uv-version-drift', 'workflow 声明 uv ' + declared + '，本机是 ' + local + '。不是错误，但要写进注释。')
  } else if (declared !== null && local === null) {
    add('uv-version-drift', 'workflow 声明 uv ' + declared + '，本机版本未读到，无法比对。')
  }

  // ----------------------------------------------------------- container
  const container = containerEvidence(options.rootDir)
  const hasContainerJob = parsed.jobs.some((job) => /compose|docker/i.test(job.runText))
  if (container.has && !hasContainerJob) {
    add(
      'container-stage-missing',
      '仓库里有 ' + container.file + ' 但 workflow 没有任何 docker/compose 步骤：镜像构建要等到部署时才发现坏。',
    )
  }

  // -------------------------------------------------------------- secrets
  // A password literal is either a `password: <value>`-ish assignment or a
  // well-known token shape. `${{ secrets.X }}` is the correct spelling and must
  // never trip this rule.
  const secretPattern =
    /\b(?:PASSWORD|PASSWD|SECRET|API_KEY|TOKEN)\s*[:=]\s*['"]?(?!\$\{\{)[^\s'"]{6,}/i
  const hardcoded =
    /(?:ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16})/.test(text) ||
    (secretPattern.test(text) && !/\$\{\{\s*secrets\./.test(text))
  if (hardcoded) {
    add('secret-in-run', 'run 里出现疑似明文口令：换成 `${{ secrets.NAME }}`，并轮换已泄露的值。')
  }

  findings.sort((left, right) => SEVERITY_ORDER.indexOf(left.severity) - SEVERITY_ORDER.indexOf(right.severity))
  const counts = { error: 0, warn: 0, info: 0 }
  for (const finding of findings) counts[finding.severity] += 1

  return { file, findings, counts }
}

/**
 * Audit every workflow under `.github/workflows/`.
 *
 * @param options - `{ rootDir, workflows: [{file, text}], pyprojectText, localUvVersion }`.
 * @returns `{ findings, counts, files }` — one flat report across all files.
 */
export function auditRepository(options = {}) {
  const files = Array.isArray(options.workflows) ? options.workflows : []
  const results = files.map((entry) => auditWorkflow({
    text: entry.text,
    file: entry.file,
    rootDir: options.rootDir,
    pyprojectText: options.pyprojectText,
    localUvVersion: options.localUvVersion,
  }))
  const findings = []
  for (const result of results) findings.push(...result.findings)
  const counts = { error: 0, warn: 0, info: 0 }
  for (const finding of findings) counts[finding.severity] += 1
  return {
    files: results.map((result) => ({ file: result.file, counts: result.counts })),
    findings,
    counts,
  }
}
