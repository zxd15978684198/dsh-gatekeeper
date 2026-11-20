# Gatekeeper × 宿主 0.2.2-rc.1 宿主契约审计

- 审计对象：`<checkout>`（v0.10.0，`package.json` name=gatekeeper）
- 宿主：Electron 桌面版 `@deepseek-ai/dsh-desktop-runtime` 0.2.2-rc.1，profile `<DSH_HOME>\profiles\desktop`
- 宿主代码：`<install>/resources/app.asar`（单文件）。下文 `dsh/...` 均为 asar 内相对路径；取证方式见 §5。
- 活宿主契约：`cordis_inspect_query`（platform=host，provider=Service/Event/Config）
- **只读审计**：未修改 `gatekeeper` 下任何文件，未重启、未装卸插件、未改 profile。

---

## 1. 结论（四档判定）

| 档位 | 是否存在 | 说明 |
|---|---|---|
| 完全无法加载 | **否** | `Config` 在活宿主中成功构建（`include:gatekeeper` status=schema），三个工具、两条路由、技能注册全部生效（活体 `GET /gatekeeper/status?peek=1` → 200）。 |
| **部分功能失效** | **是** | **`Config` 的 `.volatile()` 字段在当前宿主上解析为 Volatile 引用对象（`{get(), [write]}`）而不是取值**。gatekeeper 的 `resolveConfig()` 只认 `boolean`/`string`，于是**设置面板里的全部开关与默认值被静默忽略**，工具恒按内置默认注册，面板显示的也是默认值。详见 §3.8。 |
| 仅热更新失效 | **是（表象）** | `loader/volatile-update` 事件仍然 emit（未移除），但即便触发，`Object.assign(config, resolveConfig(settings))` 重算出的仍是默认值 —— 热更新"成功"却什么都不改。根因同上（volatile 未解包），不是事件问题。 |
| 无实际影响 | — | `ctx.tools.register` / `ctx.inject` / `skills.register` / `workingDirectory.get` / `agents.list` / `webServer.register` / `dsh.bundle.patch` / `dsh.client` 均仍兼容；`dsh.engines.dsh` 被静默忽略但无功能影响。 |

一句话：**能加载、工具能跑，但"配置"这条链路整体失效**（用户在设置里改什么都不生效，面板还显示默认值）。

---

## 2. 触点台账

> 「gatekeeper 用法」列为插件内文件:行；「当前宿主契约」列为 Inspect 输出或 asar 内源码位置:行。

