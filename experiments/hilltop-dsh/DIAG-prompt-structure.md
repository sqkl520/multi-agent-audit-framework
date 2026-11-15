# 提示词结构诊断：为什么这套框架在「修复阶段」退化成单 agent

**日期**：2026-11-14
**方法**：只读分析。逐文件读取 `framework/wrappers/`(7)、`framework/components/`(3)、`framework/templates/`(6)、`MANUAL.md`(608)、`orchestrator/protocol.md`(1318)、`README.md`(385)、`START-HERE.md`(217)，并交叉核对 `tools/check-state.mjs` / `tools/stop-hook.mjs` / `artifacts/run-state.md` 以确认提示词规则有没有落点。
**被测前提**（已实测，本报告不重测）：审计阶段任务书写了「并行派 3 个 subagent」→ 主 agent 派了 3 个，产生 7 个 `delegationDepth: 1` 子 session；修复阶段任务书没写 → 3 次独立运行（113/303/129 次工具调用，单 session 最多 196 step），`subagent` 调用 **0** 次，全部 `delegationDepth: 0`。

**结论一句话**：同一个模型、同一个工具集，两次行为差异 100% 由「任务书这一句话」解释——因为**框架本身在修复/验证相位没有任何一句话会产生那句话**。多 agent 纪律只在审计相位是以「必须派发」的形式写下的，在修复相位只以「某角色存在」的形式写下。前者是命令，后者是菜单。

---

## 一、显式要求派生 subagent 的文件 / 完全没提的文件

### 1.1 有派发纪律（逐字引用）

**审计相位**——三重冗余，三处都独立构成「必须派」：

| 位置 | 逐字原文 | 性质 |
|---|---|---|
| `framework/wrappers/sweep-scout.md:71` | 「**实例唯一性**：**一个切片一个实例**，且一个实例只承担一个切片。不得让一个实例承担多个切片。」 | 硬规则 |
| `framework/wrappers/audit-specialist.md:36` | 「**实例唯一性**：每个 `(slice_id, dimension)` 组合对应一个**独立实例**。主Agent不得让一个实例承担多个维度，也不得让两个实例审计同一个 `(slice_id, dimension)`。」 | 硬规则 |
| `framework/templates/wave2-audit.md:48` | 「同一 `slice_id` 的不同维度由**不同的审计Agent实例**负责。主Agent在派发时确保每个 `(slice_id, dimension)` 组合对应一个独立的Agent。这意味着一个切片可能被多个审计Agent并行读取，但每个Agent只报告自己的维度。」 | 硬规则 |
| `framework/templates/wave2a-sweep.md:14` | 「原设计要求「每个 `(slice_id, dimension)` 组合派一个独立实例」，6 个维度意味着 `N` 片要派 `6N` 个实例」 | 设计依据 |
| `framework/MANUAL.md:243` | 「**一片一实例**，每个宽扫 Agent 看**全部 6 个维度**」 | 操作手册 |
| `framework/MANUAL.md:246` | 「主Agent → **派 N 个 sweep-scout**（N = planned_sweep_agents，受 concurrency_window 限制）」 | 操作手册 |

**关键观察**：审计相位不只是「说了要并行」，而是**把派发数量写成了可计算的算术**——`planned_sweep_agents = min(effective_slices, sweep_budget)`（`framework/templates/wave2a-sweep.md:203`），`concurrency_window = min(8, harness_cap)`（同文件 `:206`）。主 Agent 不需要「决定要不要派」，它只需要**算一个已经定义好的数**。

### 1.2 完全没有派发纪律（零字）

以下文件里，`并发约束` 行、`实例唯一性` 段、`派 N 个` 指令**全部不存在**：

| 文件 | 行数 | `并发约束` 行 | `实例唯一性` | `subagent` 出现次数 |
|---|---|---|---|---|
| `framework/wrappers/fix-worker.md` | 72 | 有（**但是放宽式**，见 §2） | **无** | 0 |
| `framework/wrappers/verifier.md` | 82 | **无** | **无** | 0 |
| `framework/templates/wave4-fix.md` | 198 | **无** | **无** | 0（仅 `:60`/`:147` 出现「子 Agent」描述性用法） |
| `framework/templates/wave5-verify.md` | 246 | **无** | **无** | 0 |
| `framework/wrappers/critique-panel.md` | 92 | **无** | 有（`：28`，「一个实例只承担一种子角色」——只约束角色不混，不约束必须开几个实例） | 0 |
| `framework/wrappers/recon-scout.md` | 84 | **无** | 有（`:38`，但是**反向**的「不重复派发」） | 0 |
| `framework/wrappers/planner.md` | 161 | 有（`:51`「单实例」） | 无 | 0 |

`framework/wrappers/verifier.md` 里 `并发` 一词出现 **0 次**（`grep -c` 返回 0）。`framework/templates/wave5-verify.md` 的九节标题里（`第 1 节` 到 `第 9 节`）没有任何一节关于派发、并发或实例数。

### 1.3 一个更严重的观察：`protocol.md` 从不点名任何 wrapper

```
grep -c "fix-worker\|verifier\|sweep-scout\|audit-specialist\|recon-scout\|wrappers/" \
  framework/orchestrator/protocol.md
→ 0
```

**主调度协议不认识任何角色文件。** 它定义波次门控（§3, `:1007` 起）、失败处理（§4）、冲突处理（§5）、并发护栏（§6），但从头到尾不出现一个 wrapper 名，也不出现一个模板路径（唯一一处模板引用 `:781` 是 `templates/wave2a-sweep.md`，且只是举例说明主 Agent 需要 `Bash`）。

后果：主 Agent 如果只加载 `protocol.md`（`START-HERE.md:44-46` 的入口清单**正是**这么写的），它拿到的是「波次一/二/三/四/五」的抽象名字和门控条件，**没有任何一句把它连接到 `fix-worker` 这个角色，也没有任何一句告诉它「波次四要派 M 个实例」**。

---

## 二、`fix-worker` / `wave4-fix` 的并行缺口——这是本报告最硬的一条

### 2.1 对照：`sweep-scout` 的并发约束是「收紧式」

`framework/wrappers/sweep-scout.md:67`：

> 「| 并发约束 | **同时运行的实例数不超过 `scale_decision.concurrency_window`** |」

这句话**预设了「会同时运行多个实例」**，它约束的是上限，不是「要不要多实例」。

### 2.2 `fix-worker` 的并发约束是「放宽式」，且语义完全反转

`framework/wrappers/fix-worker.md:33`：

> 「| 并发约束 | **不同 `target_files` 的修复可并行**；**共享同一文件的修复必须串行**，由主Agent排序 |」

逐字读这句话，它包含三个独立的问题：

1. **「可并行」是许可，不是义务。** 中文「可」= may，不是 must。与 `sweep-scout.md:67` 的「不超过」（上限）和 `:71` 的「一个切片一个实例」（义务）相比，这里**没有任何一处要求必须派多个实例**。
2. **句子的语法重心落在后半句。** 「可并行；**共享同一文件的必须串行**」——加粗在「必须串行」上。「**由主Agent排序**」进一步把主 Agent 的角色定义为**排序者（sequencer）**，而不是派发者（dispatcher）。排序的默认心智模型是「一条队，我决定先后」，不是「一片扇出，我决定并发度」。
3. **同一行内隐含了「一次只做一个」的读法。** 如果修复真的是并行的，那么「共享同一文件必须串行」这条约束需要主 Agent 做**文件级依赖图分析**——而 L0 明确禁止它读源码（`protocol.md:701`：「读取**源代码内容**（用 Read/Grep 看实现）」）。主 Agent 想知道两条修复是否共享文件，只能靠派发参数里的 `target_files[]` 做集合求交，这倒是允许的。但框架**从未说明**这一点，于是最容易的合规路径是：**一条一条来，这样永远不会违反「共享同一文件必须串行」**。

