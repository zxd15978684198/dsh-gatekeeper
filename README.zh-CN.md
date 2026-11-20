# Gatekeeper（门禁）

一个 DSH 插件：读 Python 项目、生成门禁配置、在本地与 CI 用同一套定义执行门禁。机器标识 `gatekeeper`，界面上叫 **Gatekeeper**，中文名「门禁」。

三个工具、一个左侧面板、一个输入框下方的技能包胶囊，一起回答「这个 Python 项目要什么」；当项目不是 uv 项目时，它们会**拒绝**回答。

三个工具是按「对项目做什么」切的，不是按产出哪个文件切的：`py-audit` 读、`py-scaffold` 写、`py-run` 执行。整个工具面就这三个。它们生成的一切都来自同一份流水线定义（8 个默认阶段 + 5 个可选阶段），所以本地通过、提交钩子通过、CI 通过是同一个意思。

这是一个 DSH bundle：把十六份 skill 文档随包分发（十二份由四份上游 skill 拆分而来，另四份为本插件写的容器验收、流程形状、发布与部署），产出它们描述的配置；它默认不往你的项目里写任何东西 —— 写盘要显式要求：`py-scaffold` 与 `py-run` 的 `dryRun` 默认都是 `true`，`py-audit` 在任何路径上都不写。

## 为什么要有它

那四份上游 skill 是好文档、差工具。agent 读了 `1-uv/SKILL.md` 里「不要在别的工具管理的项目里用 uv」，照样可能在 Poetry 仓库里 `uv add` —— 因为那句话是建议，不是判据。在这里它变成了对项目自身 lockfile 的判据：

- 有 `poetry.lock` / `pdm.lock` / `Pipfile.lock` → `py-scaffold` 返回 `{ blocked: true, reason }`，且 reason 引用它执行的那条规则原文。
- 有 `uv.lock` → 工具产出配置与 workflow。

另一半是可溯源。`py-audit` 可以一次只返回一份随包文档，并标明来源，调用方能看出某句话出自 Astral 的 `uv` skill，还是出自一份早于 uv 的 CI 模板集。

## 三个工具

| 工具 | 做什么 | 默认动手吗 |
| --- | --- | --- |
| `py-audit` | 一次只读调用给出：哪个锁文件在管理依赖（uv，或必须退出的 Poetry/PDM/Pipenv 外部锁文件）、声明的 Python 版本及其来源、ruff / mypy / ty / pytest / prek / detect-secrets 配了哪些、提交钩子是否已安装、`.secrets.baseline` 是否存在、有哪些 workflow 以及十三条静态规则对它们的意见、流水线会采用的闸门顺序。`topic` 原样返回十六份随包 skill 文档之一；`run: true` 额外执行白名单里的只读探测。绝不写盘。 | 否 |
| `py-scaffold` | 生成九份门禁产物 —— `pyproject.toml` 配置表、`.pre-commit-config.yaml`、`.github/dependabot.yml`、GitHub Actions workflow、`scripts/ci.py`、`release/agent_versions.json`、`scripts/validate_version_manifest.py`、`scripts/secret_scan.py`、`scripts/container_report.py` —— 默认只预览，`dryRun: false` 才写，且只写这九个固定路径。 | 否，除非 `dryRun: false` |
| `py-run` | 按流水线顺序跑闸门并逐阶段返回退出码 —— 默认八个阶段，五个可选阶段点名才跑；`profile: "commit"` 只跑提交钩子能承受的快子集，`from` 从失败项续跑。默认只打印计划；`dryRun: false` 才执行。 | 否，除非 `dryRun: false` |

所有工具默认作用于**发起调用的会话的工作目录**；传 `path` 可指向别处。没有任何一处读 `process.cwd()`，所以在 `D:\work\api` 会话里调用，描述的是 `D:\work\api`，不是插件的安装目录。

### `py-audit`：读

一次调用、一份报告 —— 项目事实（包管理器、Python 版本及其来源、lint / 类型 / 测试 / 钩子 / 密钥基线的配置情况）、workflow 审计、闸门顺序，以及一段 `next` 说明接下来做什么。

