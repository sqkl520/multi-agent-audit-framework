---
file: orchestrator/scale-mapping.md
title: 规模映射：切片数 → 派发量与并发窗口
group_order: 2
loaded: 主Agent在波次一闭合后、波次二派发前加载
source: https://chat.deepseek.com/share/yn99k1mum4qp5fqwj8 (第 6 轮)
---

# orchestrator/scale-mapping.md

## 第 0 节：先查你的 harness 有没有原生能力（2026-11-09 新增，优先级最高）

> **这一节的结论如果成立，第 2 节之后的全部算术都可以跳过。**

**本文件原本写了 302 行并发与预算算术。2026-11-09 观察到的事实是：现代 harness 已经在运行时层面提供了这些能力，且比本框架精确。**

| 能力 | 本文件怎么做 | harness 原生提供什么 | 该用哪个 |
|---|---|---|---|
| 并发上限 | `concurrency_window` 查表 | 原生并发批次（实测见 5 agent / 7 agent 批次） | **harness** |
| 扇出数量 | `planned_sweep_agents` 算术 | 原生批量派发 | **harness** |
| 单次 Runtime 统计 | 主 Agent 手工 `stat` mtime 猜测 | **精确到秒**（如 `47m48s`） | **harness** |
| token 计量 | **完全没有** | **精确计数**（如 `243.8K` / `638K`） | **harness** |
| 任务终态 | `state.json` + 推测 | 原生 `✓ / 进行中` 状态 | **harness** |
| 相位编排 | `protocol.md` 的五波次 + 门控 | 原生 `Phases`（如 `Verify 2/5`） | **看情况**（见下） |
| 每任务模型选择 | **完全没有** | 逐任务标注（如 `Fable 5.1M`） | **harness** |

### 0.1 判定流程

```
你的 harness 是否有原生能力？
  ├─ 有并发批次 / 任务状态 / token 计量
  │    → 第 2~6 节的并发与预算算术**全部跳过**
  │    → 只保留第 1 节的输入契约（那是数据格式，不是调度策略）
  │    → 派发量由 harness 在运行时决定，本文件不预设
  │
  └─ 没有（纯提示词驱动、无运行时）
       → 回退使用第 2~6 节的算术
       → 必须承认：本文件的估计值不如运行时精确
```

### 0.2 为什么要降级（实测依据）

2026-11-09 观察到的真实运行时数据：

| 工作流 | agent 数 | 单 agent Runtime | 总 token |
|---|---|---|---|
| `round3-verify-batch1` | 5 | 28m36s / 47m48s ×3 / 40m31s | 243.8K |
| `round3-fix-batch2` | 7 | 33m40s / 47m34s / 11m29s / 20m08s / 8m33s / 16m29s / 22m51s | 638K |

**这批数据推翻了本框架此前的一个核心假设**：我们按「8–10 分钟」估单个 agent 的工作量，而实际是 **47 分钟**，差一个数量级。

| 本文件的假设 | 实测 |
|---|---|
| 单 agent 约 10 分钟 | **47 分钟是常态** |
| 用 mtime 判断是否卡住 | harness 直接给 Runtime，mtime 无意义 |
| 用 `agent_count` 做预算 | token 是更真实的成本单位，而本文件从未计量 |

**结论：在 harness 有原生能力的场景下，本文件的算术不是「简化版」，而是「更差的版本」。** 保留它只为兼容没有运行时的纯提示词环境。

### 0.3 仍然必须由框架负责的部分

降级不等于全部交给 harness。以下这些 **harness 不提供，且不能提供**：

| 能力 | 为什么 harness 管不了 |
|---|---|
| 审**什么**（切片规则、维度划分） | harness 不知道你的代码结构 |
| 什么算**证据**（门 0） | harness 不判断结论对错 |
| 什么情况下发现**不成立**（锐评） | 需要领域判断 |
| 报告**长什么样**（交付物规范） | 这是产品的形状，不是运行时的形状 |
| **严重性定级** | 需要专业知识（本框架至今没解决） |