`framework/MANUAL.md:337` 是同一句话的复述，同样以「可并行」开头：

> 「每条 `UPHELD` 的发现派一个修复实例。**不同 `target_files` 的修复可并行**，**共享同一文件的必须串行**。」

注意 `MANUAL.md:337` **前半句其实是有义务的**——「每条 `UPHELD` 的发现派一个修复实例」。但：

- 这一句出现在「步骤 5：波次四 · 修复（**可选路径，独立启动**）」（`MANUAL.md:333`），其上一行是「**默认路径到此结束。**」（`:335`）——整节被标为**可选**；
- `MANUAL.md` **不在** `START-HERE.md` 的加载清单里。`START-HERE.md:44-46` 只要求读 `environment-probe.md` / `protocol.md` / `run-state.md`。`MANUAL.md` 只在 `START-HERE.md:204` 的「想更深入」表里出现，且注明「**注意：部分章节已知过期**」。
- 因此 `MANUAL.md:337` 这句唯一带义务的表述，**既在可选路径里，又在非默认加载文件里**——它对实际执行的主 Agent 而言是双重不可见。

### 2.3 `wave4-fix.md` 的章节结构里根本没有「派发」这一节

对比两个模板的章节骨架：

```
templates/wave2a-sweep.md:
  第 1 节 核心定义——线索不等于发现
  第 2 节 一个 agent 看全部 6 个维度
  第 3 节 输出契约
  第 4 节 门控
  第 5 节 可达性标记
  第 6 节 派发规则          ← 有独立的派发节
  第 7 节 与现有波次的关系
  第 7.5 节 增量落盘
  第 8 节 常见失败模式
  第 9 节 派发给深挖任务时…

templates/wave4-fix.md:
  文件头部 强制加载与写权限边界
  第 1 节 修复Agent的职责边界——四做四不做
  第 2 节 修复契约的前置登记
  第 3 节 影响半径的显式声明
  第 4 节 验证命令的纪律
  第 5 节 与 handoff-schema 的精确对接
  第 6 节 失败与重派的特殊规则
  第 7 节 返回前的自检清单
  （无派发节）
```

`wave4-fix.md` 的 7 个节全部是**「修复 Agent 自己怎么做」**（职责边界、前置登记、影响半径、验证命令、自检），以及**「主 Agent 收到返回后怎么处理」**（第 5 节对接、第 6 节重派）。**中间缺了「主 Agent 怎么把 N 条 UPHELD 变成 N 个实例」这一节。**

`sweep-scout.md` 有 `§2 触发条件` 里的完整派发参数表 + `§实例唯一性` 硬规则 + 模板里的 `§6 派发规则` 带伪代码算术。`fix-worker.md` 的 `§2 触发条件` 里 `并发约束` 那一行就是全部，而它是「可并行」。

**这就是缺口的具体形状**：不是「忘了写并行」，而是**写了并行，但写成了许可；同时漏掉了所有把许可变成义务的机制**（实例唯一性硬规则、派发数量算术、派发章节）。

### 2.4 `verifier` 更彻底：连「可并行」都没有

`framework/wrappers/verifier.md` 的 `§2 触发条件` 表（`:28-33`）：

```
| 条件 | 判定 |
| 事件 | `FIX_COMPLETED` |
| 前置状态 | 某修复Agent返回 `SUCCESS` 且契约合规；`wave` 置为 `5` |
| 派发参数 | `trace_id`、`round_id`、`finding_id`、`fix_agent_id`、`target_files[]`、`acceptance_criteria`、`affected_issues[]`、`residual_risk_flags[]` |
| **禁止传入** | 修复Agent的 `verification_commands`、`output_snippet`、`artifact_path` 作为必读项 |
```

**没有 `并发约束` 行。** 而 `sweep-scout.md:67` 和 `audit-specialist.md:32` 都有这一行。

唯一的约束是 `verifier.md:35`：

> 「**独立性硬约束**：验收Agent与修复Agent必须是不同实例，且验收Agent的上下文不得包含修复Agent的任何自述。」

这句只约束「验收实例 ≠ 修复实例」，**完全不涉及「多条修复要不要同时开多个验收实例」**。

### 2.5 结论

**是缺口，而且是结构性的。** 精确表述：

- **缺失**：`fix-worker.md` / `wave4-fix.md` / `verifier.md` / `wave5-verify.md` 四份文件里，没有任何一处是 `sweep-scout.md:71`「一个切片一个实例」的对应物。
- **写错了**：`fix-worker.md:33` 的「可并行」+「由主Agent排序」在语义上**指向串行**——它给了主 Agent 一个合规的、低认知负荷的默认路径（一条一条做），并把这个路径明确命名为「由主Agent排序」。

---

## 三、框架是否只在「审计」相位建立了多 agent 纪律

**是。这是本报告的主结论，可以用一组量化对比证明。**

### 3.1 派发数量的算术：只在审计相位存在

| 相位 | 派发数量怎么算 | 出处 |
|---|---|---|
| 侦察 | 「派 1 个 recon-scout」 | `MANUAL.md:182` |
| 宽扫 | `planned_sweep_agents = min(effective_slices, sweep_budget)`，`sweep_budget = ceil(discovery_budget × 0.4)` | `wave2a-sweep.md:196-204`，`scale-mapping.md:182-185` |
| 深挖 | `M = 命中切片的深挖维度数之和` | `MANUAL.md:280` |
| 锐评 | 按 `effective_slices` 查表：1–5 → 2 角色，6–20 → 3 角色，>20 → 3+1 | `MANUAL.md:231-235` |
| **修复** | **无公式。** 只有「每条 `UPHELD` 派一个修复实例」（`MANUAL.md:337`，在可选路径+非默认加载文件中） | —— |
| **验收** | **无公式。** 只有「主Agent → 派 K 个 verifier」（`MANUAL.md:360`），**K 从未被定义** | —— |

`MANUAL.md:360` 的 `K` 是一个**未定义变量**。全仓搜索 `planned_fix` / `fix_agents` / `fix_budget` / `验收实例数`，**零命中**。`scale-mapping.md:274` 只给了总量的反向约束（「`UPHELD` 发现数 × 2 > 20」时按 FIFO 截断），从没给出**下限**或**并发度**。

### 3.2 预算与并发窗口的字段：审计有，修复没有

`framework/artifacts/run-state.md:41-44` 定义了四个计数字段：

> 「| `planned_sweep_agents` | 波次二A 计划派发的宽扫实例数 | 波次二A 启动**前**冻结 |」
> 「| `spawned_deep_dive` | 波次二B **实际**派发的深挖实例数 | 每次派发后 +1 |」
> 「| `failed_sweep` | 宽扫中 `PERMANENT_FAILURE` 的实例数 |」
> 「| `failed_deep_dive` | 深挖中 `PERMANENT_FAILURE` 的实例数 |」

**四个字段全部是 wave2a/2b 的。零个是 wave4/5 的。** 也就是说：即使主 Agent 想记录「我派了几个修复实例」，**`state.json` 里没有地方可以写**。这直接决定了任何一个校验器都不可能发现「修复阶段 0 次 spawn」——因为它没有被要求记这个数。

