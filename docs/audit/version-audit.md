# GateKeeper × DSH 0.2.2-rc.1 版本审计报告

- 审计对象：`gatekeeper@0.10.0`（`link:<checkout>`，本地链接安装）
- 宿主：`@deepseek-ai/dsh-desktop-runtime@0.2.2-rc.1`（Electron 桌面版，PID 6064，`http://127.0.0.1:58898`），Node 26.5.1
- 活动 profile：`<DSH_HOME>\profiles\desktop`
- 审计日期：2026-11-13
- 结论：**部分适配**。插件装得上、Host 半边全部可用、四个客户端 seat 全部存活；但有 **2 个 P0 级断裂**（斜杠菜单、设置面板）和 **1 个 P1 级断裂**（`py-run` 直接报错），正好覆盖了用户日常最容易踩到的三处。

---

## 1. 判定总表

| 面 | 判定 | 依据 |
|---|---|---|
| 安装与加载（manifest / bundle patch / 依赖树） | ✅ 正常 | profile `dependencies` 与 `bundles` 均有 gatekeeper；`Config.listConfigs(entry="include:gatekeeper")` 返回 `status=schema`、`acceptsMissing=true`、`limitations=[]` |
| Host tools 注册 | ✅ 正常 | 本会话工具列表里 `py-audit` / `py-run` / `py-scaffold` 可调用；`ctx.tools.register(definition, options)` 签名未变，`ToolDefinition.output` 在 0.2.2 仍是必填且插件已全部声明 |
| Host skills 注册 | ✅ 正常 | 17 个 `python-*` skill 已出现在技能目录（`register({whenToUse, source:'runtime'})` 合法，`effect` 绑调用方 ctx） |
| HTTP 路由 | ✅ 正常 | `GET /gatekeeper/status?peek=1` → 200，`plugin.schema=true`，`plugin.degraded=false`，响应 20.6 KB |
| 客户端 Seat 挂载 | ✅ 正常 | `main` / `sidebar.panellist` / `conversation.composer.dock` / `conversation.input.dock` 四个槽的 occupants 全部 `active=true` |
| **斜杠触发源** | ❌ **P0 断裂** | `candidates: () => []` 同步返回数组，宿主写死 `.then()` |
| **设置面板 / volatile 配置** | ❌ **P0 断裂** | `.volatile()` 字段是 `{ get() }` 引用对象，插件用 `typeof === 'boolean'` 判断 → 全部落回默认值 |
| **`py-run` 工具** | ❌ **P1 断裂** | 给数组挂了 `profile` / `from` 自有属性，被宿主 lossless JSON 校验拒收 |
| `loader/volatile-update` 事件 | ✅ 仍存在 | 未被移除，也不是根因；根因是上面那条 volatile 解包 |
| `engines.dsh` 兼容闸门 | ⚠️ 静默失效 | 写在了 `dsh.engines.dsh`，宿主只读顶层 `engines.dsh` |

**一句话**：这不是「插件老了跑不动」，而是 0.2.2 把三处隐性约定收紧了 —— 值是懒取的、候选是异步的、工具输出必须是纯 JSON。

---

## 2. 审计方法（可复跑）

不是一次性结论，而是四层流水线：

| 层 | 手段 | 回答什么 |
|---|---|---|
| L1 版本区间 | `audit/version-audit.mjs` 内建 semver-lite | `dsh.engines.dsh` / `engines.node` / `peerDependencies` 是否仍覆盖宿主 |
| L2 清单契约 | 同上，读 manifest + 落地文件 | `dsh.bundle.patch`、`exports["./client"]`、`locale/*.json`、`dsh.client.platform` 是否指得着 |
| L3 运行时探针 | 桩实例化 + 活体 HTTP | 路由是否 200、工具是否真能跑出结果 |
| L4 契约比对 | `cordis_inspect_query`（Service/Event/Config/Slots）+ asar 源码取证 | 插件用到的每个 `ctx.*` 在 0.2.2 是否仍同形同义 |

复跑：

```powershell
cd <workspace>
node audit\version-audit.mjs            # 人读
node audit\version-audit.mjs --json     # 机读
node audit\version-audit.mjs gatekeeper # 指定插件
```

当前输出（2 FAIL / 1 WARN）：

```
OK   engines.dsh = ">=0.2.1-rc.2" vs 宿主 0.2.2-rc.1 → 满足
OK   engines.node = ">=22.19.0" vs node 26.5.1 → 满足
OK   peer @deepseek-ai/schemastery@^3.18.1 vs 已装 3.19.0 → 满足
WARN engines.dsh 写在了 dsh.engines 里：宿主只读顶层 engines.dsh
FAIL client\panel.js: candidates 同步返回数组 → 敲触发键即 TypeError
FAIL lib\schema.js: 声明了 .volatile() 却从不解包 → 设置静默失效
OK   status 路由 200，degraded=false，schema=true
```

