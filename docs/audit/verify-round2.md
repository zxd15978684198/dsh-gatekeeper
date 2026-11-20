# gatekeeper × `@deepseek-ai/dsh-desktop-runtime@0.2.2-rc.1` — 独立复验（round 2）

复验者：verifier-r2（独立于修复者）。复验时间：2026-11-13 10:49–11:20（本地）。
原则：只读插件源码，唯一写入文件是本报告；不改插件、不改 profile、不改 audit 下其他文件。

---

## 结论

**完全适配。** 未发现会导致功能失效或用户可感知异常的残余不兼容：插件用到的 6 个宿主服务、2 个 loader 事件/注入点、4 个 client slot、1 个 client 服务、1 个 client 包格式，逐条与 0.2.2-rc.1 的 asar 源码对齐；4 类修复（F1–F4）在源码层与运行时层都有独立证据。

残余 8 项全部为 **P2 及以下**（文档/整洁度/健壮性），另有 1 项 **P1**（`py-run dryRun:false` 同步阻塞宿主事件循环）——它与本次版本迁移无关、是插件自身旧设计，但会在桌面宿主里表现为 UI 冻结，建议单独排期。

> ⚠️ 验证期间插件正在被修改（见下节指纹）。本报告的所有判定对应下表指纹；若文件再变，需按"复跑清单"重验。

### 复验指纹（判定所对应的文件状态）

| 文件 | 字节 | mtime | 备注 |
|---|---|---|---|
| `gatekeeper\package.json` | 2350 | 2026-11-13 11:05:36 | version **0.10.2**（round 1 记录为 0.10.1） |
| `gatekeeper\client\panel.js` | 147107 | 2026-11-13 11:10:38 | 验证中途从 139061 B 增长到 147107 B |
| `gatekeeper\test\client.mjs` | 43635 | 2026-11-13 11:07:16 | 用例数 77 → 90 |
| `gatekeeper\index.js` | 19785 | 2026-11-01 19:29:38 | 本轮未改 |
| `gatekeeper\lib\schema.js` | 7614 | 2026-11-13 10:43:11 | F2 |
| `gatekeeper\lib\pipeline\local.js` | 31927 | 2026-11-13 10:40:00 | F3 |
| `gatekeeper\cordis.patch.yml` | 998 | 2026-11-13 10:50:18 | |

**版本偏斜（需知晓，非缺陷）**：磁盘 `package.json` 已是 `0.10.2`，而 `GET /gatekeeper/status?peek=1` 仍报 `plugin.version = "0.10.1"` —— host 半边在进程启动时加载，未重载；client 半边是按磁盘实时服务的（见 §3.4 的 rev 实测）。要让 GUI 里的版本号变成 0.10.2，需要重载/重启 host。

---

## 1. 测试复跑（全部 exit 0，且在文件被修改**之后**又跑了一遍）

| 检查项 | 命令（cwd = `<checkout>`） | 结果 | 判定 |
|---|---|---|---|
| client 单测 | `node test/client.mjs` | `all checks passed (90)`；末行 `gatekeeper: this DSH has no slots service; the panel stays unmounted` | ✅ |
| smoke | `node test/smoke.mjs` | `all checks passed` | ✅ |
| 4 类修复 | `node ..\audit\verify-fixes.mjs` | `all checks passed`；含 `F1 every candidates() is async`、`F1 both slash sources are Promise-returning — 2`、`F2 the loader really hands over references, not values — object`、`F3 localPlan returns an array with only index keys — ownKeys=3 length=2`、`F3 a plan is lossless JSON`、`F4 the top-level engines.dsh is declared — >=0.2.2-rc.1`、`F4 the marketplace copy agrees — >=0.2.2-rc.1` | ✅ |
| 版本/契约审计 | `node ..\audit\version-audit.mjs`（`$env:DSH_WEB_URL="http://127.0.0.1:57801"`） | `0 项失败，0 项警告`；host `0.2.2-rc.1`、node 26.5.1；`engines.node >=22.19.0`、peer `schemastery ^3.18.1` vs 3.19.0；触点 25 条 | ✅ |

