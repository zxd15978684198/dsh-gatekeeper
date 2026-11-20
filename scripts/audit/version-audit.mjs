#!/usr/bin/env node
/**
 * DSH 插件版本审计器（只读）
 *
 * 用法：
 *   node scripts/audit/version-audit.mjs                 # 审计当前 profile 里所有 link/file 安装的本地插件
 *   node scripts/audit/version-audit.mjs gatekeeper      # 只审计指定包名
 *   node scripts/audit/version-audit.mjs --json          # 机器可读输出
 *
 * 它只读三处：
 *   1. 宿主版本       <install>\resources\app.asar 内的 dsh/package.json（desktop-runtime）
 *   2. profile        %USERPROFILE%\.dsh\profiles\<profile>\package.json
 *   3. 插件自身的     <plugin>/package.json
 *
 * 它检查四层：
 *   L1 版本区间   插件 dsh.engines.dsh / engines.node / peerDependencies 是否覆盖当前宿主
 *   L2 清单契约   dsh.bundle.patch 文件是否存在、dsh.client 是否有对应模块、locale/icon 是否齐
 *   L3 运行时探针 GET /gatekeeper/status、/gatekeeper/preview 是否 200 且 degraded=false
 *   L4 触点清单   静态 grep 出插件用到的 host API，交给 cordis_inspect 人工比对（本脚本只列清单）
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

const ROOT = resolve(import.meta.dirname, '..', '..')
const PROFILE = process.env.DSH_PROFILE || 'desktop'
const PROFILE_DIR = process.env.DSH_PROFILE_DIR || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', PROFILE)

/**
 * app.asar 的位置。
 *
 * 打包版每次安装都换目录，所以按「环境变量 → 与本脚本无关的常见安装位置」依次探，
 * 探不到只影响「宿主版本」这一项的取证，不影响其余检查。
 */
function resolveAppAsar() {
  const candidates = [
    process.env.DSH_APP_ASAR,
    // 从当前宿主进程的 exe 反推：<install>/DeepSeek Harness.exe → <install>/resources/app.asar
    process.env.DSH_APP_EXE ? join(dirname(process.env.DSH_APP_EXE), 'resources', 'app.asar') : undefined,
    join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
    join(process.env.ProgramFiles || '', 'DeepSeek Harness', 'resources', 'app.asar'),
    'E:/DSH/resources/app.asar',
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
  ]
  return candidates.find((path) => path !== undefined && path !== '' && existsSync(path)) ?? null
}

const APP_ASAR = resolveAppAsar()

// ---------------------------------------------------------------- semver-lite
/** 解析出 [major, minor, patch, prerelease[]]；无法解析返回 null。 */
function parse(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(v).trim())
  if (m === null) return null
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? [] : m[4].split('.')]
}

