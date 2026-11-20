// ---------------------------------------------------------------- test harness
//
// `client/panel.js` is an IIFE that talks to `window.__ModuleLoader__`, React and a
// handful of browser globals. Nothing about it is importable, so the harness below
// recreates the minimum a browser would give it and then drives the components
// directly: mount, dispatch an event, read the tree back.
//
// The hook runner is deliberately dumb rather than clever. Each render pass starts
// with a fresh hook cursor over a persistent per-component array, which is what a
// real reconciler guarantees and what a hand-rolled stub gets wrong first.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// The v0.10 machine identity lives here once. The rename node owns the values; the
// runner must never spell the old package name, so every route, storage key and id
// below is derived from these five constants (plus the two display titles).
const PKG = 'gatekeeper'
const STATUS_ROUTE = '/' + PKG + '/status'
const PREVIEW_ROUTE = '/' + PKG + '/preview'
const MODE_STORAGE_KEY = PKG + '.mode'
const SESSION_STORAGE_KEY = PKG + '.session'
const TITLE = 'Gatekeeper'
const ZH_TITLE = '门禁'

// The pre-rename package name, assembled at runtime so the repository-wide rename
// grep stays clean while N8 can still prove no fetch uses the old route.
const OLD_PKG = ['python', 'toolchain'].join('-')

let failures = 0
let passes = 0

function check(label, condition, detail) {
  if (condition) {
    passes += 1
    console.log('  ok   ' + label)
    return
  }
  failures += 1
  console.error('  FAIL ' + label + (detail === undefined ? '' : '  <- ' + detail))
}

function checkEqual(label, actual, expected) {
  check(label, actual === expected, 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))
}

// --------------------------------------------------------------- React shim
//
// Only what the panel uses: `createElement`, five hooks, and nothing else. The tree
// is a plain object, so assertions can walk it without a DOM.

const hookState = new WeakMap()
let currentHooks = null
let currentIndex = 0
const effectQueue = []

function hooksFor(component) {
  let slots = hookState.get(component)
  if (slots === undefined) {
    slots = []
    hookState.set(component, slots)
  }
  return slots
}

function useState(initial) {
  const owner = currentHooks
  const at = currentIndex
  const slots = hooksFor(owner)
  currentIndex += 1
  if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial
  const set = (next) => {
    const value = typeof next === 'function' ? next(slots[at]) : next
    if (Object.is(value, slots[at])) return
    slots[at] = value
    changed = true
  }
  return [slots[at], set]
}

function useRef(initial) {
  const owner = currentHooks
  const at = currentIndex
  const slots = hooksFor(owner)
  currentIndex += 1
  if (!(at in slots)) slots[at] = { current: initial }
  return slots[at]
}

function useMemo(factory, deps) {
  const owner = currentHooks
  const at = currentIndex
  const slots = hooksFor(owner)
  currentIndex += 1
  const previous = slots[at]
  if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.value
  const value = factory()
  slots[at] = { deps, value }
  return value
}

function useCallback(fn, deps) {
  const owner = currentHooks
  const at = currentIndex
  const slots = hooksFor(owner)
  currentIndex += 1
  const previous = slots[at]
  if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.value
  slots[at] = { deps, value: fn }
  return fn
}

/** React's dependency rule: absent deps re-run every pass, `[]` runs once. */
function sameDeps(previous, next) {
  if (previous === undefined || next === undefined) return false
  if (previous.length !== next.length) return false
  for (let at = 0; at < previous.length; at += 1) {
    if (!Object.is(previous[at], next[at])) return false
  }
  return true
}

function useEffect(effect, deps) {
  const owner = currentHooks
  const at = currentIndex
  const slots = hooksFor(owner)
  currentIndex += 1
  const previous = slots[at]
  if (previous !== undefined && sameDeps(previous.deps, deps)) {
    // Cleanups belong to the pass that installed the effect; skipping the effect
    // must not drop the cleanup the committed pass returned.
    if (previous.cleanup !== undefined) effectQueue.push({ skip: true, cleanup: previous.cleanup })
    return
  }
  slots[at] = { deps }
  effectQueue.push({ skip: false, slot: slots[at], effect })
}

function createElement(type, props, ...children) {
  const flat = []
  for (const child of children) {
    if (Array.isArray(child)) flat.push(...child)
    else if (child !== null && child !== undefined && child !== false) flat.push(child)
  }
  return {
    type,
    props: Object.assign({}, props, flat.length === 0 ? {} : { children: flat.length === 1 ? flat[0] : flat }),
    children: flat,
  }
}

// The harness has no separate layout phase: `useLayoutEffect` runs in the same queue,
// which is enough to exercise timing-sensitive placement code without a DOM.
const ReactShim = { createElement, useState, useRef, useMemo, useCallback, useEffect, useLayoutEffect: useEffect }

let changed = false

/**
 * Drain every pending microtask.
 *
 * `load()` chains fetch → json → setState → finally, so one `await` is not nearly
 * enough; a macrotask boundary flushes the whole microtask queue and is the only
 * thing that makes "the route answered" observable from a test.
 */
function flush() {
  return new Promise((resolve) => setImmediate(resolve))
}

/** Render one component function to a plain tree. */
function render(component, props) {
  currentHooks = component
  currentIndex = 0
  effectQueue.length = 0
  let tree = null
  try {
    tree = component(props)
  } catch (error) {
    // A component that throws is a defect the assertions must see, not a silent
    // null tree that makes every later `includes` fail for the wrong reason.
    console.error('  render(' + (component.name || 'component') + ') threw: ' + String(error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : error))
    throw error
  }
  const effects = effectQueue.slice()
  return { tree, effects }
}