复跑时机说明：`client.mjs` / `smoke.mjs` / `verify-fixes.mjs` / `version-audit.mjs` 在 `panel.js`+`package.json` 被改后（11:10 之后）重跑，全部仍绿，说明修复没有回退。

---

## 2. 宿主触点静态对照（全部触点：25 处）

### 2.1 host 半边（`gatekeeper\index.js`、`gatekeeper\lib\sessions.js`）

| 触点 | 宿主现实（证据） | 判定 |
|---|---|---|
| `index.js:144` `ctx.get('skills')`（probe 用） | 0.2.2-rc.1 提供 `skills` 服务（cordis_inspect host/Service 目录含 `skills`；实时 `status?probe=1` 返回 `available:true,total:88`） | ✅ 且 `typeof ctx.get === 'function'` 防御 |
| `index.js:329` `ctx.get('skills')`（apply 期注册 16 技能） | 同上；实时 `skills.count = 16`，名称与 client 侧 16 个 mode 一一对应 | ✅ 失败逐条 `console.warn`，不连坐 |
| `index.js:301` `ctx.tools.register(factory())` | `@deepseek-ai/dsh-tools/lib/index.js` 的 `register()` 要求 `output {schema, render}` 且 `assertSupportedJsonSchema(output.schema)`；插件三工具均声明（`lib/tools/py-audit.js:346`、`py-run.js:168`、`py-scaffold.js:201`） | ✅ 运行时实测三个工具可调用并正常渲染（见 §4.1） |
| `index.js:354` `ctx.inject(['webServer'], …)` | host 提供 `webServer`；`register({kind:'exact', path, handler})` 返回 disposer；插件用 `inner.effect(() => disposer, …)`（`index.js:392`、`433`）配对释放 | ✅ 两条路由实测 200（见 §4.2） |
| `index.js:446` `ctx.on('loader/volatile-update', …)` | Inspector 的 Event 目录**没有**该名字，但 `@deepseek-ai/cordis-plugin-loader/lib/index.js` 的 `updateVolatile()` 确实 `fiber.ctx.emit(self, "loader/volatile-update", paths)`；cordis 的 `EventsService` 挂在 root，子 ctx 原型继承，`_resolve` 用 `filter.call(thisArg, hook.ctx)` 过滤 → 后代 ctx 能收到 | ✅（**Inspector 未列出 ≠ 不存在**，以 asar 为准） |
| `lib/sessions.js:32` `ctx.get('workingDirectory')` | `@deepseek-ai/dsh-working-directory/lib/index.js` 的 `get(session)` 返回字符串 | ✅ `typeof ctx?.get === 'function'` 防御 |
| `lib/sessions.js:38` `ctx.get('agents')` | `@deepseek-ai/dsh-agent/lib/index.js` 的 `list()` 返回 `[...store.values()].map(e => e.agent)` | ✅ 另有 `typeof agents.list !== 'function'` + try/catch |

依赖声明：`index.js:49 export const inject = ['tools']` —— 只硬依赖 `tools`，其余服务全走 `ctx.get`/`ctx.inject` 延迟 + 防御。**apply 期没有任何"直接读未就绪服务"的路径**：`tools` 由 `inject` 保证就绪；`skills` 若缺失只降级（技能不注册，工具照常）。

### 2.2 client 半边（`gatekeeper\client\panel.js`）