/** semver 优先级比较：a<b → -1，a===b → 0，a>b → 1。预发布版本低于同号正式版。 */
function compare(a, b) {
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  }
  const pre = (p) => (p[3].length === 0 ? [1] : [0, ...p[3].map((x) => (/^\d+$/.test(x) ? Number(x) : x))])
  const ra = pre(pa)
  const rb = pre(pb)
  for (let i = 0; i < Math.max(ra.length, rb.length); i += 1) {
    const x = ra[i]
    const y = rb[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    if (typeof x === 'string' || typeof y === 'string') return String(x) < String(y) ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

/** 只支持 DSH 插件里实际出现的语法：>=, >, <=, <, =, ^, ~, x-range, 空格合取, || 析取。 */
function satisfies(version, range) {
  if (parse(version) === null) return null
  const alternatives = String(range).split('||').map((s) => s.trim())
  return alternatives.some((alt) => {
    // 只把「带空格的连字符区间」当区间；prerelease 里的 "-rc.1" 必须原样保留
    const lte = alt.replace(/\s+-\s+/g, ' ')
    const terms = lte.split(/\s+/).filter((t) => t !== '' && t !== '-')
    if (terms.length === 0) return true
    return terms.every((term) => satisfiesTerm(version, term))
  })
}

function satisfiesTerm(version, term) {
  const m = /^(\^|~|>=|<=|>|<|=)?v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-([0-9A-Za-z.-]+))?$/.exec(term)
  if (m === null) return null
  const [, op = '=', major, minor, patch, pre] = m
  const lo = [Number(major), minor === undefined || minor === 'x' || minor === '*' ? 0 : Number(minor), patch === undefined || patch === 'x' || patch === '*' ? 0 : Number(patch)]
  const loStr = `${lo[0]}.${lo[1]}.${lo[2]}${pre === undefined ? '' : '-' + pre}`
  if (op === '=' || op === '') {
    if (minor === undefined || minor === 'x' || minor === '*') return parse(version)[0] === lo[0]
    if (patch === undefined || patch === 'x' || patch === '*') {
      return parse(version)[0] === lo[0] && parse(version)[1] === lo[1] && compare(version, loStr) >= 0
    }
    return compare(version, loStr) === 0
  }
  if (op === '>=') return compare(version, loStr) >= 0
  if (op === '>') return compare(version, loStr) > 0
  if (op === '<=') return compare(version, loStr) <= 0
  if (op === '<') return compare(version, loStr) < 0
  // ^ 与 ~ 的上界
  const hi = op === '^'
    ? (lo[0] > 0 ? `${lo[0] + 1}.0.0` : lo[1] > 0 ? `0.${lo[1] + 1}.0` : `0.0.${lo[2] + 1}`)
    : `${lo[0]}.${lo[1] + 1}.0`
  return compare(version, loStr) >= 0 && compare(version, hi) < 0
}

// ------------------------------------------------------------------ asar 读取
/** 用偏移表读 asar 内部文件，避免引入 asar 依赖。 */
function readAsar(innerPath) {
  if (APP_ASAR === null) return null
  const buf = readFileSync(APP_ASAR)
  // asar 结构：u32@0=4 | u32@4=headersize | u32@8=jsonlen | u32@12=padding | json@16 | payload
  const headerSize = buf.readUInt32LE(4)
  const base = 8 + headerSize
  const jsonLen = buf.readUInt32LE(8) - 4
  // 头部 JSON 后面可能有对齐填充，parse 失败时退回到「最后一个 } 之前」再试一次。
  const raw = buf.subarray(16, 16 + jsonLen).toString('utf8')
  let doc
  try {
    doc = JSON.parse(raw)
  } catch {
    const end = raw.lastIndexOf('}')
    if (end < 0) return null
    doc = JSON.parse(raw.slice(0, end + 1))
  }
  let node = doc
  for (const part of innerPath.split('/')) {
    node = node?.files?.[part]
    if (node === undefined) return null
  }
  if (node.size === undefined) return null
  return buf.subarray(base + Number(node.offset), base + Number(node.offset) + Number(node.size)).toString('utf8')
}

function hostFacts() {
  const raw = readAsar('dsh/package.json')
  const pkg = raw === null ? null : JSON.parse(raw)
  return { name: pkg?.name ?? 'unknown', version: pkg?.version ?? 'unknown' }
}

// --------------------------------------------------------------------- 主流程
const args = process.argv.slice(2)
const asJson = args.includes('--json')
const only = args.filter((a) => !a.startsWith('--'))

const findings = []
const push = (level, policy, message, evidence) => findings.push({ level, policy, message, evidence })

const host = hostFacts()
const nodeVersion = process.versions.node
const profilePkgPath = join(PROFILE_DIR, 'package.json')
const profilePkg = existsSync(profilePkgPath) ? JSON.parse(readFileSync(profilePkgPath, 'utf8')) : null
if (profilePkg === null) {
  push('error', 'profile', `找不到 profile package.json：${profilePkgPath}`)
}

const localPlugins = []
for (const [name, spec] of Object.entries(profilePkg?.dependencies ?? {})) {
  const isLocal = spec.startsWith('link:') || spec.startsWith('file:') || spec.startsWith('.')
  if (!isLocal) continue
  if (only.length > 0 && !only.includes(name)) continue
  const dir = spec.startsWith('link:') || spec.startsWith('file:')
    ? resolve(spec.slice(5))
    : resolve(PROFILE_DIR, spec)
  localPlugins.push({ name, spec, dir })
}

for (const plugin of localPlugins) {
  const pkgPath = join(plugin.dir, 'package.json')
  if (!existsSync(pkgPath)) {
    push('error', plugin.name, `链接目标没有 package.json：${pkgPath}`)
    continue
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  plugin.pkg = pkg

  // L1 版本区间
  const dshRange = pkg.dsh?.engines?.dsh ?? pkg.engines?.dsh
  if (dshRange === undefined) {
    push('warn', plugin.name, '没有声明 dsh.engines.dsh：安装器无法做兼容预检')
  } else {
    const ok = satisfies(host.version, dshRange)
    push(ok === true ? 'ok' : 'error', plugin.name, `dsh.engines.dsh = "${dshRange}" vs 宿主 ${host.version} → ${ok === true ? '满足' : '不满足'}`)
  }
  if (pkg.engines?.node !== undefined) {
    const ok = satisfies(nodeVersion, pkg.engines.node)
    push(ok === true ? 'ok' : 'error', plugin.name, `engines.node = "${pkg.engines.node}" vs 当前 node ${nodeVersion} → ${ok === true ? '满足' : '不满足'}`)
  }
  for (const [peer, range] of Object.entries(pkg.peerDependencies ?? {})) {
    const installed = join(PROFILE_DIR, 'node_modules', peer, 'package.json')
    const ver = existsSync(installed) ? JSON.parse(readFileSync(installed, 'utf8')).version : null
    if (ver === null) {
      const optional = pkg.peerDependenciesMeta?.[peer]?.optional === true
      push(optional ? 'ok' : 'warn', plugin.name, `peer ${peer}@${range} 未安装（${optional ? '声明为 optional' : '非 optional，可能缺依赖'}）`)
    } else {
      const ok = satisfies(ver, range)
      push(ok === true ? 'ok' : 'warn', plugin.name, `peer ${peer}@${range} vs 已装 ${ver} → ${ok === true ? '满足' : '不满足'}`)
    }
  }

  // L2 清单契约
  const patch = pkg.dsh?.bundle?.patch
  if (patch === undefined) push('warn', plugin.name, '没有 dsh.bundle.patch：这个包不会往 profile 里插入任何进程级行')
  else if (!existsSync(join(plugin.dir, patch))) push('error', plugin.name, `dsh.bundle.patch 指向不存在的文件：${patch}`)

  if (pkg.dsh?.client !== undefined) {
    const target = pkg.exports?.['./client']
    if (target === undefined) push('error', plugin.name, '声明了 dsh.client 但 exports 没有 "./client"')
    else if (!existsSync(join(plugin.dir, target))) push('error', plugin.name, `exports["./client"] 指向不存在的文件：${target}`)
    if (pkg.dsh.client.platform !== undefined && !['web', 'desktop'].includes(pkg.dsh.client.platform)) {
      push('warn', plugin.name, `未知的 dsh.client.platform：${pkg.dsh.client.platform}`)
    }
  }
  for (const lang of ['en', 'zh']) {
    if (!existsSync(join(plugin.dir, 'locale', `${lang}.json`))) {
      push('info', plugin.name, `缺少 locale/${lang}.json：插件管理页会回退到 package.json 的 name/description`)
    }
  }

  // L4 触点清单（静态）
  const touchpoints = scanTouchpoints(plugin.dir)
  plugin.touchpoints = touchpoints
  for (const finding of contractChecks(plugin, pkg)) findings.push(finding)
}

/**
 * 宿主语义漂移的三条静态规则：都是 0.2.2 上「装得上、跑起来却不对」的坑。
 *
 * 1. `engines.dsh` 必须写在**顶层** `engines` 里。宿主 `unmetRequirements()` 只读
 *    `manifest.engines.dsh`，`dsh.engines.dsh` 是市场元数据的写法，安装期不生效。
 * 2. `Schema.x().volatile()` 的字段经校验后是 `{ get(), [write] }` 引用对象，
 *    不是值；`resolveConfig` 里不解包就永远读不到用户设置。
 * 3. slash source 的 `candidates()` 必须返回 Promise：宿主直接
 *    `source.candidates(...).then(...)`，同步返回数组会抛 `[].then is not a function`。
 */
function contractChecks(plugin, pkg) {
  const out = []
  const rel = (p) => p.replace(plugin.dir + '\\', '').replace(plugin.dir + '/', '')

  if (pkg.dsh?.engines?.dsh !== undefined && pkg.engines?.dsh === undefined) {
    out.push({
      level: 'warn',
      policy: plugin.name,
      message: `engines.dsh 写在了 dsh.engines 里（"${pkg.dsh.engines.dsh}"）：宿主只读顶层 engines.dsh，这条兼容声明在安装期被忽略`,
      evidence: 'asar lib/types/plugin-compatibility.js → unmetRequirements() 读 fields.engines.dsh',
    })
  }

  const files = []
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      // 审计探针自身会引用 .volatile() / candidates()，它们不是插件契约的一部分。
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'test' || entry.name === 'docs' || entry.name === 'audit') continue
      const p = join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (/\.(m?js|cjs)$/.test(entry.name)) files.push(p)
    }
  }
  walk(plugin.dir)

  for (const file of files) {
    const text = readFileSync(file, 'utf8')

    // 规则 2：schema 里有 volatile 字段，但同一模块没有解包动作
    if (/\.volatile\(\)/.test(text) && /resolveConfig|function resolve|export function/.test(text)) {
      const unwraps = /\.get\?\.\(\)|\.get\(\)/.test(text)
      if (!unwraps) {
        out.push({
          level: 'error',
          policy: plugin.name,
          message: `${rel(file)}: 声明了 .volatile() 字段却从不解包 —— 校验后拿到的是 { get() } 引用对象，所有设置静默落回默认值`,
          evidence: 'schemastery 3.19: .volatile() → [createVolatile(value), adapted]，值在 .get() 后面',
        })
      }
    }

    // 规则 3：slash source 的 candidates 同步返回数组
    if (/candidates\s*:\s*(?:\(\s*\)\s*=>|\(\s*[^)]*\)\s*=>|function)\s*\[/.test(text)) {
      out.push({
        level: 'error',
        policy: plugin.name,
        message: `${rel(file)}: candidates 同步返回数组 —— 宿主写死 .then()，敲触发键即 TypeError，菜单不弹`,
        evidence: 'asar InputTriggerService.fetchCandidates(): source.candidates(...).then(...)',
      })
    }

    // 规则 4：给数组挂自有属性（宿主 lossless JSON 校验会拒收）
    for (const match of text.matchAll(/^[ \t]*(\w+)\.(\w+)[ \t]*=[ \t]*\S.*$/gm)) {
      const [, , key] = match
      if (['length', 'push', 'slice', 'map', 'filter', 'sort', 'join'].includes(key)) continue
      if (!/profile|from|meta|extra|label|id/.test(key)) continue
      out.push({
        level: 'info',
        policy: plugin.name,
        message: `${rel(file)}: \`${match[0].trim()}\` —— 如果目标是数组，宿主 walkJsonValue 会判非 lossless JSON`,
        evidence: 'asar: if (Reflect.ownKeys(current).length !== length + 1) return void 0',
      })
    }
  }
  return out
}