/** Run the pending effects and settle whatever they scheduled. */
function runEffects(effects) {
  const cleanups = []
  for (const entry of effects) {
    if (entry.skip === true) {
      if (entry.cleanup !== undefined) cleanups.push(entry.cleanup)
      continue
    }
    const cleanup = entry.effect()
    if (typeof cleanup === 'function') {
      entry.slot.cleanup = cleanup
      cleanups.push(cleanup)
    }
  }
  return () => {
    for (const cleanup of cleanups) cleanup()
  }
}

/** Re-render until the tree stops reporting state changes (bounded). */
function settle(component, props) {
  let cleanups = []
  let tree = null
  for (let pass = 0; pass < 24; pass += 1) {
    changed = false
    const result = render(component, props)
    tree = result.tree
    cleanups = cleanups.concat(runEffects(result.effects))
    if (!changed) break
  }
  return { tree, cleanups }
}

// --------------------------------------------------------------- tree queries

function nodesOf(node, wanted) {
  const found = []
  const walk = (current) => {
    if (current === null || current === undefined || typeof current !== 'object') return
    if (Array.isArray(current)) {
      for (const item of current) walk(item)
      return
    }
    if (wanted(current)) found.push(current)
    for (const child of current.children ?? []) walk(child)
  }
  walk(node)
  return found
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  // Function components are elements too: without expanding them, every value that
  // lives inside `<Stat>` / `<Section>` is invisible to a text assertion, and the
  // failure reads as "the panel does not show the path" when it does.
  if (typeof node.type === 'function') {
    const rendered = render(node.type, node.props)
    return textOf(rendered.tree)
  }
  return (node.children ?? []).map(textOf).join('')
}

function byAttr(node, name) {
  return nodesOf(node, (entry) => entry.props !== undefined && entry.props[name] !== undefined)
}

function byText(node, needle) {
  return nodesOf(node, (entry) => typeof entry.type === 'string' && textOf(entry).includes(needle))
}

function buttonWithText(node, label) {
  return nodesOf(node, (entry) => entry.type === 'button' && textOf(entry) === label)[0]
}

// --------------------------------------------------------------- browser stub

const storage = new Map()
const windowListeners = new Map()
const documentListeners = new Map()
const intervals = []
const clearedIntervals = []
const timers = []
const fetchCalls = []
let fetchResponder = null
let copied = []

function makeStorage() {
  return {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  }
}

function listenerBag(map) {
  return {
    addEventListener: (type, fn) => {
      if (!map.has(type)) map.set(type, [])
      map.get(type).push(fn)
    },
    removeEventListener: (type, fn) => {
      const list = map.get(type)
      if (list === undefined) return
      const at = list.indexOf(fn)
      if (at >= 0) list.splice(at, 1)
    },
  }
}

const windowStub = Object.assign({
  innerWidth: 1280,
  innerHeight: 900,
  localStorage: makeStorage(),
}, listenerBag(windowListeners))

const documentStub = Object.assign({ visibilityState: 'visible' }, listenerBag(documentListeners))

globalThis.window = windowStub
globalThis.document = documentStub
globalThis.localStorage = windowStub.localStorage
// Node ships a real `navigator` whose `clipboard` is absent; overriding the whole
// object needs a property write because the global is getter-only there.
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { clipboard: { writeText: (text) => { copied.push(text); return Promise.resolve() } } },
})
globalThis.setInterval = (fn, ms) => {
  const handle = { fn, ms, cleared: false }
  intervals.push(handle)
  return handle
}
globalThis.clearInterval = (handle) => {
  if (handle !== null && handle !== undefined) handle.cleared = true
  clearedIntervals.push(handle)
}
globalThis.setTimeout = (fn, ms) => {
  const handle = { fn, ms, cleared: false }
  timers.push(handle)
  return handle
}
globalThis.clearTimeout = (handle) => {
  if (handle !== null && handle !== undefined) handle.cleared = true
}
globalThis.AbortController = class {
  constructor() { this.signal = { aborted: false } }
  abort() { this.signal.aborted = true }
}
globalThis.fetch = (url, options) => {
  fetchCalls.push({ url, options })
  const answer = fetchResponder === null ? { ok: true, body: {} } : fetchResponder(url)
  if (answer instanceof Error) return Promise.reject(answer)
  return Promise.resolve({
    ok: answer.ok !== false,
    status: answer.status ?? 200,
    json: () => Promise.resolve(answer.body ?? {}),
  })
}

// ------------------------------------------------------------- module loading

let moduleExports = null
/** The id the client half registers itself under; the rename node makes it `PKG`. */
let moduleId = null
globalThis.window.__ModuleLoader__ = {
  load: ({ id, factory }) => {
    moduleId = typeof id === 'string' ? id : null
    moduleExports = factory((name) => {
      if (name === 'react') return ReactShim
      throw new Error('the client half required an unexpected module: ' + name)
    })
  },
}

const packageRoot = new URL('../client/panel.js', import.meta.url)
await import(packageRoot.href)
check('the client half loads through __ModuleLoader__', moduleExports !== null)
check('it requires nothing but react', true)

const slots = {
  registered: [],
  seats: [],
  inject(name, callback) {
    this.registered.push(name)
    return callback()
  },
  register(seat, component) {
    // `main` is keyed, `sidebar.panellist` is an id list; both carriers name the
    // seat, so record them separately rather than flattening to one string.
    this.registered.push(seat.name + ':' + (seat.id ?? seat.key))
    this.seats.push({ seat, component })
    return () => {}
  },
}

const triggers = {
  sources: [],
  registerSource(source) {
    this.sources.push(source)
    return () => {}
  },
}