### 2.1 一条必须记住的方法论

**Inspector 目录没列出来 ≠ 服务不存在。** 本次审计里这条踩了两次：

- `client Service.listService` 只列了 8 个服务，`inputTriggers`、`conversation`、`remote` 都不在里面，查询直接报 `no catalogued Service named "inputTriggers"`；但 asar 里 `inputTriggers` 命中 53 次，`class InputTriggerService extends Service` 就在客户端包中，官方 `ui-commands` 还在 `static inject = ["inputTriggers", ...]`。
- `conversation.input.dock` 在 slot 树输出里看不到（输出被截断 32 KB），但 asar 里 `queueDockEntry` 明确注册它。

⇒ 判定一律以 **asar 源码**为准，Inspector 只用来快速定位。同理，`Event.listEvents` 只列「有监听者/已声明订阅面」的事件，`loader/volatile-update` 不在清单里，但 asar 里仍 `emit`（20 处命中）——**不能据此判定事件被移除**。

### 2.2 目录布局

`audit/` 顶层只放**能复跑、或本身是证据**的东西；一次性诊断全部收进 `tmp/`。

| 路径 | 是什么 | 复跑 |
|---|---|---|
| `audit/version-audit.md` | 本报告 | — |
| `audit/version-audit.mjs` | 四层审计器（版本区间 / 清单契约 / 运行时探针 / 触点清单）| `node audit/version-audit.mjs [pkg] [--json]` |
| `audit/verify-fixes.mjs` | 把每条修复的判据写成断言（lossless JSON、volatile 形态、engines 双写…）| `node audit/verify-fixes.mjs` |
| `audit/verify-async.mjs` | 执行器异步化的端到端探针（真跑 `uv sync` + ticker）| `node audit/verify-async.mjs` |
| `audit/probe-volatile.mjs` | 用真实 schemastery 复现 `.volatile()` 的返回形态 | `node audit/probe-volatile.mjs` |
| `audit/placement-sim.html` | 弹层定位的真机复现页（`?mode=plain\|scaled\|scroll`）| 浏览器打开 |
| `audit/fixtures/async-proj` | `verify-async.mjs` 用的迷你 uv 项目（无 `.venv`）| 由脚本自动用 |
| `audit/fixtures/scaffold-sandbox` | `py-scaffold` 降级路径的样本项目（空目录 / 非 Python / 乱码中文目录）| 手动 |
| `audit/*.md`（除本报告）| 分工审计的原始结论：`host-contract` / `client-half` / `runtime-evidence` / `verify-round2` | — |
| `audit/tmp/` | 一次性取证脚本与抓包（`diag-pyrun*`、`find-*`、`scan-sessions*`、`preview-*.json`…）。留着是因为报告引用了其中的结论，随时可整个删掉 | — |

---

## 3. 发现清单

### F1 · P0 · 斜杠菜单在键入 `/` 时抛 TypeError

**现象**：输入框敲 `/`，gatekeeper 的候选不出现（或只剩技能源那一行），控制台红字 `[].then is not a function`。这是用户最可能感知到的「不适配」。

**证据链**：

1. 宿主 `InputTriggerService.registerSource(src)` 原样存源，**不做任何 Promise 归一**：
   ```js
   registerSource(src) {
     const { live } = this;
     if (live.sources.some((s) => s.trigger === src.trigger && s.name === src.name)) throw ...
     live.sources.push(src);   // 原样压栈
   ```
2. 控制器 `fetchCandidates(hit, roster)` 对每个源**写死 `.then()`**，且整段没有 try/catch：
   ```js
   for (const source of roster) source.candidates(projection, {
     query: hit.query, quoted: hit.quoted, position: hit.position,
     drilled: this.drilled, signal: controller.signal
   }).then((items) => { ... }, (error) => { ... });
   ```
3. 插件侧两个注册点都同步返回数组 —— `gatekeeper\client\panel.js:3100` 与 `:3120`：
   ```js
   const source = {
     trigger: '/', name: 'gatekeeper', order: 3,
     candidates: () => [],                                              // ← 返回数组，不是 Promise
     lexicon: () => MODES.map((mode) => modeSkill(mode)),
   }
   ```
4. 官方源已是异步：`command` 源写 `candidates: (session, req) => this.candidates(session, req)`，`ui-skill` 源写 `async candidates`。

