# GateKeeper 运行时取证报告（DSH 桌面宿主 0.2.2-rc.1）

- 取证时间：2026-11-13 09:16–09:27（本地），探针时间戳为 UTC `2026-11-13T01:1x–01:2xZ`
- 插件：`<checkout>`，gatekeeper **v0.10.0**，`link:<checkout>` 装入 profile `<DSH_HOME>\profiles\desktop`
- 宿主：Electron 桌面版，`@deepseek-ai/dsh-desktop-runtime` **0.2.2-rc.1**，监听的 Web GUI `http://127.0.0.1:58898`
- 约束遵守：未改插件源码、未重启、未装/升/卸插件、未改 profile 与用户工程；所有写入只落在 `<workspace>\audit\`

---

## 0. 结论速览（按可证实程度排序）

| # | 原因 | 证据强度 |
|---|---|---|
| 1 | **`py-run` 工具 100% 必失败**：返回的 `pipeline.plan` 数组上挂了两个非索引自有属性 `profile`/`from`，违反宿主 0.2.2-rc.1 的 tool 输出"无损 JSON 快照"契约（数组要求 `Reflect.ownKeys(v).length === length + 1`），宿主直接丢弃整个结果并报 `value is not lossless JSON` | 实跑复现 4 次 + 宿主代码定位 + 插件源码定位 |
| 2 | **`engines.dsh` 声明与实跑宿主版本在严格 semver 下不兼容**：声明 `>=0.2.1-rc.2`，`semver.satisfies('0.2.2-rc.1','>=0.2.1-rc.2') === false`（预发布版本号元组不同）。宿主自身用 `includePrerelease: true` 判定所以能激活，但任何按默认 semver 语义做兼容预检的路径（npm、市场预检、第三方审计）都会判"不兼容" | semver 7.8.5 实测 + 宿主 `satisfies()` 实现对照 |
| 3 | **状态/预览端点的"静默降级"会让人误判功能坏了**：不存在的 `path` 仍返回 200 并给出一份完整 8 阶段计划；未知 `stages=xml` 只加一条 warning 而不报错；`session=bogus` 返回 200 且 `sessionMatched=false`。功能没坏，但"看不出哪里错" | HTTP 探针响应体 |

---

## 1. 实时探针（每个参数组合只打 1 次，避免触发检测逻辑）

工具：PowerShell `Invoke-WebRequest -SkipHttpErrorCheck`。全部为 GET。

| URL | 状态 | 耗时 | 大小 | 关键字段 |
|---|---|---|---|---|
| `/gatekeeper/status` | 200 | 241ms | 20643B | `plugin={"name":"gatekeeper","version":"0.10.0","schema":true,"degraded":false}`，`root=<workspace>`，`source=session` |
| `/gatekeeper/status?peek=1` | 200 | 12ms | 20643B | 只观察不写 `lastRequest`（行为符合声明） |
| `/gatekeeper/status?refresh=1` | 200 | 286ms | 20642B | 重新检测，`recordedAt` 刷新 |
| `/gatekeeper/status?probe=1` | 200 | **2210ms** | 21033B | `skillProbe={available:true,total:88,python:[…17 个 python-* 技能全部在册],cwd:<workspace>}` |
| `/gatekeeper/status?path=<checkout>` | 200 | 244ms | 23360B | `root` 正确跟随，`source=query` |
| `/gatekeeper/status?session=bogus-session-id` | 200 | 10ms | 20671B | 不报错，`source` 仍为 `session`；`sessionMatched=false`（应与 `requestedSession` 不符，未逐字段比对） |
| `/gatekeeper/preview`（无 path） | **400** | 6ms | 32B | `{"error":"preview needs a path"}` ← 唯一一处正确的 4xx |
| `/gatekeeper/preview?path=<sandbox\proj>` | 200 | 281ms | 1997B | `blocked=false`，8 阶段，`warnings=[No uv.lock…]` |
| `/gatekeeper/preview?path=<proj>&stages=lock,lint` | 200 | 7ms | 1015B | 阶段裁剪生效 |
| `/gatekeeper/preview?path=<proj>&stages=all` | 200 | 228ms | 1997B | 与默认一致（`all` 指 8 个默认阶段） |
| `/gatekeeper/preview?path=<proj>&stages=xml` | 200 | 10ms | 2141B | **不报错**，仅 `warnings="Ignored unknown stage(s): xml. Known: …"` |
| `/gatekeeper/preview?path=<sandbox\does-not-exist>` | 200 | 106ms | 2148B | **不报 4xx**，`blocked=false`，`fileName=does-not-exist.yml`，照常渲染计划 |
| `/gatekeeper/nope` | 404 | 3ms | — | 路由不存在 |

结论：Host 半边（路由 + schema + 检测 + skill 探测）健康，`degraded=false`，没有 5xx，`error` 字段未出现过。

---

## 2. 工具实跑（本会话真实宿主工具，非 mock）

沙盒 `<workspace>\audit\sandbox\{proj,empty,notpy,乱码 目录}`。`proj` = pyproject.toml（name demosb、ruff line-length 100、testpaths tests、build uv_build）+ `src/demosb/__init__.py` + `tests/test_add.py`。

| 场景 | 工具 | 结果 |
|---|---|---|
| 正常项目 | `py-audit` | ✅ 成功。`manager=uv`，`python=3.12`，ruff/pytest=yes，`confidence=medium`，8 阶段 gate order + 19 项 resolved values |
| 无 pyproject 空目录 | `py-audit` | ✅ 优雅降级（`manager=unknown`、`confidence=low`、9 项生成目标全缺、`notes` 两条），不是崩溃 |
| 非 Python 目录（仅 readme.txt） | `py-audit` | ✅ 优雅降级，且输出 `pytest.has_tests=false (detected)`、`python.version=3.13 (default)` |
| 乱码/中文+空格路径 `乱码 目录` | `py-audit` | ✅ 正常，路径原样回显，无编码问题 |
| 不存在路径 `does-not-exist` | `py-audit` | ⚠️ 首行 `py-detect: could not inspect … ENOENT: no such file or directory, scandir …`，随后仍输出通用计划与既有 findings；文本可读、不崩，但**仍然返回"看起来像成功"的审计正文** |
| 正常项目 | `py-scaffold`（默认 dryRun） | ✅ `# py-scaffold — DRY RUN, nothing was written`，9 个 target 计划，末尾显式 `Nothing was written.` |
| pyproject 已存在 | `py-scaffold` | ✅ pyproject 走 `update`（diff 预览），其余 `create` |
| 空目录 | `py-scaffold dryRun:false` | ✅ `wrote 9 of 9 file(s)`，逐条 `[CREATE]`，仅落在沙盒目录内 |
| 正常项目 | **`py-run`（默认 dryRun）** | ❌ `Error: tool "py-run" returned invalid output: value is not lossless JSON` |
| 正常项目 | **`py-run`（显式 `dryRun:true`）** | ❌ 同上（与 dryRun 无关） |
| 空目录 | **`py-run`** | ❌ 同上（与项目内容无关，**项目无关性已证实**） |