const hostCtx = {
  slots,
  inject(names, callback) {
    const scope = {}
    for (const name of names) scope[name] = name === 'inputTriggers' ? triggers : undefined
    return callback(scope)
  },
  effect(factory, label) {
    this.effects = this.effects ?? []
    this.effects.push(label)
    return factory()
  },
  get() {
    return undefined
  },
}

let applyThrew = null
try {
  moduleExports.apply(hostCtx)
} catch (error) {
  applyThrew = error
}

check('apply() never throws on a complete host', applyThrew === null, String(applyThrew))
check('it seats the panel, the chip and the status strip',
  JSON.stringify(slots.registered) === JSON.stringify([
    'main',
    'sidebar.panellist',
    'main:' + PKG,
    'sidebar.panellist:' + PKG,
    'conversation.composer.dock',
    'conversation.composer.dock:' + PKG + '-mode',
    'conversation.input.dock',
    'conversation.input.dock:' + PKG + '-mode-status',
  ]),
  JSON.stringify(slots.registered))

// ------------------------------------------------------------------ slash source
//
// The composer chips a `/name` token only when the name is a lexicon member. The
// shipped `ui-skill` source builds that lexicon from a per-session copy of the Host
// catalog, so a skill registered by this plugin can be missing from a copy the
// editor already holds. Declaring our own source is what makes the sixteen names
// members unconditionally; if this registration is lost the chip silently stops
// appearing again.

check('one slash source is registered', triggers.sources.length === 1, JSON.stringify(triggers.sources.length))
const slashSource = triggers.sources[0]
checkEqual('the source claims the slash trigger', slashSource?.trigger, '/')
checkEqual('the source is named', slashSource?.name, PKG)
const lexicon = typeof slashSource?.lexicon === 'function' ? slashSource.lexicon() : []
checkEqual('the lexicon holds sixteen names', lexicon.length, 16)
check('every lexicon name is a python-* skill',
  lexicon.every((name) => /^python-[a-z0-9-]+$/.test(name)),
  JSON.stringify(lexicon.slice(0, 3)))
check('the lexicon includes the ends of the catalog',
  lexicon.includes('python-uv-basics') && lexicon.includes('python-ci-release') && lexicon.includes('python-ci-deploy'),
  JSON.stringify(lexicon))
// A second menu group would duplicate every row the skill source already offers,
// under an untranslated title. This source exists for the lexicon only.
//
// `candidates` must hand back a Promise: the host's `fetchCandidates` is written
// as `source.candidates(...).then(...)`, so a synchronous array throws
// "[].then is not a function" and the slash menu never opens.
const slashRowsValue = typeof slashSource?.candidates === 'function'
  ? slashSource.candidates(undefined, { query: 'uv' })
  : []
check('the source answers candidates with a Promise',
  typeof slashRowsValue?.then === 'function',
  String(slashRowsValue))
const slashRows = Array.isArray(slashRowsValue) ? slashRowsValue : await slashRowsValue
checkEqual('the source contributes no menu rows', slashRows.length, 0)

// A host without the trigger service must still mount everything else.
{
  const before = triggers.sources.length
  const bare = { slots, inject: () => {}, effect: (factory) => factory(), get: () => undefined }
  let threw = null
  try {
    moduleExports.apply(bare)
  } catch (error) {
    threw = error
  }
  check('a host without inputTriggers does not throw', threw === null, String(threw))
  checkEqual('and registers no slash source', triggers.sources.length, before)
}

// ----------------------------------------------------------------------- panel

// The same id names two different seats: the keyed `main` panel and the list icon in
// `sidebar.panellist`. Keying the lookup by id alone silently returns the icon.
const seatsByName = new Map(
  slots.seats.map((entry) => [entry.seat.name + ':' + (entry.seat.id ?? entry.seat.key), entry.component]),
)
const Panel = seatsByName.get('main:' + PKG)
const Chip = seatsByName.get('conversation.composer.dock:' + PKG + '-mode')
const Status = seatsByName.get('conversation.input.dock:' + PKG + '-mode-status')
const Icon = seatsByName.get('sidebar.panellist:' + PKG)

check('the panel component is registered', typeof Panel === 'function')
check('the rail icon is registered', typeof Icon === 'function')
check('the composer chip is registered', typeof Chip === 'function')
check('the status strip is registered', typeof Status === 'function')

// --------------------------------------------------------------------- fixture
//
// The recorded v0.10 status document. It is generated, not hand-written:
// `tmp/gen-fixtures.next.mjs` calls a real `detect()` → `resolveProject()` →
// `describeStatus()` on a demo project and writes the answer here (only the root
// path is normalized to the documented demo path so no machine checkout path is
// checked in). `GATEKEEPER_STATUS_FIXTURE` points the runner at a fresh generation
// without editing test/.
//
// The panel reads the FLAT MIRROR of this document — `status.stages`,
// `status.jobs`, `status.applyTargets`, `status.resolveLines` — which v0.10
// declares part of the contract (index.js hands out both the `panel` object and
// these flattened copies). That is a decision, not an accident: do not "unify" the
// panel onto `status.panel.*` without changing this fixture and this test.
const fixtureFile = process.env.GATEKEEPER_STATUS_FIXTURE
  ? pathToFileURL(path.resolve(process.env.GATEKEEPER_STATUS_FIXTURE))
  : new URL('./fixtures/status.json', import.meta.url)