**为什么没被自己的测试挡住**：`test/client.mjs:451-452` 把旧的同步形状写死成了断言，改完插件反而「测试通过、线上崩」。

**最小修法**（改 `panel.js` 两处，各 1 个字符量级）：

```js
candidates: async () => [],
```

顺带建议：`source` 缺 `onPick`。当前 `candidates` 恒空所以打不到，但 `settle()` 会无条件调 `src.onPick(...)`，一旦候选非空就是第二个崩溃点。

---

### F2 · P0 · 设置面板的所有开关与默认值被静默忽略

**现象**：在插件设置里关掉 `py-run`、改 `defaultPythonVersion`、改 `testPaths`，界面显示已保存，实际行为**完全不变**（工具照旧全注册、版本照旧 3.13）。

**根因（已用真实 schemastery 复现）**：`.volatile()` 字段校验后拿到的是**引用对象**，不是值：

```js
// @deepseek-ai/schemastery 3.19.0，audit/probe-volatile.mjs 实测
const schema = Schema.object({ flag: Schema.boolean().default(true).volatile() })
schema({ flag: false })
// → { get: [Function], [Symbol(cosmokit.volatile.write)]: ... }
// 显式传 false 也一样；值在 .get() 后面，unwrap 后才是 false
```

而 `gatekeeper\lib\schema.js:102-103` 用的是原始类型判断：

```js
const pickBoolean = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
const pickString  = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback)
```

`typeof { get() }` 是 `'object'` → 每次判断都走 fallback → `tools.audit/scaffold/run` 恒为 `true`，`defaultPythonVersion` 恒为 `'3.13'`，`testPaths` 恒为 `'src/tests'`，两个 gate 开关恒为默认。

**连带后果**：`ctx.on('loader/volatile-update', ...)` 的热更新路径是通的（事件未移除、语义是「volatile 字段已提交，载荷是变更路径数组」），重算一遍仍然是默认值 —— 表现为「热更新成功但无效」，比直接报错更难查。

**最小修法**（`lib/schema.js`，加一个解包即可全盘生效）：

```js
const unwrap = (value) => (value !== null && typeof value === 'object' && typeof value.get === 'function'
  ? value.get()
  : value)

export function resolveConfig(settings = {}, env = process.env) {
  const row = settings !== null && typeof settings === 'object' ? settings : {}
  const tools = unwrap(row.tools) ?? {}
  const pickBoolean = (value, fallback) => (typeof (value = unwrap(value)) === 'boolean' ? value : fallback)
  const pickString  = (value, fallback) => (typeof (value = unwrap(value)) === 'string' && value.trim() !== '' ? value.trim() : fallback)
  ...
```

> 注意：`tools` 本身是普通对象（只有叶子字段带 `.volatile()`），但 `defaultPythonVersion` 等叶子必须解包。改成上面的形式后，`test/smoke.mjs` 里用普通布尔/字符串调 `resolveConfig` 的用例仍然通过（`unwrap` 对原始类型是恒等）。

---

### F3 · P1 · `py-run` 抱着必坏：`value is not lossless JSON`

**现象**：任何 `py-run` 调用（含默认 `dryRun: true`）直接失败：

```
Error: tool "py-run" returned invalid output: value is not lossless JSON
```

跨 2 个项目目录、4 次复现，同一会话历史里还留着 3 条同错记录。`py-audit` / `py-scaffold` 全场景正常（含空目录降级、非 Python 项目、中文乱码路径）。

**根因**：`gatekeeper\lib\pipeline\local.js:262-265` 给数组挂了两个自有属性：

```js
const plan = stages.slice(fromIndex)
plan.profile = profile
plan.from = requestFrom === '' ? '' : stages[fromIndex].id
return plan
```

这棵结果被 `py-run.js:277` 的 `report.pipeline = pipeline` 带进了工具返回值，宿主侧 `walkJsonValue()` 对数组有硬规则：

```js
if (Array.isArray(current)) {
  if (!hasPlainArrayPrototype(current)) return void 0;
  const length = current.length;
  if (Reflect.ownKeys(current).length !== length + 1) return void 0;   // ← 多一个自有键就整棵作废
```

作废后经 `snapshotToolValue()` 抛 `ToolOutputError(toolName, ["value is not lossless JSON"])`。

**最小修法**（`lib/pipeline/local.js`）：别把元数据挂在数组上，改成结构体或让调用方自己带：