| 触点 | 宿主现实（证据） | 判定 |
|---|---|---|
| `panel.js:3259` `ctx.slots` 缺失检查 | 缺失时 `console.error` + `return`，只放弃 panel | ✅ 且与输入触发器分开 try（见 3292/3307） |
| `panel.js:3266` `ctx.slots.inject('main', …)` | `dsh-client-ui-layout/lib/client.js`：`"main": { kind: "keyed", scope: "root" }`，渲染 `renderSlot("main", {}, { entryKey: panelId ?? "conversation" })` | ✅ 用 `key` 注册（3269 `key: PANEL_ID`）才可能被选中 |
| `panel.js:3267` `ctx.slots.inject('sidebar.panellist', …)` | `dsh-client-ui-sidebar/lib/client.js`：`"sidebar.panellist": { kind: "list" }`；`syncPanels` 读 `options.id/order/label`，`label` 经 `resolveSlotLabel` 允许函数 | ✅ 用 `id` + `order:55` + `label: () => 'Gatekeeper'` |
| `panel.js:3294` `ctx.slots.inject('conversation.composer.dock', …)` | `dsh-client-ui-conversation/lib/client.js:22994`：`{ kind: "list", scope: "session" }` | ✅ 用 `id: MODE_ID` |
| `panel.js:3309` `ctx.slots.inject('conversation.input.dock', …)` | 同文件声明 `{ kind: "list", scope: "session" }` | ✅ 用 `id: MODE_STATUS_ID` |
| `panel.js:3346` `ctx.inject(['inputTriggers'], scope => …)` | `dsh-client-ui-input-trigger/lib/client.js:1544` `super(ctx, "inputTriggers")`（服务名确认）；`:1556 registerSource(src)` 重复 `(trigger,name)` 直接 throw，返回 disposer | ✅ invoke 形状与官方插件一致；用 `scope.effect` 绑定释放（3361），无 effect 时回退裸调用（3363） |
| `panel.js:3371` `ctx.get('inputTriggers')` 回退 | 同上；服务由其它 client 插件提供，可能未就绪 | ✅ 存在性 + `registerSource` 函数双重检查后再用；否则整段跳过 |
| `panel.js:3398` `exports.inject = ['slots']` | client 包 `inject` 必须 `string[]`（`dsh-client-modules/lib/index.js` 的 `parseDshClient`） | ✅ |

`panel.js` 的唯一外部依赖是 `require('react')`；`package.json` 的 `dsh.client.inject: []` 因此是正确的（不需要声明任何 `@deepseek-ai/*` 包）。

---

## 3. 客户端契约逐条证实

### 3.1 模块格式与包声明

| 检查项 | 证据 | 判定 |
|---|---|---|
| `window.__ModuleLoader__.load({id, factory})` | `dsh-client-modules/lib/index.js` 的 `bootInjections()` 注入 `window.__ModuleLoader__ = { mode:"queue", pendingQueue, load(reg){…}, create(){…} }` | ✅ |
| `exports["./client"]` 字符串形式 | `clientExportOf()` 显式接受 string，或 object 的 `default` string | ✅ `"./client": "./client/panel.js"` |
| `parseDshClient` | `dsh.client` 必须是对象且 `platform` 为 string；`inject`/`external` 必须 `string[]`；`immediately` 必须 boolean | ✅ `{platform:"web", immediately:true, inject:[]}` |
| 与官方模板同形 | 0.2.2-rc.1 自带模板 `dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/client.js` 用的就是 `ctx.slots.inject(name, () => ctx.slots.register({name,id,order}, Component))` | ✅ 结构一致 |

### 3.2 Slots 服务（`dsh-web-frontend/dist/assets/index-BgUyXZcc.js` 内的 `register`）

反编译得到的错误语义（逐字）：`slot "…" is not declared`、`keyed slot "…" requires options.key`、`list slot "…" requires options.id`、`chain slot "…" requires options.select`、重复注册报 `single slot "…" already has a registration at priority N`。插件四个 slot 的 `kind` 与所需选项全部匹配（keyed→key；两个 list→id；无 chain）→ 不会触发任何一条。

### 3.3 inputTriggers 的 source 契约（逐字引用）