### 3.3 相位枚举里没有修复/验证相位

`framework/artifacts/run-state.md:54`：

> `"phase": "init | wave1 | wave2a | wave2b | wave3 | report | closed"`

`tools/check-state.mjs:55` 硬编码同一个闭集：

> `phase: ['init', 'wave1', 'wave2a', 'wave2b', 'wave3', 'report', 'closed'],`

`path_mode` 有 `FIX`（`run-state.md:53`：「`"path_mode": "AUDIT_ONLY | FIX"`」），**但进入 FIX 模式后，`phase` 无处可置**——没有任何 `wave4` / `wave5` / `fix` / `verify` 取值。主 Agent 若按规则把 `phase` 设成 `wave4`，`check-state.mjs:78` 会报 `invalid_enum`。

**这一条的后果是连锁的**：见 §5.2，它让 `stop-hook.mjs` 的相位闭合检查在修复阶段**完全失效**。

### 3.4 `protocol.md §0.8.2` 的相位表只覆盖审计链路

`framework/orchestrator/protocol.md:250-255`：

> 「| 相位 | 起 | 止 | 交付物 |
> | **侦察相位** | `state.phase = wave1` | 全部切片定义落盘 + `scale_decision` 冻结 | 切片清单 + 入口点 + 排除报告 |
> | **发现相位** | `phase = wave2a` | 宽扫**全部**派完 → 深挖**按预算**全部派完 → 全部 agent 到终态 | 所有产物文件 + `wave2_completed` 账本完整 |
> | **锐评相位** | `phase = wave3` | 三种角色全部返回 + Arbiter 裁决完 | 裁决记录 + 冲突表 |
> | **收尾相位** | `phase = report` | 最终报告落盘 + `status` 置为终态 | 最终报告 + 账本 |」

紧接着 `:257`：

> 「**相位之间可以停。相位之内不许停。**」

**四行相位，零行是修复或验证。** 而 `:257` 的这句话在修复阶段读起来是灾难性的：既然「相位之间可以停」，而修复/验证**不是相位**，那就落进了「可以停」的范畴——**每修完一条就停一下，是完全符合 `:257` 的**。

对照 `:267-270` 的禁止清单：

> 「**禁止**：
> - 派了 3 个 agent 就汇报「已派出 3 个」
> - 一个波次跑完就总结「宽扫完成，接下来深挖吗」
> - 遇到需要判断的地方就停下来问」

这三条禁令的**所有例子都在审计链路**。「每修完一条汇报一次」不在任何一条禁令的射程内——事实上 `framework/artifacts/final-report.md:25` 明确**要求**修复路径逐条出报告：

> 「| 修复路径（FIX）每条发现结束 | **是**（逐条） | `FIX_DONE` / `FIX_FAILED` |」

**这是提示词层面一处赤裸裸的对立**：§0.8.2 说「相位之内不许停」，`final-report.md:25` 说修复路径「每条发现结束」必须出报告。「每条发现结束」= 每条之后一个停点。两句话直接冲突，而修复相位恰好是**没有相位定义**的那个相位，所以主 Agent 只能按 `final-report.md:25` 办。

### 3.5 `protocol.md` 的失败处理节对五个波次一视同仁——除了修复

`protocol.md:1016` 波次四闭合条件：

> 「**波次四（修复）闭合条件**：每一条 `UPHELD` 的发现都有对应的修复Agent返回 `SUCCESS`（或 `PERMANENT_FAILURE` 并已记入 `unverified`），且修复Agent的返回中带有 `affected_issues` 列表」

这句本身写得好——「每一条」明确要求复数实例。**但它只是闭合条件（判据），不是派发指令（动作）。**

对比波次二：`protocol.md:1014` 给了闭合条件，「`MANUAL.md:246` + `wave2a-sweep.md:196-204`」给了派发动作。波次四**只有前者，没有后者**。

一个只加载 `protocol.md`（按 `START-HERE.md:44-46` 的指示）的主 Agent，看到波次四闭合条件是「每条 UPHELD 都有对应修复 SUCCESS」——**它完全可以把 5 条 UPHELD 在同一次会话里自己改完**，然后声称「5 条都有对应修复了」。因为**没有任何一句说「对应修复」必须是一个独立 session**。

---

## 四、`protocol.md:1009` 是否会被读成「修复阶段就该串行」

### 4.1 原文

`framework/orchestrator/protocol.md:1009`：

> 「Workflow Wave Dispatch 的纪律是：波次之间不是并行扇出，而是**顺序波次 + 验证门控**；每一波本身是一个 `parallel-agent-dispatch` 调用，波次 N+1 只在波次 N 达到合并/闭合条件后触发。`goal-workflow` 的 `graph` 模式也描述了“波次之间 fan-in barrier 合并结果并重新规划下一波”的机制[^ref5]。」

### 4.2 判定：**是，而且这句话在修复上下文中会双重误导**

**第一重：字面歧义。** 「波次之间不是并行扇出」这句话在**正确的读法**下是对的（波次是 barrier，不能并行）。但它出现在一个小节标题为「## 3. 波次门控」（`:1007`）的节里，而**波次四/五在这个节的闭合条件清单里（`:1016-1020`）与波次一/二/三并列**。于是「波次之间不是并行扇出」这条规则，在形式上覆盖了「波次三 → 波次四」和「波次四 → 波次五」两个转换。

**关键**：这句话说的是「波次**之间**」（between waves），不是「波次**之内**」（within a wave）。它同句后半已经给了正确答案：「每一波本身是一个 `parallel-agent-dispatch` 调用」。但这个从句：

- 用了 `parallel-agent-dispatch` 这个**伪工具名**（全仓无此工具，见 §7.3）；
- 放在主句之后，作为补充说明；
- 而主句以「**不是**并行扇出」开头，加粗。

心理学上（也是 LLM 提示词的通行规律），**加粗的否定式先行断言权重高于其后的补充从句**。一个在修复阶段寻找「我该并行还是串行」的主 Agent，最先抓到的信号是加粗的「不是并行扇出」。

**第二重，更严重：修复相位没有「波次之内」可言。** 因为 §3.4 已证：`phase` 枚举（`run-state.md:54`）和相位表（`protocol.md:250-255`）里**没有 wave4/wave5**。所以对修复阶段而言，「波次之内是一个 parallel-agent-dispatch 调用」这条**豁免条款无处落地**——它只对 wave1/2a/2b/3 生效。

于是修复阶段从 `:1009` 得到的**唯一可用信息**是加粗的那半句：「不是并行扇出」。**这不是误读，这是框架留下的唯一读法。**

### 4.3 同节还有一处直接鼓励串行

`protocol.md:1019`：

> 「`verdict: FAIL`（归因 `FIX_INCOMPLETE` / `FIX_INCORRECT`）→ **回到波次四**，不回到波次二；」

「回到波次四」这个措辞把修复描述成一个**可重入的循环节点**。结合 `wave4-fix.md:125` 的「三次尝试预算」（「修复Agent对同一个 `finding_id` 最多执行**三次修改尝试**」），整个修复语义是**「同一条缺陷反复试错」**——这个语义天然是**单实例迭代**，不是**多实例扇出**。多实例扇出的语义是「N 条缺陷并行各修一次」，与「一条缺陷试三次」在提示词层面**完全没有被区分**。

---

## 五、有没有哪处提示词实际上鼓励单 agent 串行