`py-run` 四次调用、两个不同目录、两种参数，均为同一错误文本 → 确定性缺陷，不是偶发。

### 2.1 `py-run` 根因（已定位到行）

1. 宿主侧：`<install>/resources/app.asar` 内 `snapshotToolValue()`（字符串 `value is not lossless JSON` 偏移 126185359）：
   ```js
   const detached = snapshotJsonValue(candidate);
   if (detached === void 0) throw new ToolOutputError(toolName, ["value is not lossless JSON"]);
   ```
2. 判定规则 `walkJsonValue()`（偏移 ≈22325249）对数组：
   ```js
   if (Array.isArray(current)) {
     if (!hasPlainArrayPrototype(current)) return void 0;
     const length = current.length;
     if (Reflect.ownKeys(current).length !== length + 1) return void 0;   // 只允许 index + length
   ```
3. 插件侧：`<checkout>\lib\pipeline\local.js:263-264` 给数组加属性：
   ```js
   const plan = stages.slice(fromIndex)
   plan.profile = profile
   plan.from = fromRequested === '' ? '' : stages[fromIndex].id
   ```
   `py-run`（`lib/tools/py-run.js:273/277`）把 `report.pipeline`（含该 `plan`）原样作为工具返回值。
4. 实测扫描（`audit\diag-pyrun-keys2.mjs`，直接 import 插件工具执行 `execute()`）：
   ```
   offending arrays: 1
     $.pipeline.plan length=8 ownKeys=11 extra=[profile,from] (host requires ownKeys === length+1)
   ```
   全树只有这一个数组越界 → 宿主 `snapshotJsonValue` 返回 `undefined` → 整条工具结果被丢弃，模型侧只能看到那句错误。