```
1414: fetchCandidates(hit, roster) {
1420:   for (const source of roster) source.candidates(projection, { query, quoted, position, drilled, signal })
1426:     .then((items) => { … source-settled … }, (error) => { console.error(`[ui-input-trigger] source "${source.name}" candidates failed:`, error) … })
1389:   names = src.lexicon(projection)
1594:   sources: (trigger) => live.sources.filter(s => s.trigger === trigger).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
```

- `candidates` **必须返回 Promise**，F1 的 `async () => []` 是正确修法（原 `() => []` 会在 1426 抛 `[].then is not a function`，且整条 slash 菜单连坐）。
- `lexicon(projection)` 返回**不带 `/` 的名字数组**；`modeSkill()` 返回 `python-<id>`，无前导斜杠 ✅。
- `order` 参与排序 ✅（插件传 `order: 3`）。
- 16 个 mode 名与 host 已注册的 16 个技能名**逐一相等**（脚本比对：`MODES` 16 个 id ⇄ `skills[].name`），不存在"提示了个 token 但宿主加载不到"。

### 3.4 client bundle 真的被装配并按磁盘实时服务（HTTP 实测）

- `statSync` → `mtimeMs=1794539438579.518`、`ctimeMs`、`size=147107`；按 `framedHash("plugin-artifact",[mtime,ctime,size])`（sha1，取前 12 位）算得 `rev=47e2c376b6d8`。
- `GET /plugins/??gatekeeper/client.js&rev=47e2c376b6d8` → **200**，`content-type: text/javascript; charset=utf-8`，`cache-control: public, max-age=31536000, immutable`。
- 正文 = 磁盘 `panel.js` + `"\n;\n//# sourceMappingURL=??gatekeeper/client.js.map&rev=47e2c376b6d8\n"`（`startsWithDisk = true`）。
- `GET /plugins/??gatekeeper/client.js.map&rev=47e2c376b6d8` → **200**，是宿主合成的 sectioned identity map（指向磁盘源文件），devtools 可直接调试。
- 无 rev / 空 path 均 404（`/plugins`、`/plugins/`、`/plugins/gatekeeper/client.js`）——属正确行为，不是装配失败。

结论：link 安装 + 源码直出，**无需构建步骤**；`panel.js` 改动后 rev 自动变，无需重启。

### 3.5 输入写入 API（composer 芯片用）

```
dsh-client-ui-conversation/lib/client.js:15368  actions = {
15370:  captureInsertion: () => ({ …selection/span… }),
15374:  insertText: (text, span) => { … },
```
插件 `insertIntoDraft()`（`panel.js:2216-2222`）正好按 `insertText(text, span)` 调用，且逐项检查 `typeof`；`inputActions` 缺失时返回 false，UI 降级为中文提示 `已开启「…」（无法写入输入框）`（`panel.js:2753-2755`），**不抛错**。`inputActions` 由 host 的 `ctx.uiSession.provide({ props: ["inputActions"] })`（`client.js:22775-22789`）向 session 槽位下发，故 `panel.js:2649` 取 `props.inputActions` 是受支持路径。

---

## 4. 运行时

### 4.1 工具（host `Tool.listTools` + 实际调用）

| 检查项 | 命令/查询 | 结果 | 判定 |
|---|---|---|---|
| 注册的工具集合 | `cordis_inspect_query` host/Tool.listTools（442 KB 全文落盘 grep） | 只有 3 个 `py-*`：`py-audit`、`py-scaffold`、`py-run` | ✅ 与 `index.js:288-292` 的 `toolFactories` 一致 |
| 实际执行 | 会话内直接调用 `py-audit` / `py-run` / `py-scaffold`（path=`<workspace>`） | 三者均正常返回结构化输出，**无** `invalid output`、**无** lossless-JSON 报错 | ✅ 证明 `output.schema`/`output.render` 被宿主接受 |
| `py-audit` 输出 | 同上 | 完整审计：manager unknown（无锁文件/无 pyproject）、python 未声明、lint/test/ci 全 no、13 阶段顺序、`resolved values` 20 行、additional findings（2 error / 4 warn / 3 info） | ✅ 结构合理 |
| `py-run` 干跑 | 同上 | 打印 8 个默认阶段的完整计划 + `Nothing was executed.` | ✅ |
| `py-scaffold` 干跑 | 同上 | 9 个 target 全部 `create` + 后续动作清单，未写盘 | ✅ |