| # | 触点（服务/事件/字段） | gatekeeper 用法 | 当前宿主契约 | 判定 | 影响 | 修复方向 |
|---|---|---|---|---|---|---|
| 1 | `ctx.tools.register(definition, options?)` | `index.js:301` `ctx.tools.register(factory())`（不传 options） | Inspect Service `tools`：`register(definition: ToolDefinition, options: ToolRegistrationOptions = {}): () => void` | **ok** | 无 | 无需改；可选：传 `options.when` 做按会话开关 |
| 2 | `ToolDefinition.output`（必填） | `lib/tools/py-audit.js:346-368` `output: {schema:{...}, render:(_a,v)=>[{type:'text',text:v.summary}]}`；15 个工具全部声明 | Inspect：`ToolDefinition` 必填 `output: ToolOutputDefinition = {schema: JsonSchemaNode; render(args,value): ContentBlock[]; presentationMeta?}` | **ok** | 无 | 无需改 |
| 3 | `ctx.inject(deps, callback)` + `inner.effect(disposer, label)` | `index.js:353-357`、`index.js:392-393`、`433-434` | `dsh/node_modules/@deepseek-ai/cordis/src/registry.ts:176` `inject(deps: Inject, callback: Plugin.Function<void>): Fiber & PromiseLike<Fiber>`；`:300` 实现；`fiber.ts:10` `Context extends Pick<Fiber,'effect'>` | **ok** | 无 | 无需改 |
| 4 | `ctx.get('skills')` + `skills.register(SkillRegistration)` | `index.js:329-331`、`lib/skills.js:125`；入参 `{name:'python-'+topic, description, whenToUse, content, source:'runtime', invocation:{modelInvocable:true,userInvocable:true}}` | `dsh/node_modules/@deepseek-ai/dsh-skill/lib/index.js:194-216`：`register(skill)` → `validateRuntimeSkill` → 补默认 `invocation`/`provider=RUNTIME_PROVIDER` → **`return this.layers.effect(this.ctx, …)`**（effect 绑在**调用方** ctx 上）；`whenToUse` 仍合法（`lib/index.js:442/459/486` 类型校验）；`source:'runtime'` 在 `SkillSource` 白名单内 | **ok** | 无（gatekeeper 丢弃 disposer 也无害：effect 归属自己的 ctx，卸载即回收） | 无需改 |
| 5 | `skills.list({cwd}?)` | `index.js:155` `await skills.list({cwd: root})` | `dsh-skill/lib/index.js:225-227` `async list(options = {})`；`SkillViewOptions = {cwd?, signal?, scope?}` | **ok** | 无 | 无需改 |
| 6 | `ctx.get('workingDirectory').get(session)` | `lib/sessions.js:45-47` `workingDirectory.get(session)`，回退 `session.header.cwd` | Inspect Service `workingDirectory`：`get(session: Session): string`（"Read the committed directory without filesystem I/O"）、`defaultDirectory`、`ensure(agent)`、`set(agent,path)`；`Session.header.cwd?: string` | **ok** | 无 | 无需改 |
| 7 | `ctx.get('agents').list()` + `agent.session.header.{cwd,updatedAt,createdAt}` | `lib/sessions.js:38-40` | `dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js:744-746` `list() { return [...this.store.values()].map(e => e.agent) }`；`:188` `this.session = session`（Agent 实例持有 session） | **ok** | 无 | 无需改 |
| 8 | `webServer.register({kind:'exact', path, handler})`，handler 用 Node `request.method/url/headers` + `response.writeHead/end` | `index.js:357-391`（status）、`399-432`（preview） | `dsh/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js:376-383` `register(route)`（kind 取 `exact`/`prefix`，重复 `(kind,path)` 抛错，返回 disposer）；`:470-472` 派发 `await responder.handler(req, res)`（**Node http 的 IncomingMessage/ServerResponse**，返回值被忽略）；`:599-614` 只有 `WebResourceRoute` 走 Fetch `Request/Response` | **ok** | 无（Inspect 把 `ServerResponse` 解析成 RPC 线协议类型属同名碰撞，以源码为准；gatekeeper 故意在 `:356` 检查 `typeof register === 'function'`） | 无需改 |
| 9 | 事件 `loader/volatile-update` | `index.js:445-453` `ctx.on('loader/volatile-update', () => { Object.assign(config, resolveConfig(settings)); syncTools() })` | **未移除**。声明：`dsh/node_modules/@deepseek-ai/cordis-plugin-loader/src/index.ts:30-34`（"Volatile config values were committed into the running fiber without a remount; dispatched to the owning fiber only."，签名 `(paths: readonly (readonly string[])[]): void`）；发射：`.../lib/index.js:554` `fiber.ctx.emit(self, "loader/volatile-update", paths)`；触发条件 `:514` `changes.length===1 && changes[0]==='config' && state===2 && equalExceptVolatile(legacy.config, this.options.config, this.fiber.runtime?.Config)`；载荷是**变更路径数组** | **changed（语义）** | 事件仍会触发且 gatekeeper 忽略参数、只重算配置，语法上兼容；但**重算结果仍是默认值**，见 #10 → 表现为"改了设置没反应" | 不是事件问题；`ctx.on` 不用改，改 `resolveConfig` 的解包（#10） |
| 10 | **Config / schemastery `.volatile()` 取值语义** | `lib/schema.js:55-74` 全字段 `.volatile()`；`lib/schema.js:99-119` `resolveConfig()` 用 `typeof value === 'boolean'/'string'` 取值；`index.js:297` `config.tools[key] === true` | **volatile 字段解析后是引用对象**：`dsh/node_modules/@deepseek-ai/schemastery/src/index.ts:516-531` `Schema.resolve` 命中 `schema.meta.volatile` 时 `return [createVolatile(value), adapted]`；`~standard.validate` = `Schema.resolve(value, this, {})[0]`（同文件 `:291-308`）→ 交给插件的就是包装对象；`createVolatile` 返回 `Object.freeze({get:()=>current, [write]:…})`（`dsh/node_modules/@deepseek-ai/cosmokit/lib/index.js:103-111`）；`cordis/lib/index.js:825-827` `internal/config` → `resolveConfig(fiber.runtime, config)`；`cordis/src/fiber.ts:256` `const config = this.resolveConfig(this.config)` → `:266` `runtime.callback(this.ctx, config)`。活宿主证据：`Config.listConfigs(entry="include:gatekeeper")` → status=`schema`，每个叶子带 `x-cordis.volatile: true` | **changed（语义已变）** | **用户在设置面板改的一切都不生效**：`tools.audit/scaffold/run` 恒为 `true`（`pickBoolean(对象, true)` 走 fallback），`defaultPythonVersion` 恒 `3.13`、`testPaths` 恒 `src/tests`、`matrixPythonVersions` 恒空、`includeSecurityGate` 恒 `true`、`includeIntegrationGate` 恒 `false`；`/gatekeeper/status` 里展示给面板的 `settings` 也是默认值。只有环境变量（`DSH_PYTHON_TOOLCHAIN_*`）还能改变行为 | `lib/schema.js` 的 `resolveConfig` 增加解包：`const val = v => (v && typeof v === 'object' && typeof v.get === 'function') ? v.get() : v`，`pickBoolean/pickString` 先 `val(...)`；`index.js:297` 同理 |
| 11 | manifest `dsh.engines.dsh` | `package.json`（`dsh.engines.dsh = ">=0.2.1-rc.2"`） | `dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:1098-1104` `unmetRequirements()` **只读顶层 `engines`**：`if (Object.hasOwn(engines,"dsh")) {…}`，无 `dsh.engines` 回退；否则只看 `peerDependencies` 里的 `@deepseek-ai/dsh*`（`:1130` `evaluatePluginCompatibility`） | **deprecated（被静默忽略）** | 无功能影响：既不会拦也不会警告，等于这行声明是装饰 | 若想被检查，改写成顶层 `"engines": {"dsh": ">=0.2.1-rc.2"}` 或加 `peerDependencies: {"@deepseek-ai/dsh": ">=0.2.1-rc.2"}` |
| 12 | manifest `dsh.bundle.patch` | `package.json` `dsh.bundle.patch = "./cordis.patch.yml"`（profile 的 `dsh.profile.bundles` 里也列了 `gatekeeper`） | `dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js:401`、`:589`、`:1038` `bundlePatchPaths(directory, manifest.dsh.bundle)`；`dsh-app-boot/lib/index.js:1348`；`dsh-web-app/lib/index.js:15` 注释 | **ok** | 无（活宿主确实按 bundle 载入了 `cordis.patch.yml`：Config 目录里出现 `include:gatekeeper`，name=`file:///…/node_modules/gatekeeper/index.js`） | 无需改 |
| 13 | manifest `dsh.client` | `package.json` `dsh.client = {platform:'web', immediately:true, inject:[]}` | `dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js:65-94` `parseDshClient`（`platform` 必填 string、`inject`/`external` 必须 string[]、`immediately` 若存在必须 boolean）；`:130-138` 说明扫描 Loader entries | **ok** | 无 | 无需改 |
| 14 | 插件级 `export const inject = ['tools']` | `index.js:49` | `cordis/src/registry.ts:19` `Inject` 支持数组；`:300` | **ok** | 无 | 无需改 |