---

## 3. 日志取证

扫描范围：`<DSH_HOME>`（含 `logs`、`guardian`、`sessions`、`.dsh-memory`）与 `<HOME>\AppData\Roaming\@deepseek-ai\dsh-desktop`（`logs`、`plugin-operations`、`desktop`），近 3 天。

- **最有价值的一条**：会话日志 `<DSH_HOME>\sessions\--<workspace>--\6c55423a-796a-4bf4-a4aa-0d4fc8170364\session.v4.jsonl.zstd` 里，2026-11-13T01:18:04Z 起连续 3 条 `tool/result` 都是
  `Error: tool "py-run" returned invalid output: value is not lossless JSON`（toolCallId 3 个不同）——说明该缺陷在本次取证之前就已在实际会话中发生并留痕。
  *技术说明*：会话日志是 **多帧 zstd**（单个文件内约 250 个独立 frame），`zstdDecompressSync` 只解第一帧会得到 202 字节的文件头；需按 magic `28 B5 2F FD` 切帧逐段解压（脚本 `audit\scan-sessions2.mjs`）。
- `AppData\Roaming\@deepseek-ai\dsh-desktop\logs\crash-2026-11-10T06-55*.log`：`app: @deepseek-ai/dsh-desktop 0.2.2-rc.1 / electron 44.7.0 / node 24.21.0`，失败原因是 `host exited with 1`，日志中可见 `@iasiv5/dsh-skip-browser-auth: dormant by design`、`[mdcg-mcp]` 自报、`dsh: warning: 1 entry did not activate` / `trusted-connection … pending`、`api.deepseek.com/models answered HTTP 401`。**没有任何 gatekeeper 相关报错**。
- `AppData\Roaming\@deepseek-ai\dsh-desktop\plugin-operations\operations.jsonl`（106KB，最新 2026-11-13 09:01）：grep `gatekeeper` **0 命中**，也无 `"error"` 行 → 该 link 安装没有留下操作记录。
- `<DSH_HOME>\guardian\startup-issues.json`（checkedAt 1794495653970）：唯一 issue 是 `dsh-better-sidebar` 的依赖不匹配（宿主供给 `@deepseek-ai/*` 显示 0.2.0-rc.2），**与 gatekeeper 无关**；`guardian\state.json` 只有 21 条 `entry-dispose`。
- `<DSH_HOME>\logs\` 只有 `dsh-memory-hook-audit.json` 与 `lingshu-bridge-debug.log`（最后一条 2026-11-11 SIGTERM，无关）。
- 跨项目抽查：`--E-projects-pyknora--`、`--E-project_month-silvermate--` 的会话中 gatekeeper/py-* 无 error 级记录（silvermate 内 0–4 处提到 gatekeeper，均非报错）。

即：**插件没有"加载失败"证据，坏的是运行期工具输出契约**。

---

## 4. 版本变更点

### 4.1 官方 nightly feed（权威）

`<install>\resources\app-update.yml` 给出真实 feed：`provider: generic`、`url: https://download.deepseek.com/dsh-desk/feeds/win-x64/`、`channel: nightly`。电子更新器先取 `{channel}.yml`，因此：