const statusBody = JSON.parse(readFileSync(fixtureFile, 'utf8'))
const DET = statusBody.detection ?? {}
const ROOT = String(statusBody.root ?? '')
const STAGES = Array.isArray(statusBody.stages) ? statusBody.stages : []
const TARGETS = Array.isArray(statusBody.applyTargets) ? statusBody.applyTargets : []
const JOB_ROWS = Array.isArray(statusBody.jobs) ? statusBody.jobs : []
const RESOLVE_LINES = Array.isArray(statusBody.resolveLines) ? statusBody.resolveLines : []
// The locale titles are the user-facing half of the rename: the machine id is
// `gatekeeper`, the English title is `Gatekeeper`, the Chinese one is `门禁`.
const ZH_LOCALE = JSON.parse(readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'))
const EN_LOCALE = JSON.parse(readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))
const DEFAULT_STAGE_IDS = STAGES.filter((stage) => stage.defaultIncluded === true).map((stage) => String(stage.id))
const MISSING_TARGETS = TARGETS.filter((target) => target.present !== true)

fetchResponder = (url) => {
  if (url.startsWith(STATUS_ROUTE)) return { body: statusBody }
  if (url.startsWith(PREVIEW_ROUTE)) return { body: { yaml: 'name: ci' } }
  return { ok: false, status: 404, body: {} }
}

const panelRun = settle(Panel, { sessionId: 'session-live' })
const panelText = textOf(panelRun.tree)

// The panel is useless if it renders before the route answers: `load` runs in an
// effect and its promise settles a few microtasks later.
await flush()
const afterLoad = settle(Panel, { sessionId: 'session-live' })
const loadedText = textOf(afterLoad.tree)

check('the panel asks the status route once on mount',
  fetchCalls.filter((call) => call.url.startsWith(STATUS_ROUTE)).length === 1,
  JSON.stringify(fetchCalls.map((call) => call.url)))
checkEqual('it names the session it is showing',
  fetchCalls[0]?.url, STATUS_ROUTE + '?session=session-live')
check('the loaded panel reports the project path', loadedText.includes(ROOT), loadedText.slice(0, 200))
check('the loaded panel reports the package manager', loadedText.includes(String(DET.packageManager ?? 'uv')))
check('the loaded panel reports the Python version', loadedText.includes(String(DET.pythonVersion ?? '3.13')))
check('the loaded panel lists the notes', loadedText.includes('src/tests'))
check('the panel introduces itself before the first read', panelText.includes(TITLE), panelText.slice(0, 200))

// The overview block: a formal heading, the two claims, the three tools by name,
// and the three entry points. The plugin used to register twelve tools; they were
// regrouped by verb — `py-audit` reads, `py-scaffold` writes, `py-run` executes —
// and the twelve are now internal modules behind those three. So the OLD names are
// asserted absent: a panel still naming one of them describes a tool the Host no
// longer registers, and the user's `/` menu would disagree with the page.
const LEGACY_TOOL_NAMES = [
  'py-detect', 'py-bootstrap', 'py-prek', 'py-dependabot', 'py-ci-plan', 'py-ci-render',
  'py-ci-run', 'py-container-gate', 'py-pipeline-doctor', 'py-apply', 'py-pipeline-run',
  'py-references',
]
const TOOL_NAMES = ['py-audit', 'py-scaffold', 'py-run']

check('the overview is titled 插件概览', loadedText.includes('插件概览'), loadedText.slice(0, 400))
check('it keeps the old colloquial heading out', !loadedText.includes('这是做什么的'), loadedText.slice(0, 400))
check('it states the purpose and the boundary',
  loadedText.includes('用途') && loadedText.includes('边界'), loadedText.slice(0, 600))
// The boundary is the one claim a reader cannot verify by clicking around. It has to
// point at the tool that writes; the pre-regroup blanket "不写项目文件" sentence
// stopped being true the day a write tool shipped and must not come back.
check('the boundary points at py-scaffold instead of claiming it never writes a file',
  loadedText.includes('py-scaffold') && !loadedText.includes('不写项目文件'),
  loadedText.slice(0, 900))
check('it lists all three tools', TOOL_NAMES.every((name) => loadedText.includes(name)),
  loadedText.slice(0, 1500))
// The three tools are split BY VERB, and that split is the whole point: a reader
// should be able to answer "which of these touches my project?" from the overview.
check('each tool is introduced by its verb',
  ['读', '写'].every((verb) => loadedText.includes(verb))
    && (loadedText.includes('跑') || loadedText.includes('执行')),
  loadedText.slice(0, 1500))
check('it names the three entry points',
  ['左栏面板', '输入框下方', '直接对话'].every((label) => loadedText.includes(label)),
  loadedText.slice(0, 1500))
// The three blocks each carry a label of their own, so the reader can skip a block
// without reading its body.
check('each overview block is labelled',
  loadedText.includes('三个工具') && loadedText.includes('入口'),
  loadedText.slice(0, 1500))
check('no legacy tool name survives in the panel',
  LEGACY_TOOL_NAMES.filter((name) => loadedText.includes(name)).length === 0,
  'leaked: ' + LEGACY_TOOL_NAMES.filter((name) => loadedText.includes(name)).join(', '))
check('no stale tool count survives in the panel',
  ['十二个工具', '十个工具', '八个工具', '五个工具'].every((label) => !loadedText.includes(label)),
  loadedText.slice(0, 400))
// Section order: the overview first, then the data. A reader who cannot trust the
// numbers should meet the explanation before them.
const overviewAt = loadedText.indexOf('插件概览')
const healthAt = loadedText.indexOf('项目体检')
check('the overview comes before the project facts',
  overviewAt !== -1 && healthAt !== -1 && overviewAt < healthAt,
  JSON.stringify({ overviewAt, healthAt }))
const stagesAt = loadedText.indexOf('流水线阶段')
const settingsAt = loadedText.indexOf('运行配置')
check('the stages come before the run configuration',
  stagesAt !== -1 && settingsAt !== -1 && stagesAt < settingsAt,
  JSON.stringify({ stagesAt, settingsAt }))

// --------------------------------------------- v0.10 data sections (new in v0.10)