三个可选参数，都是显式开启的，因为审计默认只是读文件系统：

- `topic` —— 原样返回十六份随包 skill 文档之一（带来源路径），不做审计。
- `run: true` —— 额外执行白名单里的只读探测，让「能解析但内容是错的」workflow 现形。
- `stages` —— 逗号分隔的闸门 id，用来只对其中几个做计划；不传就规划整条默认链。

### `py-scaffold`：写

九份产物、九个固定路径：

| 路径 | 是什么 |
| --- | --- |
| `pyproject.toml` | `[tool.ruff]`、`[tool.ruff.lint]`（含 `per-file-ignores`）、`[tool.ruff.format]`、`[tool.mypy]`、`[tool.pytest.ini_options]`、`[tool.coverage]`、`[tool.uv]`、`[dependency-groups]` 等表，按表合并 —— 你的 `[project]` 表永不重写 |
| `.pre-commit-config.yaml` | prek 钩子；远程仓库版本故意不钉，另加两个 local 的 gatekeeper 钩子 |
| `.github/dependabot.yml` | 每周 pip + Actions 更新，带 7 天 cooldown |
| `.github/workflows/<project>.yml` | 由流水线 IR 渲染的 workflow |
| `scripts/ci.py` | 同一套流水线的本地执行器，让 CI 和开发者跑的是同一件事 |
| `release/agent_versions.json` | 版本清单：schema 版本、服务、运行时、agent 组件 |
| `scripts/validate_version_manifest.py` | 校验该清单的单文件脚本 |
| `scripts/secret_scan.py` | CI 与提交钩子共用的只读 Secret 扫描器 |
| `scripts/container_report.py` | 容器阶段用的六项镜像体检报告 |

已存在的文件在改动前留 `.bak.<timestamp>` 副本；原本不存在的文件以独占方式创建，并发写入不会互相覆盖。版本清单是 diff-only：已有条目保留，只补缺失组件。

### `py-run`：执行

阶段来自生成 workflow 与 `scripts/ci.py` 的同一份 IR。默认是「一次 push 要过关」的八个阶段；五个可选阶段（`integration`、`audit`、`container`、`release`、`deploy`）必须点名，`stages: "all"` 也不会把它们拖进来。`profile: "commit"` 收窄到钩子能承受的快子集；`from` 从断掉的阶段续跑。

argv 不是运行时临时拼的：它就是 workflow 与 `scripts/ci.py` 里那份字符串。失败即停；没开始的阶段标为 skipped，不当作 passed。

**命令根本没跑起来**（缺 `uv`、写缓存目录权限报错）会被标为 `kind: 'environment'`，措辞是「工具没跑起来」，这与「项目没通过」是两个判断。

### 拒绝的形状

```json
{
  "blocked": true,
  "reason": "\"poetry.lock\" means another tool manages this project's dependencies. The 1-uv skill is explicit — \"Don't use uv in projects managed by other tools\" — so this plugin will not generate uv configuration or a uv-based workflow here. …",
  "root": "D:\\work\\legacy-api"
}
```

`py-audit` 不拒绝：对一个准备迁移的项目做报告，正是读者最需要报告的时候。它改为返回 `blocked: true` 并注明当前包管理器；`py-run` 则在启动任何进程之前按同一判据拒绝。

## 九条命令的门禁链（第八章：8 个默认阶段 + 5 个可选阶段）

课程第八章的流水线是九条命令，由八个默认阶段承载 —— `lint` 一个阶段里跑检查与格式化两步：

| # | 步骤 | 阶段 | 命令 |
| --- | --- | --- | --- |
| 1 | 锁检查 | `lock` | `uv lock --check` |
| 2 | 同步 | `sync` | `uv sync --locked --all-groups` |
| 3 | Ruff 检查 | `lint` | `uv run --locked ruff check .` |
| 4 | Ruff 格式化检查 | `lint` | `uv run --locked ruff format --check .` |
| 5 | 类型检查 | `type` | `uv run --locked mypy <探测出的主线路径>` |
| 6 | 版本清单 | `manifest` | `uv run --locked python scripts/validate_version_manifest.py` |
| 7 | 测试 | `test` | `uv run --locked pytest --cov --cov-report=term-missing` |
| 8 | Secret 扫描 | `security` | `uv run --locked python scripts/secret_scan.py` |
| 9 | 构建 | `build` | 清空 `dist/`，再 `uv build --all-packages --out-dir dist`（workspace）或 `uv build`（单包） |

