// Post-fix verification for the four GateKeeper × DSH 0.2.2-rc.1 findings.
//
//   node audit/verify-fixes.mjs
//
// Every check re-derives the *host's* rule rather than trusting the plugin's own
// tests: the lossless-JSON predicate below is a transcription of the `walkJsonValue`
// in app.asar, and the volatile-shape check runs the real @deepseek-ai/schemastery.

import { readFileSync } from 'node:fs'
import { fixture, pluginFile, pluginRoot, schemasteryUrl } from './paths.mjs'

// Dynamic imports below point at the plugin by URL, so they resolve against the
// checkout rather than against Node's own lookup path.
const PLUGIN = pluginRoot.href.replace(/\/$/, '')

const SANDBOX = fixture('scaffold-proj')
const CONFIG = {
  defaultPythonVersion: '3.13',
  matrixPythonVersions: '',
  testPaths: 'src/tests',
  includeSecurityGate: true,
  includeIntegrationGate: false,
  tools: { audit: true, scaffold: true, run: true },
}

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail === '' ? '' : `  — ${detail}`}`)
}

// --------------------------------------------------------------- host predicate
//
// transcription of walkJsonValue(): plain prototypes only, an array may carry no
// own key beyond its indices (Reflect.ownKeys counts non-enumerable keys and
// symbols, which is exactly why defining a hidden property does not help), and a
// plain object may not hold undefined / functions / accessors.
function lossless(value, path = '$', problems = []) {
  if (value === null) return problems
  const type = typeof value
  if (type === 'string' || type === 'boolean') return problems
  if (type === 'number') {
    if (!Number.isFinite(value)) problems.push(`${path}: non-finite number`)
    return problems
  }
  if (type !== 'object') {
    problems.push(`${path}: ${type} is not JSON`)
    return problems
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      problems.push(`${path}: array prototype is not Array.prototype`)
      return problems
    }
    const keys = Reflect.ownKeys(value)
    if (keys.length !== value.length + 1) {
      problems.push(`${path}: array has ${keys.length - 1} own keys for ${value.length} slots (${keys.map(String).join(',')})`)
    }
    for (let index = 0; index < value.length; index += 1) lossless(value[index], `${path}[${index}]`, problems)
    return problems
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    problems.push(`${path}: ${proto?.constructor?.name ?? 'null'} is not a plain object`)
    return problems
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      problems.push(`${path}: symbol key ${String(key)}`)
      continue
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !descriptor.enumerable) {
      problems.push(`${path}.${key}: not enumerable`)
      continue
    }
    if ('get' in descriptor || 'set' in descriptor) {
      problems.push(`${path}.${key}: accessor`)
      continue
    }
    if (descriptor.value === undefined) {
      problems.push(`${path}.${key}: undefined`)
      continue
    }
    lossless(descriptor.value, `${path}.${key}`, problems)
  }
  return problems
}

// ------------------------------------------------------------------ F3: plan JSON
{
  const { localPlan, planSelection, describePlan } = await import(`${PLUGIN}/lib/pipeline/local.js`)
  const plan = localPlan(['lint', 'test', 'security'], { profile: 'full', from: 'test' })
  check('F3 localPlan returns an array with only index keys',
    Reflect.ownKeys(plan).length === plan.length + 1,
    `ownKeys=${Reflect.ownKeys(plan).length} length=${plan.length}`)
  const selection = planSelection(plan)
  check('F3 the selection survives beside the array',
    selection.profile === 'full' && selection.from === 'test',
    JSON.stringify(selection))
  check('F3 describePlan still names the profile and the resume point',
    describePlan(plan).includes('profile=full, from=test'),
    describePlan(plan).split('\n')[0])
  check('F3 a plan is lossless JSON', lossless(plan).length === 0, lossless(plan).join('; '))
}

// -------------------------------------------------------------- F3: tool output
{
  const { createPyRunTool } = await import(`${PLUGIN}/lib/tools/py-run.js`)
  const tool = createPyRunTool({ config: CONFIG })
  const result = await tool.execute({ path: SANDBOX, dryRun: true }, {})
  const problems = lossless(result)
  check('F3 py-run returns a lossless payload', problems.length === 0, problems.slice(0, 3).join('; '))
  check('F3 py-run still reports its plan', Array.isArray(result?.pipeline?.plan), typeof result?.pipeline?.plan)
}

// --------------------------------------------------- F2: volatile config unwrap
{
  const schemastery = await import(schemasteryUrl())
  const Schema = schemastery.default ?? schemastery
  const schema = Schema.object({
    tools: Schema.object({
      audit: Schema.boolean().default(true).volatile(),
      scaffold: Schema.boolean().default(true).volatile(),
      run: Schema.boolean().default(true).volatile(),
    }),
    defaultPythonVersion: Schema.string().default('3.13').volatile(),
    matrixPythonVersions: Schema.string().default('').volatile(),
    testPaths: Schema.string().default('src/tests').volatile(),
    includeSecurityGate: Schema.boolean().default(true).volatile(),
    includeIntegrationGate: Schema.boolean().default(false).volatile(),
  })
  const settings = schema({ tools: { audit: false }, testPaths: 'tests', includeIntegrationGate: true })
  check('F2 the loader really hands over references, not values',
    typeof settings.tools.audit === 'object' && typeof settings.tools.audit.get === 'function',
    typeof settings.tools.audit)
  const { resolveConfig } = await import(`${PLUGIN}/lib/schema.js`)
  const resolved = resolveConfig(settings, {})
  check('F2 an edited tool switch is honoured', resolved.tools.audit === false, JSON.stringify(resolved.tools))
  check('F2 the untouched switches keep their defaults',
    resolved.tools.scaffold === true && resolved.tools.run === true,
    JSON.stringify(resolved.tools))
  check('F2 an edited string is honoured', resolved.testPaths === 'tests', resolved.testPaths)
  check('F2 an edited gate is honoured', resolved.includeIntegrationGate === true, String(resolved.includeIntegrationGate))
  check('F2 untouched values still fall back', resolved.defaultPythonVersion === '3.13', resolved.defaultPythonVersion)
  const fromEnv = resolveConfig({}, { DSH_PYTHON_TOOLCHAIN_PYTHON: '3.12' })
  check('F2 the environment fills a row that does not carry the key', fromEnv.defaultPythonVersion === '3.12', fromEnv.defaultPythonVersion)
  const rowWins = resolveConfig(schema({ defaultPythonVersion: '3.11' }), { DSH_PYTHON_TOOLCHAIN_PYTHON: '3.12' })
  check('F2 an explicit setting beats the environment', rowWins.defaultPythonVersion === '3.11', rowWins.defaultPythonVersion)
}

// ------------------------------------------------------------ F1: async candidates
{
  const panel = readFileSync(pluginFile('client/panel.js'), 'utf8')
  const sync = [...panel.matchAll(/candidates:\s*(?:async\s*)?(\(\s*\)|function)/g)]
    .filter((match) => match[0].includes('async') === false)
  check('F1 every candidates() is async', sync.length === 0, sync.map((m) => m[0]).join(' | '))
  check('F1 both slash sources are Promise-returning',
    (panel.match(/candidates: async \(\) => \[\]/g) ?? []).length === 2,
    String((panel.match(/candidates: async \(\) => \[\]/g) ?? []).length))
}

// ---------------------------------------------------------- F4: engines manifest
{
  const manifest = JSON.parse(readFileSync(pluginFile('package.json'), 'utf8'))
  check('F4 the top-level engines.dsh is declared', manifest.engines?.dsh === '>=0.2.2-rc.1', manifest.engines?.dsh)
  check('F4 engines.node is kept', manifest.engines?.node === '>=22.19.0', manifest.engines?.node)
  check('F4 the marketplace copy agrees', manifest.dsh?.engines?.dsh === '>=0.2.2-rc.1', manifest.dsh?.engines?.dsh)
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