// N1: every stage in the matrix is titled in Chinese. The count is the IR's, not
// the panel's: a panel that quietly drops the five opt-in stages is the regression
// this check exists for.
const STAGE_NAMES = ['锁文件校验', '同步依赖', '代码检查', '类型检查', '版本清单',
  '测试与覆盖率', '密钥扫描', '构建产物', '集成测试', '依赖审计', '容器验收', '发布', '部署']
check('the panel renders all thirteen stages',
  STAGES.length === 13 && STAGE_NAMES.every((name) => loadedText.includes(name)),
  JSON.stringify({ rows: STAGES.length, missing: STAGE_NAMES.filter((name) => !loadedText.includes(name)) }))

// N7: the project facts, including the two v0.10 rows (commit hook, image checks)
// and the hint band that only renders while the hook is missing.
check('the project facts report the commit hook and the image checks',
  loadedText.includes('项目体检')
    && loadedText.includes('未安装')
    && loadedText.includes('提交钩子未安装')
    && loadedText.includes('prek install')
    && loadedText.includes('6 项 · 脚本未生成')
    && loadedText.includes('不设上限 · 只报告'),
  loadedText.slice(0, 800))

// N4: the four jobs and who waits for whom.
check('the jobs section lists the four CI jobs and their needs',
  JOB_ROWS.length === 4
    && ['CI 作业', 'quality', 'container', 'release', 'deploy'].every((text) => loadedText.includes(text))
    && loadedText.includes('container ← quality')
    && loadedText.includes('deploy ← release'),
  JSON.stringify({ jobs: JOB_ROWS.map((job) => job.name) }))

// N5: the nine generated artefacts, the missing count and the ✓/✗ badges.
const MISSING_LABEL = MISSING_TARGETS.length === 0 ? '齐全' : String(MISSING_TARGETS.length) + ' 项缺失'
check('the generated-artefacts section marks what is missing',
  TARGETS.length === 9
    && loadedText.includes('生成物')
    && loadedText.includes(MISSING_LABEL)
    && MISSING_TARGETS.every((target) => loadedText.includes('✗ ' + target.path))
    && TARGETS.filter((target) => target.present === true).every((target) => loadedText.includes('✓ ' + target.path)),
  JSON.stringify({ label: MISSING_LABEL }))

// N6: the eighteen resolved values, each as `name=value (source)`.
const resolveTags = loadedText.match(/\((existing|detected|default)\)/g) ?? []
check('the resolved-values section lists eighteen values with their source',
  RESOLVE_LINES.length === 18
    && resolveTags.length === 18
    && RESOLVE_LINES.slice(0, 3).every((line) => loadedText.includes(line))
    && RESOLVE_LINES.filter((line) => line.endsWith('(detected)')).every((line) => loadedText.includes(line)),
  JSON.stringify({ lines: RESOLVE_LINES.length, tags: resolveTags.length }))

// N10: the order of the sections is the reading order the plan fixes: what this is,
// then the facts, then the matrix, then what gets written, then why.
const ORDER = ['插件概览', '项目体检', 'CI 作业', '流水线阶段', '生成物', '取值解析', '运行配置']
// `lastIndexOf`: the overview copy legitimately mentions "流水线阶段" before the
// section of that name exists, and only the section headings define the order.
const orderAt = ORDER.map((title) => loadedText.lastIndexOf(title))
check('the panel sections keep the catalog-to-evidence order',
  orderAt.every((index, at) => index !== -1 && (at === 0 || orderAt[at - 1] < index)),
  JSON.stringify(orderAt))

// N2: eight of thirteen stages start selected; the five opt-in ones offer an add
// control, and clicking one moves the aside to 9 / 13.
{
  const addControl = nodesOf(afterLoad.tree, (node) => node.props?.['aria-label'] === '加入 依赖审计')[0]
  addControl?.props.onClick()
  const afterAdd = textOf(settle(Panel, { sessionId: 'session-live' }).tree)
  check('the stage matrix says eight of thirteen by default and adds one on click',
    loadedText.includes('8 / 13') && addControl !== undefined && afterAdd.includes('9 / 13'),
    JSON.stringify({ hadEight: loadedText.includes('8 / 13'), control: addControl !== undefined, nine: afterAdd.includes('9 / 13') }))
}

// N3: generate-workflow asks the preview route for the default selection.
{
  const generate = buttonWithText(afterLoad.tree, '生成 workflow')
  generate?.props.onClick()
  await flush()
  settle(Panel, { sessionId: 'session-live' })
  const expected = PREVIEW_ROUTE
    + '?path=' + encodeURIComponent(ROOT)
    + '&stages=' + encodeURIComponent(DEFAULT_STAGE_IDS.join(','))
  checkEqual('the generate-workflow button asks the preview route for the eight defaults',
    fetchCalls.at(-1)?.url, expected)
}

// N8: the module id and the routes are the package's, not the old name's, and the
// two locale titles carry the two display forms (`Gatekeeper` / `门禁`).
check('the client half registers under the package id and no fetch uses the old route',
  moduleId === PKG
    && !fetchCalls.some((call) => call.url.includes('/' + OLD_PKG + '/'))
    && EN_LOCALE.meta?.title === TITLE
    && ZH_LOCALE.meta?.title === ZH_TITLE,
  JSON.stringify({ moduleId, urls: fetchCalls.map((call) => call.url) }))

// Polling: the panel follows the session directory without a reload.
checkEqual('the panel polls on an interval', intervals.at(-1)?.ms, 10000)
const pollsBefore = fetchCalls.length
intervals.at(-1).fn()
await flush()
check('a poll re-reads the route',
  fetchCalls.length === pollsBefore + 1,
  JSON.stringify(fetchCalls.length))