**有五处，按危险程度排序。**

### 5.1 `compatibility.md` 把「串行」写成合法降级，且降级不需要用户同意

`framework/orchestrator/compatibility.md:48-50`：

> 「| **T0（3 成员）** | 3 并行 | 3 并行 | 3 串行 | **1 个，标注「降级运行」** |
> | **T1（5 成员）** | 5 并行 | 5 并行 | 5 串行 | **1 个，标注「降级运行」** |
> | **T2（9 成员）** | 9 并行 + 3 层递归 | 9 并行 + 2 层 | **9 串行，无递归** | **1 个，标注「降级运行」** |」

`compatibility.md:74-76`：

> 「### 3.1 没有原生并发怎么办
> ```
> 检测到无并发能力 → 串行执行
> ```」

**这是框架唯一一处明确写「串行执行」的地方，而它被呈现为一条正常的、只需声明的降级路径。**

判定链条：主 Agent 若在任何时点认为「当前 harness 无原生并发」（dsh 是 L-B 或 L-C，取决于探测结果），它就有了一条**完全合规的串行授权**。代价只是「报告顶部必须加一段」（`compatibility.md:58`）声明。

**这与 §2 的缺口形成闭环**：修复阶段没有派发纪律（§2）→ 主 Agent 在「并行 or 串行」上无约束 → `compatibility.md:75` 提供了一个现成的、有文档背书的串行答案 → 主 Agent 选择串行，且**它认为自己在合规降级，而不是在退化**。

**注意 `compatibility.md:48-50` 的语义陷阱**：L-C 列写「3 串行 / 5 串行 / 9 串行」——**实例数没变，只是不并发**。这与「1 个 agent 全做完」是两件完全不同的事。但 L-D 列写「**1 个，标注「降级运行」**」——**这才是单 agent**。而 dsh 明明有 `subagent` 工具（实测审计阶段能派 3 个），它是 L-B（`compatibility.md:47`：「L-B 部分能力 | 有子 Agent + 并发，无 Workflow 脚本」），**不该走任何降级分支**。可框架从未告诉主 Agent「你怎么自证我在 L-B 而不是 L-D」。`environment-probe.md` 的探测项（`:15` 起）里，L-B/L-C/L-D 的判据边界也没有被写成可机械执行的条件。

### 5.2 `stop-hook.mjs` 的相位检查在修复阶段是空转——提示词以为它在守

`framework/orchestrator/protocol.md:472-477`：

> 「**它检查四种情形**：
> | 执行相位（wave2a/2b/3）没有 `current_plan` | 拒绝结束 |
> | `current_plan` 缺 `exit_condition` 或 `steps` 为空 | 拒绝结束 |
> | `in_flight` 里有 agent 没到终态 | 拒绝结束 |
> | 相位声明完成但交付物没落盘 | 拒绝结束 |」

`tools/stop-hook.mjs:70`：

> `if (['wave2a', 'wave2b', 'wave3'].includes(state.phase)) {`

`protocol.md` 自己已经把适用范围写成「执行相位（**wave2a/2b/3**）」——**修复和验证不在内**。`tools/check-state.mjs:233` 同样：

> `if (['wave2a', 'wave2b', 'wave3'].includes(state.phase)) {`

`tools/stop-hook.mjs:150-154` 的交付物检查表：

> ```
> const PHASE_DELIVERABLES = {
>   wave1: () => ...,
>   wave2a: () => ...,
>   report: () => ...,
> };
> ```

**三个相位，两个是审计链路的。** `wave4` / `wave5` 键不存在。

**致命之处**：`protocol.md:445-450`（§0.8.5.1）明确说提示词是**弱手段**：

> 「| 提示词（本文 §0.8） | 定义交付粒度、例外清单 | **弱**——Agent 可以判定某条不适用 |
> | **harness 机制** | Stop hook / `/goal` / 可判定的 pass-fail 检查 | **强**——唯一无法被「觉得不适用」绕过的 |」

框架**自己承认**只有 harness 机制能强制。而 Stop hook 在修复相位**不生效**（`stop-hook.mjs:70` 的相位白名单不含 wave4/5）。所以在修复阶段，框架**只剩下它自己判为「弱」的那一层**。

### 5.3 `protocol.md:208`「按发现逐条推进」——修复路径的官方节奏

`framework/orchestrator/protocol.md:205-209`：

> 「【可选路径 · 有副作用】FIX（独立启动，不是默认流程的一部分）
>   修复 → 验收
>   输入是默认路径里 UPHELD 的发现
>   **可分批、可中断、按发现逐条推进**
>   每条独立记账，一条卡住不影响其他条」

「**按发现逐条推进**」（`:208`）是框架对修复阶段执行节奏的**唯一正面表述**。逐字读：「逐条推进」= one at a time。

后一句「每条独立记账，一条卡住不影响其他条」在**正确读法**下讲的是**错误隔离**（一条失败不拖累其他条），但「一条卡住不影响其他条」这个措辞预设的是**顺序队列**——如果真是并行扇出，措辞应该是「一条失败不阻塞同批其他实例」。**「卡住」这个词只在串行上下文里有意义**（并行时后一条不会等前一条）。

### 5.4 `MANUAL.md:337` 的「由主Agent排序」+ `fix-worker.md:33` 的「由主Agent排序」

同一措辞出现两次：

- `framework/wrappers/fix-worker.md:33`：「共享同一文件的修复必须串行，**由主Agent排序**」
- `framework/MANUAL.md:337`：「**共享同一文件的必须串行**」

「排序」（sort / sequence）是一个**串行原语**。它的对立面是「扇出」（fan out）或「并发度」（concurrency）。框架在审计相位说「并发窗口」（`wave2a-sweep.md:206`），在修复相位说「排序」——**两个不同的词，对应两个不同的心智模型**，而这个词的切换恰好发生在多 agent 纪律消失的同一位置。

### 5.5 `wave2a-sweep.md:468` 的取向声明被错误地放在「本波」

`framework/templates/wave2a-sweep.md:468`：

> 「3. 一条方向性外部结论：多 agent 系统的 token 消耗是单 agent 的数倍，且「多数编程任务的可并行子任务比研究少」——**因此本波的设计取向是「先用便宜的广度换覆盖率，再对少数热点付费买深度」，而不是一上来就 6 维扇出**。」

这句话本身是对的（它在解释为什么宽扫是 1 片 1 agent 而不是 6 维扇出）。但：

- 它的措辞是「**多 agent 系统的 token 消耗是单 agent 的数倍**」，「**多数编程任务的可并行子任务比研究少**」；
- 它出现在**唯一一份带派发章节的模板**（`wave2a-sweep.md`）的**参考来源节**；
- 一个在修复阶段搜索「该不该多 agent」的主 Agent，如果读到这句，得到的信号是**「并行是奢侈的，多数任务可并行子任务少」**。

**这是框架内部唯一一处系统性贬低并行的表述**，且没有任何限定词把它约束在「宽扫的切片粒度」这个语境里。原文只说「本波的设计取向」，没说「此结论不适用于修复相位」——而修复相位的特征恰恰相反：**5 条独立缺陷、不同文件、零共享符号，是最典型的可并行子任务**。

---

## 六、框架有没有定义「调度者」角色的职责边界

### 6.1 判定：**有大量「禁止做什么」，几乎零「必须做什么」；且没有任何一处把「派发」写成义务**

### 6.2 「调度者」不是一个角色，是一个缺席的位置