顺序按第八章：便宜且确定性的先跑，最常见的失败先用最低成本暴露。失败即停；修好后从失败项重跑，最后从头再跑一遍。

五个可选阶段只在点名时进入 workflow：

| 阶段 | 证明什么 | 为什么可选 |
| --- | --- | --- |
| `integration` | `uv run --locked pytest -m integration` | 需要真实数据库或网络；没有集成测试时只打印一行可见的跳过原因并以 0 退出，不算失败 |
| `audit` | `uv run --locked --with pip-audit pip-audit` | 走网络、噪音大 |
| `container` | compose config、镜像构建检查、`up --wait`、拆除、六项镜像体检（默认用户由镜像体检从镜像的 `Config.User` 读取，不再 `compose exec`） | 需要 Docker |
| `release` | 复用已验证的 `dist`，attest、SBOM、上传、`gh release create` | 只在打 tag 时跑 |
| `deploy` | 带注释的部署框架：`gh release view`、必须替换的部署命令、条件探活 | 无法替别人猜 |

`deploy` 的占位命令没替换之前**显式失败**：`echo "::error::部署命令未配置：把本步替换成你的部署命令"` 加 `exit 1`。部署 job 全绿却什么都没部署，比红更危险。

## 三个触发入口

三个入口读同一份定义 —— `lib/pipeline/ir.js` —— 所以不会漂移：

| 入口 | 命令 | 跑什么 |
| --- | --- | --- |
| 手动（修理） | `uv run --locked python scripts/ci.py` | 全部八个默认阶段，失败即停 |
| 手动（续跑） | `uv run --locked python scripts/ci.py --from test` | 从指定阶段开始，不必从头 |
| 本地自动 | `git commit` → `.git/hooks/pre-commit`（prek）→ `uv run --locked python scripts/ci.py --profile commit` | `lock`、`lint`、`manifest`；Secret 钩子扫描暂存区 |
| 远端自动 | `git push` / PR → GitHub Actions | 同一份 IR 渲染出的同样八个阶段 |

`scripts/ci.py` 还保留 `--profile full|commit`、`--stage`、`--stop-after`、`--list`（按 job 分组）、`--json`、`--root`、`--timeout`。三条规范命令写在它的 `--help` 顶部、`py-scaffold` 的 next steps，以及这份 README 里。

`--list` 打印 payload 里的阶段并按 job 分组：默认选择就是八个门禁；用 `stages: "all"` 生成项目时是十三行，其中 `release`、`deploy` 标注 `[CI only]`（本机没有等价步骤）。默认运行仍然只跑八个默认阶段；`stages: "all"` 展开成这八个，绝不自己拖进任何可选阶段。

## py-scaffold 生成什么

| id | 路径 | 模式 | 来源 |
| --- | --- | --- | --- |
| `pyproject` | `pyproject.toml` | 追加 | 解析后的项目取值 |
| `prek` | `.pre-commit-config.yaml` | 整文件 | `py-prek` |
| `dependabot` | `.github/dependabot.yml` | 整文件 | `py-dependabot` |
| `workflow` | `.github/workflows/<name>.yml` | 整文件 | `py-ci-render` |
| `ci-script` | `scripts/ci.py` | 整文件 | `py-ci-run` |
| `manifest` | `release/agent_versions.json` | 仅补差异 | 组件探测 + 清单渲染 |
| `validator` | `scripts/validate_version_manifest.py` | 整文件 | manifest 模块 |
| `secret-scan` | `scripts/secret_scan.py` | 整文件 | secret-scan 模块 |
| `container-report` | `scripts/container_report.py` | 整文件 | 容器模块 |

`py-scaffold` 默认只预览；`dryRun: false` 才写。传 `targets` 可缩小集合；不认识的目标会被报告出来，而不是静默忽略。