/** 静态扫出插件用到的 host 触点，供 cordis_inspect 逐条比对。 */
function scanTouchpoints(dir) {
  const files = []
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'tmp') continue
      const p = join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (/\.(m?js|cjs)$/.test(entry.name)) files.push(p)
    }
  }
  walk(dir)
  const patterns = [
    /ctx\.(?:get|inject|on|effect|tools|skills|webServer|fiber|remote)\b[^\n]{0,80}/g,
    /ctx\.(?:get|inject)\(\s*\[?\s*'([a-zA-Z.]+)'/g,
    /ctx\.on\(\s*'([a-zA-Z/:-]+)'/g,
  ]
  const hits = new Set()
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) hits.add(match[1] !== undefined && !match[0].includes('(') ? match[0] : match[0].trim())
    }
  }
  return [...hits].sort()
}

// L3 运行时探针（只在审计 gatekeeper 时跑，且宿主活着）
const probe = { attempted: false }
if (localPlugins.some((p) => p.name === 'gatekeeper')) {
  // The desktop app picks a fresh port every launch, so never hardcode one: the
  // harness exports its own origin as DSH_WEB_URL. DSH_URL stays as an override,
  // and the old 58898 remains only as the last-resort default.
  const base = process.env.DSH_WEB_URL || process.env.DSH_URL || 'http://127.0.0.1:58898'
  probe.attempted = true
  probe.base = base
  for (const path of ['/gatekeeper/status?peek=1', '/gatekeeper/preview?path=' + encodeURIComponent(PROFILE_DIR)]) {
    try {
      const started = Date.now()
      const res = await fetch(base + path)
      const text = await res.text()
      probe[path] = { status: res.status, ms: Date.now() - started, bytes: text.length }
      if (res.status !== 200) push('error', 'gatekeeper', `路由 ${path} 返回 ${res.status}`, text.slice(0, 200))
      else if (path.startsWith('/gatekeeper/status')) {
        const body = JSON.parse(text)
        const degraded = body?.plugin?.degraded
        push(degraded === false ? 'ok' : 'warn', 'gatekeeper', `status 路由 200，degraded=${String(degraded)}，schema=${String(body?.plugin?.schema)}`)
      }
    } catch (error) {
      probe[path] = { error: String(error) }
      push('warn', 'gatekeeper', `路由 ${path} 探测失败`, String(error))
    }
  }
}

