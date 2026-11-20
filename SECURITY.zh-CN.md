# 安全

[English](SECURITY.md) · **简体中文**

## 这个插件能对你的机器做什么

Gatekeeper 会生成配置；你让它跑的时候，它也会执行命令。两条路径都刻意收得很窄，装之前都值得知道清楚。

**写文件只有一条路：`py-scaffold`，只在 `dryRun: false` 时，且只写九个固定目标**（`pyproject.toml`、`.pre-commit-config.yaml`、`.github/dependabot.yml`、工作流文件、`scripts/ci.py`、`scripts/validate_version_manifest.py`、`scripts/secret_scan.py`、`scripts/container_report.py`、`release/agent_versions.json`）。每次覆盖都会把原文件留在旁边，命名成 `<name>.bak.<时间戳>`。项目根目录之外不写任何东西。

**跑命令只有一条路：`py-run`，且只跑十五项 argv 白名单里的程序**（`uv`、`ruff`、`pytest`、`docker`、`git` 等）。argv 是逐字匹配的——被拒绝的命令根本到不了 `spawn`。`rm -rf /` 是测试用例，不是假想。各阶段顺序执行、第一次失败即停，单阶段上限 300 秒、总预算 900 秒。

**它不回传任何东西。** 没有遥测、没有版本检查、自己不发起任何网络请求。唯一的外部流量，是你让它跑的 `uv` / `pytest` / `docker` 自己产生的。

**它的 HTTP 路由没有鉴权**（`/gatekeeper/status`、`/gatekeeper/preview`），和 DSH 其它插件路由一样。它们是只读的，在 `127.0.0.1` 上提供当前会话项目的状态；DSH 不会把它们暴露到回环网卡之外。

## 报告安全问题

在本仓库开一条私密安全公告（Security → Advisories → Report a vulnerability），或发到 `package.json` 的 `author` 字段里的邮箱。**请不要**为「命令能逃出白名单」「写到项目根之外」「泄漏你机器上的路径」这类问题开公开 issue。

报告里请附上插件版本、DSH 版本（`dsh --version`，或应用「关于」里的版本），如果涉及命令执行，还要附上你请求的 `argv`。
