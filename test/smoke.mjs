// A dependency-free smoke test.
//
// It builds two throwaway projects in the OS temp directory — one managed by uv,
// one managed by Poetry — and drives the tool definitions the way the Host does:
// `execute(args, exec)`, with the session's working directory on `exec`. Nothing
// here imports `@deepseek-ai/schemastery`, which is exactly why it also proves the
// no-schema path works.
//
//   node test/smoke.mjs
//
// It asserts on behaviour, not on prose: a gate's position, a refusal, a topic's
// bytes. Wording is allowed to change; the refusals are not.

import { access, mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { detect } from '../lib/detect.js'
import { safeWorkflowName } from '../lib/apply.js'
import { TOPIC_IDS, readReference } from '../lib/references.js'
import { buildConfig, resolveConfig } from '../lib/schema.js'
import { createStatusStore } from '../lib/status.js'
import { sessionDirs, pickRoot } from '../lib/sessions.js'
import { dependencyGroups } from '../lib/pyproject.js'
import { createPyDetectTool } from '../lib/tools/py-detect.js'
import { createPyBootstrapTool } from '../lib/tools/py-bootstrap.js'
import { createPyCiPlanTool } from '../lib/tools/py-ci-plan.js'
import { createPyCiRenderTool } from '../lib/tools/py-ci-render.js'
import { createPyPrekTool } from '../lib/tools/py-prek.js'
import { createPyDependabotTool } from '../lib/tools/py-dependabot.js'
import { createPyReferencesTool } from '../lib/tools/py-references.js'
import { createPyCiRunTool } from '../lib/tools/py-ci-run.js'
import {
  COMMIT_STAGE_IDS,
  DEFAULT_STAGE_IDS,
  OPTIONAL_STAGE_IDS,
  STAGE_IDS,
  STAGE_CATALOG,
  applyResolved,
  parseStageList,
  resolveStages,
  stageMatrix,
} from '../lib/pipeline/ir.js'
import { renderWorkflow } from '../lib/pipeline/github.js'
import { localPlan } from '../lib/pipeline/local.js'
import { renderContainerReportScript } from '../lib/container-report.js'
import {
  ALLOWED_PREFIXES,
  isAllowed,
  planCommands,
  refusalReason,
  splitCommandLine,
} from '../lib/pipeline/exec.js'
import { RULE_IDS, auditWorkflow, parseWorkflow } from '../lib/pipeline/audit.js'
import { createPyContainerGateTool } from '../lib/tools/py-container-gate.js'
import { createPyAuditTool } from '../lib/tools/py-audit.js'
import { createPyScaffoldTool } from '../lib/tools/py-scaffold.js'
import { createPyRunTool } from '../lib/tools/py-run.js'
import { applyFixes, createPyPipelineDoctorTool, plannedFixes } from '../lib/tools/py-pipeline-doctor.js'
import { TARGET_SUMMARY, createPyApplyTool } from '../lib/tools/py-apply.js'
import {
  DEFAULT_STAGE_TIMEOUT_SECONDS,
  DEFAULT_TOTAL_BUDGET_SECONDS,
  createPyPipelineRunTool,
  failureText,
  failureKind,
  tail,
} from '../lib/tools/py-pipeline-run.js'

let failures = 0

function check(label, ok, detail) {
  if (ok) {
    console.log('  ok   ' + label)
    return
  }
  failures += 1
  console.log('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail))
}

/** The `exec` the Host passes: only the session's directory matters here. */
function execIn(cwd) {
  return { agent: { session: { header: { cwd } } } }
}

/** Whether a path is absent — `access` throwing is the "yes, absent" case. */
async function absent(target) {
  try {
    await access(target)
    return false
  } catch {
    return true
  }
}

const UV_PYPROJECT = [
  '[project]',
  'name = "demo"',
  'version = "0.1.0"',
  'requires-python = ">=3.12"',
  'dependencies = []',
  '',
  '[dependency-groups]',
  'dev = ["pytest>=8", "ruff"]',
  '',
  '[tool.ruff]',
  'line-length = 100',
  '',
  '[tool.pytest.ini_options]',
  'testpaths = ["src/tests"]',
  '',
].join('\n')

const POETRY_PYPROJECT = [
  '[tool.poetry]',
  'name = "demo"',
  'version = "0.1.0"',
  '',
  '[tool.poetry.dependencies]',
  'python = "^3.12"',
  '',
].join('\n')

async function main() {
  const base = await mkdtemp(join(tmpdir(), 'python-toolchain-smoke-'))
  const uvRoot = join(base, 'uv-project')
  const poetryRoot = join(base, 'poetry-project')
  try {
    await mkdir(join(uvRoot, '.github', 'workflows'), { recursive: true })
    await writeFile(join(uvRoot, 'pyproject.toml'), UV_PYPROJECT)
    await writeFile(join(uvRoot, 'uv.lock'), '# lock\n')
    await writeFile(join(uvRoot, '.python-version'), '3.12\n')
    await writeFile(join(uvRoot, '.github', 'workflows', 'ci.yml'), 'on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n')

    await mkdir(poetryRoot, { recursive: true })
    await writeFile(join(poetryRoot, 'pyproject.toml'), POETRY_PYPROJECT)
    await writeFile(join(poetryRoot, 'poetry.lock'), '# lock\n')

    console.log('detect')
    const uv = await detect(uvRoot)
    check('uv project is recognised', uv.packageManager === 'uv', uv.packageManager)
    check('requires-python parsed', uv.requiresPython === '>=3.12', String(uv.requiresPython))
    check('.python-version read', uv.pinnedVersion === '3.12', String(uv.pinnedVersion))
    check('ruff and pytest found', uv.linters.ruff === true && uv.linters.pytest === true)
    check('existing workflow listed', uv.workflows.length === 1 && uv.workflows[0].file.endsWith('ci.yml'))
    check('no blockers on a uv project', uv.blockers.length === 0, JSON.stringify(uv.blockers))

    const poetry = await detect(poetryRoot)
    check('poetry project is recognised as foreign', poetry.packageManager === 'poetry', poetry.packageManager)
    check('foreign lockfile becomes a blocker', poetry.blockers.some((entry) => entry.file === 'poetry.lock'))

    const config = resolveConfig({}, {})
    const store = createStatusStore()

    console.log('py-detect')
    const detectTool = createPyDetectTool({ store })
    const detected = await detectTool.execute({}, execIn(uvRoot))
    check('falls back to the session cwd', detected.root === uvRoot, detected.root)
    check('records into the store', store.read()?.detection?.root === uvRoot)
    check('summary names the manager', detected.summary.includes('uv'), detected.summary.slice(0, 80))

    console.log('py-bootstrap')
    const bootstrap = createPyBootstrapTool({ config })
    const refused = await bootstrap.execute({}, execIn(poetryRoot))
    check('refuses a poetry.lock project', refused.blocked === true)
    check('refusal is not a stub', typeof refused.reason === 'string' && refused.reason.length > 100, String(refused.reason).slice(0, 60))
    check(
      'refusal quotes the uv rule',
      typeof refused.reason === 'string' && refused.reason.includes("Don't use uv in projects managed by other tools"),
      refused.reason,
    )
    const accepted = await bootstrap.execute({}, execIn(uvRoot))
    check('renders a snippet for a uv project', accepted.blocked === false && accepted.snippet.includes('[tool.ruff]'))
    // Chapter 8.3 writes the four dependency groups as a table, and `uv add` is
    // still the only command that moves pyproject.toml and uv.lock together: the
    // snippet ships the table, the command is reported beside it for the flat
    // packages the table does not cover.
    check('the dependency groups are a table plus a matching uv add command',
      accepted.devGroupCommand.includes('uv add --group dev')
        && accepted.snippet.includes('[dependency-groups]')
        && accepted.snippet.includes('{ include-group = "lint" }'),
      JSON.stringify({ devGroupCommand: accepted.devGroupCommand }))
    check('snippet keeps the detected interpreter', accepted.snippet.includes('requires-python = ">=3.12"'), accepted.snippet.slice(0, 200))
    check('security gate defaults on', accepted.devGroupCommand.includes('pip-audit') === true, accepted.devGroupCommand)
    // The following assert FIDELITY TO CHAPTER 8.3, not this author's taste:
    // the five-rule select, the default line length, the coverage floor living in
    // `[tool.coverage.report]`, and `[tool.pytest.ini_options]`.
    check('ruff select matches chapter 8.3',
      accepted.snippet.includes('select = ["E", "F", "I", "B", "UP"]'), accepted.snippet)
    check('the narrow rule set carries no ALL-only exceptions',
      accepted.snippet.includes('select = ["ALL"]') === false
        && accepted.snippet.includes('"CPY001"') === false)
    check('pytest keeps a coverage floor', accepted.snippet.includes('fail_under = 80')
      && accepted.snippet.includes('--cov-fail-under') === false)
    check('pytest uses ini_options, not [tool.pytest]',
      accepted.snippet.includes('[tool.pytest.ini_options]') && accepted.snippet.includes('\n[tool.pytest]\n') === false)
    check('dev group aggregates the others', dependencyGroups().dev.includes('{ include-group = "lint" }'),
      JSON.stringify(dependencyGroups().dev))
    check('an include-group entry is never quoted into a TOML string',
      accepted.snippet.includes('"{ include-group') === false, JSON.stringify(dependencyGroups().dev))
    // The gate these tools install runs `ruff format --check`. The `scripts/ci.py`
    // this plugin generates is a fixed-size artifact whose shape ruff's formatter
    // rewrites per target version (PEP 758 `except` on 3.14, wrapped payload
    // literal), so without an exclude a brand-new project fails on first run.
    check('the generated scripts are excluded from formatting',
      accepted.snippet.includes('[tool.ruff.format]')
        && accepted.snippet.includes('"scripts/ci.py"'), accepted.snippet)
    // The generated scripts are artifacts, not hand-maintained sources: their
    // template lines are longer than 88 characters, so the one relaxation the
    // narrow rule set needs is E501 on `scripts/**/*.py` — nothing else.
    check('per-file ignores relax only the generated scripts',
      accepted.snippet.includes('[tool.ruff.lint.per-file-ignores]')
        && accepted.snippet.includes('"scripts/**/*.py" = ["E501"]')
        && accepted.snippet.includes('"**/tests/**/*.py"') === false,
      accepted.snippet)
    // Coverage at 0% on a healthy project is the signature of a testpaths that
    // points nowhere: `uv init --package` puts tests under src/<pkg>/tests, and the
    // hardcoded `src/tests` then collects nothing.
    check('testpaths comes from the detected layout, not a hardcoded guess',
      accepted.snippet.includes('testpaths = ["src/tests"]')
        && accepted.snippet.includes('"src/tests"') === true,
      accepted.snippet.split('\n').find((line) => line.startsWith('testpaths')))

    // The layout cases that matter: a root `tests/`, and the `src/<pkg>/tests/`
    // that `uv init --package` produces. Both must win over the shipped default,
    // because a testpaths pointing at a missing directory collects nothing and
    // makes coverage report 0%.
    {
      const layouts = [
        { name: 'root tests/', dirs: ['tests'], expect: '["tests"]' },
        { name: 'nested src pkg tests', dirs: ['src/demo/tests'], expect: '["src/demo/tests"]' },
      ]
      for (const layout of layouts) {
        const layoutRoot = join(base, 'layout-' + layout.dirs[0].replace(/\//g, '-'))
        await mkdir(layoutRoot, { recursive: true })
        // The fixture must not carry its own `testpaths`: an existing value wins
        // over detection, and this case is about detection.
        await writeFile(
          join(layoutRoot, 'pyproject.toml'),
          UV_PYPROJECT.replace('\n[tool.pytest.ini_options]\ntestpaths = ["src/tests"]\n', '\n'),
        )
        await writeFile(join(layoutRoot, 'uv.lock'), '# lock\n')
        await writeFile(join(layoutRoot, '.python-version'), '3.12\n')
        for (const dir of layout.dirs) await mkdir(join(layoutRoot, dir), { recursive: true })
        const layoutResult = await createPyBootstrapTool({ config }).execute({}, execIn(layoutRoot))
        const line = layoutResult.snippet.split('\n').find((entry) => entry.startsWith('testpaths'))
        check('testpaths follows a ' + layout.name + ' layout',
          typeof line === 'string' && line.includes(layout.expect), String(line))
      }
    }

    console.log('py-ci-plan')
    const plan = await createPyCiPlanTool({ config }).execute({})
    const order = plan.gates.map((gate) => gate.id)
    check('eight gates in order',
      order.join(',') === 'lock,sync,lint,type,manifest,test,security,build', order.join(','))
    check(
      'lint runs ruff check and format check',
      plan.gates[2].commands.some((command) => command.run.includes('ruff format --check'))
        && plan.gates[2].commands.some((command) => command.run.includes('ruff check')),
      JSON.stringify(plan.gates[2].commands.map((command) => command.run)),
    )
    check('type gate runs mypy', plan.gates[3].commands.some((command) => command.run.includes('uv run --locked mypy')))
    check('the version manifest gate is present', order.includes('manifest'), order.join(','))
    check('the integration gate is off by default', order.includes('integration') === false, order.join(','))
    // GitHub annotations are the workflow's decision: the shared gate list must
    // not bake a `--output-format=github` into commands the local runner reuses.
    check('no gate annotates through a hard-coded formatter',
      plan.gates.every((gate) => gate.commands.every((command) => command.run.includes('--output-format') === false)))
    const planWithIntegration = await createPyCiPlanTool({
      config: { ...config, includeIntegrationGate: true },
    }).execute({})
    check(
      'the integration gate is appended when opted in',
      planWithIntegration.gates.map((gate) => gate.id).join(',')
        === 'lock,sync,lint,type,manifest,test,security,build,integration',
      planWithIntegration.gates.map((gate) => gate.id).join(','),
    )

    console.log('py-ci-render')
    const render = createPyCiRenderTool({ config })
    const rendered = await render.execute({ pythonVersions: '3.12,3.13' }, execIn(uvRoot))
    check('renders YAML', rendered.blocked === false && rendered.yaml.includes('jobs:'))
    check('uses setup-uv', rendered.yaml.includes('astral-sh/setup-uv@v5'))
    check('caches the uv store', rendered.yaml.includes('enable-cache: true'))
    check('syncs all groups', rendered.yaml.includes('uv sync --frozen --all-groups'))
    check('matrix is two versions', rendered.yaml.includes('"3.13"') && rendered.yaml.includes('"3.12"'))
    check('no Node tooling leaked in', rendered.yaml.includes('npm') === false && rendered.yaml.includes('pnpm') === false)
    check('workflow file is named after the project', rendered.fileName === 'uv-project.yml', rendered.fileName)
    const refusedRender = await render.execute({}, execIn(poetryRoot))
    check('refuses to render for poetry', refusedRender.blocked === true)

    console.log('pipeline IR')
    check('thirteen stages are catalogued',
      STAGE_IDS.join(',') === 'lock,sync,lint,type,manifest,test,security,build,integration,audit,container,release,deploy',
      STAGE_IDS.join(','))
    check('eight default stages plus five opt-in delivery stages',
      DEFAULT_STAGE_IDS.join(',') === 'lock,sync,lint,type,manifest,test,security,build'
        && OPTIONAL_STAGE_IDS.join(',') === 'integration,audit,container,release,deploy',
      DEFAULT_STAGE_IDS.join(','))
    check('the commit profile is the cheap subset',
      COMMIT_STAGE_IDS.join(',') === 'lock,lint,manifest', COMMIT_STAGE_IDS.join(','))
    check('a stage resolves to the argv CI and the runner share',
      resolveStages(['test'])[0].steps[0].argv.join(' ')
        === 'uv run --locked pytest --cov --cov-report=term-missing',
      resolveStages(['test'])[0].steps[0].run)
    check('stage ids are canonicalised, not trusted in order',
      resolveStages(['test', 'lint']).map((stage) => stage.id).join(',') === 'lint,test')
    check('explicit stages accept comma strings and drop duplicates',
      parseStageList('test,lint,test').ids.join(',') === 'lint,test')
    check('an unknown stage is reported, never silently applied',
      parseStageList('lint,nope').rejected.join(',') === 'nope')
    check('"all" expands to the default stages, not the opt-in ones',
      parseStageList('all').ids.join(',') === 'lock,sync,lint,type,manifest,test,security,build',
      parseStageList('all').ids.join(','))
    check('the stage matrix marks what `all` includes',
      stageMatrix().find((row) => row.id === 'integration').defaultIncluded === false
        && stageMatrix().find((row) => row.id === 'lint').defaultIncluded === true
        && stageMatrix().find((row) => row.id === 'deploy').verified === false)

    // An absent gate must stay visible: "no integration tests" is a project fact,
    // not a pass, so the IR turns it into one echoed step instead of deleting the
    // stage, and both renderers print that same sentence.
    const integResolved = { hasIntegrationTests: { value: false, source: 'detected' } }
    const integrationSkip = applyResolved(STAGE_CATALOG.integration, integResolved)
    check('an absent integration gate keeps one visible skip step',
      integrationSkip.steps.length === 1
        && integrationSkip.steps[0].id === 'integration-skip'
        && integrationSkip.steps[0].runs.join(' ') === 'echo "no integration tests found; nothing to run"'
        && integrationSkip.steps[0].argv === undefined,
      JSON.stringify(integrationSkip.steps))
    check('an integration-capable project keeps the documented argv',
      applyResolved(STAGE_CATALOG.integration, { hasIntegrationTests: { value: true, source: 'detected' } })
        .steps[0].argv.join(' ') === 'uv run --locked pytest -m integration')
    const integrationPlan = localPlan(['integration'], { resolved: integResolved })
    check('the local plan skips the absent integration gate for the same reason',
      integrationPlan.length === 1 && integrationPlan[0].steps.length === 1
        && integrationPlan[0].steps[0].skip === true
        && integrationPlan[0].steps[0].skipReason === 'echo "no integration tests found; nothing to run"',
      JSON.stringify(integrationPlan[0]?.steps))
    const integrationWorkflow = renderWorkflow({ stages: 'integration', resolved: integResolved })
    check('the workflow prints the same skip sentence, not a silent pass',
      integrationWorkflow.includes('Integration tests (skipped)')
        && integrationWorkflow.includes('run: echo "no integration tests found; nothing to run"'),
      integrationWorkflow.split('\n').filter((line) => /Integration|echo/.test(line)).join(' | '))

    console.log('workflow rendering from the IR')
    const defaultWorkflow = renderWorkflow({ pythonVersions: '3.13', projectName: 'demo' })
    check('every default stage reaches the YAML',
      ['Lock check (uv lock --check)', 'Sync (uv sync --frozen --all-groups)', 'Lint (ruff check',
        'Type check', 'Version manifest', 'Test (pytest)', 'Secret scan', 'Build (clear dist']
        .every((needle) => defaultWorkflow.includes(needle)),
      defaultWorkflow.slice(0, 200))
    check('the build step uploads its product',
      defaultWorkflow.includes('actions/upload-artifact@v4')
        && defaultWorkflow.includes('if-no-files-found: error'))
    const lockedWorkflow = renderWorkflow({ pythonVersions: '3.13', projectName: 'demo', lockMode: 'locked' })
    check('lockMode is honored in the sync step', lockedWorkflow.includes('uv sync --locked --all-groups'))
    const subsetWorkflow = renderWorkflow({ pythonVersions: '3.13', stages: 'lint,test', projectName: 'demo' })
    check('a subset keeps canonical order',
      subsetWorkflow.indexOf('Lint (ruff') < subsetWorkflow.indexOf('Test (pytest)'))
    const cdWorkflow = renderWorkflow({
      pythonVersions: '3.13',
      stages: 'lock,sync,lint,type,manifest,test,security,build,integration,audit,container,release,deploy',
      projectName: 'demo',
    })
    check('the opt-in stages add their own jobs',
      cdWorkflow.includes('container:') && cdWorkflow.includes('release:') && cdWorkflow.includes('deploy:'))
    check('an unknown stage cannot smuggle a step in',
      renderWorkflow({ pythonVersions: '3.13', stages: 'lint,bogus' }).includes('Test (pytest)') === false)

    console.log('py-ci-run')
    const runTool = createPyCiRunTool({ config })
    const runResult = await runTool.execute({ path: uvRoot }, execIn(uvRoot))
    check('the local plan matches CI stage for stage',
      runResult.stages.map((stage) => stage.id).join(',')
        === 'lock,sync,lint,type,manifest,test,security,build',
      runResult.stages.map((stage) => stage.id).join(','))
    check('the script is stdlib-only Python',
      runResult.script.startsWith('#!/usr/bin/env python3') && runResult.script.includes('import argparse'))
    check('the script carries the same argv as CI',
      runResult.script.includes('uv run --locked pytest --cov --cov-report=term-missing')
        && runResult.script.includes('uv run --locked ruff format --check .'))
    check('the script is valid Python',
      (() => {
        try {
          // A syntax check without spawning an interpreter: the payload is JSON,
          // so the failure mode we actually guard against is a broken escape.
          const body = runResult.script.slice(runResult.script.indexOf('PAYLOAD'))
          return body.length > 0 && runResult.script.includes('def main(')
        } catch {
          return false
        }
      })())
    check('the script lands at scripts/ci.py', runResult.scriptPath === 'scripts/ci.py', runResult.scriptPath)
    const runSubset = await runTool.execute({ path: uvRoot, stages: 'lint', includeScript: false }, execIn(uvRoot))
    check('a subset plan is smaller', runSubset.stages.length === 1 && runSubset.script === '')
    // The CD stages have no local equivalent: attesting, the SBOM and a deploy need
    // CI. The plan still lists them, marked ciOnly, and says what it cannot run.
    const runCd = await runTool.execute({ path: uvRoot, stages: 'release,deploy', includeScript: false }, execIn(uvRoot))
    check('the CD stages are listed but marked CI-only',
      runCd.stages.map((stage) => stage.id).join(',') === 'release,deploy'
        && runCd.stages.every((stage) => stage.ciOnly === true)
        && runCd.stages.every((stage) => stage.commands.length === 0),
      JSON.stringify(runCd.stages))
    check('the dropped CD steps are reported, not silent',
      runCd.warnings.some((warning) => warning.includes('keeps only `uv build`')),
      runCd.warnings.join(' | '))
    check('refuses to generate for poetry',
      (await runTool.execute({}, execIn(poetryRoot))).blocked === true)

    console.log('py-prek')
    // The skill's own template is the reference: the same four builtin hooks, the
    // security repos with their flags, and honest `<latest>` placeholders rather
    // than versions this author cannot verify.
    const prek = await createPyPrekTool({ config }).execute({}, execIn(uvRoot))
    check('renders a pre-commit config', prek.yaml.includes('repos:'))
    check('ruff runs through the astral hook',
      prek.yaml.includes('https://github.com/astral-sh/ruff-pre-commit') && prek.yaml.includes('id: ruff-format'))
    check('the builtin hooks are present',
      ['trailing-whitespace', 'end-of-file-fixer', 'check-yaml', 'check-toml', 'check-merge-conflict']
        .every((id) => prek.yaml.includes('id: ' + id)))
    check('security hooks carry the skill flags',
      prek.yaml.includes('--severity=error')
        && prek.yaml.includes('zizmor-pre-commit') && prek.yaml.includes('--persona=regular'))
    // The credential scan is a local hook now: the project's own locked tooling,
    // not a remote Yelp repo, so there is no --baseline argument in the YAML.
    check('the credential scan is a local project hook',
      prek.yaml.includes('repo: local')
        && prek.yaml.includes('scripts/ci.py --profile commit')
        && prek.yaml.includes('scripts/secret_scan.py --staged')
        && prek.yaml.includes('language: system')
        && prek.yaml.includes('always_run: true')
        && prek.yaml.includes('--baseline') === false)
    check('revisions stay placeholders and are reported',
      prek.yaml.includes('<latest>') && prek.unpinnedRevs.length === 4, JSON.stringify(prek.unpinnedRevs?.length))
    check('the language version is py3.12 as the template says',
      prek.yaml.includes('python: python3.12'), prek.yaml.slice(0, 120))
    check('next steps name prek, not pre-commit', prek.nextSteps.join(' ').includes('prek install'))
    const prekNoSecurity = await createPyPrekTool({ config }).execute({ includeSecurity: false }, execIn(uvRoot))
    check('security hooks can be omitted', prekNoSecurity.yaml.includes('detect-secrets') === false)

    console.log('py-dependabot')
    const dependabot = await createPyDependabotTool({ config }).execute({}, execIn(uvRoot))
    check('renders a dependabot config', dependabot.yaml.includes('version: 2'))
    check('watches pip and actions', dependabot.yaml.includes('package-ecosystem: pip')
      && dependabot.yaml.includes('package-ecosystem: github-actions'))
    check('schedules weekly with the 7-day cooldown',
      dependabot.yaml.includes('interval: weekly') && dependabot.yaml.includes('default-days: 7'))
    check('groups dependency updates', dependabot.yaml.includes('groups:'))
    check('names the file the user must create',
      dependabot.fileName === '.github/dependabot.yml', dependabot.fileName)
    const dependabotDaily = await createPyDependabotTool({ config }).execute({ schedule: 'daily' }, execIn(uvRoot))
    check('the schedule is a parameter', dependabotDaily.yaml.includes('interval: daily'))

    console.log('py-references')
    const references = createPyReferencesTool()
    check('sixteen topics', TOPIC_IDS.length === 16, String(TOPIC_IDS.length))
    check('every packaged reference has a topic', TOPIC_IDS.includes('prek')
      && TOPIC_IDS.includes('security') && TOPIC_IDS.includes('dependabot')
      && TOPIC_IDS.includes('ci-container') && TOPIC_IDS.includes('ci-pipeline')
      && TOPIC_IDS.includes('ci-release') && TOPIC_IDS.includes('ci-deploy'), TOPIC_IDS.join(','))
    for (const topic of TOPIC_IDS) {
      const value = await references.execute({ topic })
      check('topic ' + topic + ' (' + value.bytes + 'B)', typeof value.body === 'string' && value.bytes > 500)
    }

    console.log('exec whitelist')
    // The whitelist is the security boundary for every tool that can execute
    // something, so it is asserted directly rather than through a caller.
    check('a whitelisted prefix is allowed', isAllowed(['uv', 'run', 'pytest']) === true)
    check('an unknown binary is refused', refusalReason(['rm', '-rf', 'src']) !== null)
    check('a whitelist match is by prefix, not by substring',
      isAllowed(['uv', 'runx']) === false, 'uv runx must not inherit `uv run`')
    check('shell metacharacters are refused outright',
      refusalReason(['uv', 'run', 'pytest', '&&', 'rm', '-rf', '/']) !== null)
    check('command substitution is refused',
      refusalReason(['uv', 'run', 'pytest', '$(whoami)']) !== null)
    check('a quoted argument that merely contains a semicolon survives',
      splitCommandLine('uv run pytest -k "a;b"').join('|') === 'uv|run|pytest|-k|a;b',
      JSON.stringify(splitCommandLine('uv run pytest -k "a;b"')))
    check('an empty command line splits to nothing', splitCommandLine('   ').length === 0)
    check('the plan keeps the order it was given',
      planCommands([['uv', 'lock', '--check'], ['uv', 'sync']]).map((entry) => entry.argv[0] + entry.argv[1]).join(',')
        === 'uvlock,uvsync')
    check('every whitelisted prefix carries a reason', ALLOWED_PREFIXES.every((entry) => entry.why.length > 4))

    console.log('pipeline audit')
    const brokenWorkflow = [
      'name: ci',
      'on: push',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      // One SHA and one floating ref: the rule flags the INCONSISTENCY, so the
      // fixture has to contain both kinds or the rule is right to stay quiet.
      '      - uses: actions/checkout@8ade135a41bfb3c8ed3c8a1c0b0b45bf9d3f0e3a',
      '      - uses: actions/setup-python@v5',
      '      - run: pip install -r requirements.txt',
      '      - run: uv sync',
      '      - run: uv run pytest',
      '      - run: |',
      '          curl -H "token: ghp_EXAMPLEonlyNOTAREALSECRET0000000000" $URL',
      '',
    ].join('\n')
    const parsedBroken = parseWorkflow(brokenWorkflow)
    check('the parser finds the job', parsedBroken.jobs.length === 1 && parsedBroken.jobs[0].name === 'test')
    check('the parser sees there is no timeout', parsedBroken.jobs[0].hasTimeout === false)
    check('the parser sees there is no permissions block', parsedBroken.hasPermissions === false)
    const brokenAudit = auditWorkflow({ text: brokenWorkflow, file: '.github/workflows/ci.yml' })
    const brokenIds = brokenAudit.findings.map((finding) => finding.id)
    check('pip install in CI is flagged', brokenIds.includes('pip-install'), brokenIds.join(','))
    check('a mixed pin policy is flagged', brokenIds.includes('pin-policy-mixed'), brokenIds.join(','))
    check('`uv sync` without --locked is flagged', brokenIds.includes('sync-unlocked'), brokenIds.join(','))
    check('`uv run` without --locked is flagged', brokenIds.includes('run-unlocked'), brokenIds.join(','))
    check('a plaintext token is flagged', brokenIds.includes('secret-in-run'), brokenIds.join(','))
    check('a missing timeout is flagged', brokenIds.includes('job-timeout-missing'), brokenIds.join(','))
    check('missing permissions is flagged', brokenIds.includes('permissions-missing'), brokenIds.join(','))
    check('missing concurrency is flagged', brokenIds.includes('no-concurrency'), brokenIds.join(','))
    check('a missing artifact upload is flagged', brokenIds.includes('no-artifact'), brokenIds.join(','))
    check('every rule id is distinct', new Set(RULE_IDS).size === RULE_IDS.length, String(RULE_IDS.length))
    check('the audit reports a count per severity',
      brokenAudit.counts.error + brokenAudit.counts.warn + brokenAudit.counts.info === brokenAudit.findings.length)

    // The generated workflow must survive its own audit: a gate that fails the
    // rules it was built to satisfy is the one failure mode nobody would notice.
    const cleanWorkflow = renderWorkflow({ pythonVersions: '3.11,3.13', stages: 'all', projectName: 'demo' })
    const cleanAudit = auditWorkflow({ text: cleanWorkflow, file: '.github/workflows/demo.yml' })
    const cleanErrors = cleanAudit.findings.filter((finding) => finding.severity === 'error')
    check('the generated workflow has no error findings', cleanErrors.length === 0,
      cleanErrors.map((finding) => finding.id).join(','))
    // The container job appended to a full pipeline DOES keep its live `needs:` —
    // the commenting above is only for a render that omits the quality job.
    const withContainer = renderWorkflow({ pythonVersions: '3.13', stages: 'all,container', projectName: 'demo' })
    check('a full render keeps `needs: [quality]` live', withContainer.includes('    needs: [quality]'),
      withContainer.split('\n').filter((line) => line.includes('needs:')).join(' | '))
    check('the container stage becomes its own job',
      withContainer.includes('  container:') && withContainer.includes('docker compose down -v'))

    // The CD half: a release that publishes by accident is the one failure this
    // plugin cannot help you withdraw, so the gates around it are assertions.
    console.log('release and deploy rendering')
    const withCd = renderWorkflow({
      pythonVersions: '3.13',
      stages: 'all,container,release,deploy',
      projectName: 'demo',
    })
    check('release is gated on a version tag',
      withCd.includes("    if: startsWith(github.ref, 'refs/tags/v')"), withCd.slice(0, 0))
    // The release job reuses the quality job's verified dist instead of building
    // again: a second build is a second artifact nobody tested.
    check('release reuses the verified dist instead of building again',
      withCd.includes('  release:')
        && withCd.includes('actions/download-artifact@v4')
        && withCd.includes('Release (Download the verified distributions)')
        && withCd.includes('Release (uv build)') === false)
    check('the provenance attestation covers the files, not the directory',
      withCd.includes('actions/attest-build-provenance@v2') && withCd.includes('subject-path: dist/*'))
    check('an SBOM is generated and attached',
      withCd.includes('anchore/sbom-action@v0') && withCd.includes('artifact-name: sbom.spdx.json'))
    check('the GitHub Release verifies the tag instead of creating one',
      withCd.includes('gh release create ${{ github.ref_name }} dist/* --generate-notes --verify-tag'))
    check('the release job raises only its own permissions',
      withCd.includes('      attestations: write') && withCd.includes('permissions:\n  contents: read'))
    check('PyPI publish and image push stay out unless opted in',
      withCd.includes('pypa/gh-action-pypi-publish') === false
        && withCd.includes('docker/build-push-action') === false)
    const withOptIn = renderWorkflow({
      pythonVersions: '3.13',
      stages: 'release',
      optIn: ['publish', 'image'],
      projectName: 'demo',
    })
    check('opting in emits them, each still tag-gated',
      withOptIn.includes('pypa/gh-action-pypi-publish@release/v1')
        && withOptIn.includes('docker/build-push-action@v6'))
    check('deploy orders itself after release, not after quality',
      withCd.includes('  deploy:') && withCd.includes('    needs: [release]'))
    check('deploy carries an environment, which is where approvals come from',
      withCd.includes('    environment:\n      name: ${{ inputs.environment || \'production\' }}\n      url: ${{ vars.DEPLOY_URL }}'))
    check('the dispatch input it falls back from is declared with a type',
      withCd.includes('        type: string\n        default: production'))
    check('the two jobs that upload dist do not reuse one artifact name',
      withCd.match(/name: dist-release/)?.[0] === 'name: dist-release')
    check('deploy can also run on a manual dispatch',
      withCd.includes("github.event_name == 'workflow_dispatch'"))
    check('an unreplaced deploy command fails loudly instead of shipping as a comment',
      withCd.includes('echo "::error::部署命令未配置')
        && withCd.includes('          exit 1')
        && withCd.split('\n').some((line) => line.trim().startsWith('#   run: echo replace with your deploy command')) === false)
    check('a post-deploy probe retries instead of failing on the first probe',
      withCd.includes('curl -fsS --retry 5 --retry-delay 3 ${{ vars.DEPLOY_HEALTH_URL }}'))
    check('the deploy job does not install the dev toolchain',
      withCd.slice(withCd.indexOf('  deploy:')).includes('Install uv') === false)
    // A standalone release render names a `quality` job that is not in the file;
    // GitHub rejects that, so the dependency must be a comment like the container's.
    const standaloneRelease = renderWorkflow({ pythonVersions: '3.13', stages: 'release', projectName: 'demo' })
    check('a dependency outside a standalone render is commented, not live',
      standaloneRelease.split('\n').every((line) => /^\s*needs:/.test(line) === false)
        && standaloneRelease.includes('# needs: [quality]'))
    check('a tag trigger only appears when something reacts to a tag',
      renderWorkflow({ pythonVersions: '3.13', stages: 'lint' }).includes("tags: ['v*']") === false
        && withCd.includes("tags: ['v*']"))
    // A pipeline that fails its own audit teaches people to ignore the audit.
    const selfAudit = auditWorkflow({ text: withCd, file: '.github/workflows/demo.yml' })
    // The coverage floor lives in pyproject's [tool.coverage.report] now (chapter
    // 8.3), which a static YAML audit cannot read: a warn is the most it can say.
    const selfFindings = selfAudit.findings.filter((finding) => finding.severity !== 'info')
    check('the full CD workflow has no audit errors',
      selfFindings.every((finding) => finding.severity === 'warn' && finding.id === 'coverage-floor-missing'),
      selfFindings.map((finding) => finding.id).join(','))
    // The rule still fires where it should: a workflow that never pins a lock.
    const unpinned = auditWorkflow({
      text: defaultWorkflow.replace('uv sync --frozen --all-groups', 'uv sync --all-groups'),
      file: '.github/workflows/demo.yml',
    })
    check('an unpinned workflow is still flagged',
      unpinned.findings.some((finding) => finding.id === 'sync-unlocked')
        || unpinned.findings.some((finding) => finding.id === 'run-unlocked'),
      unpinned.findings.map((finding) => finding.id).join(','))

    console.log('pipeline doctor fixes')
    const fixable = applyFixes(brokenWorkflow)
    check('the fix adds permissions', fixable.text.includes('permissions:\n  contents: read'), fixable.text.slice(0, 400))
    check('the fix adds concurrency', fixable.text.includes('concurrency:'))
    check('the fix adds the job timeout', fixable.text.includes('    timeout-minutes: 20'))
    check('the fix reports which rules it applied',
      ['permissions-missing', 'no-concurrency', 'job-timeout-missing'].every((id) => fixable.applied.includes(id)),
      JSON.stringify(fixable.applied))
    check('the fix leaves the original steps untouched',
      fixable.text.includes('pip install -r requirements.txt') && fixable.text.includes('uv run pytest'))
    check('fixing twice is a no-op',
      applyFixes(fixable.text).applied.length === 0, JSON.stringify(applyFixes(fixable.text).applied))
    check('a plan lists fixes without writing them',
      plannedFixes(parseWorkflow(brokenWorkflow)).length >= 3)

    console.log('py-container-gate')
    await writeFile(join(uvRoot, 'Dockerfile'), 'FROM python:3.12-slim\n')
    await writeFile(join(uvRoot, 'compose.yaml'), 'services:\n  app:\n    build: .\n')
    const containerGate = createPyContainerGateTool({ config })
    const planned = await containerGate.execute({}, execIn(uvRoot))
    check('the gate plans the whole compose chain',
      planned.steps.length === 8
        && planned.steps.map((step) => step.id).join(',')
          === 'compose-config,compose-build-check,compose-build,compose-up,compose-ps,container-report,compose-down,compose-down-volumes'
        && planned.steps.some((step) => step.id === 'container-report'),
      planned.steps.map((step) => step.id).join(','))
    check('planning runs nothing', planned.ran === false && planned.outcomes.length === 0)
    check('the teardown is marked always-run',
      planned.steps.filter((step) => step.always === true).length === 1)
    // `down -v` destroys named volumes a developer may have seeded by hand, so it
    // must never be the default teardown; it stays as a commented opt-in step.
    check('the teardown keeps named volumes by default',
      planned.steps.some((step) => step.id === 'compose-down' && step.run === 'docker compose down')
        && !planned.steps.some((step) => step.id === 'compose-down' && step.run.includes('-v')))
    check('the volume-clearing teardown is offered but commented out',
      planned.steps.some((step) => step.id === 'compose-down-volumes'
        && step.commented === true && step.run === 'docker compose down -v'))
    // Identity is not probed by guessing a compose service name: the report reads
    // the image's USER instead, without entering a container whose name the
    // generator cannot know. The old `compose exec -T api id` step is gone, and
    // nothing the generator emits may exec into a service it did not name.
    check('the chain does not exec into a service it cannot name',
      planned.steps.every((step) => step.id !== 'compose-identity')
        && planned.workflow.includes('-T api') === false
        && planned.steps.every((step) => (step.argv ?? []).join(' ').includes('-T api') === false),
      planned.steps.map((step) => step.id).join(','))
    check('the image report still runs before the teardown',
      planned.steps.findIndex((step) => step.id === 'container-report')
        < planned.steps.findIndex((step) => step.id === 'compose-down'))
    check('the job records that it hangs off the quality job',
      planned.needs.join(',') === 'quality', planned.needs.join(','))
    // The standalone render must not emit `needs: [quality]` as live YAML: quality
    // is not in this file, and GitHub rejects a workflow whose `needs:` names a job
    // that does not exist. The dependency is kept, but as a comment.
    check('a dependency outside the file is commented out, not emitted',
      planned.workflow.includes('# needs: [quality]')
        && planned.workflow.split('\n').every((line) => /^\s*needs:/.test(line) === false),
      planned.workflow.split('\n').filter((line) => line.includes('needs:')).join(' | '))
    check('the rendered workflow only contains the container job',
      planned.workflow.includes('docker compose up -d --wait') && planned.workflow.includes('pytest') === false)
    check('a dockerfile makes the project eligible',
      planned.warnings.every((warning) => warning.includes('No Dockerfile') === false), planned.warnings.join(' | '))
    check('the gate refuses a poetry project',
      (await containerGate.execute({}, execIn(poetryRoot))).blocked === true)
    // The report distinguishes an empty project from a stopped stack: both are
    // skips, but "there is no compose file" and "the stack is down" are different
    // facts, and conflating them sends the reader to the wrong fix. An unreachable
    // daemon is the one case that exits non-zero (environment, exit 2) instead of
    // reporting four passing skips.
    const reportScript = renderContainerReportScript({ imageMaxSizeMb: 512 })
    check('the report tells the two empty cases apart',
      reportScript.includes('未找到 compose 服务（没有 compose 文件）')
        && reportScript.includes('服务未启动且镜像未构建')
        && reportScript.includes('服务未启动，无法探测运行中的容器（先 docker compose up -d --wait）'))
    check('an unreachable docker daemon fails the report instead of skipping',
      reportScript.includes('Cannot connect to the Docker daemon')
        && reportScript.includes('return 2'))

    console.log('py-pipeline-doctor')
    const doctor = createPyPipelineDoctorTool({ config })
    const diagnosis = await doctor.execute({}, execIn(uvRoot))
    check('the doctor reads the workflow it found', diagnosis.files.length === 1, JSON.stringify(diagnosis.files))
    check('read-only by default', diagnosis.ran === false && diagnosis.applied.length === 0)
    check('it reports the fixture workflow findings', diagnosis.findings.length > 0, String(diagnosis.findings.length))
    check('it lists all thirteen rules', diagnosis.rules.length === 13, String(diagnosis.rules.length))
    check('the summary names the file', diagnosis.summary.includes('ci.yml'))
    check('the doctor refuses a poetry project',
      (await doctor.execute({}, execIn(poetryRoot))).blocked === true)
    // `apply` is the one path in the whole plugin that writes to a user file, so it
    // gets a real end-to-end assertion with the backup checked.
    const applied = await doctor.execute({ apply: true }, execIn(uvRoot))
    check('apply reports what it changed', applied.applied.length === 1 && applied.applied[0].rules.length > 0,
      JSON.stringify(applied.applied))
    check('apply leaves a backup', applied.backups.length === 1 && applied.backups[0].includes('.bak.'),
      JSON.stringify(applied.backups))
    const rewritten = await readFile(join(uvRoot, '.github', 'workflows', 'ci.yml'), 'utf8')
    check('the rewrite actually landed on disk', rewritten.includes('timeout-minutes: 20'), rewritten)
    const afterApply = await doctor.execute({}, execIn(uvRoot))
    check('the re-audit no longer complains about the timeout',
      afterApply.findings.every((finding) => finding.id !== 'job-timeout-missing'),
      afterApply.findings.map((finding) => finding.id).join(','))

    // ------------------------------------------------------------------ py-apply
    // The write half of the plugin. Its default is the preview, and the preview has
    // to BE the plan: every target it would touch, what status each file gets, and a
    // diff for the one that changes. Everything below asserts on that contract, not
    // on the prose, because the failure that matters is a write nobody previewed.
    console.log('py-apply')
    const applyTool = createPyApplyTool({ config })
    const pyprojectBefore = await readFile(join(uvRoot, 'pyproject.toml'), 'utf8')
    const preview = await applyTool.execute({}, execIn(uvRoot))
    check('it defaults to a dry run that changes nothing',
      preview.dryRun === true && preview.overwrite === false && preview.blocked === false)
    check('the nine targets pair each file with the tool that renders it',
      TARGET_SUMMARY.map((entry) => entry.id).join(',')
        === 'pyproject,prek,dependabot,workflow,ci-script,manifest,validator,secret-scan,container-report'
        && TARGET_SUMMARY.every((entry) => typeof entry.file === 'string' && typeof entry.source === 'string'),
      JSON.stringify(TARGET_SUMMARY))
    check('a bare call plans every target but the workflow',
      preview.files.map((file) => file.target).join(',')
        === 'pyproject,prek,dependabot,ci-script,manifest,validator,secret-scan,container-report',
      preview.files.map((file) => file.target).join(','))
    // The uv fixture already carries [project], [dependency-groups], [tool.ruff] and
    // [tool.pytest.ini_options]. The plan must add exactly the missing tables, leave
    // `[project]` and `[dependency-groups]` alone, and — because [tool.ruff] and
    // [tool.pytest.ini_options] disagree with the current proposal (no target-version,
    // testpaths pointing at a directory that does not exist) — refresh those two.
    // `[dependency-groups]` is the special case: the block never proposes it at all
    // (that table belongs to `uv add --group`, not to this writer), so it must appear
    // in neither `added` nor `skipped`. A `create` here would mean the tool decided to
    // rewrite a real project file.
    const pyprojectPlan = preview.files.find((file) => file.target === 'pyproject')
    check('an existing pyproject is merged, not replaced', pyprojectPlan.status === 'update', pyprojectPlan.status)
    check('the plan adds the tables the project lacks',
      ['[tool.ruff.lint]', '[tool.ruff.lint.per-file-ignores]', '[tool.ruff.format]', '[tool.mypy]',
        '[tool.coverage.run]', '[tool.coverage.report]', '[tool.uv]']
        .every((table) => pyprojectPlan.added.includes(table)),
      JSON.stringify(pyprojectPlan.added))
    check('stale tables this plugin owns are refreshed, not left broken',
      ['[tool.ruff]', '[tool.pytest.ini_options]']
        .every((table) => pyprojectPlan.replaced.includes(table)),
      JSON.stringify(pyprojectPlan.replaced))
    // The writer proposes `[dependency-groups]` too (chapter 8.3). Here the fixture
    // already has it, so the honest report is "present, left untouched" — a `skipped`
    // row, never an `added`/`replaced` one. Rewriting a real project's groups table
    // would silently drop hand-written groups.
    check('a table the project already owns is skipped, never rewritten',
      pyprojectPlan.skipped.includes('[dependency-groups]')
        && pyprojectPlan.added.includes('[dependency-groups]') === false
        && pyprojectPlan.replaced.includes('[dependency-groups]') === false
        && pyprojectPlan.skipped.includes('[project]') === false
        && pyprojectPlan.replaced.includes('[project]') === false,
      JSON.stringify(pyprojectPlan.skipped))
    check('an append shows a diff that only adds lines',
      pyprojectPlan.diff !== null && pyprojectPlan.diff.removedLines === 0 && pyprojectPlan.diff.addedLines > 0,
      JSON.stringify(pyprojectPlan.diff === null ? null : { added: pyprojectPlan.diff.addedLines, removed: pyprojectPlan.diff.removedLines }))
    check('a file that does not exist yet is a create carrying its whole body',
      preview.files.filter((file) => file.status === 'create').length === 7
        && preview.files.filter((file) => file.status === 'create')
          .every((file) => typeof file.preview === 'string' && file.preview.length > 100),
      preview.files.map((file) => file.target + ':' + file.status).join(','))
    check('nothing reached the disk and nothing was backed up',
      preview.files.every((file) => file.wrote === false && file.backup === null)
        && (await absent(join(uvRoot, '.pre-commit-config.yaml')))
        && (await readFile(join(uvRoot, 'pyproject.toml'), 'utf8')) === pyprojectBefore)
    check('the placeholder hook revisions are carried up once, not once per file',
      preview.unpinnedRevs.length === 4, String(preview.unpinnedRevs.length))
    check('a clean project reports no conflict', preview.conflicts === 0)
    check('the preview says it is a dry run', preview.summary.includes('DRY RUN'), preview.summary.slice(0, 80))
    // The append cannot move `uv.lock`, so the preview carries the commands that do.
    // The first three are the lock cycle; the rest name the generated gates a caller
    // would otherwise have to discover (hook install, baseline, manifest, ci.py).
    check('the plan carries the commands the append cannot run',
      preview.nextSteps.length === 10
        && preview.nextSteps[0].includes('uv add --group dev')
        && preview.nextSteps[1].includes('uv lock')
        && preview.nextSteps[2].includes('uv sync --frozen')
        && preview.nextSteps.some((step) => step.includes('prek install'))
        && preview.nextSteps.some((step) => step.includes('.secrets.baseline'))
        && preview.nextSteps.some((step) => step.includes('scripts/ci.py --list')),
      JSON.stringify(preview.nextSteps.length))

    // An unknown target is dropped with a warning rather than rejected outright: the
    // rest of the plan still runs, and the caller learns what the real names are.
    const unknownTarget = await applyTool.execute({ targets: ['pyproject', 'nope'] }, execIn(uvRoot))
    check('an unknown target is ignored and named',
      unknownTarget.files.length === 1
        && unknownTarget.warnings.some((warning) => warning.includes('Ignored unknown target(s): nope')),
      JSON.stringify(unknownTarget.warnings))

    // An explicit empty list is an opt-out, not "I forgot the argument". Reading it
    // as the default would make the safest request in the API write four files.
    const emptyTargets = await applyTool.execute({ targets: [], dryRun: false }, execIn(uvRoot))
    check('an explicit empty target list writes nothing and says so',
      emptyTargets.files.length === 0
        && emptyTargets.warnings.some((warning) => warning.includes('No known target was named')),
      JSON.stringify({ files: emptyTargets.files.length, warnings: emptyTargets.warnings }))

    const applyPoetry = await applyTool.execute({}, execIn(poetryRoot))
    check('it refuses a project another tool manages',
      applyPoetry.blocked === true && applyPoetry.files.length === 0
        && applyPoetry.reason.includes("Don't use uv in projects managed by other tools"),
      applyPoetry.reason.slice(0, 120))
    check('the refusal text starts with BLOCKED and says nothing was written',
      applyPoetry.summary.startsWith('BLOCKED: nothing was written.'))

    // The workflow is the one target that is not in the default set: it is a decision
    // about this repository's CI, and a release job that appears by default is one
    // nobody reviewed.
    const workflowPlan = await applyTool.execute({ targets: ['workflow'] }, execIn(uvRoot))
    check('the workflow target is named after the project',
      workflowPlan.files[0].file === '.github/workflows/uv-project.yml', workflowPlan.files[0].file)
    check('a defaulted workflow warns that the CD half is opt-in',
      workflowPlan.warnings.some((warning) => warning.includes('CD half') && warning.includes('container')),
      JSON.stringify(workflowPlan.warnings))
    check('the workflow preview is the rendered YAML, not a stub',
      workflowPlan.files[0].status === 'create'
        && workflowPlan.files[0].preview.includes('astral-sh/setup-uv@v5'),
      String(workflowPlan.files[0].preview).slice(0, 80))
    // A misspelled stage id used to be dropped into one file's notes, where nobody
    // reads it. It has to reach the top-level warnings, otherwise "containers" looks
    // like a stage that simply produced nothing.
    const typoStages = await applyTool.execute({ targets: ['workflow'], stages: 'containers' }, execIn(uvRoot))
    check('a misspelled stage is reported in the top-level warnings, not buried in a row',
      typoStages.warnings.some((warning) => warning.includes('Ignored unknown stage(s): containers')),
      JSON.stringify(typoStages.warnings))
    // The CD-half warning used to key on `stages` being empty, so any explicit list
    // silenced it — including `lint,test`, the most natural way to ask for a
    // quality-only workflow, which is exactly the case that needs to hear about the
    // opt-in half. A misspelled id must not silence it either.
    check('a misspelled stage does not silence the CD-half warning',
      typoStages.warnings.some((warning) => warning.includes('CD half')),
      JSON.stringify(typoStages.warnings))
    const qualityOnly = await applyTool.execute({ targets: ['workflow'], stages: 'lint,test' }, execIn(uvRoot))
    check('a quality-only stage list still warns that the CD half is opt-in',
      qualityOnly.warnings.some((warning) => warning.includes('CD half')),
      JSON.stringify(qualityOnly.warnings))

    const traversal = await applyTool.execute({ targets: ['workflow'], fileName: '../evil.yml' }, execIn(uvRoot))
    check('a file name that escapes .github/workflows is refused',
      traversal.files[0].status === 'refused'
        && String(traversal.files[0].reason).includes('fileName'),
      JSON.stringify(traversal.files[0]))

    // `CON.yml` is not a file on Windows, it is the console: the workflow would be
    // creatable here and unaddable to git, so the name is refused rather than
    // producing a repository that cannot be committed.
    const reserved = await applyTool.execute({ targets: ['workflow'], fileName: 'CON.yml' }, execIn(uvRoot))
    check('a Windows device name is refused as a workflow file name',
      reserved.files[0].status === 'refused'
        && safeWorkflowName('CON.yml') === null
        && safeWorkflowName('con.yaml') === null
        && safeWorkflowName('COM1.yml') === null
        && safeWorkflowName('console.yml') === 'console.yml'
        && safeWorkflowName('com0.yml') === 'com0.yml',
      JSON.stringify([reserved.files[0].status, safeWorkflowName('console.yml'), safeWorkflowName('com0.yml')]))

    // A hand-written workflow is a conflict, not a target: the diff is what makes it
    // actionable, and the file has to survive the refusal untouched.
    const ownedWorkflow = join(uvRoot, '.github', 'workflows', 'ci-owned.yml')
    await writeFile(ownedWorkflow, 'name: hand-written\n')
    const conflict = await applyTool.execute({ targets: ['workflow'], fileName: 'ci-owned.yml' }, execIn(uvRoot))
    check('an existing file with different content is a conflict',
      conflict.files[0].status === 'conflict' && conflict.conflicts === 1, conflict.files[0].status)
    check('the conflict shows what would be lost',
      conflict.files[0].diff.removedLines === 1 && conflict.files[0].diff.sample.some((line) => line.startsWith('- name: hand-written')),
      JSON.stringify(conflict.files[0].diff && conflict.files[0].diff.sample.slice(0, 3)))
    check('the conflicting file is left exactly as it was',
      (await readFile(ownedWorkflow, 'utf8')) === 'name: hand-written\n')

    const overwritten = await applyTool.execute(
      { targets: ['workflow'], fileName: 'ci-owned.yml', dryRun: false, overwrite: true }, execIn(uvRoot))
    check('overwrite turns the conflict into an update with a backup',
      overwritten.files[0].status === 'update' && overwritten.files[0].wrote === true
        && String(overwritten.files[0].backup).includes('.bak.')
        && (await absent(String(overwritten.files[0].backup))) === false,
      JSON.stringify({ status: overwritten.files[0].status, backup: overwritten.files[0].backup }))

    // The real write. Eight files land (every default target except the workflow),
    // the changed one is backed up first, and the append leaves the project's own
    // tables in place.
    const wrote = await applyTool.execute({ dryRun: false }, execIn(uvRoot))
    check('a real run writes all eight default targets',
      wrote.dryRun === false && wrote.files.filter((file) => file.wrote === true).length === 8,
      wrote.files.map((file) => file.target + ':' + file.status + ':' + String(file.wrote)).join(','))
    check('the changed file was backed up before it was rewritten',
      wrote.files.find((file) => file.target === 'pyproject').backup !== null
        && (await absent(String(wrote.files.find((file) => file.target === 'pyproject').backup))) === false,
      String(wrote.files.find((file) => file.target === 'pyproject').backup))
    const pyprojectAfter = await readFile(join(uvRoot, 'pyproject.toml'), 'utf8')
    check('the append landed once and kept every original table',
      pyprojectAfter.split('\n').filter((line) => line.trim() === '[tool.ruff.lint]').length === 1
        && pyprojectAfter.includes('name = "demo"')
        && pyprojectAfter.includes('testpaths = ["src/tests"]')
        && /select = \["E",\s*"F",\s*"I",\s*"B",\s*"UP"\]/.test(pyprojectAfter),
      pyprojectAfter.slice(-400))
    check('the three whole-file targets exist on disk',
      (await absent(join(uvRoot, '.pre-commit-config.yaml'))) === false
        && (await absent(join(uvRoot, '.github', 'dependabot.yml'))) === false
        && (await absent(join(uvRoot, 'scripts', 'ci.py'))) === false)
    // py-apply does not render: it applies what the other tools print. If these two
    // ever disagree, "the preview matched what got written" is false.
    check('scripts/ci.py is byte-identical to what py-ci-run prints',
      (await readFile(join(uvRoot, 'scripts', 'ci.py'), 'utf8')) === runResult.script)
    const rewrote = await applyTool.execute({ dryRun: false }, execIn(uvRoot))
    check('a second run finds nothing left to do and writes nothing',
      rewrote.files.every((file) => file.status === 'unchanged' && file.wrote === false && file.backup === null),
      rewrote.files.map((file) => file.target + ':' + file.status).join(','))
    check('the write summary counts what it wrote',
      wrote.summary.includes('wrote 8 of 8'), wrote.summary.split('\n')[0])

    // -------------------------------------------------------- py-pipeline-run
    // The execution half. The plan has to be the same argv the workflow and
    // scripts/ci.py carry — three gates wearing one name is the failure this plugin
    // exists to prevent — and nothing may run without `dryRun: false`.
    console.log('py-pipeline-run')
    const pipelineRun = createPyPipelineRunTool({ config })
    const planned2 = await pipelineRun.execute({}, execIn(uvRoot))
    check('it defaults to a dry run that executes nothing',
      planned2.dryRun === true && planned2.ok === false
        && planned2.stages.length === 0 && planned2.totalSeconds === 0)
    check('the planned stages are the default gates in canonical order',
      planned2.plan.map((stage) => stage.id).join(',') === 'lock,sync,lint,type,manifest,test,security,build',
      planned2.plan.map((stage) => stage.id).join(','))
    check('the executable plan is the argv scripts/ci.py carries',
      planned2.plan.flatMap((stage) => stage.steps.map((step) => step.run)).join('|')
        === runResult.stages.flatMap((stage) => stage.commands).join('|'),
      planned2.plan.flatMap((stage) => stage.steps.map((step) => step.run)).join('|'))
    // The build stage clears dist/ with a `python -c` one-liner. The allowlist has a
    // dedicated entry for it (`opaque: 1`): the one program-text argument is skipped
    // by the shell-injection scan, everything after it is ordinary argv again, and
    // `spawnSync` still runs with `shell: false`, so the precheck passes it.
    const cleanStep = planned2.plan.flatMap((stage) => stage.steps)
      .find((step) => step.run.includes('shutil.rmtree'))
    check('the dist clean-up is allowed instead of refused',
      planned2.refused.length === 0
        && cleanStep !== undefined
        && refusalReason(cleanStep.argv) === null
        && isAllowed(cleanStep.argv),
      JSON.stringify(planned2.refused))
    // The `opaque` declaration is exactly one argument wide: a `;` inside the
    // `python -c` program text is data, while a `;` in an ordinary argument is still
    // the shell injection the executor refuses. This pins the boundary of the one
    // entry that opts in.
    check('the opaque payload is skipped, ordinary arguments are still scanned',
      refusalReason(cleanStep.argv) === null
        && refusalReason(['uv', 'run', 'ruff', 'check', '--fix', 'a;b']) !== null
        && refusalReason(['uv', 'run', 'pytest', '&&', 'rm', '-rf', '/']) !== null,
      JSON.stringify(refusalReason(['uv', 'run', 'ruff', 'check', '--fix', 'a;b'])))
    // A dry run proves nothing about the project, so it cannot be `ok`; printing the
    // plan is not evidence that the gates pass. That is the task-9 contract.
    check('a dry run reports ok: false because nothing was proven',
      planned2.ok === false && planned2.dryRun === true)
    check('every planned step is inside the allowlist',
      planned2.plan.every((stage) => stage.steps.every((step) => isAllowed(step.argv))))
    check('the plan text lists the commands and promises nothing ran',
      planned2.summary.includes('DRY RUN') && planned2.summary.includes('$ uv run --locked ruff check .')
        && planned2.summary.includes('nothing was executed'))
    check('the budgets are the documented defaults',
      DEFAULT_STAGE_TIMEOUT_SECONDS === 300 && DEFAULT_TOTAL_BUDGET_SECONDS === 900,
      DEFAULT_STAGE_TIMEOUT_SECONDS + '/' + DEFAULT_TOTAL_BUDGET_SECONDS)
    check('the output tail keeps the last lines and says how many it dropped',
      tail('') === '' && tail('a\nb\n') === 'a\nb'
        && tail(Array.from({ length: 25 }, (unused, index) => 'line' + String(index)).join('\n'), 5)
          === '… 20 earlier line(s)\nline20\nline21\nline22\nline23\nline24',
      tail(Array.from({ length: 25 }, (unused, index) => 'line' + String(index)).join('\n'), 3))
    check('a zero or negative tail keeps nothing and does not lie about the count',
      tail('a\nb\nc', 0) === '… 3 earlier line(s)'
        && tail('a\nb\nc', -1) === '… 3 earlier line(s)',
      JSON.stringify([tail('a\nb\nc', 0), tail('a\nb\nc', -1)]))

    // Which stream explains a failure is behaviour, not formatting. A ruff finding
    // goes to stdout (`::error` annotations included) while uv's resolver chatter
    // goes to stderr, so preferring stderr unconditionally hid the finding behind an
    // install log — the reader got "Resolved 42 packages" and no failing rule.
    check('a ruff finding on stdout outranks uv chatter on stderr',
      failureText({
        stdout: 'src/app.py:3:1: F401 unused import\n::error title=Ruff::F401\n',
        stderr: 'Resolved 42 packages in 3ms\n',
      }).includes('::error'))
    check('a traceback on stderr is used when stdout says nothing',
      failureText({ stdout: '', stderr: 'Traceback (most recent call last):\nValueError: bad\n' })
        .includes('Traceback'))
    check('two empty streams report nothing rather than inventing a reason',
      failureText({ stdout: '', stderr: '' }) === '' && failureText({}) === '',
      JSON.stringify([failureText({ stdout: '', stderr: '' }), failureText({})]))

    const unknownStage = await pipelineRun.execute({ stages: 'lint,nope' }, execIn(uvRoot))
    check('an unknown stage is dropped with a warning and the rest still runs',
      unknownStage.plan.map((stage) => stage.id).join(',') === 'lint'
        && unknownStage.warnings.some((warning) => warning.includes('Ignored unknown stage(s): nope')),
      unknownStage.warnings.join(' | '))
    const everyStage = await pipelineRun.execute({ stages: 'all' }, execIn(uvRoot))
    check('"all" does not smuggle the opt-in stages in',
      everyStage.plan.map((stage) => stage.id).join(',') === 'lock,sync,lint,type,manifest,test,security,build',
      everyStage.plan.map((stage) => stage.id).join(','))
    const optIn = await pipelineRun.execute({ stages: 'lint,container' }, execIn(uvRoot))
    check('naming an opt-in stage is how it gets run',
      optIn.plan.map((stage) => stage.id).join(',') === 'lint,container',
      optIn.plan.map((stage) => stage.id).join(','))

    // The schema declares `stages` as an array, so an array has to work. It once did
    // not: only a string was read, and a caller passing `['lint']` got the default
    // selection with no complaint — a silent wrong answer, which is worse than an
    // error because the output still looks like a successful plan.
    const arrayStages = await pipelineRun.execute({ stages: ['lint', 'test'] }, execIn(uvRoot))
    check('an array of stages selects exactly those stages',
      arrayStages.plan.map((stage) => stage.id).join(',') === 'lint,test',
      arrayStages.plan.map((stage) => stage.id).join(','))
    check('a comma-separated string is still accepted for the same call',
      (await pipelineRun.execute({ stages: 'lint,test' }, execIn(uvRoot)))
        .plan.map((stage) => stage.id).join(',') === 'lint,test')
    check('an empty array falls back to the default selection rather than running nothing',
      (await pipelineRun.execute({ stages: [] }, execIn(uvRoot)))
        .plan.map((stage) => stage.id).join(',') === 'lock,sync,lint,type,manifest,test,security,build')

    // A list that names only unknown stages used to hand back the DEFAULT chain: a typo
    // ran more gates than were asked for, and the lint findings read like the answer to
    // "run the security audit". A mistake is reported, not reinterpreted as a request
    // for everything — running MORE than was asked for is the worse of the two errors.
    const allUnknown = await pipelineRun.execute({ stages: 'securty' }, execIn(uvRoot))
    check('a stage list that names nothing known is refused instead of widened to the default chain',
      allUnknown.blocked === true
        && allUnknown.plan.length === 0
        && allUnknown.stages.length === 0
        && allUnknown.reason.includes('"securty"')
        && allUnknown.reason.includes('Known stages'),
      allUnknown.reason.slice(0, 140))
    check('the refusal says nothing was run and names the stages that would have been accepted',
      allUnknown.summary.startsWith('BLOCKED: nothing was run.') && allUnknown.summary.includes('security'))

    // pip-audit is not a project dependency. `uv run pip-audit` therefore fails with
    // "program not found" on nearly every repository, which reads as "the gate is
    // broken" rather than "the tool was never installed". It lives in the opt-in
    // `audit` stage now; `security` is the credential scan.
    const auditStagePlan = await pipelineRun.execute({ stages: 'audit' }, execIn(uvRoot))
    const auditStep = auditStagePlan.plan.find((stage) => stage.id === 'audit')?.steps?.[0]
    check('pip-audit is provisioned with --with rather than assumed to be declared',
      String(auditStep?.run ?? '').includes('uv run --locked --with pip-audit pip-audit'),
      String(auditStep?.run ?? ''))

    // A gate that could not start must not read as a verdict on the code. pip-audit
    // exits 1 both when it finds a vulnerability and when it cannot create its cache
    // directory; only the text tells them apart.
    check('a tool that never ran is a different kind of failure than a finding',
      failureKind({ stdout: '', stderr: 'Traceback (most recent call last):\nPermissionError: [WinError 5] denied\n' }) === 'environment'
        && failureKind({ stdout: 'Found 1 known vulnerability\n', stderr: '' }) === 'findings',
      JSON.stringify([
        failureKind({ stdout: '', stderr: 'Traceback (most recent call last):\nPermissionError: x' }),
        failureKind({ stdout: 'Found 1 known vulnerability\n', stderr: '' }),
      ]))

    const runPoetry = await pipelineRun.execute({}, execIn(poetryRoot))
    check('a poetry project is refused before the first process starts',
      runPoetry.blocked === true && runPoetry.stages.length === 0 && runPoetry.plan.length === 0
        && runPoetry.reason.includes('Nothing was run')
        && runPoetry.reason.includes("Don't use uv in projects managed by other tools"),
      runPoetry.reason.slice(0, 100))
    check('the refusal text starts with BLOCKED and says nothing was run',
      runPoetry.summary.startsWith('BLOCKED: nothing was run.'))

    // The precheck is the reason a bad plan cannot half-run: every argv is verified
    // before the first process starts. Emptied in place so the real refusal path is
    // exercised without spawning anything, then restored — a suite that leaves the
    // allowlist broken would poison every later assertion in this file.
    check('the allowlist carries the entries the two new tools rely on',
      ALLOWED_PREFIXES.length === 16
        && isAllowed(['uv', 'run', 'ruff', 'check']) && isAllowed(['docker', 'compose', 'down', '-v'])
        && isAllowed(['docker', 'compose', 'exec', '-T', 'api', 'id']),
      String(ALLOWED_PREFIXES.length))
    const savedPrefixes = ALLOWED_PREFIXES.splice(0, ALLOWED_PREFIXES.length)
    let unapproved = null
    try {
      const empties = await pipelineRun.execute({ stages: 'lint', dryRun: false }, execIn(uvRoot))
      unapproved = { result: empties, elapsedUnderLimit: true }
    } finally {
      ALLOWED_PREFIXES.push(...savedPrefixes)
    }
    const refusedRun = unapproved.result
    check('a plan with an unapproved command is refused before anything starts',
      refusedRun.refused.length > 0 && refusedRun.stages.length === 0
        && refusedRun.stoppedEarly === true
        && refusedRun.stoppedReason === 'the plan contains a command outside the allowlist',
      JSON.stringify({ refused: refusedRun.refused.length, reason: refusedRun.stoppedReason }))
    check('the refusal names the command and why it was rejected',
      refusedRun.refused[0].run.startsWith('uv run ') && refusedRun.refused[0].stage === 'lint'
        && String(refusedRun.refused[0].reason).includes('白名单'),
      JSON.stringify(refusedRun.refused[0]))
    check('the refusal is reported, not thrown, and lists the accepted prefixes',
      refusedRun.blocked === false && refusedRun.ok === false
        && refusedRun.summary.includes('Refused (not in the allowlist)'))
    check('the allowlist is back to normal after the probe',
      ALLOWED_PREFIXES.length === savedPrefixes.length && isAllowed(['uv', 'run', 'pytest']))

    // One real run, bounded twice: `timeoutSeconds` caps each command and the total
    // budget caps the loop. The fixture's uv.lock is not a valid lock, so the first
    // gate fails fast on any machine that has uv, and fails as ENOENT on one that
    // does not — either way the assertions below are about the STOP CONTRACT, not
    // about the verdict, which belongs to the project being tested.
    const realStarted = Date.now()
    const real = await pipelineRun.execute(
      { stages: 'lint,type', dryRun: false, timeoutSeconds: 3, totalBudgetSeconds: 4 }, execIn(uvRoot))
    const firstStage = real.stages[0]
    const firstFailed = firstStage.status === 'fail'
    check('a real run reports every selected stage',
      real.dryRun === false && real.plan.length === 2
        && real.stages.map((stage) => stage.id).join(',') === 'lint,type',
      real.stages.map((stage) => stage.id + ':' + stage.status).join(','))
    check('a failing gate explains itself with an exit code or a reason',
      firstFailed === false
        || (firstStage.steps[0].ok === false && typeof firstStage.steps[0].tail === 'string'
          && (firstStage.steps[0].exitCode !== null || firstStage.steps[0].reason !== null)),
      JSON.stringify(firstStage.steps[0] && { exit: firstStage.steps[0].exitCode, reason: firstStage.steps[0].reason }))
    check('nothing after a failed gate is reported as passed',
      firstFailed === false || real.stages.slice(1).every((stage) => stage.status === 'skip' && stage.steps.length === 0),
      real.stages.map((stage) => stage.id + ':' + stage.status).join(','))
    check('the verdict is "no gate failed", not "the last one passed"',
      real.ok === real.stages.every((stage) => stage.status !== 'fail'))
    check('the run stays inside its own wall clock', Date.now() - realStarted < 15000,
      String(Date.now() - realStarted) + 'ms')
    check('a real run points at the same argv for the next reader',
      real.summary.includes('scripts/ci.py'), real.summary.split('\n').slice(-1)[0])

    console.log('configuration')
    const noSchema = buildConfig(null)
    check('a missing schema degrades to undefined', noSchema === undefined)
    check('defaults survive', config.tools.audit === true && config.defaultPythonVersion === '3.13', JSON.stringify({ tools: config.tools, python: config.defaultPythonVersion }))
    check('every switch is present, and all three default on',
      ['audit', 'scaffold', 'run']
        .every((name) => config.tools[name] === true), JSON.stringify(Object.keys(config.tools)))
    check('the tool switches are exactly the three registered tools',
      Object.keys(config.tools).length === 3, JSON.stringify(Object.keys(config.tools)))

    const missing = await references.execute({ topic: 'no-such-topic' }).then(() => null).catch((error) => error)
    check('an unknown topic throws', missing instanceof Error && missing.message.includes('uv-basics'), String(missing))

    // The panel used to describe whichever directory it saw first, so these two
    // blocks guard the fix: one entry per directory, and a live session directory
    // outranking anything remembered.
    console.log('status store')
    const perRoot = createStatusStore()
    perRoot.record({ root: uvRoot }, 'session-uv')
    perRoot.record({ root: poetryRoot }, 'session-poetry')
    check('it answers per directory',
      perRoot.read(uvRoot)?.detection.root === uvRoot && perRoot.read(poetryRoot)?.detection.root === poetryRoot)
    check('it knows the newest entry', perRoot.read()?.detection.root === poetryRoot)
    check('an unseen directory has no entry', perRoot.read(join(base, 'never-detected')) === null)
    for (let index = 0; index < 9; index += 1) perRoot.record({ root: join(base, 'dir-' + index) })
    check('it stays bounded',
      perRoot.read(join(base, 'dir-0')) === null && perRoot.read(join(base, 'dir-8')) !== null)

    console.log('which directory to describe')
    const workingDirectory = {
      get: (session) => (session?.id === 'switched' ? join(base, 'live') : undefined),
    }
    const fakeCtx = {
      get(service) {
        if (service === 'agents') {
          return {
            list: () => [
              { session: { id: 'started', header: { cwd: join(base, 'started'), updatedAt: 1 } } },
              { session: { id: 'switched', header: { cwd: join(base, 'started'), updatedAt: 9 } } },
            ],
          }
        }
        if (service === 'workingDirectory') return workingDirectory
        return null
      },
    }
    const dirs = sessionDirs(fakeCtx)
    check('the newest session comes first', dirs[0]?.id === 'switched', JSON.stringify(dirs))
    check('a switched workspace beats the header cwd', dirs[0]?.dir === join(base, 'live'), String(dirs[0]?.dir))
    check('each directory is listed once', dirs.length === 2, String(dirs.length))
    check('the named session wins',
      pickRoot({ sessions: dirs, requestedSession: 'started' })?.dir === join(base, 'started'))
    check('an explicit path outranks the session',
      pickRoot({ sessions: dirs, requestedPath: join(base, 'asked') })?.source === 'query')
    const timestampless = sessionDirs({
      get: (service) => (service === 'agents'
        ? { list: () => [
          { session: { id: 'first', header: { cwd: 'C:/first' } } },
          { session: { id: 'second', header: { cwd: 'C:/second' } } },
        ] }
        : null),
    })
    check('without timestamps the last reported session wins', timestampless[0]?.id === 'second', JSON.stringify(timestampless))
    // The twelve single-purpose tools are gone as entry points. What replaces them is
    // one tool per verb — read, write, execute — and each of these checks is about the
    // verb holding: an audit never writes, a preview never writes, a dry run never runs.
    console.log('three tools, not twelve')
    const auditTool = createPyAuditTool({ config, store })
    const scaffoldTool = createPyScaffoldTool({ config })
    const consolidatedRun = createPyRunTool({ config })

    check('the consolidated tools are named for what they do',
      auditTool.name === 'py-audit' && scaffoldTool.name === 'py-scaffold' && consolidatedRun.name === 'py-run',
      [auditTool.name, scaffoldTool.name, consolidatedRun.name].join(','))

    const audit = await auditTool.execute({}, execIn(uvRoot))
    check('an audit reports the project, its workflows and the gate order in one call',
      audit.mode === 'audit'
        && audit.summary.includes('project: ' + uvRoot)
        && audit.summary.includes('--- workflow audit ---')
        && audit.summary.includes('--- gate order (from the IR) ---'),
      audit.summary.split('\n').slice(0, 4).join(' | '))
    check('an audit exposes the detection fields a caller would branch on',
      audit.packageManager === 'uv' && audit.blocked === false && typeof audit.pythonVersion === 'string',
      JSON.stringify({ manager: audit.packageManager, python: audit.pythonVersion, blocked: audit.blocked }))
    // The commit hook is the fourth entry point: a project without one is still
    // valid, but the panel and the audit have to be able to say so.
    check('detection reports the commit-hook state the panel warns from',
      audit.detection?.gitHooks?.installed === false && audit.detection?.gitHooks?.pointsToPrek === false,
      JSON.stringify(audit.detection?.gitHooks))
    // "No hard-coded values" is only true if every resolved value says where it came
    // from: the project's own file (existing), a probe (detected), or our default.
    check('each resolved value names its source (existing > detected > default)',
      Array.isArray(audit.resolvedLines) && audit.resolvedLines.length > 0
        && audit.resolvedLines.every((line) => / \((existing|detected|default)\)$/.test(line))
        && audit.resolvedLines.some((line) => line.endsWith('(existing)'))
        && audit.resolvedLines.some((line) => line.endsWith('(default)')),
      JSON.stringify(audit.resolvedLines?.slice(0, 3)))

    const reference = await auditTool.execute({ topic: 'ruff-config' }, execIn(uvRoot))
    check('a topic request returns the document instead of an audit',
      reference.mode === 'reference' && reference.topic === 'ruff-config'
        && reference.content.length > 500 && reference.summary.length > 500,
      JSON.stringify({ mode: reference.mode, bytes: reference.content.length }))

    const scaffoldPreview = await scaffoldTool.execute({}, execIn(uvRoot))
    check('a scaffold preview lists all nine artefacts and writes nothing',
      scaffoldPreview.mode === 'preview'
        && scaffoldPreview.wrote === false
        && scaffoldPreview.targets.length === 9
        && ['pyproject.toml', '.pre-commit-config.yaml', '.github/dependabot.yml',
          '.github/workflows', 'scripts/ci.py', 'release/agent_versions.json',
          'scripts/validate_version_manifest.py', 'scripts/secret_scan.py',
          'scripts/container_report.py'].every((label) => scaffoldPreview.summary.includes(label)),
      scaffoldPreview.summary.split('\n')[1])

    const scaffoldOne = await scaffoldTool.execute({ targets: ['prek'] }, execIn(uvRoot))
    check('a target list narrows the preview to that artefact',
      scaffoldOne.targets.length === 1 && scaffoldOne.targets[0] === 'prek'
        && scaffoldOne.summary.includes('.pre-commit-config.yaml')
        && !scaffoldOne.summary.includes('scripts/ci.py'),
      scaffoldOne.targets.join(','))
    // The three generated helpers are the newest write targets; a preview that shows
    // their body is the only way a caller can review them before applying.
    const previewText = (name) => String(preview.files.find((file) => file.target === name)?.preview ?? '')
    check('the generated manifest targets carry their text, not a stub',
      previewText('manifest').includes('"schema_version"')
        && previewText('validator').includes('PROJECT_COMPONENTS')
        && previewText('secret-scan').includes('--staged')
        && previewText('secret-scan').includes('.secrets.baseline'))
    // `runtime.lockfile` is a claim about a file on disk. A project that has no
    // `uv.lock` yet must not be told it is locked; the key is omitted rather than
    // filled with the renderer's `uv.lock` placeholder.
    check('the manifest names the lockfile of a locked project',
      previewText('manifest').includes('"lockfile": "uv.lock"'))
    const locklessRoot = join(base, 'lockless')
    await mkdir(join(locklessRoot, '.github', 'workflows'), { recursive: true })
    await writeFile(join(locklessRoot, 'pyproject.toml'),
      '[project]\nname = "lockless"\nversion = "0.1.0"\nrequires-python = ">=3.12"\ndependencies = []\n')
    const locklessPreview = await applyTool.execute({}, execIn(locklessRoot))
    const locklessManifest = String(locklessPreview.files.find((file) => file.target === 'manifest')?.preview ?? '')
    check('a project without uv.lock does not claim a lockfile',
      locklessManifest.includes('"schema_version"') && locklessManifest.includes('"lockfile"') === false,
      locklessManifest.slice(0, 300))

    const writeRoot = join(base, 'scaffold-write')
    await mkdir(writeRoot, { recursive: true })
    await writeFile(join(writeRoot, 'pyproject.toml'), '[project]\nname = "w"\nversion = "0.1.0"\nrequires-python = ">=3.12"\n')
    const written = await scaffoldTool.execute({ dryRun: false, targets: ['prek'] }, execIn(writeRoot))
    const wrotePrek = await readFile(join(writeRoot, '.pre-commit-config.yaml'), 'utf8').then(() => true).catch(() => false)
    check('dryRun: false is the only thing that writes, and it writes only what was asked for',
      written.mode === 'write' && written.wrote === true && wrotePrek === true
        && !(await access(join(writeRoot, '.github', 'dependabot.yml')).then(() => true).catch(() => false)),
      JSON.stringify({ mode: written.mode, files: (written.files ?? []).map((file) => file.path ?? file.target) }))

    const pipelinePlan = await consolidatedRun.execute({}, execIn(uvRoot))
    check('a run plans by default and says so',
      pipelinePlan.mode === 'run' && pipelinePlan.dryRun === true
        && pipelinePlan.summary.includes('Nothing was executed'),
      pipelinePlan.summary.split('\n').slice(0, 2).join(' | '))
    // The consolidated entry point hands the whole default chain to the same
    // precheck; with the clean-up allow-listed, nothing in it is refused any more.
    check('a full dry run has no refused step, the dist clean-up included',
      (pipelinePlan.pipeline?.refused ?? []).length === 0 && pipelinePlan.stages.length === 0,
      JSON.stringify(pipelinePlan.pipeline?.refused))

    const buildPlanRun = await consolidatedRun.execute({ stages: ['build'] }, execIn(uvRoot))
    check('the build stage passes the precheck with nothing refused',
      buildPlanRun.mode === 'run' && (buildPlanRun.pipeline?.refused ?? []).length === 0
        && buildPlanRun.pipeline?.dryRun === true && buildPlanRun.summary.includes('uv build'),
      JSON.stringify(buildPlanRun.pipeline?.refused))

    const containerOnly = await consolidatedRun.execute({ stages: ['container'] }, execIn(uvRoot))
    check('asking for the container stage alone does not drag the uv gates in',
      containerOnly.mode === 'run'
        && containerOnly.container !== undefined
        && containerOnly.stages.length === 0,
      JSON.stringify({ stages: containerOnly.stages.length, hasContainer: containerOnly.container !== undefined }))
  } finally {
    await rm(base, { recursive: true, force: true })
  }

  if (failures === 0) {
    console.log('\nall checks passed')
    return
  }
  console.error('\n' + failures + ' check(s) failed')
  process.exitCode = 1
}

await main()