全仓 `调度者` / `dispatcher` / `Dispatcher` 的命中：

| 位置 | 原文 | 性质 |
|---|---|---|
| `framework/artifacts/run-state.md:609` | 「上面的协议在**没有调度器**的情况下也能落地，方法是让主 Agent 把 `state.json` 当作**自己维护的一个文件**」 | 承认调度器**可能不存在** |
| `framework/orchestrator/protocol.md:216` | 「用户或调度器发出「修复 round{N}」指令才启动」 | 把「调度器」当成**外部实体** |
| `framework/MANUAL.md:103` | 「### 方式二：Agent SDK / **自己写调度器**」 | 调度器 = **代码** |
| `framework/PORTABILITY.md:23` | 「### 方式 A：由**调度器（代码）**加载 —— 最可靠」 | 调度器 = **代码** |

**结论：框架里的「调度器」指的是「用代码写的加载/编排层」，不是「主 Agent 扮演的角色」。** 而 `run-state.md:609` 明确说了在没有调度器时由主 Agent 顶替——但**顶替的是「维护 state.json」这件事，不是「调度者角色定义」**。

### 6.3 唯一的「主 Agent 职责」定义是一份负面清单

`framework/orchestrator/protocol.md:699-707`（§1.2 L0）：

> 「| 禁止行为 | 理由 |
> | 读取**源代码内容**（用 Read/Grep 看实现） | 上下文隔离的第一性原理，整套框架的地基 |
> | 亲自**写代码或修改文件**（除账本、报告、状态机） | 破坏「第二个人独立看过」这一层 |
> | 自行**提高并发上限**超过 `concurrency_window` | round31 的教训 |
> | 自行**降低门控标准**放行不合格输出 | 契约底线 |
> | **裁决冲突**（自己决定谁对） | 必须派 Arbiter |
> | **缩小任务范围后重派** | 必须原样重派新实例 |
> | 修改已冻结的 `scale_decision`（除 L1 允许的项） | 冻结的意义在此 |」

**七条全部是「不得」。** 唯一的「必须派」是「裁决冲突 → 必须派 Arbiter」（`:705`），而 Arbiter 属锐评相位。

`protocol.md:711-717` 的 L1「允许的裁量」表：

> 「| 按**可达性**（`reachability`）调整派发顺序 |
> | 按**线索密度**决定深挖哪些切片 |
> | 按**线索指向的维度**指派深挖维度 |
> | 在**预算耗尽**时选择截断哪些深挖 |
> | 在**同优先级**内调整 FIFO 顺序 |」

**五项全部是「调整已定义的派发」——顺序、选择、截断、FIFO。没有一项是「决定派多少个实例」，因为那是上游算术给定的（`wave2a-sweep.md:196-204`）。**

`framework/README.md:27` 引用了原始硬禁令：

> 「**你不得使用任何代码读取、文件写入、搜索或分析工具。你唯一允许执行的动作是 `spawn_agent` 和 `read_agent_result`。任何需要"看一眼"才能做的决定，都必须转化为一个子Agent任务。**」

**这是全仓最接近「调度者角色定义」的一句话**——而它被 `protocol.md:666-674` 明确标注为**已失效的原设计**：

> 「### 1.1 原禁令与其失效
> 原设计写的是**绝对禁令**：
> > （上述引文）
> **这条路线的收益是真实的**：…这个第一性原理**保留**。
> **但「零裁量」在真实运行中失效了。**」

`protocol.md:1303` 进一步把这条的角色禁令来源降级：

> 「| 主 Agent 不亲自执行领域任务（角色禁令） | `ref0`/`ref2`/`ref3` | **D · 无法核实** | 改写为「本框架的第一性原理是上下文隔离，由此推出主 Agent 只调度」——**从原理推导，不再假装有出处** |」

### 6.4 根因判定：**是，「没有定义调度者职责边界」是主 agent 什么都自己干的根因之一，但更精确的说法是「定义了权限，没定义产出」**

框架对主 Agent 告诉了三件事：

1. **不能做什么**（L0 七条，`protocol.md:699-707`）——清晰、强制、有违规后果（「该轮结论作废」）。
2. **允许裁量什么**（L1 五条，`protocol.md:711-717`）——清晰，要留痕。
3. **必须产出什么**——**只在审计链路以「相位交付物」形式存在**（`protocol.md:250-255` 的四行相位表）。

missing 的是第 4 件：**主 Agent 在每个相位必须「开出多少个实例」**。审计链路有（算术给定），修复链路没有（§3.1 的 `K` 未定义）。

于是在修复阶段，「主 Agent 亲自改文件」的行为会撞上 L0 的哪一条？**一条都撞不上**：

- `protocol.md:701`「读取源代码内容」——如果主 Agent 亲自修，它当然读了源码，但**没有人会检查**（`tools/verify-artifacts.mjs` 检查的是产物里的 `files_read`，不检查主 Agent 的上下文）；
- `protocol.md:702`「亲自**写代码或修改文件**（除账本、报告、状态机）」——**这一条会被撞上**。但撞上之后呢？`protocol.md:744`：「| L0 行为 | 违规 | 该轮结论**作废**，必须在报告中声明 |」。谁来判？

**这才是真正的根因**：L0 的「主 Agent 不得亲自修改文件」是一条**只能事后判定的规则**。判定者是 Skeptic（`protocol.md:751-757`）——**而 Skeptic 属于锐评相位，在修复相位不被派发**。

```
主 Agent 在修复相位亲自改文件
  → 违反 protocol.md:702 (L0)
  → 判定者 = Skeptic (protocol.md:754)
  → Skeptic 只在 wave3 存在 (critique-panel.md:9, trigger_event: WAVE_2_CLOSED)
  → wave4 没有 Skeptic
  → 违规无人判定
```

框架把「主 Agent 不得自己干」的**审计权**放在了一个**只在审计相位存在的角色**上。修复相位是 L0 的**法外之地**。

---

## 七、其他结构性缺陷（补充，非主因但会加重问题）

### 7.1 `fix-worker.md` 与 `verifier.md` 是被 checkout 事故截断的文件

`START-HERE.md:190`：

> 「**5 份 wrapper 的内容永久缺失（行数低于事故前基线）** | **已知未闭合，无源可恢复**。2026-11-13 一次 `git checkout -- framework/wrappers/` 销毁了未提交的改动…`audit-specialist` 少 13%、`critique-panel` 少 36%、**`fix-worker` 少 33%**、`recon-scout` 少 20%、**`verifier` 少 21%**。」

**`fix-worker` 少了 33%，`verifier` 少了 21%——恰好是本报告认定的两个缺口文件。** 这不能证明缺失的内容里有并行条款，但它是**最合理的物理解释**：`sweep-scout.md`（未受损）有 119 行、`:67` 和 `:71` 两处并发规则；`fix-worker.md`（少 33%）只剩 72 行、零处实例唯一性。

`START-HERE.md:190` 最后一句订正了「结构已按契约补齐，但**不补写内容**」——`check-wrapper-integrity` 只校验结构，**不校验语义完整性**。所以这个缺口不会被任何工具发现。

### 7.2 `fix_contracts` 校验是「有才校验」，修复链路可以整段跳过

`tools/check-state.mjs:203`：

> `if (Array.isArray(state.fix_contracts)) {`

**条件守卫。** 如果 `fix_contracts` 不存在（`undefined`），整段校验**跳过**。而 `run-state.md:53` 的 `state.json` 骨架里，`fix_contracts` **不是必填字段**（`TOP_REQUIRED` 见 `check-state.mjs:72`：「`['schema_version', 'trace_id', 'round_id', 'path_mode', 'phase', 'status', 'slices']`」——不含 `fix_contracts`）。