// ---------------------------------------------------------------------- 输出
const report = { host, node: nodeVersion, profile: PROFILE, profileDir: PROFILE_DIR, findings, plugins: localPlugins, probe }
if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  const mark = { ok: '  OK  ', warn: ' WARN ', error: ' FAIL ', info: ' INFO ' }
  console.log(`DSH 版本审计  host=${host.name}@${host.version}  node=${nodeVersion}  profile=${PROFILE}`)
  console.log('-'.repeat(78))
  for (const f of findings) console.log(`${mark[f.level] ?? ' ---- '} [${f.policy}] ${f.message}`)
  for (const p of localPlugins) {
    console.log('-'.repeat(78))
    console.log(`插件 ${p.name}@${p.pkg?.version ?? '?'}  ${p.spec}`)
    console.log(`  目录  ${p.dir}`)
    console.log(`  触点  ${(p.touchpoints ?? []).length} 条（用 cordis_inspect_list/query 逐条比对当前宿主契约）`)
    for (const t of (p.touchpoints ?? []).slice(0, 40)) console.log(`        ${t}`)
    if ((p.touchpoints ?? []).length > 40) console.log(`        … 另 ${p.touchpoints.length - 40} 条`)
  }
  console.log('-'.repeat(78))
  const bad = findings.filter((f) => f.level === 'error').length
  const warn = findings.filter((f) => f.level === 'warn').length
  console.log(`结论：${bad} 项失败，${warn} 项警告。失败项必须修，警告项确认后写进报告。`)
}