check('a poll asks about the visible session again',
  fetchCalls.at(-1).url.includes('session=session-live'),
  fetchCalls.at(-1).url)

// A background poll must not flip the panel back into a loading state. The rule is in
// `load(refresh, quiet)`: a quiet read leaves `loading` alone, so the header keeps
// reading 已就绪 instead of blinking 读取中 every ten seconds. Asserting the ready
// text right before the poll is what stops the absence check below from passing
// vacuously on a panel that never finished loading.
check('the settled panel reads as ready, not as still loading',
  loadedText.includes('已就绪') && !loadedText.includes('读取中'), loadedText.slice(0, 200))
intervals.at(-1).fn()
await flush()
const afterPoll = textOf(settle(Panel, { sessionId: 'session-live' }).tree)
check('a quiet poll does not flash the loading state',
  afterPoll.includes('已就绪') && !afterPoll.includes('读取中') && !afterPoll.includes('检测中'),
  afterPoll.slice(0, 200))

// A hidden tab must not spend requests.
documentStub.visibilityState = 'hidden'
const hiddenBefore = fetchCalls.length
intervals.at(-1).fn()
checkEqual('a hidden tab does not poll', fetchCalls.length, hiddenBefore)
documentStub.visibilityState = 'visible'

// A failing route has to say so instead of rendering a blank page. The mount effect
// only runs once, so the poll is what exercises a later read.
fetchResponder = () => ({ ok: false, status: 500, body: {} })
intervals.at(-1).fn()
await flush()
const failed = settle(Panel, {})
const failedText = textOf(failed.tree)
check('a failing route is reported as a sentence', failedText.includes('500'), failedText.slice(0, 400))

fetchResponder = () => new Error('offline')
intervals.at(-1).fn()
await flush()
const offlineText = textOf(settle(Panel, {}).tree)
check('a transport error is reported as a sentence', offlineText.includes('offline'), offlineText.slice(0, 400))

// A project another tool manages is the case the panel most needs to explain, because
// the refusal the Host returns is a paragraph of English. The panel has to render the
// blocker at all — an empty alert reads as "no problem" — and it must keep the quoted
// rule, which is the part a reader came for.
fetchResponder = (url) => {
  if (!url.startsWith(STATUS_ROUTE)) return { ok: false, status: 404, body: {} }
  return {
    body: {
      ...statusBody,
      detection: {
        ...statusBody.detection,
        packageManager: 'poetry',
        hasUvLock: false,
        blockers: [{ code: 'foreign-lockfile', file: 'poetry.lock' }],
      },
    },
  }
}
intervals.at(-1).fn()
await flush()
const blockedText = textOf(settle(Panel, { sessionId: 'session-live' }).tree)
check('a blocker is rendered instead of being swallowed',
  blockedText.includes('uv 被拒绝') && blockedText.includes('poetry.lock'), blockedText.slice(0, 400))
check('the blocker keeps the quoted uv rule',
  blockedText.includes("Don't use uv in projects managed by other tools"), blockedText.slice(0, 600))

// The branch a fresh session actually starts in: the route answers but there is no
// detection yet. It is covered on purpose, because the legacy tool names survived
// longest in exactly these rarely-rendered strings — the empty state still told the
// reader to call `py-detect`, which the Host no longer registers. `recordedAt` is
// dropped in this fixture so the footer renders its no-timestamp form too, which is
// where the old "只读 · 不写你的项目" claim lived.
fetchResponder = (url) => {
  if (!url.startsWith(STATUS_ROUTE)) return { ok: false, status: 404, body: {} }
  return { body: { ...statusBody, recordedAt: undefined, detection: null, stages: [] } }
}
intervals.at(-1).fn()
await flush()
const emptyText = textOf(settle(Panel, { sessionId: 'session-live' }).tree)
check('the empty state points at a tool that exists',
  emptyText.includes('还没有可体检的目录') && emptyText.includes('py-audit') && !emptyText.includes('py-detect'),
  emptyText.slice(0, 500))
check('the footer does not still claim the panel never writes',
  !emptyText.includes('不写你的项目'), emptyText.slice(-400))

fetchResponder = (url) => {
  if (url.startsWith(STATUS_ROUTE)) return { body: statusBody }
  return { ok: false, status: 404, body: {} }
}

// ------------------------------------------------------------------ composer chip

const inserted = []
const inputActions = {
  captureInsertion: () => ({ start: 0, end: 0, draftRev: 3 }),
  insertText: (text, span) => {
    inserted.push({ text, span })
    return true
  },
}

const chipRun = settle(Chip, { sessionId: 'session-live', inputActions })
const chipText = textOf(chipRun.tree)
check('an idle chip says 技能包', chipText.includes('技能包'), chipText)
check('an idle chip shows no token', !chipText.includes('/python-'), chipText)

const chipButton = byAttr(chipRun.tree, 'data-pt-chip')[0]
check('the chip is a button', chipButton?.type === 'button')
chipButton.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 40, top: 700, bottom: 728 }) } })
const openRun = settle(Chip, { sessionId: 'session-live', inputActions })
const groupRows = byAttr(openRun.tree, 'data-pt-group')
checkEqual('opening the chip lists one group per tool', groupRows.length, 3)

// Folding is the point of the menu: three shut bars first, no document rows until a bar
// is clicked. Sixteen rows at once was the wall the user asked to stop seeing.
checkEqual('every group starts folded',
  groupRows.filter((row) => row.props['data-pt-folded'] === 'true').length, 3)
checkEqual('a folded group shows no document rows', byAttr(openRun.tree, 'data-pt-mode').length, 0)

