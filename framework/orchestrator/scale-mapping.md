---
file: orchestrator/scale-mapping.md
title: 规模映射：切片数 → 派发量与并发窗口
group_order: 2
loaded: 主Agent在波次一闭合后、波次二派发前加载
source: https://chat.deepseek.com/share/yn99k1mum4qp5fqwj8 (第 6 轮)
---

# orchestrator/scale-mapping.md

## 文件头部：强制加载声明

> scale-mapping.md
> 主Agent在波次一闭合后、波次二派发前加载。
> 本文件是查找表 + 算术规则，不是分析指南。
> 主Agent不得修改、合并或覆盖本文件中的任何映射值。
> 如果 harness 的并发上限低于本文件的并发窗口，取 min(本文件值, harness_cap)。

---

## 第 1 节：输入契约——主Agent只允许读取这六个字段

侦察Agent的 `output-contract` 保证以下字段的存在和类型。主Agent**不读取 `audit_slices` 内部的文件路径**来做任何筛选，因为切片已经是侦察Agent按独立性筛过的产物。主Agent如果因为“某个切片看起来小”而合并它，就重新引入了主观裁量。

| 字段 | 类型 | 用途 | 缺失时行为 |
|---|---|---|---|
| `slice_count` | int | 必须等于 `len(audit_slices)` | 视为 `CONTRACT_VIOLATION`，重派侦察Agent |
| `audit_slices` | list[object] | 每个元素对应一个发现波Agent | 空列表视为 `CONTRACT_VIOLATION` |
| `unverified` | list[string] | 无法归入任何切片的路径，作为追加切片 | 空列表是合法值 |
| `entry_points` | list[string] | 只传给验收波，**不参与规模计算** | 空列表时标记 `unverified` |
| `covered_modules` | list[string] | 历史轮次已深度审计的模块 | 仅当账本中显式存在时才使用 |
| `harness_concurrency_cap` | int | 由侦察Agent从运行时读取或声明 | 缺失时取保守值 `4` |

**关键约束**：`slice_count` 必须与 `audit_slices` 长度一致。如果不一致，主Agent不做“以哪个为准”的判断，直接标记 `CONTRACT_VIOLATION` 并重派侦察Agent。

---

## 第 2 节：有效切片数计算——唯一的算术步骤

```
effective_slices = len(audit_slices) + len(unverified)
```

如果 `covered_modules` 非空且账本中带有明确的“上轮审计成功”标记，执行**受控折减**：

```
eligible_for_skip = 仅当切片的所有文件路径都落在 covered_modules 内
skip_count = min(len(eligible_for_skip), floor(effective_slices * 0.30))
effective_slices = effective_slices - skip_count
```

折减有三个硬边界：

1. 折减后 `effective_slices` 不得小于 1；
2. 折减比例不超过原始值的 30%；
3. **如果账本中没有 `covered_modules` 或没有“上轮成功”标记，折减步骤完全跳过**，主Agent不得自行推测“这个模块以前可能审过了”。

---

## 第 3 节：映射表——从 `effective_slices` 到计划量与并发窗口

这张表是 `scale-mapping.md` 的核心。主Agent拿到 `effective_slices` 后，**只做区间匹配，不做区间内的微调**。

| `effective_slices` | 发现波计划量 | 锐评波基础角色 | 锐评波追加 | 修复波 | 验收波 | 单波并发窗口 |
|---|---|---|---|---|---|---|
| **1–5** | `= effective_slices` | Skeptic + Arbiter | 无 | 每条 `UPHELD` 1 个 | 每条修复 1 个 | `min(5, harness_cap)` |
| **6–20** | `= effective_slices` | Skeptic + Devil's Advocate + Arbiter | 无 | 每条 `UPHELD` 1 个 | 每条修复 1 个 | `min(8, harness_cap)` |
| **> 20** | `= effective_slices` | 同上 3 角色 | +1 交叉模式扫描 | 每条 `UPHELD` 1 个 | 每条修复 1 个 + 1 回归扫描 | `min(8, harness_cap)` |

**逐条解释**：

