// The `py-audit` tool: one read-only call that answers "what is this project, and
// what is wrong with it?".
//
// This replaces four separate tools that each answered a slice of that question —
// `py-detect` (packaging facts), `py-pipeline-doctor` (workflow lint), `py-ci-plan`
// (gate order) and `py-references` (which upstream document says so). A model asking
// "how should this project's CI look?" had to call three of them and stitch the
// answers together; worse, it could skip one and never notice. One tool, one call,
// one report — and the reference lookup stays here because the audit's job is to
// point at the document behind each finding.
//
// Nothing in here writes to the project. `run: true` only executes the doctor's
// whitelisted read-only probes (`uv lock --check`, `ruff`, `pytest --collect-only`).
//
// v0.10: the 13-stage list, the job assignment and the commands are read from
// `pipeline/ir.js` rather than copied into this file. The previous version carried
// its own nine-gate array next to the IR's, which is exactly how the audit and the
// workflow it checked could disagree about what the pipeline is.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { TOPIC_IDS } from '../references.js'
import { DEFAULT_STAGE_IDS, OPTIONAL_STAGE_IDS, STAGE_IDS, stageMatrix } from '../pipeline/ir.js'
import { describeResolved, resolveProject } from '../resolve.js'
import { createPyDetectTool } from './py-detect.js'
import { createPyPipelineDoctorTool } from './py-pipeline-doctor.js'
import { createPyReferencesTool } from './py-references.js'

/** Every topic `py-references` understands, pinned here so the schema stays exact. */
const TOPIC_LIST = [...TOPIC_IDS]

/**
 * The 9 files `py-apply` knows how to generate. Kept here as ids only: this tool
 * reports which ones are missing, it never writes them, so importing the apply
 * module (which is the writer) would only create a cycle for a read-only check.
 */
const APPLY_TARGETS = [
  'pyproject',
  'prek',
  'dependabot',
  'workflow',
  'ci-script',
  'manifest',
  'validator',
  'secret-scan',
  'container-report',
]

/** A block separator that reads fine both in a terminal and in a tool card. */
function rule(title) {
  return '--- ' + title + ' ---'
}

/** `stat` returns a promise; `existsSync` is enough for the handful of probes below. */
function hasFile(root, relative) {
  if (typeof relative !== 'string' || relative === '') return false
  return existsSync(path.join(root, relative))
}

/** Read a workflow file for the structural checks that need its text. */
function readWorkflow(root, file) {
  try {
    return readFileSync(path.join(root, file), 'utf8')
  } catch {
    return ''
  }
}

/**
 * Slice one job out of a workflow by indentation.
 *
 * Line-based on purpose: a YAML dependency would be the only third-party import in
 * the plugin, and the doctor already parses the file properly. This only needs to
 * answer "does this job run X", so a column-2 key scan is honest about its limits.
 */
