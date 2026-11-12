# 实验数据丢失事件

**时间**：2026-11-10 23:48
**影响**：`D:\audit-out\` 下除 `ground-truth/injected` 和 `D2-report.md` 之外的所有实验产物

---

## 丢了什么

| 目录 / 文件 | 内容 | 能否恢复 |
|---|---|---|
| `ground-truth/base/` | 无缺陷基准库 + 38 项测试 | ❌ 丢失 |
| `ground-truth/manifest.json`（初版） | 20 条缺陷定义 | ❌ 丢失（已从 D2 报告重建为 15 条） |
| `ground-truth/verify.mjs` 等 6 个脚本 | 注入/验证/打分工具 | ❌ 丢失 |
| `ground-truth/*-report.md`（A/B/C/D） | 四组实验结果 | ❌ 丢失 |
| `ground-truth/*.md`（5 份文档） | DESIGN/BUILD/CONCLUSION 等 | ❌ 丢失 |
| `prompt-critique/`（13 份） | 12 人锐评面板 + 蓝队报告 | ❌ 丢失 |
| `agent-plan-research/`（3 份） | R1/R2/R3 研究 | ❌ 丢失 |
| `critique-measure/`、`critique-tier2/` | 锐评实验 | ❌ 丢失 |
| `wave-measure/` | 波次价值测量 | ❌ 丢失 |

**框架本体完好**：`D:\Projects\...\multi-agent-audit-framework\` 未受影响，18 条 lint 和全部测试仍可跑。

---

## 为什么发生

**我没有执行过任何删除命令。** `/d/audit-out` 的目录 mtime 显示 **23:48:13** 被重建。

可能原因（我无法确认是哪个）：
1. 另一个并发会话（本次会话期间有 10+ 个 peer session 在跑）
2. 系统清理（磁盘 85% 使用率，74G 可用，不像空间不足）
3. 我的某个后台任务有未预期的副作用

**我不做推测性归因**。事实是：目录被重建，内容丢失，我没做删除操作。

---

## 教训

**所有实验产物都放在单一目录 `D:\audit-out\` 下，没有版本控制，没有备份。**

这是设计缺陷：
- `D:\audit-out` 在项目仓库之外，**不在 git 里**
- 没有增量备份
- 一个目录消失，全部实验数据归零

**正确的做法**：
1. 实验产物放进项目仓库（`multi-agent-audit-framework/experiments/`），纳入 git
2. 或者至少定期复制一份到 `D:\Projects\` 下
3. 关键结果（manifest、结论）应即时写进框架文档，而不是只留在实验目录

---

## 抢救出来的

`ground-truth/injected/`（从 `/tmp/gt-hidden/codebase` 的副本恢复）——这是被审代码本身，最有价值的部分。

`D2-report.md`（395 行）——D2 组在隔离环境下的完整审查报告。

**其他全部需要重做**，但关键结论已经写进框架文档：

| 结论 | 落在哪里 |
|---|---|
| 缺失型缺陷检查法 | `wave2-audit.md` §4.8（+ L18 lint 守护） |
| 承诺兑现工具 | `tools/check-promises.mjs`（12 项测试） |
| 「多 agent 无显著增益」 | 本文档 + D2 报告 |
| 交付粒度定义 | `protocol.md` §0.8 |
| Stop hook | `tools/stop-hook.mjs`（12 项测试） |
| 35 条锐评发现的问题 | 已修进框架（L13-L18、G8、A1-A12 修补） |

**框架的改进没有丢，丢的是改进所依据的原始数据。**