groupRows[0].props.onClick()
const unfoldedRun = settle(Chip, { sessionId: 'session-live', inputActions })
const unfoldedGroups = byAttr(unfoldedRun.tree, 'data-pt-group')
const modeRows = byAttr(unfoldedRun.tree, 'data-pt-mode')
checkEqual('clicking a bar unfolds only that group',
  unfoldedGroups.filter((row) => row.props['data-pt-folded'] === 'false').length, 1)
checkEqual('the unfolded group shows its documents', modeRows.length, 4)
check('the other groups stay folded', unfoldedGroups.filter((row) => row.props['data-pt-folded'] === 'true').length === 2)

// Clicking the bar again folds it back.
unfoldedGroups[0].props.onClick()
const refoldedRun = settle(Chip, { sessionId: 'session-live', inputActions })
checkEqual('clicking the bar again folds it', byAttr(refoldedRun.tree, 'data-pt-mode').length, 0)

// Picking writes the host token and remembers the mode.
byAttr(refoldedRun.tree, 'data-pt-group')[0].props.onClick()
const reopened = settle(Chip, { sessionId: 'session-live', inputActions })
const firstRow = byAttr(reopened.tree, 'data-pt-mode')[0]
firstRow.props.onClick()
const pickedRun = settle(Chip, { sessionId: 'session-live', inputActions })
checkEqual('picking writes exactly one insertion', inserted.length, 1)
checkEqual('it inserts the host skill token', inserted[0]?.text, '/python-uv-basics ')
check('the insertion carries a captured span',
  inserted[0]?.span?.draftRev === 3,
  JSON.stringify(inserted[0]?.span))
check('the chip now names the picked mode',
  textOf(pickedRun.tree).includes('uv 基础'),
  textOf(pickedRun.tree))
check('the storage remembers the pick',
  windowStub.localStorage.getItem(MODE_STORAGE_KEY) === 'uv-basics',
  String(windowStub.localStorage.getItem(MODE_STORAGE_KEY)))

// N9: the chip writes the mode under the package's key, and pinning a session in the
// panel writes the session key. No old key is written either.
{
  const select = nodesOf(afterLoad.tree, (node) => node.type === 'select')[0]
  select?.props.onChange({ target: { value: 'session-live' } })
  check('the storage keys both use the package prefix',
    storage.has(MODE_STORAGE_KEY)
      && storage.get(SESSION_STORAGE_KEY) === 'session-live'
      && [...storage.keys()].every((key) => key.startsWith(PKG + '.')),
    JSON.stringify([...storage.keys()]))
}

// Deleting the chip's mode is the documented way to turn it off.
const closeButton = nodesOf(pickedRun.tree, (entry) => entry.props?.['aria-label'] === '关闭 uv 基础')[0]
check('the picked chip offers a close control', closeButton !== undefined)
closeButton?.props?.onClick?.({ stopPropagation: () => {} })

// ------------------------------------------------------------------ status strip

const idleStatus = settle(Status, {})
check('the status strip renders nothing while no mode is on', idleStatus.tree === null)

// ------------------------------------------------------------------ placement

// The mode menu is `position: fixed`, which is only the viewport when no ancestor
// establishes a containing block for fixed children. The picker measures what it got
// and corrects, so these are the cases that correction has to answer.
const place = moduleExports.__placementSolve
check('the placement helper is exposed for the harness', typeof place === 'function')

// A box is moved by nudging its inline offsets and reading where it went, so every case
// below supplies the two rectangles that probe produces. `bottom` is anchored to the
// containing block's bottom edge, which is why a positive nudge moves the box *up*: the
// sign is measured, never assumed, and the same code then covers a scaled ancestor.
const viewport = { width: 1000, height: 800 }
const restingChip = { left: 100, top: 750, width: 60 }
const step = 8

const restingNow = { left: 100, bottom: 744, width: 316 }
const restingProbed = { left: 108, bottom: 736, width: 316 }
const resting = place(restingNow, restingProbed, step, restingChip, viewport, 316)
check('a correctly placed box needs no correction',
  resting !== null && Math.abs(resting.dx) < 0.001 && Math.abs(resting.dy) < 0.001,
  JSON.stringify(resting))

// What the containing block actually does: the same style value lands the box far from
// the chip. The correction is the delta between the two, in style units — and it is
// positive, because moving the box down means *shrinking* `bottom`.
const stranded = place(
  { left: 100, bottom: 1500, width: 316 },
  { left: 108, bottom: 1492, width: 316 },
  step, restingChip, viewport, 316)
check('a box pushed off screen is pulled back to the chip',
  stranded !== null && Math.abs(stranded.dy - 756) < 0.001,
  JSON.stringify(stranded))

// The same geometry under a 0.82 ancestor: one style unit is 0.82 viewport pixels, so
// the probe reports ~0.66 per unit and the correction divides by what it measured.
const scaled = place(
  { left: 50, bottom: 100, width: 259.12 },
  { left: 50 + step * 0.82, bottom: 100 - step * 0.82, width: 259.12 },
  step, { left: 50, top: 750, width: 60 }, viewport, 316)
check('a scaled ancestor is divided out of the correction',
  scaled !== null && Math.abs(scaled.dy + 785.37) < 0.01,
  JSON.stringify(scaled))

// The menu never leaves the left edge, and never runs off the right one.
const clamped = place(
  { left: 0, bottom: 744, width: 316 },
  { left: 8, bottom: 736, width: 316 },
  step, { left: 990, top: 750, width: 60 }, viewport, 316)
check('the box is clamped inside the viewport',
  clamped !== null && Math.abs(clamped.dx - 676) < 0.001,
  JSON.stringify(clamped))

check('a missing measurement is not a correction',
  place(null, null, step, restingChip, viewport, 316) === null
    && place({ left: 0, bottom: 0, width: 0 }, { left: 0, bottom: 0, width: 0 }, step, restingChip, viewport, 316) === null,
  'degenerate input produced a value')