（客户端半部 —— `ctx.slots.inject/register`、`inputTriggers.registerSource`、四个 slot 名 —— 不在本报告范围：本次 client Inspect 查询超时未返回；由 client-half 队友的 `audit\client-half.md` 覆盖。）

---

## 3. 关键证据细节

### 3.8 `.volatile()` 包装 —— 本次最严重的不兼容（changed）

证据链（每一跳都可复现）：

1. 活宿主确认该插件的 Config 已成功投影、且**所有叶子都是 volatile**：
   `cordis_inspect_query(platform=host, provider=Config, method=listConfigs, input={entry:"include:gatekeeper"})`
   → `status: "schema"`、`acceptsMissing: true`，`tools.audit` 等每个字段都带 `"x-cordis": {"volatile": true}`。
2. 解析时 volatile 字段被包成引用对象：
   `dsh/node_modules/@deepseek-ai/schemastery/src/index.ts:522-531`
   ```ts
   if (schema.meta?.volatile) {
     const inner = Schema(schema); inner.meta = { ...schema.meta, volatile: false }
     const [value, adapted] = Schema.resolve(data, inner, options, strict)
     return [createVolatile(value), adapted]        // ← 交给插件的是包装对象
   }
   ```
   而 `~standard.validate` 就是 `Schema.resolve(value, this, {})[0]`（同文件 `:291-308`）。