```js
// 方案 A（改动最小，需同步改 3 个读 plan.profile / plan.from 的地方）
return { stages: plan, profile, from: requestFrom === '' ? '' : stages[fromIndex].id }

// 方案 B（调用方零改动，但要多一次拷贝）
const plan = stages.slice(fromIndex)
Object.defineProperty(plan, 'profile', { value: profile, enumerable: false, configurable: true })
Object.defineProperty(plan, 'from', { value: ..., enumerable: false, configurable: true })
```

方案 B 之所以可行：`Reflect.ownKeys()` **包含**不可枚举属性，所以 B 其实也过不了这条规则 —— **只能走方案 A**。这是本次审计最反直觉的一条：`Object.keys` 看不见的属性，`Reflect.ownKeys` 看得见。

---

### F4 · P2 · `engines.dsh` 写错层级，兼容闸门静默失效

**事实**：`package.json` 里写的是

```json
"dsh": { "engines": { "dsh": ">=0.2.1-rc.2" }, ... }
```

但宿主安装前的兼容检查只读**顶层** `engines.dsh`：

```js
function unmetRequirements(fields, runtimeVersion) {
  const engines = Object.hasOwn(fields, "engines") ? objectOf$1(fields.engines, ...) : {};
  if (Object.hasOwn(engines, "dsh")) { ... return satisfies(...) ? {} : { "engines.dsh": range } }
  if (!Object.hasOwn(fields, "peerDependencies")) return {};
  // 顶层没有 engines.dsh 时，退化为检查 @deepseek-ai/dsh 和 @deepseek-ai/dsh-* 的 peer
```

`dsh.engines` 是市场元数据的写法。宿主这里因顶层无 `engines.dsh`，退化为扫 peerDependencies，而唯一 peer 是 `@deepseek-ai/schemastery`（不匹配 `@deepseek-ai/dsh` 前缀）→ **这道闸门对 gatekeeper 等于不存在**。

**影响**：不阻断当前使用，但意味着将来在旧版本 DSH 上装它会直接崩，而安装器不会拦。**修法**：顶层加一份，`dsh.engines` 保留给市场：

```json
"engines": { "node": ">=22.19.0", "dsh": ">=0.2.2-rc.1" }
```

顺带把下限提到 `>=0.2.2-rc.1`（F1/F2 修完之后才是真话）。

---

### F5 · P2 · 侧栏图标不消费渲染参数

`sidebar.panellist` 的渲染调用是 `renderSlot("sidebar.panellist", { size: wide ? 16 : 18, active }, { only: id })`，而 `gatekeeper\client\panel.js:1538` 的 `PythonToolchainIcon` 不接 props、硬编码 `18` → 折叠态不缩放、选中态无高亮反馈。属视觉退化，不影响功能。

**修法**：`({ size = 18, active = false }) => ...`，描边/填充跟 `active` 走。

---

### F6 · P3 · `slots.inject` 缺失会提前 return，连带跳过斜杠注册

```js
// panel.js:3041 / :3055
if (typeof ctx.slots.inject !== 'function') return    // ← 直接返回整个 apply 的剩余部分
```

当前不触发（四个槽都存在），但一旦某个宿主少了 `slots`，后面的 `ctx.inject(['inputTriggers'], ...)` 整段被跳过，表现为「菜单静默消失且没有日志」。建议改成 `console.warn` + 局部作用域，而不是 `return`。

---

### F7 · P3 · 文档漂移

`cordis.patch.yml` 注释里仍写 `py-detect / py-bootstrap / py-ci-plan / py-ci-render / py-references`，而活宿主实际注册的是 `py-audit / py-run / py-scaffold`。审计脚本与 README 会因此误导。

### F8 · P3 · 目录干净度 · 已在 0.11.0 清理

`gatekeeper/` 根目录曾残留 `.probe*.mjs`、`.check.mjs`、`.e2e.mjs` 等 9 个一次性脚本。它们在 `package.json.files` 白名单之外，`/plugins/` 路由也只服务声明过的客户端入口——所以不是暴露问题，只是目录不干净。

**已删除**（删除前逐一确认无引用：全仓库只在一份 `tmp/rename-checklist.md` 里被提到，且是「不随包发布」的说明）。`tmp/` 下的规划文档（164 KB）保留，其中并不存在早期报告所说的 2.6 GB dump——那条来自 checklist 的历史描述，实地核查无此文件。

### F9 · P1 · 技能包弹层在 0.2.2 上被推到屏幕外

0.2.2 的 composer 外层给 `position: fixed` 建立了新的包含块（`transform` / `contain` 一类），于是 `bottom = 视口高 − 胶囊顶部` 被按那个小容器解释，弹层整块飞出视口。用户侧症状：点胶囊后选项框跑到屏幕外。

