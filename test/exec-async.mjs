// The executor used to be `spawnSync`: while `uv sync` installed packages the whole
// host froze, which from the outside is indistinguishable from a hang. These checks
// pin both halves of the fix — the verdict shape did not change, and the event loop
// now keeps turning while a child runs.
//
// The slow command is deliberately one the allowlist accepts (`uv run python -c`
// with its payload marked opaque), so this test proves the real path rather than a
// stubbed one.

import { planCommands, runCommand, runCommandAsync, runPlanAsync } from '../lib/pipeline/exec.js'

let failed = 0
function check(name, ok, detail) {
  if (ok !== true) failed += 1
  console.log((ok === true ? '  ok   ' : '  FAIL ') + name + (detail === undefined ? '' : '  — ' + detail))
}

const SLOW = ['uv', 'run', 'python', '-c', 'import time; time.sleep(2)']

// 1. The caller reads the same keys it always did.
const fast = await runCommandAsync(['uv', '--version'], { timeoutSeconds: 30 })
const shape = ['argv', 'ok', 'refused', 'reason', 'exitCode', 'stdout', 'stderr', 'seconds']
check('async result carries the sync verdict shape', shape.every((key) => key in fast))
check('a fast command still succeeds', fast.ok === true && /uv\s+\d/.test(fast.stdout), fast.stdout.trim().slice(0, 24))

// 2. The point of the change: timers keep firing while the child runs.
let ticks = 0
const ticker = setInterval(() => { ticks += 1 }, 50)
const started = Date.now()
const slow = await runCommandAsync(SLOW, { timeoutSeconds: 60 })
const elapsed = Math.round((Date.now() - started) / 100) / 10
clearInterval(ticker)
check('the event loop kept turning while the command ran', ticks >= 12, ticks + ' ticks in ' + elapsed + 's')
check('the slow command still reports its own verdict', slow.ok === true && slow.seconds >= 1.8, 'seconds=' + slow.seconds)

// 3. The contrast: the sync path really does block, so the test would have failed
//    before this change. Without this line the check above proves nothing.
let syncTicks = 0
const syncTicker = setInterval(() => { syncTicks += 1 }, 50)
runCommand(SLOW, { timeoutSeconds: 60 })
clearInterval(syncTicker)
check('the sync executor still blocks (the bug this replaces)', syncTicks <= 2, syncTicks + ' ticks')

// 4. A timeout is a verdict, not an exception.
const timedOut = await runCommandAsync(SLOW, { timeoutSeconds: 1 })
check('a timeout is reported rather than thrown', timedOut.ok === false && String(timedOut.reason ?? '').includes('超时'), String(timedOut.reason))

// 5. A refused argv never spawns.
const refused = await runCommandAsync(['rm', '-rf', '/'], {})
check('a refused argv comes back refused', refused.refused === true && refused.ok === false && refused.exitCode === null)

// 6. Abort kills the run and says so instead of blaming the project.
const controller = new AbortController()
setTimeout(() => controller.abort(), 300)
const aborted = await runCommandAsync(SLOW, { timeoutSeconds: 60, signal: controller.signal })
check('abort ends the run with a reason', aborted.ok === false && aborted.reason === '已取消', String(aborted.reason))

// 7. The plan runner stays one-result-per-command.
const results = await runPlanAsync(planCommands([['uv', '--version'], ['uv', 'lock', '--check']]), { timeoutSeconds: 20 })
check('runPlanAsync returns one verdict per planned command', results.length === 2 && results[0].ok === true)

console.log('')
if (failed > 0) {
  console.log(failed + ' check(s) failed')
  process.exit(1)
}
console.log('all checks passed')
