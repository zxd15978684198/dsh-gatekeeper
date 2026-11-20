// Quality gates and the GitHub Actions workflow that runs them.
//
// Since v0.6 the gate definitions live in `lib/pipeline/ir.js` and the YAML is
// produced by `lib/pipeline/github.js`. This module stays as the public face it
// has always been — `CI_GATES`, `ciPlan`, `renderWorkflow`, `workflowFileName` —
// so every existing caller and test keeps working while the seam underneath
// becomes `ir → renderer`.
//
// The gate ORDER comes from `3-ci-cd-and-automation` (cheap and fast first, so a
// typo costs 20 seconds rather than a full test run). The COMMANDS do not: that
// skill's examples are all Node, and `4-github-actions-templates` is a Node-18-era
// collection whose `docker/build-push-action@v5` is already behind. Copying either
// one would ship a workflow that runs `npm ci` in a Python repository, so the
// Python side is written here, and the Node original is kept only as the
// `replaces` field so the substitution is auditable rather than implied.

import { STAGE_CATALOG, STAGE_IDS, legacyStageIds, resolveStages } from './pipeline/ir.js'
import {
  parseVersions,
  renderWorkflow as renderGithubWorkflow,
  selectStages,
  workflowFileName,
} from './pipeline/github.js'

/**
 * One quality gate in the shape callers already consume.
 *
 * The plan lists every step a stage *can* run, including the opt-in ones, because a
 * reader deciding whether to publish needs to see the publish step. `optIn: true` on
 * a command is how the plan says "this one is not emitted unless you ask".
 */
export const CI_GATES = STAGE_IDS.map((id) => {
  const stage = STAGE_CATALOG[id]
  const materialized = resolveStages([id], ['publish', 'image'])[0]
  const gate = {
    id: stage.id,
    title: stage.title,
    replaces: stage.replaces,
    rationale: stage.why,
    commands: materialized.steps.map((step) => {
      const command = { label: step.label, run: step.run }
      if (step.optional !== undefined) command.optIn = true
      if (step.verified === false) command.unverified = true
      return command
    }),
  }
  if (stage.optional === true) gate.optional = true
  if (stage.if !== undefined) gate.trigger = stage.if
  return gate
})

/**
 * The gates this plugin will run, in order, with their commands.
 *
 * @param includeSecurity - whether to include the audit gate.
 * @param includeIntegration - whether to include the integration-test gate.
 * @returns a copy of the selected gates, so a caller cannot mutate {@link CI_GATES}.
 */
export function ciPlan(includeSecurity = true, includeIntegration = false) {
  const selected = legacyStageIds(includeSecurity, includeIntegration)
  return CI_GATES
    .filter((gate) => selected.includes(gate.id))
    .map((gate) => ({ ...gate, commands: gate.commands.map((command) => ({ ...command })) }))
}

/** `3.13` -> `py313`, the spelling `[tool.ruff] target-version` expects. */
export function ruffTargetVersion(pythonVersion) {
  const major = /^(\d+)/.exec(String(pythonVersion ?? ''))
  const minor = /^\d+\.(\d+)/.exec(String(pythonVersion ?? ''))
  if (major === null || minor === null) return 'py313'
  return 'py' + major[1] + minor[1]
}

export { parseVersions, workflowFileName, selectStages }

/**
 * Render a Python/uv GitHub Actions workflow.
 *
 * @param options - `{ pythonVersions, testPaths, includeSecurity, includeIntegration,
 *   stages, lockMode, projectName }`. Extra keys are ignored by the renderer.
 * @returns the workflow as YAML text.
 */
export function renderWorkflow(options = {}) {
  return renderGithubWorkflow(options)
}