## 写入的 pyproject（第八章默认口径）

对新项目，模板就是第八章的严格配置：

- `[tool.ruff]`：`line-length = 88`，`target-version` 取自项目 Python，`src = ["src"]`。
- `[tool.ruff.lint]`：`select = ["E", "F", "I", "B", "UP"]` —— 第八章那套，不是 `ALL`；项目要放宽用 `extend-select`。`ALL` 宽口径加 per-file-ignores 只在库级存在（`renderPyprojectBlock` 接受 `ruffSelect`/`ruffIgnore`），脚手架工具参数没有暴露它，想要 ALL 的项目只能自己改生成出来的 `[tool.ruff.lint]`。
- `[tool.mypy]`：`python_version` 加 `strict = true`。
- 只有类型检查器解析为 `ty` 时才写 `[tool.ty]`。
- `[tool.pytest.ini_options]`：`testpaths`，`addopts = "-ra --strict-markers"`。
- `[tool.coverage.run]`：`branch = true`，`source` 取自探测。
- `[tool.coverage.report]`：`show_missing = true`，`fail_under` —— 新项目 90，已有项目补表时 80（门槛高于现状会让第一次运行直接变红）。
- `[dependency-groups]` 四组：`lint`（`mypy`、`ruff`）、`test`（`pytest`、`pytest-cov`）、`security`（`detect-secrets`），`dev` 用 `include-group` 聚合前三个。
- `[tool.uv]`：`required-version`，确保跑门禁的 uv 认识锁格式与 `--all-groups`。
- workspace 项目额外写 `[tool.uv.workspace]` 的 `members`，以及 `[tool.uv.sources]` 里对应成员的 `workspace = true`。

已有项目只补缺失的表；不归本插件所有的表永不重写。模板写入的每个值都是解析值，dry-run 会打印它来自哪里。

## 取值解析（existing > detected > default）

项目里的任何东西都不硬编码。每个闸门取值只按一个顺序读：

1. **existing** —— 项目自己的 `pyproject.toml` 配置；
2. **detected** —— 探测仓库得到的事实（`.python-version`、锁文件、`tests/` 还是 `src/<pkg>/tests`、workspace 成员、mypy/ty 是否存在、`.secrets.baseline`）；
3. **default** —— 插件默认值，集中在一处。

每个值都带来源，dry-run 打印的是 `ruff.line-length=88 (default)`，不会把猜测说成项目自己的声明。覆盖的值包括 Python 版本与目标、ruff 行宽与规则集、类型检查器与路径、测试目录、构建方式、覆盖率门槛、清单组件与状态基线。

## 版本清单

`release/agent_versions.json` 是 `manifest` 阶段校验的版本证据：schema 版本、服务、运行时，以及 agent 组件 —— prompt 文件、知识文件、索引、eval 集、源码树 —— 每项带路径与摘要。`scripts/validate_version_manifest.py` 是单个标准库文件，校验 schema、每条路径都在仓库根内、以及每个记录的摘要与磁盘文件一致。清单重新生成时是 diff-only：已有条目保留，只补缺失组件。项目没有 `uv.lock` 时，runtime 不写 `lockfile` 字段 —— 缺失就写明缺失，不猜成 `uv.lock`。

## Secret 检查

`scripts/secret_scan.py` 是只读的：扫描 git 跟踪的文件（或 `--staged` 时的暂存区 diff）并报告候选。`.secrets.baseline` 是带人工审核历史的文件，**本插件从不写它** —— 基线缺失时，security 阶段失败并给出指引；建立基线意味着先跑一次扫描，然后逐条审核每个发现，确认后才留下基线。为了变绿而覆盖基线会抹掉审核记录，插件不替你做这件事。

`detect-secrets` 放在 `security` 依赖组里，由 `uv sync --locked --all-groups` 安装。

## 提交钩子（prek）

`py-scaffold` 写出的 `.pre-commit-config.yaml` 包含它无法替项目钉版本的远程仓库（ruff + ruff-format、内置空白/YAML/TOML/合并冲突检查、shellcheck、actionlint、zizmor —— rev 故意留 `<latest>` 占位，注释里给出 releases 地址），以及两个跑项目自己门禁的 local 钩子：

