---
file: artifacts/report-naming.md
title: 报告命名与落盘（机械规则）
group_order: 5
loaded: 所有子Agent在写出产物文件前加载；主Agent在生成最终报告时加载
source: 续写，遵守 orchestrator/protocol.md 的"主Agent零裁量"原则
---

# artifacts/report-naming.md

> **加载时机**：所有子 Agent 在写出产物文件前加载；主 Agent 在生成最终报告时加载。
> **职责边界**：只定义文件名规则和最终报告的拼接规则。不定义报告内容、不定义审查逻辑。

## 第 1 节：文件命名规则

```
round{RN}-{stage}-{discriminator}.md
```

| 片段 | 定义 | 示例 |
|---|---|---|
| `round{RN}` | 轮次号，来自 `artifacts/round-detection.md`，无前导零、无后缀 | `round30` |
| `{stage}` | 波次标识，固定两位数字 + 短名 | `01-recon`、`02-audit`、`03-critique`、`04-fix`、`05-verify` |
| `{discriminator}` | 区分同一波次内多个实例的稳定标识 | `slice-07`、`slice-07-logic`、`skeptic`、`fix-017` |

**校验正则**：

```
^round(\d+)-(01-recon|02-audit|03-critique|04-fix|05-verify)-[a-z0-9]+(-[a-z0-9]+)*\.md$
```

**全路径**：`docs/reports/round{RN}/{文件名}`。

## 第 2 节：`{stage}` 与 `{discriminator}` 的取值

| 波次 | `{stage}` | `{discriminator}` 构成 | 完整示例 |
|---|---|---|---|
| 一·侦察 | `01-recon` | `slices`（固定常量，无论派出几个侦察实例都用同一个 discriminator） | `round30-01-recon-slices.md` |
| 二·审计 | `02-audit` | `{slice_id}-{dimension}` | `round30-02-audit-slice-07-logic.md` |
| 三·锐评 | `03-critique` | `{critique_role}` | `round30-03-critique-skeptic.md` |
| 四·修复 | `04-fix` | `fix-{finding序号}` | `round30-04-fix-017.md` |
| 五·验收 | `05-verify` | `verify-{finding序号}` | `round30-05-verify-017.md` |

**`discriminator` 的稳定性要求**：同一 `(round, stage, discriminator)` 三元组必须唯一。若一个实例被重派（`RETRYABLE_FAILURE` 后），新实例**覆盖**同名文件，而不是追加 `-v2`。理由：重派意味着旧输出已作废，保留旧文件会让最终报告误把作废内容计入。

**禁止的命名**：

- 时间戳后缀（`round30-02-audit-slice07-20261101.md`）——破坏幂等，重跑会产生新文件；
- 递增版本号（`-v2`、`-final`、`-final2`）——同上；
- 中文或空格——跨平台路径问题；
- 超过一个连字符的波次名（必须是固定的 `01-recon` 等五个之一）。

## 第 3 节：最终报告的结构

最终报告 `docs/reports/round{RN}/round{RN}-final-report.md`，**只做拼接和索引，不重写任何子Agent的结论**。

固定五个部分，顺序不变：

1. **元信息**：`round_id`、开始/结束时间、`trace_id`、`scale_decision` 摘要（`effective_slices`、`concurrency_window`、`agent_count`）。
2. **裁决索引表**：一行一条 `UPHELD` / `DOWNGRADED` / `REVOKED` 的发现，列 `finding_id`、原文 `severity`、最终裁决、`artifact_ref`。
3. **验收结果表**：一行一条修复，列 `finding_id`、`verdict`、`escalation_required`、`failure_category`（若有）、`artifact_ref`。
4. **未闭合项**：直接来自 `handoff-schema` 的 `open_items` 中 `blocking: true` 的条目，原样转写，不改写措辞。
5. **覆盖说明**：`deferred_slices` 与 `unverified` 的完整列表；若 `deferred_slices` 超过 `effective_slices` 的 50%，必须在此显式标注"本轮覆盖不完整"。

**"只拼接不重写"的操作定义**：

- 汇总文件的**每个结论单元**必须带 `artifact_ref` 指向原始文件；
- 主Agent不得修改原始文件中的任何措辞、严重性、裁决结论；
- 主Agent可以做的只有三件事：排序、加索引、加统计数字（统计必须可复核，即读者能按索引自行数出同样的结果）。

## 第 4 节：目录结构

```
docs/reports/
├── round{N}/
│   ├── round{N}-01-recon-slices.md
│   ├── round{N}-02-audit-slice-01-logic.md
│   ├── ...
│   ├── round{N}-03-critique-skeptic.md
│   ├── round{N}-04-fix-017.md
│   ├── round{N}-05-verify-017.md
│   └── round{N}-final-report.md
```

**向后兼容**：历史上存在 `round16/` ~ `round29/` 目录与 `round2-audit.md` 等散落文件（两种命名风格）。本规则**只约束新产出**，不要求重命名历史文件。`artifacts/round-detection.md` 的探测逻辑同时兼容两种形态。

## 第 5 节：写入纪律

| 规则 | 说明 |
|---|---|
| 只写自己那一个文件 | 每个子Agent只允许写入属于自己的产物文件，不得写其他的 |
| 不覆盖他人文件 | 唯一允许的覆盖是"自己重派后的自我覆盖"（见第 2 节） |
| 不写历史轮次目录 | 本轮产物只能写 `round{RN}/`，不得修改 `round{M}`（M ≠ RN） |
| 临时文件不入库 | 复现脚本等临时产物写入系统临时目录，路径在 `payload` 中说明 |
| 不创建额外目录 | 除 `round{RN}/` 外不新建目录 |

**主Agent的写权限**：主 Agent 只写两个文件——账本（由 harness 提供）与最终报告 `round{N}-final-report.md`。它**不得**写任何波次产物文件。

## 第 6 节：幂等与冲突

| 情形 | 处理 |
|---|---|
| 同一文件被重复写入（重跑同一实例） | 覆盖，内容以最后一次为准 |
| 两个实例试图写同名文件 | 说明 `discriminator` 设计有误——同一 `(round, stage, discriminator)` 应只对应一个实例。主Agent发现冲突时作废两者并按 `protocol.md` 重派 |
| 目标目录已存在同名历史文件（跨轮次冲突） | 不可能发生（路径含 `round{RN}`），除非 `round_id` 被中途改动——见 `round-detection.md` 第 7 节 |
| 写入失败（磁盘满、权限） | 返回 `PERMANENT_FAILURE`，`error_type: "ToolError"`，不得假装成功 |

## 第 7 节：自检清单

| 检查 | 通过条件 |
|---|---|
| 文件名合规 | 匹配第 1 节的正则 |
| 路径在正确轮次 | 全路径以 `docs/reports/round{RN}/` 开头 |
| `discriminator` 唯一 | 同一 `(round, stage, discriminator)` 本批次只一个实例 |
| 未越权写入 | 只写了自己的产物文件 |
| 最终报告只做索引 | 每个结论单元带 `artifact_ref`，未改写原文措辞 |
| 覆盖说明完整 | `deferred_slices` 与 `unverified` 全部列出，超 50% 有显式标注 |