3. 包装对象的形状：`dsh/node_modules/@deepseek-ai/cosmokit/lib/index.js:103-111`
   `createVolatile` → `Object.freeze({ get: () => current, [write]: (v) => { current = v } })`。
4. 校验后的对象就是 `apply` 的第二个参数：
   `cordis/lib/index.js:825-827` `this.on("internal/config", (fiber, next) => resolveConfig(fiber.runtime, next()))`；
   `cordis/src/fiber.ts:256-266` `const config = this.resolveConfig(this.config)` … `runtime.callback(this.ctx, config)`。
5. gatekeeper 侧只认原始值：`lib/schema.js:102-103`
   ```js
   const pickBoolean = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
   const pickString  = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback)
   ```
   → 传入的是对象，全部落回 `fallback`（即硬编码默认值）。

补充：schema 里 `volatile()` 的用法本身是**正确**的（`lib/schema.js:39-47` 注释解释了「只有 volatile 字段才会进 `volatileForm()` 表单」——该机制在当前宿主仍成立，见 1.2 的 `x-cordis.volatile` 投影）。错的只是**取值**。

### 3.9 `loader/volatile-update` 为什么不是问题

- 声明与发射仍在（见台账 #9），但**只有当"仅 volatile 字段变化且其余深层相等"时**才不发重挂载、走 `_commitVolatile()`（`:514-516`）。
- `_commitVolatile()` 通过 `volatileEntries(fiber.effectiveConfig)` 找到引用对象，再用 `updateVolatile(ref, source)`（`cosmokit:150-152` → `target[write](source.get())`）**原地改写引用**，然后 `emit(self, "loader/volatile-update", paths)`。
- 也就是说：正确写法是**在调用时 `.get()`**，让引用对象始终指向最新值；gatekeeper 每次 `resolveConfig(settings)` 都从包装对象重新读，但因为不解包，永远拿默认值。
- `Event.listEvents` 里查不到它并不代表被移除：Inspect 的 Event 目录只枚举宿主自有 Events 接口（77 个），不含第三方包对 Context 的类型增补。**结论与 lead 的第 2 点一致。**

### 3.11 `dsh.engines.dsh`

`dsh-app-boot/lib/index.js:1098-1104`：
```js
function unmetRequirements(fields, runtimeVersion) {
  const engines = fields.engines
  if (engines && Object.hasOwn(engines, "dsh")) { const range = engines.dsh; … }
  // 没有 dsh.engines 分支
```
`npm` 语义里 `dsh.engines` 从来不是标准字段；宿主只认顶层 `engines.dsh`。gatekeeper 又没写 `@deepseek-ai/dsh` 的 peerDependency，所以兼容性预检对它恒通过。

