# 参与与维护

[English](CONTRIBUTING.md) · **简体中文**

## 拿到一份能改的开发副本

Gatekeeper 以 `link:` 依赖的形式挂在某个 DSH profile 里，所以你改的文件和宿主加载的文件是同一份——没有构建步骤，也不用拷贝。

```bash
git clone https://github.com/zxd15978684198/dsh-gatekeeper.git
cd dsh-gatekeeper
```

然后把某个 profile 指向你的工作副本：

```jsonc
// <DSH_HOME>/profiles/<profile>/package.json
{
  "dependencies": { "gatekeeper": "link:/path/to/dsh-gatekeeper" },
  "dsh": { "profile": { "bundles": ["gatekeeper"] } }
}
```

在该 profile 里装依赖、重启 DSH，面板就出来了。**改客户端代码只需刷新页面；改宿主代码需要重启。**

## 四套测试

全部是普通 Node 脚本，手写断言、不装测试框架：

```bash
node test/smoke.mjs        # 宿主侧：工具、流水线、拒绝路径、生成出来的文件
node test/client.mjs       # 客户端侧：slot 注册、定位数学、胶囊
node test/exec-async.mjs   # 执行器：异步 spawn、超时、取消、拒绝

# 三套一起跑
npm run test:all
```

客户端那套用一个极小的 React shim 跑 `client/panel.js`，所以界面会用到、又需要单测的纯函数必须保持「可 import、无副作用」——`placementSolve`、`detailOffset`、`arrowOffset` 就是为了这个才显式导出的。

## 审计探针

`scripts/audit/` 里是把这个插件从 DSH 0.2.1 拉到 0.2.2 时用的兼容性探针。它们不随插件发布，但一直保持可跑：

```bash
node scripts/audit/version-audit.mjs   # 对着已安装的 DSH 跑四层检查
node scripts/audit/verify-fixes.mjs    # 本插件修掉的每个回归各一条断言
node scripts/audit/verify-async.mjs    # 端到端：真的 uv、真的项目
```

路径从探针自身位置以及 `DSH_PROFILE_DIR` / `DSH_HOME` / `DSH_PROFILE` 推导；profile 放在非常规位置时设置 `DSH_PROFILE_DIR`。

## 什么样的改动算好

- **一个提交只做一件事**，理由写进提交信息。「为什么」比「做了什么」有用：推理只活在历史里。
- **先有一个能失败的回归测试。** `docs/audit/version-audit.md` 里每条都有；新行为也要有。
- **不引入新的运行时依赖。** 宿主那半边跑在 DSH 自己的运行时里，`react` 和 `@deepseek-ai/schemastery` 由它提供，其余只能用 Node 标准库。
- **兼容性修复不改行为。** 宿主换代时的修法都刻意保持插件表面不变；你的改动同理。

## 报告问题

缺陷与不兼容：开 issue，附上 DSH 版本、插件版本，以及确切的 `argv` 或面板状态。安全问题请看 [SECURITY.zh-CN.md](SECURITY.zh-CN.md)。