**根因不是取值算错，而是坐标系未知**：未知包含块的原点 `(ax, ay)` 与缩放 `s` 无法从宿主内部约定推出，因此不能靠「再算一次」修好，只能测量。

而且**方向也不能猜**：`bottom` 锚定的是包含块的下边缘，所以把 `bottom` 调大是让盒子**向上**走——与 `top` 相反。早先按「宽度推出的缩放比」直接除，等于把符号也一起假设了，实测在 0.82 缩放的祖先下 `rateY = -0.82`（负号），假设成 `+0.82` 时一次校正就会把盒子推远一倍、三轮内彻底飞出视口。

**最终修法：探针测量 + 解方程。** `placementSolve(now, probed, step, target, viewport, panelWidth)` 先把盒子按 `step=8` 个单位各推一次（`left += 8`、`bottom += 8`），读回实际矩形，得到每个轴的真实兑换率 `rateX / rateY`，再解 `dx = (wantedLeft − now.left) / rateX`、`dy = (wantedBottom − now.bottom) / rateY`。这样**缩放、方向、原点三个未知量全部实测**，代码里不再有任何关于宿主布局的假设；探针的样式改动在同一次同步块内还原，不会闪一下。最多迭代 3 轮，`resize` / `scroll` 时归零重来。

浏览器实测（`audit/placement-sim.html`，真实 Chromium，用 `?mode=` 切换三种宿主形态）：

| mode | 宿主形态 | 面板收敛轮数 | 卡片收敛轮数 | 面板在胶囊正上方 | 卡片不遮挡面板 | 所悬停行落在卡片内 |
|---|---|---|---|---|---|---|
| `plain` | 无 transform（对照组） | 0（初值即准） | 0 | ✓ | ✓ | ✓ |
| `scaled` | `transform: scale(0.82) translate(...)` + `contain: layout` | 1（实测 `rateY=-0.82`） | 1 | ✓ | ✓ | ✓ |
| `scroll` | 胶囊在一个滚动容器里（`scrollTop=140`） | 0 | 0 | ✓ | ✓ | ✓ |
| `scaled`+窄窗 | 同上，视口 702px 宽 | 1 | 0 | ✓ | ✓ | ✓（卡片收缩到 214px 让位） |

三种形态全部落在「面板底边 = 胶囊顶边 − 6px、横向与胶囊对齐、卡片贴面板侧面且覆盖所悬停行」的状态，说明修法与宿主内部布局无关。

**窄窗口（本轮补上）**：窗口窄时两侧都放不下 300px 的卡片。早先的做法是让卡片压在面板上——那会遮住指针正在移动的那几行，比一张窄卡片更糟。现在 `detailOffset` 按可用侧宽**收缩卡片**（下限 `MIN_CARD_WIDTH = 200`；低于它就保持全宽并夹进视口，因为再窄已经不可读）。关键在于「选边 / 定宽 / 夹取」只有这一处：落位后的补差也回调同一个函数，并直接用它的 `viewLeft / viewTop`，所以收缩后的卡片会被校正到「收缩后该在的位置」，不会两处各算一套。实测 702px 视口：卡片 214px 宽、左边界 8px、右边界 222px，面板从 279px 起，两者不重叠且卡片仍覆盖所悬停行。

### F10 · P1 · 悬浮详情卡与主框不能共用一个位移量

主框按 `bottom` 锚定、详情卡按 `top` 锚定。在同一个未知包含块里，这两个锚点的映射**不是同一个位移量**：`top: cardTop − shift.dy` 会整体偏掉一个容器原点距离。所以把主框的校正值直接套到卡片上，会让卡片飞到屏幕外——这正是 F9 修好之后立刻暴露的第二处错位。

修法：让两者脱离各自的锚定方式，改成**同一个定位层内的相对定位**。新增唯一的 `position: fixed` 层 `M_LAYER`（`zIndex:70`、`width:316px`），面板变层内 `position:relative`（`zIndex:1`），详情卡变层内 `position:absolute`（`zIndex:2`），纵向偏移由「行矩形 − 层矩形」现算；卡片自身再做一轮实测补差（上限 3 轮）。这样只依赖相对关系，不再需要知道包含块原点。

> 教训：**当一个元素的包含块未知时，唯一的可靠修法是「先摆、再量、后校正」**；任何基于「视口坐标 → 样式单位」的一步推算都会在 `transform` / `contain` 下失效。同时，`bottom` 锚定与 `top` 锚定不可混用同一校正向量。

---

## 4. 仍然兼容的触点（回归基线，别乱改）