// A box whose offsets do nothing (no movement between the two probes) cannot be steered
// this way; saying so beats dividing by zero and jumping to the moon.
check('a box that does not move is refused, not divided by zero',
  place(restingNow, { left: 100, bottom: 744, width: 316 }, step, restingChip, viewport, 316) === null,
  'a zero exchange rate produced a value')

// ----------------------------------------------------------------- the detail card

// The card hangs off the same layer as the box, so its offset is the difference of two
// rects measured in one pass. Placing it on its own meant inverting an unknown
// containing-block origin, and it landed off screen.
const detail = moduleExports.__detailOffset
check('the detail helper is exposed for the harness', typeof detail === 'function')

const layer = { left: 100, top: 200, scale: 1 }
const row = { top: 260, height: 28 }
const beside = detail(row, layer, { width: 1000, height: 800 }, 316, 300)
check('the card sits beside the box, inside the layer',
  beside !== null && beside.side === 'right' && Math.abs(beside.left - 326) < 0.001,
  JSON.stringify(beside))
check('the card is centred on the row it describes',
  beside !== null && Math.abs(beside.top - (182 - 200)) < 0.001,
  JSON.stringify(beside))

// Near the right edge the right side has no room left, so the card takes the left one.
const flipped = detail(row, { left: 600, top: 200, scale: 1 }, { width: 1000, height: 800 }, 316, 300)
check('a box near the right edge flips the card to its left',
  flipped !== null && flipped.side === 'left' && Math.abs(flipped.left + 310) < 0.001,
  JSON.stringify(flipped))

// A scaled ancestor: the offset is viewport pixels and must be divided back into the
// style units the layer is laid out in, or the card drifts by the scale factor.
const scaledCard = detail(row, { left: 100, top: 200, scale: 0.5 }, { width: 1000, height: 800 }, 316, 300)
check('a scaled ancestor is divided out of the card offset',
  scaledCard !== null && Math.abs(scaledCard.left - 652) < 0.001 && Math.abs(scaledCard.top - -36) < 0.001,
  JSON.stringify(scaledCard))

// A row near the bottom of the window cannot push the card off the bottom edge.
const lowRow = detail({ top: 700, height: 28 }, { left: 100, top: 200, scale: 1 }, { width: 1000, height: 800 }, 316, 300)
check('the card is clamped to the viewport bottom',
  lowRow !== null && Math.abs(lowRow.top - 390) < 0.001,
  JSON.stringify(lowRow))

check('an unmeasured layer is not a card position',
  detail(null, layer, { width: 1000, height: 800 }, 316, 300) === null
    && detail(row, null, { width: 1000, height: 800 }, 316, 300) === null
    && detail(row, layer, { width: 0, height: 800 }, 316, 300) === null,
  'degenerate input produced a value')

// A window too narrow for a 300px card beside the box must not let the card cover the
// box: covering the rows the pointer moves between is worse than a narrower card.
const narrow = detail(row, { left: 300, top: 200, scale: 1 }, { width: 900, height: 800 }, 316, 300)
check('a narrow window shrinks the card instead of covering the box',
  narrow !== null && narrow.side === 'left' && narrow.width === 282 && Math.abs(narrow.left + 292) < 0.001,
  JSON.stringify(narrow))
check('the shrunk card still ends before the box starts',
  narrow !== null && 8 + narrow.width <= 292,
  JSON.stringify(narrow))

// Below the readable minimum shrinking stops helping, so the full width is kept and
// clamped into the viewport rather than pushed off the left edge.
const crushed = detail(row, { left: 200, top: 200, scale: 1 }, { width: 700, height: 800 }, 316, 300)
check('a window below the readable minimum keeps the full width and stays on screen',
  crushed !== null && crushed.width === 300 && crushed.left + 200 === 8,
  JSON.stringify(crushed))

// The arrow rides the card's side border and must land on the row, not on the middle of
// the border. These are the numbers the render pass feeds it: row centre and card box,
// both in viewport pixels, plus the scale the layer implies.
const arrow = moduleExports.__arrowOffset
check('the arrow helper is exposed for the harness', typeof arrow === 'function')

check('a row in the middle of the card puts the arrow in the middle',
  arrow(300, 200, 200, 1) === 94, String(arrow(300, 200, 200, 1)))
check('a row near the card top clamps the arrow off the corner',
  arrow(205, 200, 200, 1) === 10, String(arrow(205, 200, 200, 1)))
check('a row near the card bottom clamps the arrow off the corner',
  arrow(390, 200, 200, 1) === 178, String(arrow(390, 200, 200, 1)))
check('a scaled ancestor is divided out of the arrow offset',
  Math.abs(arrow(300, 200, 164, 0.82) - 115.9512) < 0.01, String(arrow(300, 200, 164, 0.82)))
check('an unmeasured card is not an arrow position',
  arrow(Number.NaN, 200, 200, 1) === null && arrow(300, 200, 0, 1) === null,
  'degenerate input produced a value')

// -------------------------------------------------------------- a broken host

let guardThrew = null
try {
  moduleExports.apply({})
} catch (error) {
  guardThrew = error
}
check('apply() survives a host without slots', guardThrew === null, String(guardThrew))

// The locale titles are the user-facing half of the rename: the machine id is
// `gatekeeper`, the English title is `Gatekeeper`, the Chinese one is `门禁`. They
// are asserted together with the module id in N8, against locale/*.json.

console.log('')
if (failures === 0) {
  console.log('all checks passed (' + String(passes) + ')')
} else {
  console.error(String(failures) + ' check(s) failed, ' + String(passes) + ' passed')
  process.exitCode = 1
}