- `https://download.deepseek.com/dsh-desk/feeds/win-x64/latest.yml` → **HTTP 404**（该目录不存在 latest.yml，这也是最初查不到的原因）
- `https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml` → **HTTP 200**：
  ```yaml
  version: 0.2.2-rc.1
  path: …/deepseek-harness-0.2.2-rc.1-win-x64.exe   # 293,425,336 B
  stagingPercentage: 100
  releaseDate: '2026-11-04T09:31:49.677Z'
  ```
  → **当前已发布的 nightly 就是 0.2.2-rc.1，本机宿主为最新版，不存在"宿主该升没升"的问题。**

### 4.2 宿主真实版本（直接读 asar）

读法：`app.asar` 前 8 字节为 asar header；`[4..8]` = uint32 headerSize = **5748132**；JSON 实际从 offset **16** 开始、长度 `headerSize-8`；内容基址 = `8 + headerSize` 对齐 4 = **5748140**。

- `dsh/package.json` → `"@deepseek-ai/dsh-desktop-runtime"` version **0.2.2-rc.1**，依赖 `@deepseek-ai/dsh` 0.2.2-rc.1、schemastery 3.19.0、cordis 4.1.0
- `dsh/desktop-runtime.json`（4,942,461B）→ `release.version=0.2.2-rc.1`、`hostProtocolVersion=4`、`nodeVersion=24.21.0`、`pnpm=11.28.5`、`platform=win32/x64`
- 本机 CLI 的 `node` 是 v26.5.1，宿主内置 24.21.0，均 ≥ 插件声明的 `node >=22.19.0` → **node 约束满足**

### 4.3 0.2.1 → 0.2.2-rc.1 的变更线索