- **发现波计划量永远等于 `effective_slices`**。侦察Agent返回 17 个切片，发现波就计划 17 个Agent；返回 3 个，就计划 3 个。主Agent不得因为“17 个太多”而合并，也不得因为“3 个太少”而拆分。
- **锐评波不随切片数线性增长**。6–20 档和 >20 档的基础角色都是 3 个（Skeptic、Devil's Advocate、Arbiter），>20 档只追加 1 个交叉模式扫描，因为大规模代码库中“未被任何切片覆盖的模块”风险更高，而不是因为“切片多所以锐评也要按比例多”。
- **修复波和验收波按问题数派，不按切片数派**。一个切片可能产出 0 条或 5 条 `UPHELD` 发现；修复Agent的数量由仲裁后的发现数决定，与 `effective_slices` 无关。
- **并发窗口是上限，不是目标**。`min(8, harness_cap)` 意味着：harness 支持 16 并发时，窗口仍然是 8；harness 只支持 4 并发时，窗口是 4。主Agent不得因为“窗口没用满”而提高并发数。

**为什么并发窗口不随切片数增长**：HiveMind 的实测数据显示，无协调的并行Agent在高争用下失败率可达 72–100%，而引入准入控制和背压后失败率降至 0–18%[^ref1]。并发窗口的作用是**把瞬时争用控制在可协调的范围内**，而不是把硬件或API配额吃满。计划量（population）和并发窗口（throughput）是两个独立变量，必须解耦。

---

## 第 4 节：队列与排出——计划量大于窗口时的行为

当 `effective_slices > 并发窗口` 时，主Agent执行**准入-排队-排出（admit-and-queue, then drain）**，而不是拒绝或合并。

**硬规则**：

1. **所有切片一次性进入 `PENDING` 队列**，主Agent不预筛选、不预排序（排序规则由第 5 节的滚动窗口决定）；
2. 主Agent在任意时刻**只维持 `并发窗口` 个 `RUNNING` 状态的Agent**；
3. 每当一个 `RUNNING` Agent 进入终态（`SUCCESS` / `RETRYABLE_FAILURE` / `CONTRACT_VIOLATION` / `PERMANENT_FAILURE`），**立即从 `PENDING` 队列头部取下一个切片派发**，填补空出的槽位；
4. **不等待整批完成再派下一批**。这是滚动窗口，不是固定分块。

**队列可见性**：账本中必须同时维护 `running_count` 和 `queued_count` 两个独立计数，主Agent在每次调度决策后更新。如果 harness 的运行时支持状态面，这两个计数应当可被外部观测；如果不支持，主Agent必须在账本的每次更新中写入这两个值。

**准入上限**：除了并发窗口之外，设置一个**独立的准入/总量上限**：

```
admission_ceiling = min(60, effective_slices + 30)
```

这个上限的存在是为了防止队列无界增长——当 `PENDING + RUNNING + COMPLETED` 总数触达 `admission_ceiling` 时，主Agent停止接受新切片，将剩余切片标记为 `DEFERRED` 并写入最终报告的“未覆盖”部分，而不是无限排队。

**与 `protocol.md` 第 6 节的关系**：`protocol.md` 规定**单次运行总Agent数上限 = 60**（硬护栏，跨波次累计，包括发现波、锐评波、修复波、验收波的所有实例）。本节的 `admission_ceiling` 是**单波次内**的队列上限，二者是不同层级的约束，且 `admission_ceiling` **不得超过** 60：

- `effective_slices ≤ 30` 时，`admission_ceiling = effective_slices + 30`（≤ 60），留出重派与追加切片的余量；
- `effective_slices > 30` 时，`admission_ceiling = 60`，即**硬护栏就是队列上限**，剩余切片一律 `DEFERRED`，最终报告标注“本轮覆盖不完整”。

**为什么不是 `max(60, ...)`**：如果写成 `max`，超大项目会让队列上限突破 60，与 `protocol.md` 的硬护栏直接冲突——主Agent会陷入"该遵守哪个数"的两难，而框架的核心原则是主Agent不做裁量。`min` 保证两个数字永远不矛盾：60 是天花板。

---

## 第 5 节：滚动窗口的排序规则——确定性的补位顺序

当多个切片在 `PENDING` 队列中等待时，主Agent按以下**优先级顺序**决定下一个补位：