- `gatekeeper` —— `uv run --locked python scripts/ci.py --profile commit`，语言 `system`，`pass_filenames: false`，`always_run: true`。
- `gatekeeper-secrets` —— `uv run --locked python scripts/secret_scan.py --staged`，同样设置；只扫暂存区，凭据就不会跟着提交走。

每个 clone 配一次：

```text
uv tool install prek
prek install                # 写 .git/hooks/pre-commit
prek run --all-files
```

首次运行需要 `.secrets.baseline`：先扫描，逐条审核，确认后才保留基线。`prek install` 才是「自动」的来源；没跑它时钩子文件不存在，面板会如实报告未安装。

## 安装

```text
plugin_manager action=install_bundle target=<本目录绝对路径>
```

bundle 会加进 `dsh.profile.bundles`，它的 patch 插入插件行；`GET /gatekeeper/status` 返回 200 就是 Host 半侧已就绪的证据。客户端半侧（面板 + 胶囊）需要刷新一次页面。

## 配置

三个开关、五个默认值，全部可选且 `.volatile()`，改动即时生效：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `tools.audit` | `true` | 注册 `py-audit`：只读体检 + workflow 审计 + 闸门顺序 |
| `tools.scaffold` | `true` | 注册 `py-scaffold`：生成九份门禁配置（默认只预览） |
| `tools.run` | `true` | 注册 `py-run`：在本机跑同一套质量闸门（默认 dry-run） |
| `defaultPythonVersion` | `3.13` | `.python-version` 与 `requires-python` 都没写时使用 |
| `matrixPythonVersions` | *（空）* | CI 矩阵，逗号分隔；留空则跟随项目自己的 Python 版本 |
| `testPaths` | *（空）* | 留空则使用探测到的测试目录 |
| `includeSecurityGate` | `true` | security 阶段（Secret 扫描、基线接线）是否进入生成物 |
| `includeIntegrationGate` | `false` | `integration` 阶段是否进入 CI |

两个环境变量覆盖版本设置、一个开关打开集成阶段；变量名沿用改名前的 `DSH_` 前缀，代码未改。

项目 Python 版本的读法只有一处、一个顺序：`.python-version` → `requires-python` 下界 → 默认值。`requires-python = ">=3.9"` 意味着目标 3.9 —— 下界是代码必须能解析的版本，声称支持 3.9 却按 3.13 做 lint，是仓库漂移的常见起点。

`@deepseek-ai/schemastery` 是**可选** peer 依赖。有它，面板显示生效配置；没有它，三个工具照默认值工作，面板如实说明而不假装能开关。

## 面板

左栏一个 Gatekeeper 座位（`main` + `sidebar.panellist`），一次显示一个项目：路径、包管理器、Python、lint、测试、CI，13 阶段矩阵（8 个默认阶段与 5 个可选阶段分别标注）、四个 job 分组、九个 apply 目标及其是否存在、git 钩子状态（是否安装、是否指向 prek）、Secret 基线状态，以及带来源标注的解析值。

它跟随会话而不是安装：路由接受 `?session=`，胶囊把它所在的会话 id 公布给面板，切换会话就切换面板。`?refresh=1` 重新读取而不是回放缓存快照；10 秒轮询让数字保持诚实又不闪烁。

路由是 `GET /gatekeeper/status` 与 `GET /gatekeeper/preview`，都带 `cache-control: no-store`：显示昨天的面板比什么都不显示更糟。preview 路由按 `?stages=` 命名渲染 workflow，先看变体再决定写不写。状态路由未挂载时（没有 `webServer` 的旧宿主），面板用一行字说明，三个工具照常工作。

## 技能包（输入框下方的模式按钮）

面板是「看」，技能包是「调」。输入框下方有一个 `技能包` 小胶囊：点开是**一个框里的三行可折叠分组**，每行按工具分组，共十六份文档。选中一份只往草稿里写**一个 skill 命令** —— 宿主用 `ctx.skills.register()` 注册的真实名字；不插入任何提示词，所以不存在「先删掉一段话才能打字」。宿主不支持插入时，命令复制到剪贴板，胶囊明说。