### 4.2 HTTP 路由（`http://127.0.0.1:57801`，插件路由免鉴权）

| 请求 | 状态码 | 关键结果 | 判定 |
|---|---|---|---|
| `GET /gatekeeper/status?peek=1` | 200 | 20 个顶层键；`plugin={name:'gatekeeper',version:'0.10.1',schema:true,degraded:false}`；`stages` 13 条（deploy `verified:false`）；`jobs` quality/container/release/deploy；`applyTargets` 9 项全 `present:false`；`resolve` 20 值 | ✅ |
| `GET /gatekeeper/status` | 200 | 比 peek 大 170 B（peek 不写 `lastRequest`） | ✅ 语义正确 |
| `GET /gatekeeper/status?peek=1&probe=1` | 200 | `skillProbe={available:true,total:88, python:[…17 项…], cwd:"E:\\dsh-plugin-creator"}`；`skills.count=16` | ✅ 证明 `ctx.skills.register` 运行时真实生效（宿主目录 17 个 `python-*` 中 `python-backend` 属另一插件，非本插件漏注册） |
| `GET /gatekeeper/preview?path=<workspace>&stages=lock,lint` | 200 | 键 `blocked,reason,stages,fileName,yaml,warnings` | ✅ |
| `GET /gatekeeper/preview?path=E:\dsd-nonexistent&stages=lock` | 200 | `blocked:false`、`stages:["lock"]`、warning「No uv.lock at this project…」 | ⚠️ 已知静默降级（按要求只记录，不改） |
| `GET /gatekeeper/preview?stages=lock`（缺 path） | **400** | — | ✅ 正确拒绝 |
| `GET /gatekeeper/preview?…&stages=bogus` | 200 | warning「Ignored unknown stage(s): bogus. Known: …」并回落默认 8 阶段 | ✅ 容错合理 |

---

## 5. 残余问题清单

严格分级：**P0** = 功能失效/崩溃；**P1** = 用户可感知的明显异常；**P2** = 文档、整洁度、健壮性。

### P0 —— 无

### P1

**P1-1　`py-run` 执行路径同步阻塞宿主事件循环（最长 300 s/阶段、900 s 预算），且无法取消**
- 证据：`lib/pipeline/exec.js:12 import { spawnSync } from 'node:child_process'`；`exec.js:199 runCommand()` 用 `spawnSync(argv[0], argv.slice(1), { cwd, timeout, encoding:'utf8', shell:false, maxBuffer })`；执行链 `lib/tools/py-run.js:189 execute()` → `py-pipeline-run.js:623 runCommand(step.argv, …)`（`runPlan` 是 `for` 循环串行）。`execute` 虽声明 `async`，函数体是同步阻塞，`await` 不会让出事件循环。
- 影响：桌面宿主里执行一次完整流水线（`uv sync`/`pytest`/`docker build`）期间，GUI 渲染与 `/gatekeeper/*` 路由一起冻结；用户无法中断。
- 性质：**非 0.2.2-rc.1 引入**，与本次迁移无关；plugin 自己的文档也承认「A timeout stops waiting for the command; it does not kill the processes that command started」（`py-run.js:149-154`）。
- 修法：`runCommand` 改为 `child_process.spawn` + Promise（`stdio:'pipe'` 收集、`child.on('exit')` 结算），超时用 `child.kill('SIGTERM')` 再 `SIGKILL` 兜底；把 `execute(args, exec)` 里可得的 abort signal（或自建 `AbortController`）串进 `runPlan`，`runPlan` 改 `for (const …) await`。改动局限在 `lib/pipeline/exec.js`（+ `exec.js:226 runPlan` 与 `py-pipeline-run.js:623` 的调用点），不触宿主契约。