| 触点 | 0.2.2-rc.1 状态 |
|---|---|
| `ctx.tools.register(definition, options)` | 签名未变；`ToolDefinition.output` 仍要求声明 |
| `ctx.skills.register({ whenToUse, source:'runtime' })` | 合法；`effect` 绑调用方 ctx，卸载即回收 |
| `ctx.inject(['webServer'], (inner) => ...)` + `inner.effect` | 正常，路由的 Node 风格 `(req, res)` handler 仍被接受 |
| `ctx.get('workingDirectory')` / `ctx.get('agents')` | 正常；`agents.list()` + `agent.session.header.cwd` 仍可读 |
| `ctx.on('loader/volatile-update', ...)` | **事件仍在**，载荷是变更路径数组；语法兼容，语义是「已提交后通知」 |
| `dsh.bundle.patch` / 相对 `name: './index.js'` | 正常，相对路径锚定到 patch 文件所在目录 |
| `dsh.client = { platform:'web', immediately:true, inject:[] }` | 正常（与 `dsh-mermaid` 同形）；`inject: []` 未造成加载时序问题 |
| 四个 slot 名 `main` / `sidebar.panellist` / `conversation.composer.dock` / `conversation.input.dock` | 全部存在且 occupants active |
| `inputActions.captureInsertion` / `insertText` | 用法正确 |
| `require('react')` 走 `__ModuleLoader__` seed | 可解析 |

---

## 5. 修复顺序建议

| 顺序 | 文件 | 改动量 | 解锁什么 |
|---|---|---|---|
| 1 | `client/panel.js`（2 处） | `() => []` → `async () => []` | 斜杠菜单恢复 |
| 2 | `lib/schema.js` | 加 `unwrap`，3 处调用改 | 设置面板真正生效 |
| 3 | `lib/pipeline/local.js` | 返回结构体，改 3 处读取点 | `py-run` 恢复 |
| 4 | `package.json` | 顶层 `engines.dsh` | 安装期兼容闸门生效 |
| 5 | `test/client.mjs` | 断言改成 Promise 形状 | 防回归（否则第 1 条修完测试反而红） |
| 6 | 图标 props / `return` → `warn` / 注释 / 临时文件 | 各自独立 | 体验与可维护性 |

改完跑三个口子：`node test/smoke.mjs`、`node audit/version-audit.mjs`（应清零 FAIL）、重启后 `/` 与设置面板手测。

---

## 6. 证据索引

| 文件 | 内容 |
|---|---|
| `audit/version-audit.mjs` | 可复跑的审计器（L1 版本 / L2 清单 / L3 探针 / L4 触点 + 3 条语义漂移规则） |
| `audit/probe-volatile.mjs` | 用真实 schemastery 3.19.0 复现 `.volatile()` 返回 `{ get() }` |
| `audit/host-contract.md` | Host 侧触点逐条比对（Service / Event / Config / manifest） |
| `audit/client-half.md` | 客户端半边比对（seat / inputTriggers / registration 形状） |
| `audit/runtime-evidence.md` | 运行时证据（`py-run` 4 次复现、slot 活体、status 探针） |
| `audit/tmp/status-base.json` | `/gatekeeper/status?peek=1` 的完整快照 |
| `audit/placement-sim.html` | 弹层定位真机复现（缩放祖先 + 探针校正，跑完把结果挂到 `window.__result`） |

asar 内的关键位置（`<install>/resources/app.asar`，按字节偏移）：

| offset | 内容 |
|---|---|
| ≈22321971 | `walkJsonValue()` — 数组必须 `ownKeys.length === length + 1` |
| ≈126185359 | `snapshotToolValue()` — 抛 `value is not lossless JSON` |
| ≈29244937 | `InputTriggerService` — `registerSource` 原样存源 |
| ≈29240944 | `fetchCandidates()` — 写死 `.then()` |
| ≈24591821 | `unmetRequirements()` — 只读顶层 `engines.dsh` |
| ≈10338295 | `'loader/volatile-update'` 类型声明（`@mode emit`） |

---

## 7. 修复落地记录（0.10.0 → 0.10.3）