**这一栏才是本框架的价值。第 2 节之后的算术属于上一栏。**

---

## 文件头部：强制加载声明

> scale-mapping.md
> 主Agent在波次一闭合后、波次二派发前加载。
> 本文件是查找表 + 算术规则，不是分析指南。
> 主Agent不得修改、合并或覆盖本文件中的任何映射值。
> 如果 harness 的并发上限低于本文件的并发窗口，取 min(本文件值, harness_cap)。
>
> **2026-11-09 补充**：先执行第 0 节的判定。harness 有原生能力时，本文件第 2~6 节不适用。

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

> **2026-11-01 重要修订：波次二拆成 二A 宽扫 / 二B 深挖。** 原表把「发现波计划量」写成 `= effective_slices`，与 `README.md` 的「每个 `(切片, 维度)` 派一个独立实例」（6 维）**直接矛盾**：按前者算，每片只审 1 维（等于放弃 5/6 覆盖）；按后者算，85 片需 510 个实例（是预算的 8.5 倍）。**两遍制消除这个矛盾**：宽扫按片派（算术 = 片数），深挖按线索派（算术 = 命中切片 × 适用维度，且命中数远小于总片数）。

| `effective_slices` | 二A 宽扫 | 二B 深挖 | 锐评波基础角色 | 锐评波追加 | 单波并发窗口 |
|---|---|---|---|---|---|
| **1–5** | `= effective_slices` | 只对 `HIGH` 线索派 | Skeptic + Arbiter | 无 | `min(5, harness_cap)` |
| **6–20** | `= effective_slices` | 按第 3.2 节阈值 | + Devil's Advocate | 无 | `min(8, harness_cap)` |
| **> 20** | `= effective_slices` | 按第 3.2 节阈值 | 同上 3 角色 | +1 交叉模式扫描 | `min(8, harness_cap)` |

### 3.1 二A 宽扫：一片一实例

**宽扫的计划量永远等于 `effective_slices`**。侦察返回 17 片就派 17 个宽扫 agent；返回 3 片就派 3 个。主 Agent 不得因为「17 个太多」而合并，也不得因为「3 个太少」而拆分。

宽扫产出**线索**（`lead`），不是发现。线索不进锐评波、不进最终报告正文，只用于决定二B 派给谁。详见 `templates/wave2a-sweep.md`。

### 3.2 二B 深挖：按线索派，不按切片派

**深挖的触发阈值（写死，零裁量）**：

| 条件 | 动作 |
|---|---|
| 切片有 ≥1 条 `confidence: HIGH` 线索 | **必深挖**，维度取该线索的 `suspected_dimension` |
| 切片 `lead_count ≥ 3` | 深挖，维度取 `dimension_histogram` 计数最高的 **2** 个 |
| 切片 `reachability == UNREACHABLE` | **不深挖** |
| 其余 | 不深挖，线索进最终报告的「未深挖线索」附录 |

**深挖成本的界（主 Agent 必须验算）**：

```
deep_dive_cost = Σ(每个命中切片的深挖维度数)      # 每片最多 2 个维度（除 HIGH 线索指定）
total_wave2    = planned_sweep_agents + deep_dive_cost
必须满足：total_wave2 ≤ discovery_budget
```

**若超出**：按 `reachability`（`PROD` 优先）→ `lead_count` 降序 → 切片原始 FIFO 的顺序截断，其余标 `DEFERRED_DEEP_DIVE`。**禁止按文件名/目录名/修改时间排序**；`reachability` 与 `lead_count` 是**结构特征**，不违反这条禁令。