### P2

1. **`py-audit` 的输出文案指向一个未注册的工具 `py-apply`** — `lib/tools/py-audit.js:276`：`'…用 py-scaffold 生成草稿，或 py-apply 按白名单写入（写前留 .bak，绝不盲覆盖）…'`。运行时只有 3 个 `py-*` 工具（§4.1 实测），用户按提示去调 `py-apply` 会找不到；`py-audit.js:34/305` 的注释与 summary 同样残留该名字；而 `test/client.mjs:560-563` 的 `LEGACY_TOOL_NAMES` 恰好把 `py-apply` 列为「必须不得出现的旧名」并在 `594-595` 断言 —— 同一个名字在 client 侧被当作禁止项、在 host 侧的输出里却被建议使用，属明显的不一致。修法：文案改为「用 py-scaffold（`dryRun:false`）按白名单写入」；顺带清理 34/305 两处注释。
2. **`py-audit` 的 "gate order" 段与同一份输出里的 resolved values 自相矛盾** — `lib/tools/py-audit.js:92 function gateOrderLines(stageIds)` 渲染的是**静态 IR**（`lib/pipeline/ir.js:256` 默认 argv 硬写 `['uv','build','--all-packages','--out-dir','dist']`），而 `py-audit.js:430-431` 调用它时没有接 `applyResolved`；同一份输出里 `resolved values` 却写 `build.mode=package (default)`，`py-run` 的 dry run 打印的又是 `uv build --out-dir dist`。三处对同一阶段给出两种 argv。修法：`gateOrderLines` 接受 resolved 并按 `ir.js:259-263` 的 `argvBy` 变体渲染（`applyResolved` 已存在，直接复用）。
3. **5 个退役工具模块仍随包发货且零引用** — `lib/tools/py-bootstrap.js`(13 633 B)、`py-ci-plan.js`(6 899 B)、`py-ci-run.js`(8 480 B)、`py-dependabot.js`(5 935 B)、`py-prek.js`(6 362 B)，合计 ≈ 41 KB；全库 import 扫描（按 basename）零命中，仅 `test/smoke.mjs:26-32` 直接 import 它们做旧功能回归。修法：移入 `test/fixtures/` 或删除并同步 `smoke.mjs` 的五段断言。（注：`py-pipeline-run`/`py-container-gate`/`py-pipeline-doctor`/`py-references` 虽未注册为工具，但被 `py-run`/`py-audit` 复用，**属正常分层，不是死代码**。）
4. **`client/panel.js:68` 的 `slashSourceMounted` 是只写不读的死状态** — 仅在 `3365` 与 `3387` 赋值，无任何读取点。修法：删除该变量与两处赋值，或真正用它做幂等判断。
5. **四个 slot 均不传 `locale`，标签硬编码中文** — 官方插件（`dsh-client-ui-goal`、`dsh-client-ui-jobs`、`dsh-client-ui-chat`）注册时都传 `locale: NS`；`gatekeeper/locale/en.json`、`zh.json` 只含 `meta.title`/`meta.description`（插件卡片元数据），不含任何 UI 文案，`panel.js` 也没有 `useLocale`/`t()`。宿主切到英文界面时，面板、芯片、状态条仍是中文。修法：抽一个 NS，四个 slot 传 `locale`，把 UI 文案移进 `locale/*.json`（属国际化工作量，不影响功能）。
6. **注释与实际不符**：`client/panel.js:3255` 写「the eight tools work without any of this」，实际只注册 3 个工具（§4.1）。修法：改成 "three tools"。
7. **`index.js:125` 的 `lastRequest` 是模块级单例** — 多挂载/热重载时共享，`peek=1` 诊断可能读到上一次挂载写入的请求。修法：挪进 `apply()` 作用域（`index.js:265` 的写入点与 `index.js:373` 同一闭包内即可）。
8. **两条路由不鉴权、无 CORS 头** — `index.js:99-106 sendJson()` 只设 `content-type` 与 `cache-control: no-store`。任何本机进程可读绝对路径、技能清单、项目体检结果（浏览器跨站读不到，因无 `Access-Control-Allow-Origin`）。若这是有意的设计（本地工具、无需鉴权），建议在 `README` 里明说，避免后续误判为遗漏。