function jobSection(text, name) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => new RegExp('^  ' + name + ':\\s*$').test(line))
  if (start === -1) return ''
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[index])) {
      end = index
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

/** The default gate list, in the canonical order the IR declares. */
function gateOrderLines(stageIds) {
  const wanted = new Set(stageIds)
  const rows = stageMatrix().filter((row) => wanted.has(row.id))
  return rows.map((row, index) => {
    const mark = row.optional === true ? ' (可选)' : ''
    return [
      (index + 1) + '. ' + row.id + mark + ' — ' + row.title,
      '   job: ' + (row.job ?? 'quality') + '; needs: ' + ((row.needs ?? []).join(', ') || '—'),
      ...row.commands.map((command) => '   $ ' + command),
    ].join('\n')
  })
}

/** Paths the v0.10 gates read. `detect` reports booleans; this module names them. */
const GATE_ARTIFACT_PATHS = {
  ciScript: 'scripts/ci.py',
  secretHelper: 'scripts/secret_scan.py',
  validator: 'scripts/validate_version_manifest.py',
  manifest: 'release/agent_versions.json',
  containerReport: 'scripts/container_report.py',
  prek: '.pre-commit-config.yaml',
  dependabot: '.github/dependabot.yml',
}

/** Findings the detect facts can produce without parsing a workflow. */
function detectionFindings(detection, root) {
  const findings = []
  const add = (id, severity, title, message) => findings.push({ id, severity, title, message, file: null, line: null })

  const validator = detection?.validator ?? {}
  const secrets = detection?.secrets ?? {}
  const container = detection?.container ?? {}
  const hooks = detection?.gitHooks ?? {}

  // `detect` hands back presence booleans rather than paths, so each message names
  // the path the gate will actually try to run — a boolean alone tells nobody what
  // to create.
  if (validator.script !== true) {
    add(
      'manifest-validator-missing',
      'error',
      '版本清单校验器缺失',
      '`' + GATE_ARTIFACT_PATHS.validator + '` 不存在，manifest 阶段会直接失败。用 py-scaffold 生成再跑一遍。',
    )
  }
  if (validator.manifest !== true) {
    add(
      'manifest-missing',
      'warn',
      '版本清单文件缺失',
      '`' + GATE_ARTIFACT_PATHS.manifest + '` 不存在；manifest 校验器会报“清单不存在”。' +
        '生成它之前，先让各组件真实发布过版本，清单记的是已发布的版本号。',
    )
  }
  if (secrets.helper !== true) {
    add(
      'secret-helper-missing',
      'error',
      'secret 扫描脚本缺失',
      'security 阶段运行 `' + GATE_ARTIFACT_PATHS.secretHelper + '`，但项目里没有这个文件。' +
        '用 py-scaffold 生成 secret-scan 目标。',
    )
  }
  if (secrets.baseline !== true) {
    add(
      'secret-baseline-missing',
      'warn',
      '.secrets.baseline 不存在',
      '第一次运行 security 会停在“No such file or directory: .secrets.baseline”。按提示生成并审计：' +
        '`uv run --locked detect-secrets scan > .secrets.baseline`，然后 ' +
        '`uv run --locked detect-secrets audit .secrets.baseline`；之后只允许 scan --baseline，不要再覆盖。',
    )
  }
  if (hooks.installed !== true) {
    add(
      'git-hooks-missing',
      'warn',
      'commit hook 未安装',
      '`.pre-commit-config.yaml` 只定义钩子，安装才会让它们生效：`uv tool install prek`，然后 `prek install`。' +
        '没有安装时，commit profile 永远不会在提交时自动跑。',
    )
  } else if (hooks.pointsToPrek !== true) {
    add(
      'git-hooks-wrong',
      'warn',
      'commit hook 指向别的工具',
      '`.git/hooks/pre-commit` 指向的既有钩子不是 prek。先 `prek install` 接管，或把现有钩子内容合并进来。',
    )
  }
  if (container.reportScript !== true) {
    const limit = container.imageLimit
    add(
      'container-report-missing',
      'info',
      '容器体检脚本缺失',
      '`' + GATE_ARTIFACT_PATHS.containerReport + '` 不存在：container 阶段仍会构建和探活，' +
        '但会跳过镜像尺寸/层数报告。' +
        (typeof limit === 'number'
          ? '当前配置了镜像上限 ' + limit + ' MiB，缺失报告时会显式告警。'
          : '当前也没有配置镜像上限，跳过不会影响结论。'),
    )
  }
  return findings
}

/** Findings the generated workflow's shape can produce, without re-parsing YAML. */
function workflowFindings(detection, root) {
  const findings = []
  const add = (id, severity, title, message, file) =>
    findings.push({ id, severity, title, message, file: file ?? null, line: null })
  const workflows = Array.isArray(detection?.workflows) ? detection.workflows : []
  if (workflows.length === 0) return findings

  let sawReleaseJob = false
  let sawDeployJob = false
  for (const workflow of workflows) {
    const text = readWorkflow(root, workflow.file)
    if (text === '') continue
    if (!/uses:\s*astral-sh\/setup-uv@/.test(text)) {
      add('workflow-not-uv', 'info', 'workflow 没有用 setup-uv',
        '`' + workflow.file + '` 是旧式或别家的 CI：本插件的 13 阶段矩阵不会在其中生效。', workflow.file)
    }
    if (!/Install dependencies/.test(text)) {
      add('workflow-stale', 'info', 'workflow 缺 v0.10 的 Install dependencies 步骤',
        '`' + workflow.file + '` 里没有 `uv sync --locked --all-groups` 命名步骤，可能是旧版渲染；重新生成一次 workflow 目标。', workflow.file)
    } else if (!/secret_scan\.py/.test(text)) {
      add('workflow-security-missing', 'warn', 'workflow 没接 secret 扫描',
        '`' + workflow.file + '` 看不到 `scripts/secret_scan.py`：security 阶段在 CI 里会空跑。重新生成 workflow 目标。', workflow.file)
    }

    const release = jobSection(text, 'release')
    if (release !== '') {
      sawReleaseJob = true
      if (!/download-artifact/.test(release)) {
        add('release-no-download-artifact', 'error', 'release job 没有 download-artifact',
          '产物必须由 build 上传、release 下载；release 里重新 `uv build` 会产出与测试过的不同的 wheel。', workflow.file)
      }
      if (/\buv build\b/.test(release)) {
        add('release-rebuilds', 'error', 'release job 重新构建',
          'release 里出现了 `uv build`：改为 `actions/download-artifact@v4`（name: dist），发布已测试的产物。', workflow.file)
      }
    }
    const deploy = jobSection(text, 'deploy')
    if (deploy !== '') {
      sawDeployJob = true
      if (!/::error::/.test(deploy) && !/\bexit 1\b/.test(deploy)) {
        add('deploy-placeholder-missing', 'error', 'deploy 占位不是失败步',
          'deploy 阶段在未配置真实部署时必须显式失败；现在看不到 `::error::` 或 `exit 1`，会变成静默通过的假绿。', workflow.file)
      }
    }
  }
  // Presence is not proof: a project with a release stage but no release job will be
  // honestly told which half is missing instead of being handed a generic "no CI".
  if (sawReleaseJob !== true && workflows.length > 0) {
    add('release-job-missing', 'info', 'workflow 没有 release job',
      '当前 workflow 只覆盖质量门；等要发版本时再生成 release job（需要 tag 触发与 download-artifact）。')
  }
  if (sawDeployJob !== true && workflows.length > 0) {
    add('deploy-job-missing', 'info', 'workflow 没有 deploy job',
      'deploy 阶段需要真实的部署目标；没有配置前，工作流里保留会失败的占位 job 比删掉它更安全。')
  }
  return findings
}

/** Which of the 9 generated files are missing, keyed by the target that writes them. */
function applyTargetFindings(detection, root) {
  const present = {
    pyproject: detection?.hasPyproject === true,
    prek: hasFile(root, GATE_ARTIFACT_PATHS.prek),
    dependabot: hasFile(root, GATE_ARTIFACT_PATHS.dependabot),
    workflow: (detection?.workflows?.length ?? 0) > 0,
    'ci-script': hasFile(root, GATE_ARTIFACT_PATHS.ciScript),
    manifest: detection?.validator?.manifest === true,
    validator: detection?.validator?.script === true,
    'secret-scan': detection?.secrets?.helper === true,
    'container-report': detection?.container?.reportScript === true,
  }
  const missing = APPLY_TARGETS.filter((target) => present[target] !== true)
  if (missing.length === 0) return []
  return [{
    id: 'apply-targets-missing',
    severity: 'info',
    title: '缺失的生成目标（9 项中的 ' + missing.length + ' 项）',
    message:
      'missing: ' + missing.join(', ') + '。用 py-scaffold 生成草稿；要真正写盘必须显式传 dryRun:false' +
      '（只动这 9 个白名单文件，写前留 .bak，绝不盲覆盖）。这是提示，不是错误：有的文件（如 CI 脚本）可能故意由别处管理。',
    file: null,
    line: null,
  }]
}

/**
 * The tool definition. Built per registration, never shared across mounts.
 *
 * @param store - the status store `py-detect` records into, so the sidebar panel
 *                can follow the same detection without a second filesystem walk.
 * @param config - resolved plugin settings.
 */
export function createPyAuditTool({ config, store }) {
  const detectTool = createPyDetectTool({ store })
  const doctorTool = createPyPipelineDoctorTool({ config })
  const referencesTool = createPyReferencesTool()

  return {
    name: 'py-audit',
    description:
      'Audit a Python project in one read-only call. Returns which lockfile manages the ' +
      'dependencies (uv, or a foreign Poetry/PDM/Pipenv lockfile that uv must stay out of), ' +
      'the 18 values the 13-stage pipeline resolves to (interpreter, ruff rule set, type ' +
      'checker and paths, coverage floor, test paths, manifest/validator paths, secret baseline, ' +
      'container report and image limit), which of ruff/mypy-or-ty/pytest/pre-commit are ' +
      'configured, whether the commit hook is actually installed in .git/hooks, which GitHub ' +
      'Actions workflows exist and what the 13 static rules say about them, which generated ' +
      'files (of the 9 py-apply targets) are missing, and the canonical gate order with the ' +
      'job each stage belongs to. Pass `topic` instead to read one bundled skill document ' +
      'verbatim (the upstream reasoning behind a finding). Pass `run: true` to also execute ' +
      'the doctor\'s whitelisted probes — they do not modify your files, but they resolve the ' +
      'project\'s tool dependencies, so they can create a .venv. Use this first, before changing ' +
      'anything about a Python project.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Directory to audit. Defaults to the calling session\'s working directory, which ' +
            'is almost always the right answer; pass a subproject path for a monorepo.',
        },
        topic: {
          type: 'string',
          enum: TOPIC_LIST,
          description:
            'Return this skill document verbatim instead of auditing. Use it when you need the ' +
            'source a finding comes from, or when the project is already healthy and you want ' +
            'the upstream guidance for the next step.',
        },
        run: {
          type: 'boolean',
          description:
            'Also run the doctor\'s whitelisted probes (uv lock --check, ruff, ' +
            'pytest --collect-only) so a workflow that parses but is wrong becomes visible. ' +
            'Off by default; the audit is a filesystem read unless you ask for more. These ' +
            'probes never modify your files, but they do resolve the project\'s tool ' +
            'dependencies, so they can create a .venv.',
        },
        stages: {
          type: 'string',
          description:
            'Comma-separated stage ids to show the gate order for (' + STAGE_IDS.join(', ') +
            '). Defaults to the 8 default stages. Optional stages (' + OPTIONAL_STAGE_IDS.join(', ') +
            ') can be named too; the order is always canonical.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          mode: { type: 'string' },
          summary: { type: 'string' },
          root: { type: 'string' },
          packageManager: { type: 'string' },
          pythonVersion: { type: 'string' },
          blocked: { type: 'boolean' },
          findings: { type: 'array', items: { type: 'object', additionalProperties: true } },
          gates: { type: 'array', items: { type: 'string' } },
          optionalStages: { type: 'array', items: { type: 'string' } },
          stages: { type: 'array', items: { type: 'object', additionalProperties: true } },
          topic: { type: 'string' },
          source: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['mode', 'summary'],
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const requestedTopic = typeof args?.topic === 'string' ? args.topic.trim() : ''

      // A topic request is not an audit: return the document and nothing else, so a
      // model that asked "show me the ruff guidance" is not handed an unrelated report.
      if (requestedTopic !== '') {
        const reference = await referencesTool.execute({ topic: requestedTopic }, exec)
        return {
          mode: 'reference',
          topic: requestedTopic,
          source: String(reference?.source ?? ''),
          // The reference tool calls the document `body`; `content` is kept as the
          // name this tool's schema promises, so a caller reads one field either way.
          content: String(reference?.body ?? ''),
          bytes: Number(reference?.bytes ?? 0),
          summary: String(reference?.summary ?? ''),
        }
      }

      const path = typeof args?.path === 'string' ? args.path : undefined
      const detection = await detectTool.execute({ path }, exec)
      const doctor = await doctorTool.execute({ path, run: args?.run === true }, exec)
      const root = String(detection?.root ?? '')

      // Which stages the gate-order block describes. Unknown ids are dropped rather
      // than echoed: the audit must not present a stage the pipeline cannot run.
      const requestedStages = typeof args?.stages === 'string'
        ? args.stages.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean)
        : []
      const knownStages = requestedStages.filter((id) => STAGE_IDS.includes(id))
      const focus = knownStages.length > 0 ? knownStages : [...DEFAULT_STAGE_IDS]

      const blockers = Array.isArray(detection?.blockers) ? detection.blockers : []
      const doctorFindings = Array.isArray(doctor?.findings) ? doctor.findings : []
      const findings = [
        ...doctorFindings,
        ...(blockers.length > 0 ? [] : [
          ...detectionFindings(detection, root),
          ...workflowFindings(detection, root),
          ...applyTargetFindings(detection, root),
        ]),
      ]

      // The 18 resolved values are what the workflow, `scripts/ci.py` and py-run
      // actually use; showing them here is what makes a finding actionable ("src is
      // the type path" instead of "type check may be misconfigured"). A project
      // another tool owns has no uv values to resolve, so the block is skipped.
      let resolved = null
      let resolvedLines = []
      if (detection?.ok === true) {
        try {
          resolved = resolveProject({ rootDir: root, detection })
          resolvedLines = describeResolved(resolved)
        } catch {
          resolved = null
        }
      }

      const parts = [
        String(detection?.summary ?? 'py-audit: no detection result'),
        '',
        rule('gate order (from the IR)'),
        gateOrderLines(focus).join('\n'),
        '',
        'optional stages (never run unless named): ' + OPTIONAL_STAGE_IDS.join(', '),
        '',
        rule('workflow audit'),
        String(doctor?.summary ?? 'py-audit: the workflow audit returned nothing'),
      ]
      if (resolvedLines.length > 0) {
        parts.push('', rule('resolved values (what the pipeline will use)'))
        for (const line of resolvedLines) parts.push('- ' + line)
      }
      if (findings.length > 0) {
        parts.push('', rule('additional findings'))
        for (const finding of findings) {
          parts.push('- [' + String(finding.severity ?? 'info') + '] ' + String(finding.title ?? finding.id ?? '') +
            ': ' + String(finding.message ?? ''))
        }
      }
      // Naming the two shapes is the part a caller most often gets wrong: it builds
      // the fast local hook, calls it "the gate", and the audit never runs anywhere.
      // The plugin cannot enforce which gates a project wires up — it can refuse to
      // let that omission stay invisible. v0.10 pins the split to two real commands:
      // the manual full run and the commit hook's fast subset.
      parts.push(
        '',
        rule('which gates, when'),
        'Two entries, two promises. `uv run --locked python scripts/ci.py` is the manual ' +
          'full run: all 8 default stages in canonical order (the 9-step gate list of chapter 8). ' +
          '`.pre-commit-config.yaml` wires `scripts/ci.py --profile commit`, which is only ' +
          'lock + lint + manifest — offline and fast, none of the network or container stages. ' +
          'security (pip-audit over the network) and integration (a real database) belong to CI. ' +
          'A resume after a failure is `--from <stage>:[...]`. Whatever a gate leaves out, ' +
          'state it where the gate is defined: an "all" that silently drops the audit is how ' +
          'a project ends up with a gate that never audits.',
      )
      parts.push(
        '',
        rule('next'),
        blockers.length > 0
          ? 'This project is managed by another tool — do not add uv to it. Read the reason above, ' +
            'then use py-audit({ topic: "migration" }) if the project is moving to uv on purpose.'
          : 'Change nothing until the findings above are understood. Use py-scaffold for the ' +
            'configuration this project is missing, and py-run to see which gates already pass.',
      )

      return {
        mode: 'audit',
        summary: parts.join('\n'),
        root,
        packageManager: String(detection?.packageManager ?? ''),
        pythonVersion: String(detection?.pythonVersion ?? ''),
        blocked: blockers.length > 0,
        findings,
        gates: [...focus],
        optionalStages: [...OPTIONAL_STAGE_IDS],
        stages: stageMatrix().map((row) => ({
          id: row.id,
          title: row.title,
          job: row.job ?? 'quality',
          needs: row.needs ?? [],
          optional: row.optional === true,
          kind: row.kind ?? 'gate',
        })),
        resolved: resolved ?? null,
        resolvedLines,
        detection,
        doctor,
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: typeof args?.topic === 'string' && args.topic.trim() !== ''
        ? 'Read the ' + args.topic.trim() + ' guidance'
        : 'Audit this Python project',
    }),
  }
}
