// End-to-end probe: the real tool, a real project, a real `uv sync` — with a ticker
// running alongside. This is the property the user feels: while `uv` works, the host
// keeps answering. Before the change this loop was `spawnSync` and no timer fired.

import { rmSync } from 'node:fs'
import { fixture } from './paths.mjs'
import { resolveConfig } from '../../lib/schema.js'
import { createPyPipelineRunTool } from '../../lib/tools/py-pipeline-run.js'

let failed = 0
function check(name, ok, detail) {
  if (ok !== true) failed += 1
  console.log((ok === true ? '  ok   ' : '  FAIL ') + name + (detail === undefined ? '' : '  — ' + detail))
}

// A tiny committed fixture (pyproject + uv.lock, no .venv) so this probe is
// reproducible instead of depending on whatever project happens to be around.
const root = fixture('async-proj')
// A missing venv makes `uv sync` do real work instead of returning immediately.
rmSync(root + '/.venv', { recursive: true, force: true })

const config = resolveConfig({}, {})
const tool = createPyPipelineRunTool({ config })
const exec = { cwd: root }

const dry = await tool.execute({ path: root, stages: ['sync'], dryRun: true }, exec)
check('dry run still lists the plan', Array.isArray(dry.plan) && dry.plan.length > 0)
check('dry run ran nothing', dry.stages.length === 0 && dry.dryRun === true)

let ticks = 0
const ticker = setInterval(() => { ticks += 1 }, 20)
const started = Date.now()
const live = await tool.execute({ path: root, stages: ['sync'], dryRun: false, timeoutSeconds: 120 }, exec)
const elapsed = Math.round((Date.now() - started) / 100) / 10
clearInterval(ticker)

const stage = live.stages?.[0]
check('the stage really ran', live.dryRun === false && stage !== undefined, stage === undefined ? 'no stage' : stage.status + ' in ' + stage.seconds + 's')
check('the sync gate passed', stage?.status === 'pass', stage?.steps?.map((s) => s.run + ' → ' + s.status).join(' | '))
// 20ms interval = at most 50 ticks/s. A blocking call yields 0; requiring 20/s
// (40% of the ceiling) fails loudly if the loop is ever starved again.
check('the event loop stayed responsive for the whole run',
  ticks >= Math.max(5, Math.floor(elapsed * 20)), ticks + ' ticks in ' + elapsed + 's')
check('the result is serialisable (the host snapshots it)', JSON.stringify(live).length > 0)

console.log('')
if (failed > 0) {
  console.log(failed + ' check(s) failed')
  process.exit(1)
}
console.log('all checks passed')