1. **`unverified` 追加切片优先于 `audit_slices`**。侦察阶段明确标注“无法确认”的路径，风险高于已归类切片，应当先被审计。
2. **同一优先级内，按切片在 `audit_slices` 中出现的原始顺序（FIFO）** 。主Agent不对切片做“重要性排序”，因为那需要理解代码内容。
3. **`CONTRACT_VIOLATION` 的重派实例插入队首**。违反契约的Agent比正常排队的切片更需要尽快替换，但**新实例必须从原始任务描述重新执行**，不继承旧实例的任何输出。
4. **`RETRYABLE_FAILURE` 的重派实例插入队尾**。可重试失败不改变队列中其他切片的相对顺序，重试实例获得全新超时预算，但排在所有 `PENDING` 切片之后。

**禁止的排序行为**：主Agent不得按文件数、目录名、修改时间或任何内容特征对切片排序。排序规则必须是**确定性且与切片内容无关**的。

---

## 第 6 节：历史轮次的覆盖折减——受控、显式、默认关闭

折减逻辑已经在第 2 节给出算术形式，这里补充**执行纪律**：

- 折减**只作用于 `effective_slices` 的计算**，不作用于 `audit_slices` 本身。被折减的切片仍然保留在账本中，标记为 `SKIP_REAUDIT`，并在最终报告中列出“本轮跳过的切片及其上一轮审计结论”。
- 如果 `covered_modules` 中的某个模块在本轮侦察中被**部分**覆盖（即某个切片只有部分文件落在已覆盖模块内），该切片**不得折减**。折减只对“完全落在已覆盖模块内”的切片生效。
- 折减比例 30% 是硬上限。如果 `eligible_for_skip` 超过 `effective_slices` 的 30%，只取前 30%（按 FIFO 顺序），剩余切片正常进入发现波。

---

## 第 7 节：边界情况与失败模式

**情况 A：`effective_slices = 0`**（侦察Agent返回空切片列表且 `unverified` 为空）。
→ 这不是合法的侦察结果。主Agent标记 `CONTRACT_VIOLATION`，派一个**全新侦察Agent**从原始项目认知任务重新执行。不得进入发现波。

**情况 B：`harness_concurrency_cap` 缺失或无法解析**。
→ 取保守值 `4`，并在账本中记录 `concurrency_cap_source: "FALLBACK"`。主Agent不得因为“可能支持更高并发”而自行提高窗口。

**情况 C：`effective_slices` 极大（例如 200+），且 `admission_ceiling` 被触达**。
→ 主Agent停止接受新切片，将剩余切片标记为 `DEFERRED`，写入最终报告的“未覆盖”部分。**不得压缩切片、不得合并Agent、不得降低每Agent的审计深度来“挤进”上限**。如果 `DEFERRED` 切片数量超过 `effective_slices` 的 50%，最终报告必须显式标注“本轮覆盖不完整”。

**情况 D：某个 `RUNNING` Agent 长时间不返回（超过该模板的默认超时）**。
→ 主Agent将其标记为 `RETRYABLE_FAILURE`，从槽位中移除，按第 5 节规则派发重试实例，**立即释放槽位给下一个 `PENDING` 切片**。不得等待超时自然到期再处理。

**情况 E：`slice_count` 与 `len(audit_slices)` 不一致**。
→ 直接 `CONTRACT_VIOLATION`，重派侦察Agent。主Agent不做“以哪个为准”的仲裁。

---

## 第 8 节：与 `protocol.md` 的交接点

`scale-mapping.md` 的输出写入账本的以下字段，`protocol.md` 的波次门控直接消费这些字段：

```
ledger.scale_decision:
  effective_slices: int
  planned_discovery_agents: int      # = effective_slices
  concurrency_window: int            # = min(窗口值, harness_cap)
  admission_ceiling: int
  critique_roles: ["Skeptic", "Devil's Advocate", "Arbiter"]  # 或子集
  critique_extra: "cross-pattern-scan" | "regression-scan" | null
  skipped_slices: [string]           # SKIP_REAUDIT 的切片标识
  deferred_slices: [string]          # 触达 admission_ceiling 后未派发的切片
```

主Agent在波次二启动前将 `scale_decision` 写入账本，之后**不再回头修改**。如果运行过程中发现 `effective_slices` 的初始计算有误，修复方式是**派一个全新的侦察Agent重新执行切片**，而不是在运行中热改 `scale_decision`。

---

## 参考来源

[^ref1]: [HiveMind: OS-Inspired Scheduling forConcurrent LLM Agent Workloads](https://ar5iv.labs.arxiv.org/html/2604.17111#1)