于是：主 Agent 若不建 `fix_contracts` 数组，`wave4-fix.md:58` 的硬规则（「缺失任一字段，修复Agent**不得**进入编辑阶段，主 Agent 判 `CONTRACT_VIOLATION`」）**完全不会被任何工具执行**。这与 §3.2 是同一个病：修复链路的账本字段全是可选的。

### 7.3 框架用伪工具名描述真实动作

| 框架用的名字 | 出处 | 真实工具 |
|---|---|---|
| `spawn_agent` | `protocol.md:670`、`:765`、`MANUAL.md:111` | `subagent`（dsh）/ `Task`（Claude Code） |
| `read_agent_result` | `protocol.md:670` | `subagent-settled` 注入（`protocol.md:528`） |
| `read_result` | `protocol.md:765` | 同上 |
| `write_ledger` / `write_report` / `update_state` | `protocol.md:765` | `Write` / `Edit` |
| `parallel-agent-dispatch` | `protocol.md:1009` | 无。单次消息内多个 `subagent` 调用 |

`protocol.md:521-534` **自己实测清楚**了真实工具的语义：

> 「`subagent` 工具的**返回值是「已启动」，不是「已完成」**：
> tool result: `"started subagent 82757119-cfd1-45d1-8807-d5f82d3f52e6"`」

**但这段实测结论被放在 §0.8.5.4「机制层面为什么会漏掉产物」里，而不是被用来替换 §1.5 白名单里的伪工具名。**

后果：主 Agent 读到「你唯一允许执行的动作是 `spawn_agent` 和 `read_agent_result`」，但工具集里没有这两个名字，只有 `subagent`。**它必须自己做一次名字映射。** 这次映射不需要判断力，但它需要主 Agent 意识到「spawn_agent = subagent」，而框架从未给出这个等式——`PORTABILITY.md` 的能力对照表（`:62-70`）也只有 harness 名，没有工具名映射。

**在修复阶段这个缺陷的代价最高**：主 Agent 已经在用 `Read`/`Edit`/`Bash`，这些工具名是真实的、可用的；而 `spawn_agent` 是个它从未见过的名字。**在「用真实工具」和「用一个只在提示词里存在、名字还不匹配的工具」之间，摩擦最小的路径显然是前者。**

### 7.4 `START-HERE.md` 的入口提示词只教审计，不教修复

`START-HERE.md:25-60` 是整个框架**唯一的入口提示词**（`:23`：「复制下面这段」）。它的三条硬约束：

- `:49-50`「零写入：不得修改 `<TARGET_REPO>` 任何文件」
- `:51-52`「默认只读：跑完 侦察 → 宽扫 → 深挖 → 锐评 → 报告 就结束。修复是另一件事，等我明确说"修复 round{N}"才启动。」
- `:53`「任何终止路径都必须出一份报告」

**没有任何一句告诉用户「启动修复时要给主 Agent 什么」。** 框架明确要求「等我明确说『修复 round{N}』才启动」，但**从未提供「修复 round{N}」这句话的模板**。

这就解释了实测现象：审计阶段任务书（`experiments/hilltop-dsh/task-b2.md:10`）能写「**并行派 3 个 subagent，每个负责一个模块。** 不要一个 agent 串行读三个模块」，是因为用户在**审计阶段知道该派 agent**；修复阶段任务书（`experiments/hilltop-dsh/task-repair.md`）是用户手写的，**全 85 行零次出现 `subagent`/`并行`/`派`**（`grep` 结果：仅 `:74` 提到框架路径，用于指定产物落点）。

**用户为什么没写？** 因为框架从未告诉他修复阶段也需要。而框架从未告诉他的原因，正是 §2/§3 的缺口。

**闭环**：框架缺派发纪律 → 用户不知道要写 → 任务书没写 → 主 agent 按「§5 鼓励串行的那些提示词」执行 → 串行。**用户的这句话是框架缺口的补偿，不是框架的能力。**

### 7.5 `MANUAL.md` 自称「唯一加载的操作文档」，但不在 START-HERE 的加载清单

`MANUAL.md:298`：

> 「而 MANUAL 是主 Agent 唯一加载的操作文档（见下方「加载顺序」）」

但 `START-HERE.md:43-46` 的加载清单是：

> 「【然后读】
> `<FRAMEWORK_ROOT>/orchestrator/environment-probe.md`   ← 环境探测协议
> `<FRAMEWORK_ROOT>/orchestrator/protocol.md`            ← 调度协议（含 harness 优先原则）
> `<FRAMEWORK_ROOT>/artifacts/run-state.md`              ← 状态机」

**`MANUAL.md` 不在这三行里**，而且 `MANUAL.md:298` 说的「见下方『加载顺序』」这一节在文件里**不存在**（`grep -n "加载顺序"` 只命中 `:298` 自身）。

**后果对本报告极其关键**：`MANUAL.md:337`（「每条 `UPHELD` 的发现派一个修复实例」）和 `MANUAL.md:340`（「主Agent → 派 M 个 fix-worker」）是**框架里仅有的两处要求修复必须多实例的表述**，而它们所在的文件**不在默认加载清单里**。

---

## 八、缺陷清单（按严重度排序）

严重度判据：**该缺陷在多大程度上单独解释了实测的「修复阶段 0 次 subagent 调用」**。S1 = 单独足以解释；S2 = 与 S1 叠加后必致；S3 = 加重但不独立。

---

### S1-1｜修复/验证相位在状态机与相位表中不存在，导致所有「相位内不许停」的强制手段在该相位失效

**类型**：缺失
**位置与原文**：
- `framework/artifacts/run-state.md:54`：「`"phase": "init | wave1 | wave2a | wave2b | wave3 | report | closed"`」
- `tools/check-state.mjs:55`：「`phase: ['init', 'wave1', 'wave2a', 'wave2b', 'wave3', 'report', 'closed'],`」
- `framework/orchestrator/protocol.md:250-255`：四行相位表（侦察/发现/锐评/收尾），**零行修复或验证**
- `tools/stop-hook.mjs:70`：「`if (['wave2a', 'wave2b', 'wave3'].includes(state.phase)) {`」

**如何导致串行**：框架自己判定提示词是弱手段、只有 harness 机制是强手段（`protocol.md:445-450`）。Stop hook 是它提供的唯一强手段，而 Stop hook 的相位白名单是 `wave2a/2b/3`。修复阶段因此**只剩下弱手段**。同时，`protocol.md:257`「相位之间可以停」在修复阶段被读成「每修完一条可以停」，因为修复不是相位——`final-report.md:25`（「修复路径（FIX）每条发现结束 | **是**（逐条）」）进一步把逐条停点写成了**要求**。逐条停点必然导向逐条执行、单 session 串行。

---

### S1-2｜修复与验收没有任何「必须派多个实例」的表述；唯一的并发表述是「可并行」+「由主Agent排序」，语义指向串行