> **⚠ 已知的算术陷阱（必须读，否则会误以为新公式没解决问题）**
>
> 用 round31 的真实数据（85 片、`discovery_budget = 40`）代入上式会得到：
>
> ```
> planned_sweep_agents = min(85, 40) = 40        ← 宽扫已经吃满全部 discovery_budget
> 剩余给深挖的预算   = 40 - 40 = 0
> → 深挖永远无法进行
> ```
>
> **也就是说：只要 `effective_slices ≥ discovery_budget`，两遍制会退化成"只宽扫、零深挖"——比原设计更糟**（原设计至少审了 40 个维度，现在只剩 40 份线索）。
>
> **这不是设计缺陷，是 discovery_budget 的定义造成的**：它原本是为「单遍审计」定的，现在要同时装下"宽扫 + 深挖"两笔开销。**因此当 `effective_slices ≥ discovery_budget` 时，主 Agent 必须先做一次显式的预算分配，而不是让宽扫先吃光：**
>
> ```
> # 宽扫是廉价遍，深挖是昂贵遍。两者按固定比例分配，而不是先到先得。
> sweep_budget = ceil(discovery_budget × 0.4)     # 40% 给宽扫
> deep_dive_budget = discovery_budget - sweep_budget   # 60% 给深挖
>
> planned_sweep_agents = min(effective_slices, sweep_budget)
> affordable_deep_dive = deep_dive_budget
> ```
>
> 代入 round31：`sweep_budget = 16`、`deep_dive_budget = 24`。即**宽扫 16 片，深挖约 12 片 × 2 维**。覆盖的切片数从 40 降到 16，但**深挖的 16 片是经可达性筛选后的 PROD 代码**，而原设计那 40 片里有 29 片是死代码。
>
> **这个比例是启发式，不是实测最优值**，必须在最终报告中声明用了哪个比例，以及为何该比例适用于本项目。**若 `effective_slices < discovery_budget`**（小项目），宽扫可以全量覆盖，剩余预算全部给深挖，不需要切分。
>
> **诚实的代价**：在超大仓库上，"每片都宽扫一遍"和"每片都深入审计"**不可能同时满足**。两遍制能保证「宽扫过的一定被记录、深挖过的一定可信」，但**不能保证每片都被深挖**。最终报告必须写明"宽扫覆盖率"与"深挖覆盖率"两个独立数字，不得合并成一个数字来假装覆盖完整。

> **为什么每片最多 2 个深挖维度**：这是成本上限，不是质量主张。有 `HIGH` 线索时按线索走（可能 1 个维度就够）；无线索密度支撑时，同时深挖 3+ 维度大概率是在给低价值代码花高价预算。若某片确实需要更多维度，走 L1 裁量留痕（`protocol.md` 第 1.2 节），并说明依据。

### 3.3 逐条解释

- **宽扫计划量 = `effective_slices`**，因为它必须覆盖每一片——这一遍的使命是「不漏」。
- **深挖计划量 ≠ 切片数**，因为它由**线索密度**驱动，而线索密度在宽扫完成前无法预知。这与「修复/验收按发现数派」是同一个道理。
- **锐评波不随切片数线性增长**。6–20 档和 >20 档基础角色都是 3 个，>20 档只追加 1 个交叉模式扫描，因为大规模代码库中「未被任何切片覆盖的模块」风险更高，不是因为「切片多所以锐评也要按比例多」。
- **并发窗口是上限，不是目标**。`min(8, harness_cap)` 意味着 harness 支持 16 并发时窗口仍是 8。主 Agent 不得因为「窗口没用满」而提高并发数。

**为什么并发窗口不随切片数增长**：并发窗口的作用是**把瞬时争用控制在可协调的范围内**，而不是把硬件或 API 配额吃满。计划量（population）和并发窗口（throughput）是两个独立变量，必须解耦。

**窗口值 8 的来源与限度（必须读，否则会误用）**：8 是一个**设计假设**，不是实测得出的最优值。它的依据是切片粒度（每片 5–8 文件）与协调开销的经验权衡。harness 上限更低时取 `min`，**不得**因为"可能支持更高并发"而上调。