最后一次选择记在浏览器本地，刷新页面后胶囊与状态条都还在。

## 验证

```text
node test/smoke.mjs
node test/client.mjs
```

`smoke.mjs` 在系统临时目录里造一个 uv 项目和一个 Poetry 项目，然后按宿主的方式（`execute(args, exec)`）逐个驱动工具。断言的是行为而不是文案：拒绝、闸门顺序、矩阵、prek 的钩子与占位版本、Dependabot 的 cooldown 与分组、十六个 topic 都能读出来、十三个阶段（8 默认 + 5 可选）与 `all` 的默认选择、未知阶段被报出而不是被应用、以及生成的 `scripts/ci.py` 带着与 workflow 相同的 argv。`client.mjs` 在 VM 里渲染真实组件树（React 替身 + 假 fetch），座位注册坏了在进浏览器之前就会失败。

## 流水线 IR

`lib/pipeline/ir.js` 里有十三个阶段：八个默认（lock、sync、lint、type、manifest、test、security、build）与五个可选（integration、audit、container、release、deploy）。每个阶段带 argv、存在理由、所属 job 与依赖关系。三个渲染器读这一份来源：

- `lib/pipeline/github.js` → GitHub Actions workflow（jobs、`needs`、矩阵、权限、缓存、产物）
- `lib/pipeline/local.js` → `scripts/ci.py`，本地执行器
- `py-run` → 同一份 argv，执行

改一个门禁只改一处。workflow 里有、`py-run` 里没有的闸门，正是这套安排要让其不可能发生的 bug。

job 是隔离单元，不是为并行而并行：`quality` 承载八个默认阶段（以及可选的 `integration` / `audit`），`container` 需要 Docker，`release` 需要 tag 与写权限，`deploy` 依赖 release 与你提供的部署命令。container 的拆除渲染 `if: always()`，失败的 job 也会清理 compose 栈；`down -v` 保持注释步骤，需要你自己取消注释。release 复用 quality 已验证的 `dist` 产物而不是重新构建。deploy 的探活条件挂在 `vars.DEPLOY_HEALTH_URL` 上。

## 审计不是它写的流水线

`py-audit` 用十三条静态规则审 `.github/workflows/*`，按 `RULE_IDS` 的声明顺序：`pin-policy-mixed`、`job-timeout-missing`、`no-artifact`、`artifact-always-error`、`sync-unlocked`、`run-unlocked`、`pip-install`、`no-concurrency`、`permissions-missing`、`coverage-floor-missing`、`uv-version-drift`、`container-stage-missing`、`secret-in-run`。每条发现都点名文件、规则与改法。

十三条规则之外，release/deploy 矩阵也按 id 检查：`release-no-download-artifact`、`release-rebuilds`、`release-job-missing`、`deploy-placeholder-missing`（deploy job 里看不到 `::error::` 或 `exit 1`，就是静默通过的假绿）、`deploy-job-missing`；workflow 形状另有 `workflow-not-uv`、`workflow-stale`、`workflow-security-missing`。

## 什么能执行，什么不能

执行走十五条 argv 前缀、从不经过 shell：`uv`（`--version`、`sync`、`run`、`build`、`lock`）、`docker compose`（`config`、`ps`、`build`、`up`、`down`、`exec`、`logs`）、`docker build`；精确清单在 `lib/pipeline/exec.js`。除此之外没有，`shell: false` 始终成立。

两条限制明说而不是藏起来：

- `uv run` 等价于运行仓库自己的代码，所以门禁按设计就在跑可信代码。跑它们就是意义所在。
- 超时杀掉的是工具启动的进程，不是它派生出的孙进程。把超时读作「这个工具不再等了」，而不是「机器干净了」。

`docker compose down` 从不带 `-v`：门禁不能删命名卷。想要干净重来时，`compose-down-volumes` 以注释步骤生成，由你自己取消注释。

## 什么能写，什么不能

