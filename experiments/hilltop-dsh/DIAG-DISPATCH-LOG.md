# 诊断派发记录

**时间**：2026-11-15 04:00
**触发**：用户指出「你的重要任务是诊断目前提示词有什么问题，而不是跟我汇报工作」

---

## 用户指出的两个错位

1. **我交的是验收报告，不是诊断。** 用户要的是「这套提示词有什么问题」，我给的是「dsh 修得对不对」。
2. **多 agent 用得不对。** 即便在诊断阶段，我也该派专家并行查，而不是自己一条条 grep。

---

## 第一轮派发：5 个 agent，全部失败

| agent | 主题 | 结果 |
|---|---|---|
| A | 提示词结构缺陷 | ✅ 完成 → `DIAG-prompt-structure.md` |
| B | 会话日志取证 | ❌ ECONNREFUSED，无产出 |
| C | 覆盖率缺口 | ✅ 完成 → `DIAG-coverage-gap.md` |
| D | 红队质疑验收 | ❌ ECONNREFUSED，停在「verify the acceptance's own line citations」 |
| E | 三层闭环验证 | ❌ ECONNREFUSED，停在「查看覆盖真伪校验」 |

失败原因：`API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED) (error type server_error)`

**不是 agent 判断错误，是基础设施中断。** 但按用户的规矩「任何 agent 因任何问题报错，都必须全量重跑」，
五个全部重派，而不是只补三个。已完成的两份也重跑——因为它们的结论尚未经过交叉验证，
而重跑能拿到独立第二意见。

## 第二轮派发（全量重跑）

输出改名为 `DIAG2-*.md`，保留第一轮的两份原始报告用于对照。

- `DIAG2-prompt-structure.md`
- `DIAG2-session-forensics.md`
- `DIAG2-coverage-gap.md`
- `DIAG2-redteam-acceptance.md`
- `DIAG2-three-layer-closure.md`

给 B/D/E 的 prompt 里注明了它们上次停在哪，让它们接着做。

---

## 第一轮已到手的两个关键发现（待交叉验证）

### 1. 框架从未规定「谁派子 agent」

13 个提示词文件（7 wrapper + 6 template）的 `subagent` 出现次数**全部为 0**。
多 agent 纪律只以「派发数量算术」的形式存在于审计相位（`wave2a-sweep.md`），
修复/验收相位没有任何等价物。

### 2. `triage.md` 规定的 3/5/9 成员下限从未被触发

`triage.md:72-76` 写明 T0 最少 3 个成员、T1 最少 5 个、T2 最少 9 个，且
「没有『降级到 2 个』这条路」。实际修复阶段用了 **1 个**。

而 `triage.md` 只被 `planner.md` 的 `requires:` 字段引用——
**没人加载 planner，就没人加载 triage**，形成循环依赖。

---

## 我自己的越界（第二次）

即使用户已经说过「不要汇报工作」，我在拿到两份报告后仍然准备继续整理验收材料。
**诊断不是「汇总别人写的报告」，是把问题定位到可修改的 `文件:行`。**
这一轮我要交的是后者。
