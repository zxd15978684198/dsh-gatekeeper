# GateKeeper 客户端半边兼容性审计（client/panel.js）

- 审计对象：`<checkout>\client\panel.js`（3143 行，`exports.apply` 在 :3009-3135）
- 宿主：Electron 桌面版 `@deepseek-ai/dsh-desktop-runtime 0.2.2-rc.1`，GUI `http://127.0.0.1:58898`，profile `<DSH_HOME>\profiles\desktop`
- 只读审计：未修改插件任何文件；本文件是唯一写入物。
- 取证手段：① `cordis_inspect_list` / `cordis_inspect_query`（客户端侧全部超时，见 §6）；② 直接解析 `<install>/resources/app.asar`（213,202,918 B，JSON 头在 offset 16，内容基址 5,748,140）读宿主源码；③ 对活体 GUI 发只读 HTTP 探测。

## 一、结论

**判定：部分失效（partial）。** 客户端半边能加载、四个座位都能挂载，面板/侧栏按钮/输入框 chip/状态条都不会白屏；但**斜杠触发源（`/`）的 `candidates` 返回类型与当前客户端契约不符**，用户输入 `/` 时会在编辑器更新回调里抛 `TypeError`，斜杠菜单失效。这是唯一会让用户直接感到"不适配"的点。

最可能被用户描述为"不适配"的现象：**在输入框敲 `/` 时斜杠菜单不弹出（或只显示技能源的部分行），控制台出现 `source.candidates(...).then is not a function` 类报错**；面板本身打开是正常的。

## 二、客户端触点台账