只有 `py-scaffold`，只有 `dryRun: false`，只写上面那九个路径，只在项目根之内。路径检查逐段解析符号链接，拒绝根之下的链接 —— 项目本身是链接（比如指向另一块盘的 Windows junction）照常工作；在项目里埋的链接不行。manifest 目标是 diff-only，已有版本文件不会被替换。

不改任何源文件。除工具自己的缓存目录外，不碰任何全局状态。

## 与四份上游 skill 的对应关系

| 上游 | 变成 |
| --- | --- |
| `1-uv` | 锁文件判据、拒绝句子、`uv-basics` / `uv-commands` 文档 |
| `2-modern-python` | pyproject / ruff / mypy / pytest / coverage 配置、prek 钩子、Dependabot、PEP 723、迁移与安全文档 |
| `3-ci-cd-and-automation` | 闸门顺序、本地执行器、`ci-design` |
| `4-github-actions-templates` | workflow 渲染器、`gh-workflow` |

本插件另写的四份文档 —— `ci-container`、`ci-pipeline`、`ci-release`、`ci-deploy` —— 补上游止步的地方：容器阶段、workflow 该有几个 job，以及生成器最容易因猜测而昂贵地弄坏的发布/部署一半。

## 随包 skill

`skills/` 下十六份文档，一份上游包一个目录，另加本插件新增的四份。`skills/VERSIONS.md` 记录复制了什么、什么时候复制；`scripts/sync-skills.mjs` 从源树重新复制 vendored 文档，而 `modern-python/templates/*` 两个文件不是 vendored —— 它们由 `lib/prek.js` 与 `lib/dependabot.js` 渲染。运行时这些文档被读出并注册进宿主的 `runtime` skill 层 —— 不往 `DSH_HOME/skills` 写任何东西。

## 验证

v0.10 的验证由 `test/smoke.mjs`（287 项）、`test/client.mjs`（76 项）与
`tmp/e2e-run.mjs`（在生成项目上跑 12 项端到端检查）组成。九个门禁命令也在空项目上
逐条跑过：`lock`、`sync`、`lint`、`type`、`test`、`build` 通过，项目没有源码或测试时
`type`、`test` 显示可见的 skip；`security` 在缺少 `.secrets.baseline` 时按设计失败，
并打印 `detect-secrets` 的 scan → audit 步骤。

检查项、已修缺陷与仍开放项的记录在 [docs/audit/version-audit.md](docs/audit/version-audit.md)，每条兼容性修复都附证据。

## 卸载

```text
plugin_manager action=remove_bundle target=gatekeeper
```

移除 bundle 会移除工具、座位、路由与已注册的 skill。`py-scaffold` 已经写进项目的文件留在原处；旁边的 `.bak.<timestamp>` 是当时的前一版内容。

## 审计留档

这个插件是从 DSH 0.2.1 适配到 0.2.2 的，做法是读宿主而不是猜宿主：直接看 `app.asar` 里的真实契约，再把发现写下来。这些记录留在仓库里，因为「能跑」不是一个可以验证的说法。

| 路径 | 是什么 |
|---|---|
| [docs/audit/version-audit.md](docs/audit/version-audit.md) | 主报告：发现的每处不兼容、最小修法、证据 |
| [docs/audit/host-contract.md](docs/audit/host-contract.md) | 宿主侧服务、事件、配置契约的实测结果 |
| [docs/audit/client-half.md](docs/audit/client-half.md) | 座位、输入区、斜杠触发源 |
| [docs/audit/runtime-evidence.md](docs/audit/runtime-evidence.md) | 运行期真实失败的复现记录 |
| [docs/audit/verify-round2.md](docs/audit/verify-round2.md) | 独立复验，连「没验证成什么」一起写 |
| [docs/audit/placement-sim.html](docs/audit/placement-sim.html) | 弹层包含块缺陷的浏览器复现页 |
| [scripts/audit/](scripts/audit/) | 可复跑的探针：`npm run audit`、`npm run verify` |

## 参与

见 [CONTRIBUTING.md](CONTRIBUTING.md)。三套测试只需要 Node（pipeline 相关另需 `uv`）。

## 许可

MIT，见 [LICENSE](LICENSE)。