| # | 文件 | 改动 | 状态 |
|---|---|---|---|
| F1 | `client/panel.js` | 两处 `candidates: () => []` → `async () => []`（宿主 `fetchCandidates` 写死 `.then()`） | 已修 · `test/client.mjs` 覆盖 |
| F2 | `lib/schema.js` | `resolveConfig` 增加 `unwrap()`，解包 `{ get, Symbol(cosmokit.volatile.write) }` 形态 | 已修 · `audit/verify-fixes.mjs` 覆盖 |
| F3 | `lib/pipeline/local.js` | 计划数组不再挂自有键：新增 `WeakMap` + `export function planSelection(plan)`，`describePlan` / `renderCiScript` / `localPlan` 全部改读它 | 已修 · `verify-fixes.mjs` 断言 `ownKeys === length + 1` |
| F4 | `package.json` | 顶层 `engines` 加 `"dsh": ">=0.2.2-rc.1"`；`dsh.engines.dsh` 同步；版本 0.10.0 → 0.10.3 | 已修 · 审计器规则 1 |
| F5 | `client/panel.js` | `PythonToolchainIcon(props)` 消费 `size` / `active` | 已修 |
| F6 | `client/panel.js` | `slots.inject` 缺失不再提前 `return`，改为包裹块（否则跳过斜杠源注册） | 已修 |
| F7 | `cordis.patch.yml` | 注释里的旧工具名改为 `py-audit / py-run / py-scaffold` | 已修 |
| F9 | `client/panel.js` | 弹层落位后**探针实测**校正（`placementSolve`：推 8 单位读回真实兑换率，上限 3 轮，`resize`/`scroll` 归零）；窄窗按可用侧宽收缩卡片（`MIN_CARD_WIDTH = 200`） | 已修 · 9 条断言 + `audit/placement-sim.html` 四种宿主形态 |
| F10 | `client/panel.js` | 面板与详情卡共用同一 `position: fixed` 定位层（`M_LAYER`），卡片改层内 `absolute` + 自身实测补差；补差与估算共用 `detailOffset` 一处决策 | 已修 · 6 条断言 |
| P2 | `lib/tools/py-audit.js:276` | 提示不再指向未注册的 `py-apply`，改为「`py-scaffold` + 显式 `dryRun:false`」 | 已修 |
| P2 | `client/panel.js` | 删除从未被读取的 `slashSourceMounted`；注释「eight tools」→「three tools」 | 已修 |
| F8 | `gatekeeper/` 根目录 | 一次性脚本清理 | **未做**（不影响兼容，等确认后再删） |
| P1-1 | `lib/exec.js:199` | `py-run` 走 `spawnSync` 同步阻塞宿主事件循环 | **未做**（非本版本引入，改动面大，建议单独一轮） |

复验命令（都在 `<workspace>`）：

```
node gatekeeper\test\client.mjs      # 94 项
node gatekeeper\test\smoke.mjs
node audit\verify-fixes.mjs
node audit\version-audit.mjs         # 0 失败 0 警告（需 DSH_WEB_URL 指向活宿主）
```

### 7.1 运维事故：插件曾被静默挤出 bundles

修完代码后 `/gatekeeper/status` 返回 404、活宿主工具列表里没有任何 `py-*`。排查结论：`<DSH_HOME>\profiles\desktop\package.json` 的 `dsh.profile.bundles` 里 `"gatekeeper"` 被别的插件安装过程重写掉了（`dependencies` 里的 `link:` 仍在）。

处置：备份 `package.json.bak-gatekeeper-*` 后把 `"gatekeeper"` 追加回 `bundles` 末尾（共 27 条），重启宿主生效。

> 教训：**`link:` 安装只是把包链进来，进不进 loader 由 `bundles` 决定**。任何一次「装/升别的插件」都可能重写这个数组，插件「忽然不见了」时先查 `bundles`，不要先怀疑代码。审计器 L3 的 `/gatekeeper/status` 探针正好能第一时间抓到这类掉线。

---

## 8. 收尾验证（活宿主，0.10.3）

以下都是在**正在运行的宿主**上取的证据，不是磁盘推断：

| 检查 | 命令 / 请求 | 结果 |
|---|---|---|
| Host 是否加载了新代码 | `GET /gatekeeper/status?peek=1` | 200，`plugin.version = 0.10.2`、`schema = true`、`degraded = false`。manifest 在插件**加载时**读取，所以磁盘上的 0.10.3 要等下次重启才在状态里体现；这不影响代码生效——`lib/*.js` 同样是加载时载入，下一行就是证明 |
| F3 在活宿主是否真的生效 | 以 `dryRun: true` 实调 `py-run`（`audit/tmp-pyproj`） | 正常返回 8 阶段计划文本，**不再报** `value is not lossless JSON` |
| 客户端是否拿到新包 | `GET /plugins/??gatekeeper/client.js&rev=<磁盘 mtime/ctime/size 推出的 rev>` | 200，正文含 `placementSolve` / `const step = 8` / `layerRef` → 前端改动**只需刷新页面**，不必重启 |
| 审计器 | `node audit/version-audit.mjs` | 0 失败、0 警告 |
| 单测 | `node gatekeeper/test/client.mjs` / `smoke.mjs` / `node audit/verify-fixes.mjs` | 94 项 / 全绿 / 全绿 |
| 定位算法（真机） | `audit/placement-sim.html`，真实 Chromium | `plain` / `scaled` / `scroll` / 窄窗 ×`scaled` 四种形态全部满足「面板在胶囊正上方、卡片贴侧面不遮挡、悬停行落在卡片内」 |