> **关于 HiveMind 数据的正确读法**（`arxiv.org/abs/2604.17111`，Agemang 等，2026-04，cs.DC）：
> 该文确实报告了「10+ agent 直连时失败率 100%、replay-11 为 73%」与「HiveMind 为 10%/18%」两组数字[^ref1]。但引用时必须带三个限定，否则是误用：
> 1. **实验场景是 mock API server**，agent 做的是「重复顺序 API 调用」，**不是代码审计**；
> 2. **「失败」的定义是首个不可恢复的 HTTP 502 / 连接重置**——它衡量的是**API 层争用死亡率**，与审计质量、发现准确率无关；
> 3. **论文从未建议并发窗口 = 8**（其测试档位是 5/10/11/20/50）。
>
> 更关键：论文的消融明确写「**transparent retry 是影响最大的单一原语**」，且**仅加准入控制仍有 81.8% 的失败率**。所以「准入 + 背压即把失败率降到 0–18%」是对原文的**反向误读**。正确的推论是：**背压必须与重试配对**，单靠限流不解决问题——这恰好是 `RETRYABLE_FAILURE` 原样重派规则（`protocol.md` 第 4 节）的依据。

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

第 3 节的映射表说"宽扫计划量永远等于 `effective_slices`"，本节又说超过 60 的部分要 `DEFERRED`。这两个规则不矛盾，因为它们描述的是**两个不同阶段的数字**：

| 数字 | 阶段 | 定义 |
|---|---|---|
| `planned_sweep_agents = effective_slices` | 波次二A**规划时** | 每一片都必须有一个宽扫 Agent，**不允许合并切片**。这是"计划量"，写入账本后不再修改 |
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
  concurrency_window: int            # = min(窗口值, harness_cap)
  admission_ceiling: int             # 队列背压阀，= min(60, effective_slices + 30)
  total_budget: int                  # = 60，跨波次累计硬护栏
  reserved_for_downstream: int       # = 20，锐评+修复+验收预留
  discovery_budget: int              # = total_budget - reserved_for_downstream

  # --- 波次二A 宽扫（1 片 1 实例，算术 = 片数）---
  planned_sweep_agents: int          # = min(effective_slices, discovery_budget)
  affordable_slices: int             # 同上；超出部分 DEFERRED
  deferred_slices: [string]

  # --- 波次二B 深挖（按线索派，在宽扫完成后才确定）---
  deep_dive_trigger: object          # 阈值快照，便于复核（HIGH 线索 / lead_count>=3）
  planned_deep_dive_agents: int|null # 宽扫完成前为 null
  deep_dive_slices: [string]|null    # 命中深挖的切片
  deep_dive_dims: {slice_id: [dim]}  # 每片深挖哪几个维度
  deep_dive_truncated: [string]      # 因预算截断的深挖，标 DEFERRED_DEEP_DIVE

  critique_roles: ["Skeptic", "Devil's Advocate", "Arbiter"]  # 或子集
  critique_extra: "cross-pattern-scan" | "regression-scan" | null
  skipped_slices: [string]           # SKIP_REAUDIT 的切片标识
  deferred_deep_dive: [string]       # 有线索但未深挖的切片
```

**两阶段冻结规则**（2026-11-01 修订）：

- `planned_sweep_agents` / `concurrency_window` / `total_budget` 在**波次二A 启动前**冻结，之后不得修改；
- `planned_deep_dive_agents` / `deep_dive_dims` 在**波次二A 闭合后**写入并冻结。这是因为深挖数量依赖线索密度，宽扫前无法预知——**这不是裁量，是设计上的两阶段决策点**；
- 若深挖阶段的成本超出 `discovery_budget`，按第 3.2 节的确定性规则截断，并把截断决策写进 `discipline_log`（`BUDGET_TRUNCATION` 类）。

**禁止**：在运行中热改 `effective_slices`。若发现切片计算有误，修复方式是**派一个全新的侦察 Agent 重新执行切片**。

---

## 参考来源

[^ref1]: [HiveMind: OS-Inspired Scheduling for Concurrent LLM Agent Workloads](https://arxiv.org/abs/2604.17111) — 注意：其「失败」指 **HTTP 502/连接重置**，场景为 mock API server，**不是**审计失败率；且仅加准入控制仍有 81.8% 失败率，透明重试才是主导原语。
