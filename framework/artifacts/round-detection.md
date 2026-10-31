---
file: artifacts/round-detection.md
title: 轮次探测（机械规则）
group_order: 5
loaded: 主Agent在波次一启动前派一个轻量Agent执行；主Agent本身不执行本文件中的任何读取动作
source: 续写，遵守 orchestrator/protocol.md 的"主Agent零裁量"原则
---

# artifacts/round-detection.md

> **加载时机**：主Agent在波次一启动前，派一个轻量 Agent 执行本文件。
> **职责边界**：只做轮次号的机械探测。不做项目分析、不评价历史报告质量、不决定本轮该审什么。
> **为什么必须由子Agent执行**：本文件需要读取目录，而 `protocol.md` 禁止主Agent使用任何文件读取工具。

## 第 1 节：输出契约

轮次探测Agent的返回是一个极小的结构化对象：

```json
{
  "round_id": "round30",
  "round_number": 30,
  "scan_root": "docs/reports",
  "scanned_entries": 43,
  "matched_entries": 31,
  "max_found": 29,
  "max_source": "docs/reports/round29/",
  "created_root": false,
  "anomalies": [
    { "entry": "docs/reports/round23b/", "reason": "VERSION_SUFFIX", "treated_as": 23 },
    { "entry": "docs/reports/project-critique-2026-10-19.md", "reason": "NON_ROUND_NAMING", "treated_as": null }
  ]
}
```

主Agent只消费 `round_id` 和 `anomalies`。它不重新计算轮次号。

## 第 2 节：探测步骤（确定性序列）

按顺序执行，不得跳步、不得调整顺序：

1. **检查扫描根**。若 `docs/reports` 不存在，创建它（这是唯一允许的写动作），并在返回中置 `created_root: true`。若存在但不是目录（例如是一个同名文件），返回 `PERMANENT_FAILURE`，`error_type: "InputValidationError"`，说明该路径被占用。
2. **枚举条目**。列出 `docs/reports` 下的**直接子项**（一层，不递归）：目录名与文件名都要，包括不带扩展名的。**跳过 `.round-claims/` 隐藏目录**（它是本文件第 5 节的占位锁目录，不是轮次产物）。
3. **逐个匹配模式** `^round(\d+)([a-z]*)$`（大小写不敏感，见第 3 节的规则），匹配对象是**条目名去掉扩展名后**的部分。
4. **归一化后缀**。捕获组 2 为目标后缀，用于同号判定（见第 4 节），**不参与**数值比较。
5. **取最大值**。在全部匹配成功条目的数值中取 `max`。
6. **计算轮次号**。`round_number = max + 1`；若没有任何匹配条目，`round_number = 1`。
7. **组装 `round_id`**。固定格式 `round{N}`，无前导零、无后缀。
8. **返回**。写入第 1 节的结构化对象。

**硬规则**：本文件的所有判断都是模式匹配和数值比较，**不包含任何"这个目录看起来像不像一轮"的主观判断**。

## 第 3 节：匹配模式的精确定义

| 规则 | 定义 |
|---|---|
| 正则 | `^round(\d+)([a-z]*)$`，作用于条目名的 basename（去掉最后一个扩展名） |
| 大小写 | 匹配时统一转小写；`Round16`、`ROUND16` 都视为匹配 |
| 前导零 | 允许，按数值处理。`round0999` 数值为 `999`，不是字符串比较 |
| 数值上限 | 超过 `10^6` 视为 `SUSPICIOUS_RANGE`，记录到 `anomalies` 但**仍参与**最大值计算（不因可疑而忽略，否则会导致轮次号回退） |
| 空数字 | 形如 `round.md`、`round-`、`round(` 不匹配（捕获组必须至少一个数字） |
| 尾部后缀 | 仅允许**纯小写字母**。`round23b` 匹配（数值 23，后缀 `b`）；`round23-backup`、`round23_old`、`round23 (1)` **不匹配**，记为 `NON_ROUND_NAMING` |

## 第 4 节：边界情况判定表

| 情况 | 判定 | 处理 |
|---|---|---|
| `docs/reports` 不存在 | 正常首次运行 | 创建目录，`created_root: true`，`round_number = 1` |
| `docs/reports` 存在但为空 | 正常 | `round_number = 1`，`scanned_entries: 0` |
| 目录为空、但有非 round 命名的文件 | 不构成轮次 | 忽略，记入 `anomalies` 的 `NON_ROUND_NAMING` |
| `round23b` 与 `round23` 同时存在 | 同一轮次的变体 | 取数值 `23`；**不**因后缀而 +0.5 或 +1 |
| 只有 `round23b` 没有 `round23` | 后缀不影响数值 | 数值仍为 `23`，下一轮为 `24` |
| 跳号：有 `round18` 和 `round21`，缺 19、20 | 正常（历史跳号） | 取 `max = 21`，下一轮 `22`。**不回填**缺失号 |
| `round0999` 前导零 | 数值 999 | 下一轮 `round1000` |
| 大小写混合 `Round16` | 匹配 | 同一数值空间 |
| 同名既是目录又是文件（`round16/` 与 `round16.md`） | 均为同一轮次的产物 | 数值只计一次，`anomalies` 记 `DUP_NAME_TYPES` |
| 符号链接指向 `docs/reports` 外部 | 不跟随 | 记 `SYMLINK_SKIPPED`，不读取链接目标 |
| 无法读取目录（权限） | 阻塞 | 返回 `PERMANENT_FAILURE`，`error_type: "ToolError"`，**不得**假设"没有轮次"而返回 1 |
| 条目名含非 ASCII 或空格 | 不匹配 `round` 模式则忽略 | 记 `NON_ROUND_NAMING` |
| 数值极大赛过 `10^6` | 可疑但合法 | 参与计算，记 `SUSPICIOUS_RANGE` |
| 只有 `.gitkeep` 之类的占位文件 | 无匹配 | `round_number = 1` |