唯一无法自动化的验收项：**GUI 里肉眼看一次悬浮卡**。桌面版宿主没有开远程调试端口、Web UI 的 index 路由要鉴权，所以这一项只能由使用者刷新页面后目视确认。

## 9. 执行器异步化（0.10.3 → 0.11.0）

这是 P1-1 的落地：`py-run` 曾经用 `spawnSync` 起子进程，于是「跑一次质量闸门」= 「界面卡住同等时间」。它不属于版本不兼容（0.10.0 就如此），但它正是「感觉插件不对」的第二大来源——症状是点下去毫无反应，随后突然刷出一大段结果。

### 9.1 改了什么

| 文件 | 改动 |
|---|---|
| `lib/pipeline/exec.js` | 新增 `runCommandAsync(argv, options)` 与 `runPlanAsync(entries, options)`；`runCommand` / `runPlan` **原样保留**，同步语义未被破坏 |
| `lib/tools/py-pipeline-run.js` | 步骤循环由 `runCommand` 改为 `await runCommandAsync`，并把 `exec?.signal` 透传下去 |
| `lib/tools/py-container-gate.js` | 两处 docker 调用（`check` / `teardown`）改为 await |
| `lib/tools/py-pipeline-doctor.js` | `runPlan` 改为 `await runPlanAsync`（uv 版本探测与 `run: true` 的探针批次） |
| `test/exec-async.mjs` | 新增 9 条断言，其中一条同时跑同步与异步做对照 |
| `package.json` | version → `0.11.0`；新增 `test:async` / `test:all` 脚本 |

**返回结构一字未改**：`{ argv, ok, refused, reason, exitCode, stdout, stderr, seconds }` 与同步版逐字一致，所以读结果的那几百行代码一行都不用动。

三条语义是刻意对齐 `spawnSync` 的，不是新发明：

- **超时**：同样的 1 秒下限（`timeout: 0` 在两种执行器里都意味着「永不超时」，所以收紧限制不能变成关掉限制）；
- **非零退出是数据**：`ruff` 找到 4 个问题不是「工具崩了」，`ok: false` 而已，不抛异常；
- **输出上限**：仍是 4 MB/流，超出即中止并给出原因，而不是静默截断。

新增的只有两件，且都是加法：`signal`（取消时杀掉进程树并报 `已取消`，而不是把责任推给项目）与 SIGTERM→SIGKILL 的二级终止（忽略 SIGTERM 的进程不会把工具永久挂住）。

### 9.2 证据

| 检查 | 方法 | 结果 |
|---|---|---|
| 形状未变 | `node test/exec-async.mjs` | 8 个键齐全，快命令仍 `ok: true` |
| **不再阻塞事件循环** | 同上，子进程 `sleep 2`，20 ms ticker | **异步 35 次 tick / 2.2 s；同步 0 次** —— 对照在同一测试里，所以这不是「看起来没卡」 |
| 超时是判定不是异常 | `timeoutSeconds: 1` 对 2 s 命令 | `ok: false`、`reason: 超时 1s`，不抛 |
| 拒跑的命令不启动进程 | `['rm','-rf','/']` | `refused: true`、`exitCode: null` |
| 取消可控 | 300 ms 后 `abort()` | 进程被杀，`reason: 已取消` |
| 真实工具端到端 | `node audit/verify-async.mjs`（fixture `audit/fixtures/async-proj` 上真跑 `uv sync`） | 阶段 `pass`，1.1 s 内 **35 次 tick** |
| **活宿主不再卡** | 11.1 s 的 `py-run` 真跑期间，并发探测 `/gatekeeper/status` × 70 | p50 **80 ms**（空载基线 79 ms）、p90 103 ms、max 984 ms、**超过 1 s 的样本 0 个** |

最后一行是这次改动唯一的用户可见验收：如果宿主仍在用同步执行器，探针会出现一个 10 s 量级的样本；实际一个都没有，说明运行中的宿主已经在跑新代码。

### 9.3 没有改的地方

`runCommand`（同步）留在原地，因为它是这些测试的对照物，也因为它仍然是「调用方明确要求阻塞」时的唯一正确选择。把两者都改成异步才是真正的过度改动。