**类型**：缺失 + 写错了（两处）
**位置与原文**：
- `framework/wrappers/fix-worker.md:33`：「| 并发约束 | 不同 `target_files` 的修复可并行；**共享同一文件的修复必须串行**，由主Agent排序 |」
- `framework/MANUAL.md:337`：「不同 `target_files` 的修复可并行，**共享同一文件的必须串行**。」
- `framework/wrappers/verifier.md:28-33`：`§2 触发条件` 表**无 `并发约束` 行**（对比 `sweep-scout.md:67`、`audit-specialist.md:32` 都有）
- `framework/templates/wave5-verify.md`：九节标题中零节涉及派发/并发/实例数
- `framework/templates/wave4-fix.md`：七节标题中零节是「派发规则」（对比 `wave2a-sweep.md:191` 有 `## 第 6 节：派发规则`）

**如何导致串行**：
1. 「**可**并行」是许可不是义务。审计相位有 `sweep-scout.md:71` 的「**一个切片一个实例**…**不得**让一个实例承担多个切片」硬规则，修复相位**没有对应物**。
2. 「**由主Agent排序**」把主 Agent 定义为 sequencer 而非 dispatcher。排序是串行原语。
3. 「共享同一文件的必须串行」这条约束，在**没有任何「必须并行」的下限约束时**，唯一安全的满足方式是「一条一条来」——因为串行永远不违反它。
4. `verifier.md` 连「可并行」都没有，`K`（`MANUAL.md:360` 的「派 K 个 verifier」）从未被定义。

---

### S1-3｜框架里唯一一处「主 Agent 必须只调度、不得亲自执行」的完整表述，被自己标注为「已失效的原设计」

**类型**：写错了（自我否定）
**位置与原文**：
- `framework/README.md:27` / `protocol.md:670`（引用原文）：「**你不得使用任何代码读取、文件写入、搜索或分析工具。你唯一允许执行的动作是 `spawn_agent` 和 `read_agent_result`。任何需要"看一眼"才能做的决定，都必须转化为一个子Agent任务。**」
- `framework/orchestrator/protocol.md:666-674`：小标题「### 1.1 原禁令与其失效」，正文「原设计写的是**绝对禁令**：…**但「零裁量」在真实运行中失效了。**」
- `framework/orchestrator/protocol.md:1303`：「| 主 Agent 不亲自执行领域任务（角色禁令） | `ref0`/`ref2`/`ref3` | **D · 无法核实** | 改写为…**从原理推导，不再假装有出处** |」

**如何导致串行**：这句话是**唯一一句把「派发」写成主 Agent 唯一合法动作**的表述。它被标注为失效后，替代品是 L0 的七条负面清单（`protocol.md:699-707`）——七条全是「不得」。**「不得亲自改文件」与「必须派 fix-worker」是两条完全不同的规则**：前者禁止一个行为，后者要求一个行为。框架只保留前者，删除了后者。

在修复阶段，一个主 Agent 面对「5 条 UPHELD 发现 + 一个 Bash/Edit 工具集」，只有一句「不得亲自写代码」在约束它——而**它违反这条的判定者是 Skeptic，Skeptic 只在锐评相位存在**（`critique-panel.md:9`：`trigger_event: WAVE_2_CLOSED`）。**修复相位是 L0 的执法真空。**

---

### S1-4｜`protocol.md:1009` 的「波次之间不是并行扇出」在修复上下文中只剩加粗的否定式

**类型**：写错了（歧义，且在本上下文中只能被读成一种意思）
**位置与原文**：
- `framework/orchestrator/protocol.md:1009`：「波次之间不是并行扇出，而是**顺序波次 + 验证门控**；每一波本身是一个 `parallel-agent-dispatch` 调用…」
- 该句所在节 `:1007` 的闭合条件清单 `:1013-1020` **包含波次四和波次五**

**如何导致串行**：这句话的正确读法依赖后半从句「每一波本身是一个 `parallel-agent-dispatch` 调用」。但（a）加粗在否定式主句上；（b）`parallel-agent-dispatch` 是伪工具名（全仓无此工具，见 S3-3）；（c）**修复相位不是"波次之内"**——它在相位枚举里不存在（S1-1），所以豁免条款无处落地。因此修复阶段从这句得到的唯一可用信号是「不是并行扇出」。

---

### S2-1｜修复与验收的派发数量没有算术，`state.json` 没有对应字段，任何校验器都不可能发现「修复阶段 0 次派发」

**类型**：缺失
**位置与原文**：
- `framework/MANUAL.md:360`：「主Agent → 派 **K** 个 verifier」——`K` 未定义
- `framework/artifacts/run-state.md:41-44`：四个计数字段 `planned_sweep_agents` / `spawned_deep_dive` / `failed_sweep` / `failed_deep_dive` —— **全部是 wave2a/2b 的**
- 全仓 `grep "planned_fix\|fix_budget\|fix_agents"` → **零命中**

**如何导致串行**：审计相位的派发是**一个已定义的算术**（`wave2a-sweep.md:196-204`），主 Agent 不需要决定「要不要派」，只需算数。修复相位没有这个算术，于是「要不要派」重新变成一个**需要主 Agent 主动决定的问题**。在提示词层面，需要主动决定的事会被默认值吞掉，而默认值（单 session 直接改文件）摩擦最低。同时，因为没有账本字段，**框架的所有机械校验器都无法把「修复阶段 spawn 次数 = 0」报出来**——缺失不可观测。

---

### S2-2｜`compatibility.md` 把「串行执行」写成合规降级，且降级判据不可机械执行

**类型**：写错了（提供了合规的串行出路）
**位置与原文**：
- `framework/orchestrator/compatibility.md:74-76`：「### 3.1 没有原生并发怎么办 / `检测到无并发能力 → 串行执行`」
- `framework/orchestrator/compatibility.md:48-50`：能力矩阵，L-C 列「3 串行 / 5 串行 / 9 串行」，L-D 列「**1 个，标注「降级运行」**」
- `framework/orchestrator/compatibility.md:58`：「在 L-C / L-D 上运行时，报告顶部必须加一段」——代价仅为一段声明

**如何导致串行**：这是框架唯一一处**明确写出「串行执行」**的地方，且被呈现为正常降级路径。判据「检测到无并发能力」不可机械执行——dsh 实测能派 3 个 subagent（审计阶段已证），属 L-B，但框架没有给出「如何自证我是 L-B」的判定条件。主 Agent 只需自认「无原生并发」即可获得串行授权，代价是一段报告声明。**这把串行从「退化」重构成了「合规」。**

**加重项**：`compatibility.md:48-50` 的 L-C 列写「3 串行 / 5 串行 / 9 串行」——实例数不变，只是不并发；L-D 列才是「1 个」。两者是不同的失效，但同表呈现，容易被合并理解成「串行 = 少开实例」。

---

### S2-3｜`protocol.md:208`「按发现逐条推进」是框架对修复节奏的唯一正面表述

**类型**：写错了
**位置与原文**：`framework/orchestrator/protocol.md:205-209`：
> 「【可选路径 · 有副作用】FIX（独立启动，不是默认流程的一部分）
>   修复 → 验收
>   输入是默认路径里 UPHELD 的发现
>   **可分批、可中断、按发现逐条推进**
>   每条独立记账，一条卡住不影响其他条」

**如何导致串行**：「逐条推进」逐字就是 one-at-a-time。「一条卡住不影响其他条」——「卡住」是串行语义（并行时不存在「后一条等前一条」）。正确读法是「错误隔离」，但措辞预设了顺序队列。

---

### S2-4｜唯一带「修复必须多实例」义务的两句话，都在非默认加载的文件里，且其中一句在「可选路径」小节