**关键纪律**：遇到任何**无法确定**的情况，不得猜测。要么记入 `anomalies` 后按规则继续（当规则已明确覆盖时），要么返回 `PERMANENT_FAILURE`（当规则未覆盖时）。**不得**自行发明一条新规则来"让流程继续"。

## 第 5 节：并发与幂等

**问题**：如果两个 Agent 同时执行轮次探测，可能拿到同一个 `round_number`，导致两批产物写入同一轮次目录。

**解决方案（按优先级）**：

1. **优先**：由主Agent保证同一时刻只有一个探测Agent在跑。这是默认情况——轮次探测在波次一**之前**串行执行，不参与并发扇出。
2. **若 harness 支持原子创建**：探测Agent在算出 `round_number` 后，立即以**独占方式**创建占位文件 `docs/reports/.round-claims/round{N}.claim`（注意：占位文件放在 `docs/reports` 下的**独立隐藏目录** `.round-claims/`，不放进 `round{N}/` 内，以免污染该轮次的产物目录、也不被 `report-naming.md` 的命名正则约束）。创建成功即锁定该号；若创建失败（已存在），说明被其他实例抢占，**重新扫描并取 max+1**，最多重试 3 次。
3. **若 harness 不支持原子创建**：探测Agent在返回中附带 `claim_token`（时间戳 + 随机串），主Agent负责校验唯一性。若发现两个探测结果冲突，主Agent作废两者并按 `protocol.md` 第 4 节派、全量重跑探测。

**禁止**：用"当前时间戳"代替轮次号（会破坏历史连续性），或用"随机数"（会导致目录膨胀）。

## 第 6 节：幂等与重跑

同一个 `round_id` 被重复探测时，结果必须一致。因此：

- **探测只读**（除了首次创建 `docs/reports`、占位锁与空目录），不修改任何历史条目；
- 若上一轮探测成功但流程中途失败需要重跑，主Agent**复用**已写入账本的 `round_id`，**不重新探测**——重新探测会把 `round30` 变成 `round31`；
- 只有当账本中 `round_id` 缺失（例如账本本身损坏）时，才重新探测。

**判据**：账本中 `round_id` 字段非空 → 直接使用，不探测。空 → 探测一次并写入。

### 「孤儿轮次目录」的回收规则

存在一种真实的崩溃场景：探测Agent创建了 `round30/` 并写入了部分产物，但主Agent在把 `round_id` 写进账本之前崩溃。此时账本为空，按上面的判据会重新探测，得到 `max = 30` → `round31`，而 `round30/` 里躺着半成品，成为永久孤儿。

**处理规则**：重新探测时，若 `max_source` 指向的 `round{N}/` 目录满足**全部**下列条件，判定为孤儿轮次，**复用 `N` 而不是取 `N+1`**：

1. 该目录中存在 `docs/reports/.round-claims/round{N}.claim`，且 claim 文件内的 `trace_id` **不等于**本次运行的 `trace_id`（说明是上一次运行的残留）；
2. 该目录下**没有** `round{N}-final-report.md`（说明上一轮没有正常闭合）；
3. 该目录下所有产物文件的时间戳都早于本次运行的启动时间。

三个条件全部满足 → 返回 `round_number = N`，并在 `anomalies` 中记 `ORPHAN_ROUND_REUSED`，`detail` 写明复用了哪个目录、含多少个残留文件。主Agent据此决定是清空重跑还是续跑（这是主Agent的调度决策，不是探测Agent的判断）。

**只满足部分条件时**：**不复用**，按 `max+1` 正常推进，并在 `anomalies` 中记 `ORPHAN_ROUND_DETECTED`。理由：宁可留下一个孤儿目录（可在最终报告中说明），也不能因为误判而复用一个可能已经正常闭合的轮次，那会让两轮产物混在一起。

**孤儿目录必须在最终报告中暴露**：无论是否复用，`anomalies` 中的孤儿条目都要写入 `round{RN}-final-report.md` 的「覆盖说明」部分（见 `artifacts/report-naming.md` 第 3 节第 5 项），不允许静默留下垃圾目录。

## 第 7 节：与账本的对接

探测结果写入账本的以下位置，`protocol.md` 的波次门控与 `artifacts/report-naming.md` 直接消费：

```
ledger.round_detection:
  round_id: "round30"
  round_number: 30
  detected_at: "ISO8601"
  detected_by: "agent-id"
  anomalies: [...]            # 原样透传，最终报告必须列出
  claim_token: "string|null"
```

主Agent在写入后**不再回头修改**。若后续波次发现 `round_id` 有误，正确做法是**终止本轮并在最终报告中说明**，而不是中途换号——中途换号会让已产出的文件散落在两个轮次里。