| # | 触点 | panel.js 用法（文件:行） | 当前客户端契约（证据） | 判定 | 用户可见影响 | 修复方向 |
|---|---|---|---|---|---|---|
| 1 | `ctx.slots` 服务（`inject`/`register`/`entriesOfSlot`） | `client/panel.js:3018-3033`、`:3042`、`:3056` | `dsh-client-ui-sidebar/lib/client.js` 用同一套 API（`ctx.slots.inject("sidebar", …)`、`entriesOfSlot`、`subscribe`）；`dsh-cordis-client-runner/lib/client.js` 的 `CLIENT_SLOT_API` 目录 | ok | — | — |
| 2 | `main`（keyed，key=`gatekeeper`） | `:3020-3023` `{name:'main', key:'gatekeeper'}` | `dsh-client-ui-layout/lib/client.js`：`renderSlot("main", {}, { entryKey: panelId ?? "conversation" })`；契约 `keyDomain: "open: any string the owner dispatches"` | ok | 侧栏点 Gatekeeper → 中栏渲染面板 | — |
| 3 | `sidebar.panellist`（list） | `:3024-3027` `{id:'gatekeeper', order:55, label:()=>'Gatekeeper'}` | `dsh-client-ui-sidebar/lib/client.js`：`syncPanels` 读 `entriesOfSlot("sidebar.panellist")` + `resolveSlotLabel(options.label)`；渲染 `renderSlot("sidebar.panellist", { size: wide?16:18, active }, { only: id })` | ok（图标 props 未消费 → 视觉降级） | 侧栏出现 Gatekeeper 按钮；折叠态图标不缩到 16px、选中态无视觉反馈 | `PythonToolchainIcon({size, active})` 消费 props（`panel.js:1538-1556` 目前硬编码 18） |
| 4 | `conversation.composer.dock`（list） | `:3043-3046` `{id:'gatekeeper-mode', order:55, label:()=>'技能包'}` | `dsh-client-ui-conversation/lib/client.js`：`registerComposerBar` 的 children 声明该 seat；渲染条件 `variant === "composer" && input !== void 0 && sessionId !== void 0 ? renderSlot("conversation.composer.dock", {}) : null` | ok | 输入框控制行出现"技能包"chip；hero/新建会话页不渲染（契约如此，非缺陷） | — |
| 5 | `conversation.input.dock`（list） | `:3057-3060` `{id:'gatekeeper-mode-status', order:55, label:()=>'技能包状态'}` | **仍存活**：`registerComposerBar` children 里声明 `"conversation.input.dock": {kind:"list", scope:"session"}`；渲染 `zone !== void 0 && renderSlot("conversation.input.dock", zone)`；现有 occupants：todo dock（id `todo`，order 0）、queue dock（id `queue`，order 20） | ok（**未被移除**，原假设不成立） | 状态条正常挂载；无 mode 时 `return null`（`:2983`），不留空 DOM | — |
| 6 | `inputActions.captureInsertion()` / `insertText(text, span)` | `:2199-2212`、`:2572` | `dsh-client-ui-conversation/lib/client.js` `SessionInputShell.actions`：`captureInsertion: () => ({...caretSpan(), draftRev})`；`insertText: (text, span) => { if (frozen||disposed) return false; if (span.draftRev !== this.rev) return false; … }` | ok | chip 点击写入 `/python-xxx `；CAS 失败时返回 false（panel 已处理） | — |
| 7 | `inputTriggers` 服务 + `registerSource(src)` | `:3091-3112`（`ctx.inject(['inputTriggers'])`）、`:3114-3129`（`ctx.get` 回退） | `dsh-client-ui-input-trigger/lib/client.js` `InputTriggerService`（`super(ctx,"inputTriggers")`，`static inject=["sessions"]`）；`registerSource(src)` 在 `(trigger,name)` 重复时抛 `slash source "/gatekeeper" is already registered`，返回 disposer；`refreshLexicon()` 调 `src.lexicon(projection)` | ok | 16 个 `python-*` 进入 `/` 词表，`/python-uv-basics` 能被 chip 化 | — |
| 8 | **`source.candidates` 返回类型** | `:3100` `candidates: () => []`（`:3120` 同） | `dsh-client-ui-input-trigger/lib/client.js` `fetchCandidates`：`for (const source of roster) source.candidates(projection, {query, quoted, position, drilled, signal}).then(items => …)`；官方 `dsh-client-ui-skill/lib/client.js` 源为 `async candidates(session, {query, signal}) { … }`（返回 Promise） | **changed（不兼容）** | 输入 `/` 时 `[].then is not a function` → `track()` 抛错（`onEditorUpdate` 无 try/catch），斜杠菜单不弹出或只显示已先发起的技能源行；控制台每次输入都报错 | 改为 `async candidates() { return [] }` 或 `candidates: () => Promise.resolve([])` |
| 9 | RPC 路由 `/gatekeeper/status`、`/gatekeeper/preview` | `:1686`、`:1941`（`fetch(url, {headers:{accept:'application/json'}})`，相对路径同源） | `dsh-host-webserver/lib/index.js` `register(route)`（exact/prefix Map，重复抛错，返回 disposer），**未发现 token/authorization/403/CORS 校验**；活体 `GET /gatekeeper/status` → **200，20643 B**，JSON 首部 `{"plugin":{"name":"gatekeeper","version":"0.10.0",…}}` | ok | 面板数据正常；无 401/403 | — |
| 10 | `require('react')` | `:30` | 前端 seed 表（`dsh-web-frontend/dist/assets/index-BgUyXZcc.js` ≈946986）含 `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`zod` 等；`dsh-client-modules/lib/client.js` 的 `makeRequire` 先查 `this.seed` 再 `stripClientSuffix` | ok | — | — |
| 11 | `dsh.client` 声明 + `exports["./client"]` | `package.json`：`exports["./client"]="./client/panel.js"`，`dsh.client={platform:'web', immediately:true, inject:[]}` | `dsh-client-modules/lib/index.js`：`parseDshClient`（platform 必须 string，immediately 必须 boolean）、`clientExportOf`（接受 string 形式）、`locatePkgJson`（相对 `name:'./index.js'` → `nearestPackage` → `gatekeeper`） | ok | 客户端半边被发布进 boot 图 | — |
| 12 | `ctx.inject([...], cb)` / `ctx.effect(fn, label)` | `:3091-3104`、`:3123-3124` | 官方客户端插件普遍使用：`ctx.inject([...])` 在 15+ 个 `dsh-client-ui-*` 包中出现；`ctx.effect(fn, "label")` 见 `dsh-client-ui-sidebar/lib/client.js` | ok | 服务晚到时仍能注册，provider 重载会重跑 | — |
| 13 | `locale`（未传） | 四个 `register` 均无 `locale` | 官方注册普遍带 `locale: NS`（如 plugin-manager `{name:"sidebar.panellist", id, order:0, label:()=>t("panel"), locale:NS}`） | changed（轻微） | 英文/其它语言界面下三个标签仍是中文硬编码 | 可选：接 `ctx.locale` |

## 三、重点核实逐条

1. **四个 seat 是否都活**：全部存活。`main`、`sidebar.panellist`、`conversation.composer.dock`、`conversation.input.dock` 都在 `CLIENT_SLOT_API`（`dsh-cordis-client-runner/lib/client.js`，109 条）里，且 `conversation.input.dock` 在 `dsh-client-ui-conversation/lib/client.js` 的 `registerComposerBar` children 中声明、渲染条件为 `zone !== void 0 && renderSlot("conversation.input.dock", zone)`。**"input.dock 已被移除"的假设不成立**，状态指示灯不会静默丢失。
2. **registration 形状**：与官方注册逐字对齐——`main` 用 `{name,key}`（官方 `{name:"main", key:"conversation", children:{…}}`）；三个 list 用 `{name,id,order,label}`（官方 `{name:"sidebar.panellist", id:PANEL_ID, order:0, label:()=>t("panel"), locale:NS}`、`{name:"conversation.composer.dock", id:"activity", order:0, locale:NS, inject:…}`）。`label` 传函数是合法的（sidebar 用 `resolveSlotLabel` 解析）。缺 `locale` 与 `inject` 均为可选。
3. **client service 键**：`inputTriggers` 仍注册（`InputTriggerService`，服务名 `"inputTriggers"`），`registerSource` 签名未变；**但 `candidates` 的返回类型已变为 Promise**（见台账 #8），这是本次审计唯一确认的破坏性契约变化。
4. **RPC 路径与鉴权**：`/gatekeeper/status` 活体 200（20643 B），无鉴权拦截。注意：`GET /` 返回 `dsh web authentication required; reopen the URL printed by dsh web`，说明**外壳 HTML 有鉴权、插件自注册路由没有**——同源 `fetch` 不受影响，但若宿主后续给插件路由加 peer/token 校验，面板会整体 401。
5. **React/宿主注入模块**：`require('react')` 走 `__ModuleLoader__` 的 seed 表，可解析；panel.js 未直接使用 `__ModuleLoader__` 注入其它模块，也未使用 `ctx.remote.*`（全部走同源 `fetch`），因此不受 remote RPC 契约变化影响。

## 四、最可能让用户感觉"不适配"的具体现象

**输入 `/` 时斜杠菜单不弹出（或只显示技能源的部分行），控制台抛 `TypeError`。** 链路：`DraftEditorRuntime.onUpdate → SessionInputShell.onEditorUpdate → inputTriggers.track() → fetchCandidates() → source.candidates(...).then(...)`；gatekeeper 的源返回数组，`.then` 不存在，异常在 `track()` 内同步抛出，而 `onEditorUpdate`（`dsh-client-ui-conversation/lib/client.js`）没有 try/catch 包裹。面板、侧栏按钮、chip、状态条本身都正常，所以用户会觉得"插件装了但斜杠不好使"。

## 五、修复方向（按优先级）

1. **P0**：`panel.js:3100` 与 `:3120` 的 `candidates: () => []` 改为 `async candidates() { return [] }`（或 `() => Promise.resolve([])`）。同时把 `test/client.mjs:451-452` 的断言改为 `await`，否则测试继续掩盖该契约。
2. **P1**：`PythonToolchainIcon` 接受 `{size, active}`（`panel.js:1538`），折叠态用 16px、选中态给视觉反馈。
3. **P2**：`panel.js:3041`、`:3055` 的 `if (typeof ctx.slots.inject !== 'function') return` 会**提前 return 掉整个 apply**，从而跳过斜杠源注册（`:3090` 之后）。当前 `slots.inject` 存在所以不触发，但这是潜在缺陷，应改为不返回或把斜杠源注册提前。
4. **P3**（可选）：四个 `register` 补 `locale`，标签走 `ctx.locale`。

## 六、未能证实 / 已尝试的手段

- **客户端 Inspect 全部超时**：`Slots.listSubTree` 试 2 次、`Service.listService` 试 1 次，均返回 `Client inspect query Slots.listSubTree timed out after 10000ms. Open or reconnect the Harness page, then retry.`。slot 树因此改用 asar 内 `CLIENT_SLOT_API` 取证（该目录正是 Inspect Provider 的数据源）。
- **未能直接观测页面 boot 图**：`GET /` 被 `dsh web authentication required` 拦截；`GET /plugins/??gatekeeper`（无 rev）→ 404。故"客户端 bundle 已被当前页面加载"只能由 `dsh-client-modules` 解析链（`locatePkgJson` → `nearestPackage` → `gatekeeper` → `exports["./client"]`）推断，未直接抓到脚本。
- **React 版本未直接取证**：前端 bundle 内联，asar 内无 `react/package.json`。panel.js 只用 `React.createElement`，18/19 均兼容，风险低。
- 未做任何写操作：未改插件、未重启 DSH、未装卸插件、未改 profile、未刷新页面。

## 附：证据索引

- 插件侧：`gatekeeper/client/panel.js:30, 103, 1538-1556, 1649-1699, 2199-2212, 2571-2572, 2979-2998, 3009-3135`；`gatekeeper/test/client.mjs:384, 441-452`；`gatekeeper/package.json`（exports/dsh.client）；`gatekeeper/cordis.patch.yml`（`- insert: - id: gatekeeper / name: './index.js'`）。
- 宿主侧（asar 内）：`dsh/node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js`（`CLIENT_SLOT_API`，offset≈124098）；`dsh-client-ui-layout/lib/client.js`（`renderSlot("main", …)`）；`dsh-client-ui-sidebar/lib/client.js`（`syncPanels`、`renderSlot("sidebar.panellist", {size, active}, {only:id})`）；`dsh-client-ui-conversation/lib/client.js`（`registerComposerBar`、`renderSlot("conversation.input.dock"/"conversation.composer.dock")`、`SessionInputShell.actions`）；`dsh-client-ui-input-trigger/lib/client.js`（`registerSource`、`refreshLexicon`、`fetchCandidates`）；`dsh-client-ui-skill/lib/client.js`（`async candidates`）；`dsh-client-modules/lib/index.js`（`parseDshClient`、`clientExportOf`、`locatePkgJson`、`processOne`/`flush`）；`dsh-host-webserver/lib/index.js`（`register`）。
- 活体探测：`GET http://127.0.0.1:58898/gatekeeper/status` → 200 / 20643 B；`GET /` → `dsh web authentication required`；`GET /plugins/??gatekeeper` → 404。
- profile：`<DSH_HOME>\profiles\desktop\package.json`（`"gatekeeper": "link:<checkout>"`，`dsh.profile.bundles` 含 `gatekeeper`）；`cordis.yml` 为 `[]`；`cordis.patch.yml` 无 gatekeeper 行（由 bundle 层提供）。