**类型**：缺失（可达性缺失）
**位置与原文**：
- `framework/MANUAL.md:337`：「每条 `UPHELD` 的发现派一个修复实例。」
- `framework/MANUAL.md:340`：「主Agent → 派 M 个 fix-worker」
- 同一节 `:333` 标题：「### 步骤 5：波次四 · 修复（**可选路径，独立启动**）」；`:335`：「**默认路径到此结束。**」
- `START-HERE.md:43-46`：加载清单只有 `environment-probe.md` / `protocol.md` / `run-state.md`，**无 `MANUAL.md`**
- `START-HERE.md:204`：「| 完整操作手册 | `framework/MANUAL.md`（**注意：部分章节已知过期**，见文末缺陷表） |」

**如何导致串行**：框架里仅有的两句「修复必须多实例」位于（a）被标为「可选」的小节、（b）不在默认加载清单的文件、（c）该文件被入口文档警告「部分章节已知过期」。三重可达性衰减后，主 Agent 实际看到的修复规则是 `protocol.md` 的闭合条件（`:1016`）——它只说「每条 UPHELD 都有对应修复 SUCCESS」，**不断言「对应修复」必须是独立 session**。

---

### S3-1｜`fix-worker.md` / `verifier.md` 是 checkout 事故的截断文件（-33% / -21%），且完整性检查只验结构不验语义

**类型**：缺失（可能有内容丢失，不可恢复）
**位置与原文**：`START-HERE.md:190`：「…**`fix-worker` 少 33%**、`recon-scout` 少 20%、**`verifier` 少 21%**…结构已按契约补齐（`check-wrapper-integrity` 全过），但**不补写内容**」
**如何导致串行**：不能证明丢失内容含并行条款，但两个缺口文件（§2）恰好是受损最重的两个（33%、21%）。完整性工具只校验结构，**语义完整性无任何检查**。

---

### S3-2｜`fix_contracts` 校验是「有才校验」的条件守卫，修复链路账本字段全部可选

**类型**：写错了（校验形同虚设）
**位置与原文**：
- `tools/check-state.mjs:203`：「`if (Array.isArray(state.fix_contracts)) {`」
- `tools/check-state.mjs:72`：`TOP_REQUIRED` 不含 `fix_contracts`
**如何导致串行**：`wave4-fix.md:58` 的硬规则（缺任一前置字段「修复Agent**不得**进入编辑阶段」）在 `fix_contracts` 不存在时整段跳过。修复链路的所有账本约束都是可选的，进一步降低「必须走正式派发流程」的压力。

---

### S3-3｜框架用伪工具名（`spawn_agent` / `parallel-agent-dispatch`）描述真实动作，且实测到的真名 `subagent` 未被写进白名单

**类型**：写错了（摩擦不对称）
**位置与原文**：
- `framework/orchestrator/protocol.md:765`：「调度类    `spawn_agent` / `read_result` / `write_ledger` / `write_report` / `update_state`」
- `framework/orchestrator/protocol.md:521-524`：实测「`subagent` 工具的**返回值是「已启动」，不是「已完成」**」，真名 `subagent` 出现在这段实测里，**但没进 §1.5 白名单**
- `framework/orchestrator/protocol.md:1009`：`parallel-agent-dispatch`（无此工具）
**如何导致串行**：修复阶段主 Agent 手里是真实的 `Read`/`Edit`/`Bash`，而「派 agent」需要一个不存在的名字。摩擦不对称使「直接用真工具自己干」成为最小阻力路径。

---

### S3-4｜入口提示词只为审计阶段设计，从未提供「修复 round{N}」的启动模板

**类型**：缺失
**位置与原文**：
- `START-HERE.md:23`：「复制下面这段，把 `<...>` 换成你的实际路径」
- `START-HERE.md:51-52`：「默认只读：跑完 侦察 → 宽扫 → 深挖 → 锐评 → 报告 就结束。**修复是另一件事，等我明确说"修复 round{N}"才启动**。」
- 全 `START-HERE.md`（217 行）**无修复阶段的入口模板**

**如何导致串行**：框架要求「等我说『修复 round{N}』」，却没给这句话的模板。实测任务书 `task-repair.md`（85 行）全文 `subagent`/`并行`/`派` 零命中。**用户的任务书是框架缺口的补偿。** 这条解释了「为什么同一套框架、审计带那句话、修复不带」——不是用户疏忽，是框架从未告诉他需要。

---

### S3-5｜`wave2a-sweep.md:468` 的「多数编程任务的可并行子任务比研究少」没有语境限定

**类型**：写错了（语境未限定）
**位置与原文**：`framework/templates/wave2a-sweep.md:468`：「…多 agent 系统的 token 消耗是单 agent 的数倍，且「多数编程任务的可并行子任务比研究少」——**因此本波的设计取向是…而不是一上来就 6 维扇出**。」
**如何导致串行**：原文只说「本波」，但这句话是全框架唯一系统性贬低并行的表述，且出现在唯一一份带派发章节的模板里。修复相位的特征（5 条独立缺陷、不同文件）恰恰是最可并行的场景，与这句话的取向正相反，而框架未做区分。

---

## 九、一句话总结

**审计阶段多 agent 纪律的实现方式是三重冗余**：硬规则（`sweep-scout.md:71` 实例唯一性）+ 数量算术（`wave2a-sweep.md:196-204`）+ 强制机制（`stop-hook.mjs:70` 相位闭合）。

**修复阶段这三重冗余一条都不存在**：

| 手段 | 审计相位 | 修复相位 |
|---|---|---|
| 实例唯一性硬规则 | `sweep-scout.md:71`、`audit-specialist.md:36` | **无** |
| 派发数量算术 | `wave2a-sweep.md:196-204` | **无**（`K` 未定义） |
| `concurrency_window` 约束行 | `sweep-scout.md:67`、`audit-specialist.md:32` | `fix-worker.md:33` 是「可并行」；`verifier.md` **无此行** |
| Stop hook 相位闭合 | `stop-hook.mjs:70` 含 wave2a/2b/3 | **不含 wave4/5** |
| 账本计数字段 | `run-state.md:41-44` 四个 | **零个** |
| 违规判定者 | Skeptic（`protocol.md:754`） | **Skeptic 不在 wave4** |
| 入口提示词 | `START-HERE.md:25-60` 完整 | **无** |

**所以在修复阶段，「主 Agent 什么都自己干」不是模型不服从，是框架没有给出任何一条可服从的规则。** 差别只在任务书那一句话——而那句话是用户在替框架补它没写的东西。

修复的**最小充分集**（按性价比排序）：

1. 给 `phase` 枚举加 `wave4` / `wave5`，并让 `stop-hook.mjs:70` 与 `check-state.mjs:233` 的白名单覆盖它们（一处改动，恢复整个强制层）。
2. 把 `fix-worker.md:33` 的「**可**并行」改成 `sweep-scout.md:71` 的句式：「**一条 `UPHELD` 一个实例。** 主Agent不得让一个实例承担多条发现。共享 `target_files` 的由主Agent串行化**并记入 `discipline_log`**」——把「排序」从默认行为降级为需要留痕的例外。
3. 给 `run-state.md` 的 `budget` 加 `planned_fix_agents` / `spawned_fix` / `planned_verify_agents` / `spawned_verify`，让「修复阶段 spawn 次数」可观测。
4. 在 `START-HERE.md` 补一段「修复 round{N}」的入口模板，含「每条 UPHELD 派一个独立 fix-worker」。
5. 给 `protocol.md:1009` 加一句限定：「本条只约束波次**之间**；波次**之内**（含修复与验收）必须扇出到实例粒度」。
