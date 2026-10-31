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
- `effective_slices > 30` 时，`admission_ceiling = 60`，剩余切片一律 `DEFERRED`，最终报告标注"本轮覆盖不完整"。

### 「计划量 = 切片数」与队列上限的关系

第 3 节的映射表说"发现波计划量永远等于 `effective_slices`"，本节又说超过 60 的部分要 `DEFERRED`。这两个规则不矛盾，因为它们描述的是**两个不同阶段的数字**：

| 数字 | 阶段 | 定义 |
|---|---|---|
| `planned_discovery_agents = effective_slices` | 波次二**规划时** | 每一片都必须有对应的审计 Agent，**不允许合并切片**。这是"计划量"，写入账本后不再修改 |
| `admission_ceiling` | 波次二**执行时** | 同时在队列中（`PENDING + RUNNING`）的实例数上限，是**背压阀**，不是总量限制 |

**关键区分**：`admission_ceiling` 限制的是**队列中同时存在的实例数**，不是**总共能派多少个**。滚动窗口的机制是：一个实例进入终态、结果被主Agent收集后，从队列中移除，下一个 `PENDING` 切片补位。因此 100 个切片、`admission_ceiling = 60` 时，不是"只能派 60 个"，而是"任意时刻队列里最多 60 个"。

### 总预算 60 的分配（这是真正的约束）

`protocol.md` 的 `total_agent_count = 60` 是**跨波次累计**的硬护栏，涵盖侦察、审计、锐评、修复、验收的全部实例。这意味着发现波不能独占 60——否则下游无预算可用。因此引入**分波预算**：

```
total_budget = 60
reserved_for_downstream = 20          # 锐评 + 修复 + 验收的预留
discovery_budget = total_budget - reserved_for_downstream = 40
affordable_slices = min(effective_slices, discovery_budget)
deferred_slices = effective_slices - affordable_slices
```

| 情形 | 发现波实派 | 下游预留 | 结果 |
|---|---|---|---|
| `effective_slices ≤ 40` | `= effective_slices` | ≥ 20 | 全部切片被审计 |
| `effective_slices > 40` | `40` | 20 | 超出部分 `DEFERRED`，最终报告标注"本轮覆盖不完整" |

**为什么预留 20 而不是按比例**：下游 Agent 数量由**发现数**驱动，而发现数在波次二完成前无法预知。20 是一个保守的下界，覆盖"锐评 3–4 个实例 + 若干修复与验收"。如果实际发现数很少，剩余预算闲置，这比"发现波吃光预算导致无法修复"要好得多。

**发现数超过预留时的处理**：如果 `UPHELD` 发现数 × 2（修复 + 验收）> 20，主Agent**不自行挑选修哪些**，而是按发现 ID 的 FIFO 顺序处理前若干个，其余写入 `open_items`，`kind: "UNRESOLVED_FINDING"`，`blocking: false`，`next_action: "NONE"`，`summary` 写明"因总预算耗尽，本轮排入下一轮修复"（**不得**用 `DEFERRED_SLICE`——那个枚举专指未派发的**审计切片**，不是未修复的**缺陷**；混用会让最终报告的"未覆盖切片数"统计失真）。**不得**因为预算不足而降低单个修复的验收标准。

**超过预算时的推荐做法**：`effective_slices > 40` 时，主Agent**不自行决定审哪 40 片**（那是裁量），而是按第 5 节第 2 条"同一优先级内按原始 FIFO 顺序"取前 40 片。第 41 片之后全部 `DEFERRED`，由下一轮审计接手。

**这带来的诚实代价**：大项目一轮审不完，需要多轮。框架选择"每轮诚实报告覆盖率"，而不是"一轮内悄悄降低深度假装审完了"。这与 `README.md` 开头的核心原则一致——宁可承认覆盖不足，不可产生看起来完整的假象。

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
  planned_discovery_agents: int      # = affordable_slices，见第 4 节预算分配
  concurrency_window: int            # = min(窗口值, harness_cap)
  admission_ceiling: int             # 队列背压阀，= min(60, effective_slices + 30)
  total_budget: int                  # = 60，跨波次累计硬护栏
  reserved_for_downstream: int       # = 20，锐评+修复+验收预留
  discovery_budget: int              # = total_budget - reserved_for_downstream
  affordable_slices: int             # = min(effective_slices, discovery_budget)
  critique_roles: ["Skeptic", "Devil's Advocate", "Arbiter"]  # 或子集
  critique_extra: "cross-pattern-scan" | "regression-scan" | null
  skipped_slices: [string]           # SKIP_REAUDIT 的切片标识
  deferred_slices: [string]          # 因 discovery_budget 或 admission_ceiling 未派发的切片
```

主Agent在波次二启动前将 `scale_decision` 写入账本，之后**不再回头修改**。如果运行过程中发现 `effective_slices` 的初始计算有误，修复方式是**派一个全新的侦察Agent重新执行切片**，而不是在运行中热改 `scale_decision`。

---

## 参考来源

[^ref1]: [HiveMind: OS-Inspired Scheduling forConcurrent LLM Agent Workloads](https://ar5iv.labs.arxiv.org/html/2604.17111#1)