官方社区版升级指南（基线 `0.2.2-rc.1`，2026-11-04）：[dshx.dev · 0.2.2-rc.1 变更与升级入口](https://dshx.dev/en/docs/releases/0-2-2-rc-1/)、[GitHub Release `dsh-v0.2.2-rc.1`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1)。相对 `0.2.1-rc.5` 的 6 项主变更：

1. 文件写入不再要求先读（`FS_NOT_OBSERVED` 取消，`apply_patch` 进默认工具集）
2. Schedule 工具与存储大改（`schedule_create/list/view/edit` + RRULE，存储写 version 2）
3. Forge 与 worktree 入口合并（一个开关启用审查面板 + worktree + `create_worktree`）
4. Forge 的 Git 查询跟随 Session 权限
5. pi-ai 请求图片上限 50 张，超出丢最旧批次并重试
6. **SDK `run()` 返回 `RunResult`**（插件/CLI 兼容性主题）

与 gatekeeper 直接相关的是第 6 条与"工具/事件返回值必须是无损 JSON"这一类契约收紧，但**官方 changelog 没有逐字提到 tool 输出的 lossless 快照校验**（见 §5）。

### 4.4 声明 vs 实跑

| 项 | 声明 | 实跑 | 判定 |
|---|---|---|---|
| `dsh.engines.dsh` | `>=0.2.1-rc.2` | 宿主 0.2.2-rc.1 | **严格 semver：不满足**（`satisfies()===false`）；宿主用 `includePrerelease:true` 判定 → 实际放行 |
| `engines.node` | `>=22.19.0` | 24.21.0（宿主）/ 26.5.1（CLI） | 满足 |
| `peerDependencies` | `@deepseek-ai/schemastery ^3.18.1`（optional） | 3.19.0 | 满足 |
| `dsh.client.platform` | `web` | 桌面宿主加载 web 半边 | 一致（HTTP 半边确实活着） |

宿主判定实现（asar 偏移 ≈24591464）：
```js
function satisfies(runtimeVersion, range) {
  return range.trim() !== "" && semver.satisfies(runtimeVersion, range, { includePrerelease: true });
}
```
本地 `semver@7.8.5` 实测：
```
satisfies('0.2.2-rc.1', '>=0.2.1-rc.2')                     = false
satisfies('0.2.2-rc.1', '>=0.2.1-rc.2', {includePrerelease:true}) = true
satisfies('0.2.1-rc.2', '>=0.2.1-rc.2')                     = true
```
→ 声明区间只覆盖 `0.2.1` 线；跨到 `0.2.2` 线后靠 `includePrerelease` 侥幸放行，这本身就是"对该版本没适配"的可证实信号。

---

## 5. 未能证实 / 未做

1. **未能证实** lossless JSON 快照校验是 0.2.2 才新增的 breaking change。理由：本机只有 0.2.2-rc.1 的 `app.asar`，profile 内 `@deepseek-ai/*` 只有 0.2.2-rc.1 的 SDK 包，没有 0.2.1 的宿主包可做 A/B；官方 0.2.2-rc.1 升级指南与研究页也未逐字提及该契约。已尝试：asar 内字符串检索（`value is not lossless JSON` 命中 2 处，均在 0.2.2-rc.1 包内）、dshx.dev 发布页、GitHub Release 页。
2. **未能证实**客户端半边在桌面里是否有视觉缺陷：`cordis_inspect_query(client/Slots.listSubTree)` 返回 `timed out after 10000ms`（需要页面在线应答），按约束未重新打开/刷新页面，故未取证。辅助证据：`host/Config.listConfigs` 中提到 gatekeeper 的条目在首页 100 条里未出现（total 243），未做全量翻页确认。
3. `status?session=bogus` 的 `sessionMatched` 语义只做了单点观测（200 + `sessionMatched=false`），未逐字段核对 `requestedSession`。
4. 未执行任何写盘、重启、升级、卸载动作；`py-scaffold dryRun:false` 的写盘只发生在 `audit\sandbox\empty`。

---

## 6. 复现附件（均在 `<workspace>\audit\`）

- `probe.ps1`：HTTP 探针（状态/耗时/字节/关键字段）
- `status-base.json`：`/gatekeeper/status` 全量快照
- `preview-notexist.json` / `preview-bogusstage.json` / `preview-empty.json`：preview 边界响应体
- `diag-pyrun-keys2.mjs`：定位 `$.pipeline.plan` 数组越界（决定性证据）
- `diag-pyrun2.mjs` / `diag-pyrun4.mjs`：JSON 往返 diff（早期定位）
- `scan-sessions2.mjs`：多帧 zstd 会话日志解压 + 关键词扫描
- `find-lossless.mjs` / `find-lossless2.mjs` / `find-snapshot.mjs` / `find-engines.mjs`：asar 内契约代码定位

---

## 7. 修复方向（只给方向，未改代码）

1. `lib/pipeline/local.js:263-264`：不要给数组挂属性。改成返回 `{ steps: stages.slice(fromIndex), profile, from }`，或在返回前 `Object.assign([...plan], {})` 后剥离；`py-run` 出口再做一次 `JSON.parse(JSON.stringify(...))` 之外的结构清洗（`structuredClone` 也不会保留数组属性，可作为出口防御）。
2. `package.json` 的 `dsh.engines.dsh` 扩到 `>=0.2.2-rc.1`（或 `^0.2.2-rc.1 || ^0.2.1` 这类显式区间），避免市场/审计按严格 semver 判不兼容。
3. `status`/`preview` 对不存在的 `path` 给 4xx 或显式 `blocked`，别静默渲染计划；`stages` 全未知时也应是错误而不是 warning。
