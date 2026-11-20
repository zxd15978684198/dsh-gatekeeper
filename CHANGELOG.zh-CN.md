# 更新记录

[English](CHANGELOG.md) · **简体中文**

0.10.0 之前的版本不列：插件到 0.11.0 才公开，0.10 之前是一连串内部重写，不是发布。

## 0.11.0

让插件公开的版本。除执行器外行为与 0.10.3 一致——执行器不再在跑命令时堵住宿主。

### 修复

- **`py-run` 会堵住宿主事件循环。** 每次 `uv` / `pytest` / `docker` 调用都走 `spawnSync`，一次十一秒的测试让界面死了十一秒。新增 `runCommandAsync` / `runPlanAsync`，并把 `py-run`、`py-container-gate`、`py-pipeline-doctor` 迁过去。同步执行器保留：既给确实想阻塞的调用方，也在新测试里当对照组。活宿主实测：一次 11.1 秒的 `py-run` 期间，`/gatekeeper/status` 的 p50 延迟仍是 80 毫秒，没有任何样本超过 1 秒。
- **`py-audit` 指向了一个不存在的工具。** 它的提示建议用 `py-apply`，而这个工具从未注册。现在说的是实话：写盘靠 `py-scaffold`，且必须显式传 `dryRun: false`。

### 变更

- 从仓库根删掉九个一次性探针脚本。它们本来就不在发布内容里（`files` 从未包含）。

### 新增

- `test/exec-async.mjs`、`scripts/audit/verify-async.mjs`，以及 CI。

## 0.10.3

### 修复

- **悬浮卡会滑出屏幕**：composer 的 transform 制造了一个嵌套包含块。现在卡片与面板放在同一个定位层里，宽度按实际剩的空间收缩——窗口窄于约 660px 时不再与面板重叠。
- **卡片三角被钉在边框中央。** 现在指向悬停的那一行，并夹在卡片边框内，所以三角位置是可变的。

## 0.10.2

### 修复

- 删掉客户端一个只写不读的模块级变量，改正两处仍用旧工具名描述工具的注释。

## 0.10.1

面向 DSH 0.2.2 的兼容版本。

### 修复

- **斜杠菜单从来没出现过。** `conversation.input.dock` 的触发源从 `candidates()` 返回数组，而宿主写死 `candidates(...).then(...)`。敲 `/` 会在一个没有 `try` 的监听器里抛 `[].then is not a function`，于是菜单静默失效。现在两处都是 `async`。
- **所有设置都退回默认值。** DSH 把这个插件的字段标成 `x-cordis.volatile`，校验后的值到达时是 `{ get() }` 引用对象而不是普通值。`resolveConfig` 拿这个对象去和 `false` / `''` 比较，永远不成立。现在先解包再读。
- **`py-run` 返回 `value is not lossless JSON`。** 阶段计划是个数组，上面多挂了两条自有属性（`profile`、`from`）；宿主的序列化器要求数组的自有键恰好是它的下标。选择项现在存在以计划为键的 `WeakMap` 里，由 `planSelection(plan)` 读出。
- **侧栏图标忽略尺寸与选中态**，折叠栏里不缩放，选中的时候也没反馈。
- **`engines.dsh` 写在了宿主不读的位置。** 移到顶层 `engines` 字段——插件兼容性检查读的才是那里。

## 0.10.0

第一个具备当前三工具表面（`py-audit` 读、`py-scaffold` 写、`py-run` 执行）、16 个内置技能、以及输入框胶囊的版本。