**按指示只记录、不判为缺陷**：`/gatekeeper/preview` 对不存在的 `path` 返回 200 + `blocked:false`（§4.2 第 5 行）——已知静默降级。

---

## 6. 我没有验证到的部分（诚实清单）

1. **client 侧 occupant 的实时状态未确认。** `cordis_inspect_query`（client/Slots.listSubTree、client/Service.listService）连续 3 次均 `timed out after 10000ms`；改用 chrome-devtools 打开 `http://127.0.0.1:57801` 得到 **401 Unauthorized**（profile 里 `@iasiv5/dsh-skip-browser-auth` 已安装，`cordis.patch.yml` 的 `trusted-connection` / `trusted-connection-021` 均 `disabled:false`，index 仍 401），拿不到授权页面 → 无法实证 `main`/`sidebar.panellist`/`conversation.composer.dock`/`conversation.input.dock` 四个 occupant 的 `active` 字段为 true。替代证据：宿主 bundle 的 slot 声明 + 渲染代码（§2.2、§3.2）、90 条 client 单测、bundle 200 直出。
2. **GUI 端到端「点选 mode → token 进草稿 → 宿主渲染成 chip → 删 chip 关模式」未实测**（同一鉴权阻塞）。静态上契约齐备（§3.5），缺失时也有中文降级提示。
3. **`loader/volatile-update` 的真实触发未在运行时观察**：只做了 asar 源码确认 + `verify-fixes.mjs` 的 F2 单测（"an edited string is honoured"/"untouched values still fall back"）。没有在 GUI 里改设置看热更新是否即时生效。
4. **host 半边未重载到 0.10.2**：`status` 仍报 0.10.1（§0 版本偏斜）。重启/重载后版本字段是否更新、是否有启动期差异，未验证（重启属 Lead 决定，我不擅自操作）。
5. **`py-run dryRun:false` 的真实执行未跑**（会真的执行 `uv`/`pytest`/`docker`，且当前目录不是 Python 项目）→ P1-1 的卡顿影响是代码推断 + 插件文档自述，未测实际冻结时长。
6. **非 Windows 平台未验证**（`shell:false` + argv 拼接在 POSIX 上的行为、`spawnSync` 超时语义差异）。宿主是 Electron 桌面版，本轮结论仅对 Windows 有效。
7. **不是 git 仓库**（`<checkout>` 无 `.git`），无法用 diff 界定「本轮改了什么」，只能靠 mtime + 测试数变化（77→90）推断；验证期间文件仍在变，若后续再有改动，本报告结论需按 §1 复跑清单重验。
8. **多 session 隔离未实测**：`conversation.composer.dock` 是 `scope:"session"`，插件的 `rememberVisibleSession`/`readStoredMode` 逻辑仅由单测覆盖，未在两个 session 间切换验证状态不串。

---

## 附：复跑清单（若文件再变，按此顺序）

```powershell
cd <checkout>
$env:DSH_WEB_URL = "http://127.0.0.1:57801"
node test/client.mjs; node test/smoke.mjs
node ..\audit\verify-fixes.mjs; node ..\audit\version-audit.mjs
# 然后核对：status?peek=1&probe=1 的 plugin.version / schema / degraded / skills.count
# 以及 /plugins/??gatekeeper/client.js&rev=<按 mtimeMs,ctimeMs,size 重算的 rev> 是否 200 且正文等于磁盘
```