---

## 4. 修复方向（按性价比）

1. **解包 volatile（必须，唯一会导致用户可见功能失效的项）**
   `lib/schema.js:99-119` 的 `resolveConfig`：在 `pickBoolean`/`pickString` 之前统一 `unwrap`：
   ```js
   const unwrap = (v) => (v !== null && typeof v === 'object' && typeof v.get === 'function') ? v.get() : v
   ```
   `index.js:297` 的 `config.tools[key] === true` 改读 `resolveConfig` 产出的普通对象即可（`resolveConfig` 已返回纯值）。
2. **声明真实引擎约束**：`package.json` 增加顶层 `"engines": { "dsh": ">=0.2.1-rc.2" }`（或 `peerDependencies["@deepseek-ai/dsh"]`）；`dsh.engines` 可以留着做文档，但宿主不看。
3. **可选加固**：`ctx.tools.register(def, { when })` 用 `options.when` 表达开关，比"注册/注销"更贴合当前契约（现在的 disposer 方式仍有效）。
4. 无需改动：tools 定义形状、`output.render`、`ctx.inject + inner.effect`、`skills.register`、`workingDirectory.get`、`agents.list`、`webServer` Node 风格 handler、`dsh.bundle.patch`、`dsh.client`。

---

## 5. 复现方式与已排除的误判

**读 app.asar**（文件被运行中进程锁定，必须带 `FileShare.ReadWrite`）：

```powershell
$fs = [System.IO.FileStream]::new('<install>/resources/app.asar','Open','Read','ReadWrite')
# 头：前 8 字节，[4..8]=uint32 headerSize；JSON 从首个 '{' 到末个 '}'；内容基址 = 8+headerSize（4 字节对齐）
# 文件绝对偏移 = base + entry.offset；路径按 JSON 的 files 树逐段下钻
```
本报告引用位置均以「相对 asar 路径:行」给出（行号为解出文件后的物理行）。

**已排除的误判：`Config === undefined`（不是问题）**

- 用普通 `node` 直接 `import('file:///<DSH_HOME>/profiles/desktop/node_modules/gatekeeper/index.js')`，
  会得到 `Config typeof= undefined`，并打出插件自己的告警
  `gatekeeper: no schema builder (@deepseek-ai/schemastery) …`。
  原因：`@deepseek-ai/schemastery` 只存在于 **profile** 的 `node_modules`，而 gatekeeper 是 `link:<checkout>`（junction），普通 node 会按 realpath 解析（`<checkout>` → 无 `node_modules`）→ `ERR_MODULE_NOT_FOUND`。
- **但活宿主不是这样**：Loader 以 `file:///<DSH_HOME>/profiles/desktop/node_modules/gatekeeper/index.js` 载入并按 junction 路径解析依赖，Config 正常构建（`Config.listConfigs` 里 `status="schema"` 且字段齐全，`description` 与 `lib/schema.js:74` 一致）。
- 教训/提醒：**"离线 import 判定依赖能否解析"会得出与宿主相反的结论**，配置类判断必须用 Inspect 的 Config 目录核对。

**未能证实 / 未覆盖**

- 客户端半部（`slots`/`inputTriggers` 契约与四个 slot 名是否仍存在）：`cordis_inspect_query(platform=client, …)` 两次超时（`Client inspect query … timed out after 10000ms`），交由 `audit\client-half.md`。
- 未实测"改设置后面板不刷新"的端到端行为（属于写操作/需要交互）；本报告结论基于源码链路 + 活宿主 Config 投影，未重启宿主验证。
- `py-run` 的失败（runtime-evidence 已定位到 `lib/pipeline/local.js:262-264`）是插件自身 JSON 序列化问题，与宿主契约无关，不在本报告范围。
