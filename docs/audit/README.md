# 审计留档

[English summary below](#english-summary)

这里是把本插件从 DSH 0.2.1 拉到 0.2.2 期间的工作文档，**按当时的原样保留**，没有事后润色。里面有走过的弯路和后来的更正，因为审计过程本来就长这样。

| 文件 | 是什么 |
|---|---|
| `version-audit.md` | 主报告：发现 F1–F10、每条的最小修法、修复顺序、证据索引 |
| `host-contract.md` | 宿主侧的服务、事件、配置 schema，从活宿主读出来的 |
| `client-half.md` | Slot、composer、斜杠触发源，以及没能验证的部分 |
| `runtime-evidence.md` | 真正在运行时看得见的那些失败的复现记录 |
| `verify-round2.md` | 独立第二意见，明确列出了它查不了的东西 |
| `placement-sim.html` | 一个独立浏览器页面，用三种布局模式复现弹层的包含块缺陷 |

## 读之前要知道的两件事

**测量是在 DSH 0.2.2-rc.1 上做的。** 之后对着接替它的 0.2.2-rc.5 做了复验，确认了最容易先坏的那几处：`py-audit` 能跑且输出仍满足 lossless JSON；`/gatekeeper/status` 返回 `degraded: false` 与它的 16 个技能；`sidebar.panellist` 与 `conversation.input.dock` 两个座位都还在、且处于 active。**报告里的版本号是当时为真的那个**，不是现在的。

**报告里有些路径指向的文件不在这里。** 那些一次性诊断脚本活在作者的工作树里（`audit/tmp/…`），刻意没有发布。值得留下的探针被改写成与 checkout 无关的形式，移到了 [`../../scripts/audit/`](../../scripts/audit/)。发布前**绝对路径换成了占位符**（`<DSH_HOME>`、`<checkout>`、`<install>`、`<project>`）——结论不依赖它们，依赖的只是当初复现它的那台机器。

探针现在仍然可以跑：

```bash
node scripts/audit/version-audit.mjs
node scripts/audit/verify-fixes.mjs
node scripts/audit/verify-async.mjs
```

## English summary

These are the working documents from bringing this plugin from DSH 0.2.1 to
0.2.2, kept as they were written rather than tidied afterwards — dead ends and
corrections included, because that is what an audit looks like while it is
happening. The documents themselves are in Chinese.

**The measurements were taken against DSH 0.2.2-rc.1.** A later re-check against
0.2.2-rc.5, the release that replaced it, confirmed the parts that would break
first: `py-audit` runs and its output still serializes losslessly,
`/gatekeeper/status` answers with `degraded: false` and its 16 skills, and the
`sidebar.panellist` and `conversation.input.dock` seats are both still occupied
and active. Version numbers inside the reports are the ones that were true when
they were written.

**Absolute paths were replaced with placeholders** (`<DSH_HOME>`, `<checkout>`,
`<install>`, `<project>`) before publishing. The one-off diagnostic scripts were
not published; the probes worth keeping were rewritten to be checkout-relative
and moved to [`../../scripts/audit/`](../../scripts/audit/), where they still run:

```bash
node scripts/audit/version-audit.mjs
node scripts/audit/verify-fixes.mjs
node scripts/audit/verify-async.mjs
```
