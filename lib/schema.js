// The schema builder behind `Config`, resolved through one interop hop.
//
// `@deepseek-ai/schemastery` is an OPTIONAL peer dependency: a real DSH profile
// supplies it, but this module is also imported standalone by `test/smoke.mjs`.
// A hard import would turn a missing settings service into five missing tools, so
// index.js soft-imports it and everything here tolerates `null`.
//
// The export shape is the fragile part. `@deepseek-ai/schemastery` publishes the
// builder as its DEFAULT export: the namespace of `await import(...)` is
// `{ default: Schema }`, with no named `Schema`. Code that destructures `{ Schema }`
// gets `undefined` without any error, `Schema?.object({...})` then yields
// `undefined`, the plugin declares no `Config`, and the sidebar panel silently
// renders without its switches. That is a quiet failure two layers away from its
// cause, so the shape is pinned here, in one place.

/**
 * Pick the schema builder out of a module namespace.
 *
 * @param namespace - a module namespace (`await import(...)`), or anything else.
 * @returns the builder, or null when the namespace carries none.
 */
export function pickSchemaBuilder(namespace) {
  if (namespace === null || typeof namespace !== 'object') return null
  const candidates = [namespace.Schema, namespace.default?.Schema, namespace.default]
  for (const candidate of candidates) {
    // `object` is the entry point every Config needs; requiring it here makes a
    // wrong export shape look like a missing builder instead of a schema that
    // throws later, once the composition is already being built.
    if (candidate !== null && candidate !== undefined && typeof candidate.object === 'function') {
      return candidate
    }
  }
  return null
}

/**
 * Build this plugin's configuration schema, or `undefined` when there is no builder.
 *
 * EVERY field is `.volatile()`, and that is load-bearing rather than decorative:
 * DSH projects a plugin's config into a form only through `volatileForm()`, which
 * keeps a field only when its nearest ancestor is marked volatile. A schema
 * without one contributes no form at all, so the entry never reaches
 * `ctx.settings.describe()`, its namespace is never served to the browser, and the
 * sidebar panel waits forever for a scope that will never arrive.
 *
 * A volatile field must not sit inside another volatile one, which is why `tools`
 * is a plain object whose leaf switches are volatile.
 *
 * @param Schema - the builder from {@link pickSchemaBuilder}.
 * @returns the schema, or undefined.
 */
export function buildConfig(Schema) {
  if (Schema === null || Schema === undefined) return undefined
  try {
    return Schema.object({
      tools: Schema.object({
        audit: Schema.boolean().default(true)
          .description('注册 `py-audit`：只读体检（18 个 resolve 值、13 阶段矩阵、9 个生成目标缺失、git hook 状态）+ workflow 审计；也可以 `topic` 取回一份 skill 原文。').volatile(),
        scaffold: Schema.boolean().default(true)
          .description('注册 `py-scaffold`：生成 9 份 CI/CD 配置（pyproject、prek、dependabot、workflow、ci-script、manifest、validator、secret-scan、container-report）；默认只预览，`dryRun: false` 才写盘。').volatile(),
        run: Schema.boolean().default(true)
          .description('注册 `py-run`：在本机跑 IR 的 13 阶段质量闸门（默认 dry-run，只跑白名单命令），支持 `profile: full|commit` 与 `from`。').volatile(),
      }).description('要注册哪些工具；改动即时生效。'),
      defaultPythonVersion: Schema.string().default('3.13')
        .description('生成 pyproject / workflow 时默认使用的 Python 版本（如 `3.13`）。').volatile(),
      matrixPythonVersions: Schema.string().default('')
        .description('CI 矩阵里要测的 Python 版本，逗号分隔（如 `3.11,3.12,3.13`）；留空则跟随项目自己的 Python 版本。').volatile(),
      testPaths: Schema.string().default('src/tests')
        .description('pytest 的 `testpaths`，逗号分隔；项目布局不同就改这里（检测到别的测试目录时优先用检测结果）。').volatile(),
      includeSecurityGate: Schema.boolean().default(true)
        .description('security 阶段是否进入生成物：pyproject 的 security 依赖组、容器/CI 里的 secret 扫描接线。').volatile(),
      includeIntegrationGate: Schema.boolean().default(false)
        .description('integration 阶段是否进入 CI（`uv run pytest -m integration`）；项目没打 integration 标记时不要开。').volatile(),
    }).description('Gatekeeper 的功能开关与默认值。')
  } catch (error) {
    // A builder that is present but incompatible used to throw HERE, at module
    // scope during import, which took every tool down with it. Building the
    // schema must never be the thing that decides whether a tool exists.
    console.warn(
      'Gatekeeper: building the Config schema failed — the tools run on their ' +
      'defaults and the sidebar panel will not offer the switches',
      error,
    )
    return undefined
  }
}

/**
 * Resolve the configuration this plugin actually runs on.
 *
 * Precedence is schema defaults, then the settings row, then the environment —
 * the same order the platform's own plugins use, and resolved once per mount so a
 * volatile edit can re-resolve in place without remounting. Because the loader
 * validates the row, the schema default is always present, so the environment
 * only fills a key the row does not carry (a partial row, a test fixture).
 *
 * @param settings - the row the loader handed `apply`.
 * @param env - environment variables, for tests.
 * @returns the effective configuration, with `tools` always a complete set.
 */
export function resolveConfig(settings = {}, env = process.env) {
  const row = settings !== null && typeof settings === 'object' ? settings : {}
  // A `volatile` schema field does not arrive as a value but as a live reference
  // (`{ get(), [cosmokit.volatile.write] }`), so `typeof` on it is 'object' and
  // every picker below would treat an edited setting as absent, silently falling
  // back to the default. Unwrap before looking at the type.
  const unwrap = (value) =>
    value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
  const unwrappedTools = unwrap(row.tools)
  const tools = unwrappedTools !== null && typeof unwrappedTools === 'object' ? unwrappedTools : {}
  const pickBoolean = (value, fallback) => {
    const plain = unwrap(value)
    return typeof plain === 'boolean' ? plain : fallback
  }
  const pickString = (value, fallback) => {
    const plain = unwrap(value)
    return typeof plain === 'string' && plain.trim() !== '' ? plain.trim() : fallback
  }
  const options = {
    defaultPythonVersion: pickString(
      row.defaultPythonVersion,
      pickString(env.DSH_PYTHON_TOOLCHAIN_PYTHON, '3.13'),
    ),
    matrixPythonVersions: pickString(
      row.matrixPythonVersions,
      pickString(env.DSH_PYTHON_TOOLCHAIN_MATRIX, ''),
    ),
    testPaths: pickString(row.testPaths, 'src/tests'),
    includeSecurityGate: pickBoolean(row.includeSecurityGate, true),
    includeIntegrationGate: pickBoolean(
      row.includeIntegrationGate,
      pickString(env.DSH_PYTHON_TOOLCHAIN_INTEGRATION, '') === '1',
    ),
  }
  return {
    tools: {
      audit: pickBoolean(tools.audit, true),
      scaffold: pickBoolean(tools.scaffold, true),
      run: pickBoolean(tools.run, true),
    },
    ...options,
  }
}
