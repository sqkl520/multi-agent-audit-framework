# 提示词结构诊断（第三次）：为什么修复相位必然退化成单 agent

**日期**：2026-11-15
**方法**：只读分析，逐章节落盘（防中断）。
**被测前提**（已实测，不重测）：审计阶段任务书写了「并行派 3 个 subagent」→ 主 agent 实际 spawn 3 个，产生 7 个 `delegationDepth: 1` 子 session；修复阶段任务书没写 → 3 次独立运行（113/303/129 次工具调用，单 session 最多 196 step），`subagent` 调用 **0** 次，全部 `delegationDepth: 0`。

**读法约定**：
- **缺失** = 该有而没写（文件里搜不到）。
- **写错了** = 写了，但字面意思被反着理解 / 或与另一条规则互相抵消。

---

## 一、每个文件的 `subagent` / `并行` / `实例` 词频，与「谁显式要求派生」

### 1.1 机械计数（`grep -o | wc -l`，整文件）

| 文件 | 行数 | `subagent` | `并行` | `实例` | `波次` |
|---|---:|---:|---:|---:|---:|
| `README.md` | 385 | **0** | 2 | 20 | 11 |
| `START-HERE.md` | 217 | **4** | 1 | 0 | 4 |
| `framework/MANUAL.md` | 608 | **0** | 3 | 19 | 12 |
| `wrappers/audit-specialist.md` | 90 | **0** | 0 | 5 | 2 |
| `wrappers/critique-panel.md` | 92 | **0** | 0 | 2 | 4 |
| `wrappers/fix-worker.md` | 72 | **0** | **1** | **0** | 1 |
| `wrappers/planner.md` | 161 | **0** | 0 | 2 | 1 |
| `wrappers/recon-scout.md` | 84 | **0** | 0 | 1 | 3 |
| `wrappers/sweep-scout.md` | 119 | **0** | 0 | **5** | 2 |
| `wrappers/verifier.md` | 82 | **0** | **0** | **1** | 2 |
| `components/evidence-policy.md` | 205 | 0 | 1 | 0 | 0 |
| `components/handoff-schema.md` | 326 | 0 | 0 | 5 | 35 |
| `components/output-contract.md` | 731 | 0 | 0 | 14 | 5 |
| `templates/wave1-recon.md` | 300 | **0** | 1 | 1 | 4 |
| `templates/wave2-audit.md` | 830 | **0** | 1 | 3 | 2 |
| `templates/wave2a-sweep.md` | 529 | **0** | 1 | 4 | 10 |
| `templates/wave3-critique.md` | 542 | **0** | 1 | 3 | 19 |
| `templates/wave4-fix.md` | 198 | **0** | **0** | **5** | 3 |
| `templates/wave5-verify.md` | 246 | **0** | **0** | **1** | 17 |
| `orchestrator/protocol.md` | 1318 | **12** | 4 | 12 | 50 |
| `orchestrator/scale-mapping.md` | 369 | 0 | 0 | 16 | 18 |
| `orchestrator/triage.md` | 247 | **2** | 0 | 0 | 3 |
| `orchestrator/compatibility.md` | 243 | **1** | **7** | 0 | 0 |
| `orchestrator/environment-probe.md` | 114 | **6** | 0 | 0 | 2 |
| `artifacts/run-state.md` | 630 | **1** | 0 | 16 | 9 |
| `tools/check-state.mjs` | 332 | **0** | 0 | 0 | 0 |
| `tools/stop-hook.mjs` | 174 | **0** | 0 | 0 | 0 |

### 1.2 第一个结构性事实：`subagent` 在**所有 7 个 wrapper、所有 6 个 template 里，出现 0 次**

这不是疏忽，是**分层设计的结果**：`subagent` 这个词只出现在「orchestrator 层」（protocol / triage / compatibility / environment-probe / run-state）。

但这里有一个致命的错位：

> **orchestrator 层讲的是「主 Agent 的运行时行为」，而 wrapper 层讲的是「角色身份」。**
> 审计相位之所以能派出去，是因为 `wave2a-sweep.md:203` / `:206` 把**派发数量写成了算术**（见 §1.3），并且 START-HERE 那段可直接粘贴的任务书里出现了「并行」「派 agent」的字面。
> 修复相位之所以派不出去，是因为**没有任何一份文件把「修复阶段要派几个」写成数字**。

### 1.3 显式要求派生 subagent 的文件（只有 4 处，全部在审计相位）

| 位置 | 逐字原文 | 性质 |
|---|---|---|
| `framework/wrappers/sweep-scout.md:71` | 「**实例唯一性**：**一个切片一个实例**，且一个实例只承担一个切片。不得让一个实例承担多个切片。」 | 硬规则，**带「不得」** |
| `framework/wrappers/audit-specialist.md:36` | 「**实例唯一性**：每个 `(slice_id, dimension)` 组合对应一个**独立实例**。主Agent不得让一个实例承担多个维度，也不得让两个实例审计同一个 `(slice_id, dimension)`。」 | 硬规则，**带「不得」** |
| `framework/templates/wave2-audit.md:48` | 「同一 `slice_id` 的不同维度由**不同的审计Agent实例**负责。主Agent在派发时确保每个 `(slice_id, dimension)` 组合对应一个独立的Agent。」 | 硬规则 |
| `framework/templates/wave2a-sweep.md:14` | 「原设计要求「每个 `(slice_id, dimension)` 组合派一个独立实例」，6 个维度意味着 `N` 片要派 `6N` 个实例」 | 设计依据（回溯性叙述） |

配套的**算术**（这是「可执行」与「可理解」的分界线）：

- `framework/templates/wave2a-sweep.md:203`：`planned_sweep_agents = min(effective_slices, sweep_budget)`
- `framework/templates/wave2a-sweep.md:206`：`concurrency_window = min(8, harness_cap)`

主 Agent 在审计相位不需要「决定要不要派」——它只需要**算一个已经定义好的数**。

### 1.4 零次「实例」且零次「subagent」的文件（修复/验收相位的全部载体）

| 文件 | `subagent` | `实例` | 有「实例唯一性」段 | 有并发约束行 |
|---|---:|---:|---|---|
| `wrappers/fix-worker.md` | 0 | **0** | **无** | 有，但是**放宽式**（§2 详述） |
| `wrappers/verifier.md` | 0 | 1（`:35` 独立性硬约束） | **无** | **无** |
| `templates/wave4-fix.md` | 0 | 5（全是「一个实例」的**失败重派**语境） | **无** | **无** |
| `templates/wave5-verify.md` | 0 | 1 | **无** | **无** |
| `wrappers/critique-panel.md` | 0 | 2（`:28` 只约束「角色不混」，不约束「开几个」） | 有但**反向** | **无** |
| `wrappers/recon-scout.md` | 0 | 1（`:38` **不重复派发**） | 有但**反向** | **无** |

`templates/wave4-fix.md` 的 5 次「实例」全部出现在 `:152`、`:162` 这类**重派**语境：
> `:162`「主Agent作废该修复Agent的全部输出，**必须**执行回滚（如果可执行），然后派一个**全新的修复Agent实例**从原始缺陷重新执行。」

即：**修复相位唯一提到「实例」的地方，讲的是「出错了要换一个新实例」，从没讲过「本来就应该有几个实例」。**

### 1.5 一个反例值得单独记：`fix-worker` 的 `并发约束` 行

`framework/wrappers/fix-worker.md:33`：
> 「| 并发约束 | 不同 `target_files` 的修复可并行；**共享同一文件的修复必须串行**，由主Agent排序 |」

这一行**是修复相位唯一一句谈到「并行」的话**，而它同时做了两件事：
1. 给出一个「可并行」的许可（不是命令）；
2. 立刻给出一个「必须串行」的例外，并把裁决权交给主 Agent（「由主Agent排序」）。

后果见 §2 与 §3.1。**这是全仓库最典型的「写错了」样本**：它不是缺失，它是一句话同时给出许可和禁令，而禁令带有「必须」二字。

---

## 二、`fix-worker` / `wave4-fix` / `verifier` / `wave5-verify` 的实例唯一性缺口

### 2.1 对照组：`sweep-scout` 的写法有三个**可分别缺失**的零件

`framework/wrappers/sweep-scout.md:71` 只有一行，但它同时装了三个零件：

> 「**实例唯一性**：**一个切片一个实例**，且一个实例只承担一个切片。不得让一个实例承担多个切片。」

拆开来看：

| 零件 | 逐字 | 作用 |
|---|---|---|
| **① 基数规则** | 「一个切片一个实例」 | 给出 `1 : 1` 的算术，主 Agent 可以据此**算出**要开几个 |
| **② 反向禁令** | 「不得让一个实例承担多个切片」 | 堵住「一个 agent 顺序做完所有片」这条偷懒路径 |
| **③ 段落标题** | 「实例唯一性」 | 可被 grep、可被 `check-wrapper-integrity` 检查 |

`framework/wrappers/audit-specialist.md:36` 是同一模板的另一种填法（`(slice_id, dimension)` 组合 → 独立实例），零件相同。

**关键**：零件 ② 是**唯一能挡住「单 agent 顺序扫完全部切片」的句子**。没有它，零件 ① 可以被读成「一个实例可以承担多片，只要每次只做一片」——这在中文里是成立的读法，而且正是模型在修复相位做的事（一次运行做完 129 个 tool call 的全部修复）。

### 2.2 `fix-worker.md`：三个零件**一个都没有**，且第 4 个位置被写成了反向许可

`framework/wrappers/fix-worker.md` 全文 72 行，`实例` 出现 **0 次**，`subagent` **0 次**，`实例唯一性` 段**不存在**。

它有的是一行 `并发约束`（`:33`）：

> 「| 并发约束 | 不同 `target_files` 的修复可并行；**共享同一文件的修复必须串行**，由主Agent排序 |」

逐字拆解这行：

| 片段 | 逐字 | 实际效果 |
|---|---|---|
| 「不同 `target_files` 的修复**可**并行」 | **可**，不是「必须」 | 许可，不是命令。模型可以合法地选择不并行 |
| 「共享同一文件的修复**必须**串行」 | **必须** | 全句唯一的强制词，指向**串行** |
| 「**由主Agent排序**」 | 主 Agent 获得排序权 | 把「要不要并行」变成主 Agent 的**裁量**，而 L1 裁量只需留痕即可 |

**缺口的具体形状**：`fix-worker` 的第 33 行**占据了 `sweep-scout` 第 71 行的位置**（都在「触发条件」表里、都叫「并发约束」），但语义完全相反：

```
sweep-scout.md:71   「一个切片一个实例 ... 不得让一个实例承担多个切片」
                     → 基数 1:1 + 禁令「一实例做多个」被禁止

fix-worker.md:33    「不同 target_files 的修复可并行；共享同一文件的修复必须串行，由主Agent排序」
                     → 基数未定义 + 唯一强制词是「串行」 + 裁决权下放给主 Agent
```

这不是「少写了一句」，是**同一个表位被一句反向的话填满了**。任何「检查 wrapper 是否有并发约束行」的机械检查都会**通过**——字段在，语义反了。

### 2.3 `verifier.md`：有「唯一性」三个字，但约束的是**两个角色不同**，不是**一个发现一个实例**

`framework/wrappers/verifier.md:35`：

> 「**独立性硬约束**：验收Agent与修复Agent必须是不同实例，且验收Agent的上下文不得包含修复Agent的任何自述。」

这是全修复/验收链路里**唯一一句带「必须」的实例约束**，但它回答的是「A 和 B 能不能是同一个」，**不是**「N 条发现该有几个验收实例」。

形状差异：

| 问题 | `sweep-scout:71` 回答 | `verifier:35` 回答 |
|---|---|---|
| 一个实例能做几件事？ | 1 片（基数） | **未回答** |
| 一条发现要几个实例？ | — | **未回答** |
| 两个角色能不能合并？ | 不适用 | 不能（唯一回答的问题） |

于是模型可以合法地推理：「我和修复 Agent 是不同实例（满足 :35），所以我现在这一个实例可以顺序验收全部 N 条发现。」**这句话没有任何一行能反驳它。**

### 2.4 `wave4-fix.md` / `wave5-verify.md`：`实例` 的 5 次 / 1 次出现，全部是**重派**语境

`framework/templates/wave4-fix.md` 中 `实例` 出现 5 次，逐条定位：

| 行 | 逐字 | 语境 |
|---|---|---|
| `:152` | 「可以重派一个**新实例**，携带原始 `finding_ref` 和验收标准，**不继承旧实例的 patch**」 | 失败重派 |
| `:162` | 「派一个**全新的修复Agent实例**从原始缺陷重新执行」 | 契约违规重派 |

`framework/templates/wave5-verify.md` 中 `实例` 仅 1 次（`:149`「作废该验收实例」），同样是**作废/重派**语境。

**这是第二个缺口形状**：修复/验收相位的「实例」词汇被**独占于失败处理**。也就是说，这套文档在修复相位提到「实例」时，**唯一的含义是「上一个坏了，换一个」**。它从未把「实例」当作**正常派发的计量单位**。

对比审计相位：`scale-mapping.md:253` 与 `:131` 用「实例」做**容量计量**（「同时存在的实例数」「85 片需 510 个实例」）。同一个词，两个相位两个语义。

### 2.5 `MANUAL.md:337` 写了基数——但它在三重门后面，且被同一句里的「可并行」抵消

`framework/MANUAL.md:337`：

> 「每条 `UPHELD` 的发现派一个修复实例。不同 `target_files` 可并行，**共享同一文件的必须串行**。」

这一句**确实有零件 ①（基数）**。但它同时具备三个削弱条件：

1. **位置**：它在 `### 步骤 5：波次四 · 修复（**可选路径，独立启动**）` 之下，而该节开头（`MANUAL.md:334`）写着：
   > 「> **默认路径到此结束。** 以下内容只有用户发出「修复 round{N}」指令时才执行。」
   一次「修复 round{N}」运行是否算「进入步骤 5」——文档没说。若模型把它当成「一次独立任务」而不是「步骤 5」，整节就不被加载。

2. **同句自我抵消**：基数后面紧跟「可并行」，再紧跟「必须串行」。三个分句里唯一的强制词是「串行」。

3. **没有 `不得`**：`sweep-scout:71` 的零件 ② 在这里缺失。MANUAL 没说「不得让一个实例承担多条发现」。

### 2.6 缺口的完整形状（一句话）

> **审计相位把「派几个」写成了算术 + 禁令；修复相位把「派几个」写成了一个可选项，并把唯一的强制词留给了「串行」。**

具体到可机械检查的字段：

| 检查项 | `sweep-scout` / `wave2a` | `fix-worker` / `wave4-fix` | `verifier` / `wave5-verify` |
|---|---|---|---|
| 基数公式 | ✅ `planned_sweep_agents = min(effective_slices, sweep_budget)`（`wave2a-sweep.md:203`） | ❌ 无 | ❌ 无 |
| 基数文字 | ✅ 「一个切片一个实例」 | ⚠️ 仅 MANUAL:337（可选路径内） | ❌ 无 |
| 「不得一实例做多个」 | ✅ `sweep-scout.md:71` | ❌ 无 | ❌ 无 |
| 段落标题「实例唯一性」 | ✅ | ❌ | ❌ |
| 并发约束行存在 | ✅ | ✅ **但语义反向** | ❌ |
| `subagent` 一词 | 0（靠 orchestrator 层） | 0 | 0 |

---

## 三、实际鼓励串行的措辞（逐条：原文 → 如何被读成串行）

判定标准：一句话若**同时**满足「出现强制词」且「强制词指向串行/顺序」，就记为 S 级证据；若只是**许可**并行（可/可以/允许），记为弱化证据——因为许可在 L1 裁量体系下等于「可以不做」。

### 3.1 `framework/orchestrator/protocol.md:208` —— 「按发现逐条推进」

```
【可选路径 · 有副作用】FIX（独立启动，不是默认流程的一部分）
  修复 → 验收
  输入是默认路径报告里 UPHELD 的发现
  可分批、可中断、按发现逐条推进          ← :208
  每条独立记账，一条卡住不影响其他条
```

**如何被读成串行**：这是**修复相位的总纲**——`protocol.md` 是「主Agent在整个生命周期中常驻加载」（`:5`），而这一段是全文唯一描述 FIX 路径执行形态的伪代码块。

「逐条推进」在中文里的默认读法是**一次一条、按顺序**。它没有说「逐条**并行**推进」。同一块伪代码里也没有任何派发数量的词（没有「派 M 个」「并行」「扇出」）。

**加重条件**：紧邻的下一行是「每条独立记账，一条卡住不影响其他条」——这句话的**技术含义**是「用多个独立 agent，互不阻塞」，但它的**字面主语是「条」不是「agent」**。模型读到的是一句关于「记账粒度」的话，不是一句关于「并发度」的话。

**这是全仓库最接近「写错了」的一条**：作者想表达「可并行、可分批」，写出来的是「逐条推进」。三个并列短语（可分批 / 可中断 / 逐条推进）里，只有最后一个带动作动词。

### 3.2 `framework/wrappers/fix-worker.md:33` —— 「可并行」+「必须串行」+「由主Agent排序」

> 「| 并发约束 | 不同 `target_files` 的修复可并行；**共享同一文件的修复必须串行**，由主Agent排序 |」

**如何被读成串行**，三层：

1. **唯一的强制词指向串行**。「可并行」是许可；「**必须**串行」是命令。在同一行里，模型会优先服从带「必须」的那个分句——这是提示词工程里稳定的现象（modal verb 强度排序）。
2. **「由主Agent排序」把并发决策变成裁量**。而在 `protocol.md:694` 的裁量分级里，「影响派发顺序/数量」属于 **L1**：
   > 「| **L1 · 允许但必须留痕** | 影响派发顺序/数量、但不改变判断内容 | 可做，**每次必须写 `discipline_log`** |」
   L1 的代价只是「写一条日志」。**不做并行 = 零成本；做并行 = 要写日志 + 承担「共享文件冲突」风险。** 单一理性选择是不并行。
3. **`fix-worker` 是修复 Agent 自己读的文件**（它是 wrapper，即派发时注入的 system prompt）。也就是说：**执行者读到的唯一并发指令，是「必须串行」**。派发者（主 Agent）读的是 `MANUAL.md:337`，两处措辞高度相似，互相印证「串行是常态」。

### 3.3 `framework/MANUAL.md:337` —— 与 3.2 同构，但多了一个前置基数

> 「每条 `UPHELD` 的发现派一个修复实例。不同 `target_files` 可并行，**共享同一文件的必须串行**。」

**如何被读成串行**：同上。额外一点——这句在 `### 步骤 5：波次四 · 修复（**可选路径，独立启动**）` 之下，而该节的**第一句**是：

> `MANUAL.md:334`：「> **默认路径到此结束。** 以下内容只有用户发出「修复 round{N}」指令时才执行。」

于是「修复 round{N}」这个指令**是否算「进入步骤 5」**成了歧义。若模型理解为「这是一次新的、独立的修复任务」，步骤 5 的整节（含 `:337` 的基数句）就不被当作本次运行的指令集。

**加重：MANUAL 自己承认它才是主 Agent 的加载源**。`MANUAL.md:298`：
> 「而 MANUAL 是主 Agent 唯一加载的操作文档（见下方「加载顺序」）」

这句话在文档里出现了一次，却指向一个**不存在的章节**——`MANUAL.md` 全文 608 行没有任何名为「加载顺序」的节（目录见 `:9-21`：0 第一原则 / 1 三个决定 / 2 运行方式 / 3 准备 / 4 执行流程 / 5 每波检查 / 6 出错 / 7 报告怎么读 / 8 字段速查 / 9 常见问题 / 附一页纸）。**这是一个悬挂引用**：它把「MANUAL 是唯一加载源」这个结论的**依据**指到了一个不存在的锚点。

### 3.4 `framework/orchestrator/protocol.md:1009` —— 「波次之间不是并行扇出」

> 「Workflow Wave Dispatch 的纪律是：波次之间不是并行扇出，而是**顺序波次 + 验证门控**；每一波本身是一个 `parallel-agent-dispatch` 调用，波次 N+1 只在波次 N 达到合并/闭合条件后触发。」

**如何被读成串行**：这句话在**技术上是对的**（波次之间串行、波次内部并行），但它的**字面重心在否定并行**（「不是并行扇出」加粗）。而它出现在 `## 3. 波次门控` 节，是主 Agent 常驻加载文件里唯一用加粗字体谈「并行」的地方。

对一个只读了粗体的模型，这句话的净信息是：**「并行」= 被否定的东西**。它需要读到后半句「每一波本身是一个 `parallel-agent-dispatch` 调用」才能恢复正确理解——而后半句没有加粗，且紧接着是「波次 N+1 只在波次 N 达到合并/闭合条件后触发」（又一次强调顺序）。

**缺一句必要的限定**：这句从未说明「修复波内部的 N 条发现，是一次 `parallel-agent-dispatch`，还是 N 次单派」。而 `protocol.md` 的 §3 门控表（`:1020` 附近）对波次四只写了闭合条件，没写派发形态。

### 3.5 `framework/templates/wave2a-sweep.md:468` —— 「而不是一上来就 6 维扇出」

> 「3. 一条方向性外部结论：多 agent 系统的 token 消耗是单 agent 的数倍，且「多数编程任务的可并行子任务比研究少」——**因此本波的设计取向是「先用便宜的广度换覆盖率，再对少数热点付费买深度」，而不是一上来就 6 维扇出**。」

**如何被读成串行**：这是一条**反扇出的设计取向声明**，且带「因此」这个因果连接词，因此读起来像一条**原则**而不是一次局部取舍。它出现在 `## 参考来源` 节，位置在文档末尾——但模型对「设计取向」这类元陈述的权重往往高于散落的技术规则。

`wave2a-sweep.md` 是**宽扫**模板。这条原则被搬到修复相位时，字面依然成立：「修复也先用便宜的广度…而不是一上来就 9 个 agent 扇出。」

### 3.6 `framework/orchestrator/compatibility.md:93` —— 「只能声称『9 个成员按顺序执行』」

> 「3. 只能声称「9 个成员按顺序执行」——这是事实，不含独立性暗示」

**如何被读成串行**：这是 L-C 降级路径的措辞，本意是防止夸大。但它把「按顺序执行」写成了**诚实性的标志**——即「按顺序」= 更可信，「并行」= 需要额外声明。这条与 `compatibility.md:48-50`（L-C 列写「3 串行 / 5 串行 / 9 串行」）叠加后，形成一条隐性联想：**串行是安全默认，并行是需要论证的例外。**

### 3.7 `framework/orchestrator/protocol.md:1140` —— 多失败窗口触发「按顺序执行自动降级」

> 「- **多失败窗口**：如果同一波次内 2 个以上 Agent 在 60 秒内同时失败，主 Agent 应暂停该波次的新派发，记录 `phase_level_failure`，然后**按顺序执行自动降级**，而不是无限等待人工：」

**如何被读成串行**：这是**故障路径**上的规则，但它是全文唯一出现「暂停该波次的新派发」的地方——**这是全仓库唯一一条明确授权「不要派」的规则**，而且它的触发条件极宽（同一波次 2 个以上 agent 在 60 秒内失败）。

在修复相位，若前两条修复派发失败（或干脆没派，因此「没有 agent 失败」），这条不触发；但若模型把它理解为「失败即转为串行」，它就成了一条**把并行降级为串行的合法通道**。

### 3.8 汇总：三类措辞的分布

| 类别 | 出现处 | 数量 | 对修复相位的影响 |
|---|---|---:|---|
| **强制词指向串行** | `fix-worker.md:33`、`MANUAL.md:337` | 2 | **直接**（修复 Agent 与主 Agent 各读一处） |
| **无强制词的顺序暗示** | `protocol.md:208`「逐条推进」、`protocol.md:1009`「不是并行扇出」、`compatibility.md:93`「按顺序执行」 | 3 | **间接但高频**（常驻文件 + FIX 路径总纲） |
| **反扇出设计取向** | `wave2a-sweep.md:468` | 1 | **语境**（被当作原则复用） |
| **授权「不派」** | `protocol.md:1140` | 1 | **故障路径** |

**真正的问题不是「有几句鼓励串行」，而是「一句鼓励并行的强制句都没有」**：

- 修复相位 `必须 + 并行` 的同句组合：**0 处**。
- 审计相位 `必须 + 并行` 的同句组合：`sweep-scout.md:71`「不得让一个实例承担多个切片」（禁令式）、`wave2-audit.md:48`「主Agent在派发时确保」。

---

## 四、`triage.md` 的 T0=3 / T1=5 / T2=9 与实际用 1 个：谁负责触发 TIER 判定？

### 4.1 `triage.md` 的 규定本身是硬的

`framework/orchestrator/triage.md:74-76`：

> 「| **T0** 简单 | 0 | **3** | 执行 1 + 批判 1 + 验证 1 | 1 层 | **没有"降级到 2 个"这条路** |
> | **T1** 标准 | 1 | **5** | 执行、检索、批判、红队、验证 | 2 层 | 五职能齐备 |
> | **T2** 复杂 | ≥2 | **9** | T1 五人 + 规划 + 裁决 + 2 个专项 | 3 层 | 专项角色按任务定制 |」

`triage.md:217` 的自检要求：
> 「| 成员数达标 | **T0≥3 / T1≥5 / T2≥9** |」

`triage.md:224`：
> 「**七项缺一不可。缺任何一项不得派发。**」

**规则本身没有任何问题**——它是文档里最硬、最可机械执行的一段（`tools/check-plan.mjs` 就是为它写的）。

### 4.2 谁负责触发？——`planner` wrapper，而 `planner` 把自己的触发条件写成了 `TASK_RECEIVED`

`framework/wrappers/planner.md:9`：
```
trigger_event: TASK_RECEIVED
```

`planner.md:47`：
> 「| 前置状态 | 用户下达任务，尚未派发任何执行 Agent |」

也就是说：**TIER 判定的触发点是「用户下达任务」这个事件，而不是「主 Agent 决定要不要开面板」这个决策。** 这个设计的隐含假设是「每一个任务都会先经过 planner」。

### 4.3 但入口文档的加载清单里没有 `planner`，也没有 `triage.md`

`START-HERE.md:43-46` 是**唯一一处明确列出「然后读」的文件清单**：

```
【然后读】
<FRAMEWORK_ROOT>/orchestrator/environment-probe.md   ← 环境探测协议
<FRAMEWORK_ROOT>/orchestrator/protocol.md            ← 调度协议（含 harness 优先原则）
<FRAMEWORK_ROOT>/artifacts/run-state.md              ← 状态机
```

**三个文件，没有 `triage.md`，没有 `compatibility.md`，没有 `planner.md`。**

交叉核对整个仓库的引用关系（`grep -rn "triage"`，结果见下）：

| 引用 `triage.md` 的地方 | 是否在入口路径上 |
|---|---|
| `orchestrator/compatibility.md:5`「在 environment-probe.md 之后、triage.md 之前加载」 | **compatibility.md 本身不在 START-HERE 清单里** |
| `orchestrator/compatibility.md:11` 同上 | 同上 |
| `orchestrator/protocol.md:1289`「T2 任务（`triage.md` §2）」 | ✅ 在清单里，**但只是一次括号内的旁引** |
| `wrappers/planner.md:6` `template: orchestrator/triage.md` | planner 不在入口路径上 |
| `wrappers/planner.md:7` `requires: [orchestrator/triage.md, ...]` | 同上 |
| `components/output-contract.md:163` | 只是一句校验说明 |
| `tools/lint-autonomy.mjs` / `tools/check-plan.mjs` | 静态检查器，**运行时不加载** |

**结论：`triage.md` 在运行时路径上没有任何一个「必须加载」的入口。**

### 4.4 这是一个循环依赖，而且闭合得很完整

把加载关系画出来：

```
START-HERE.md:43-46  →  只列 environment-probe / protocol / run-state
                          ↓
                   protocol.md:1289  只把 triage 当作括号旁引
                          ↓
                   triage.md 的加载时机由 compatibility.md 声明
                          ↓
                   compatibility.md:5  「在 environment-probe 之后、triage 之前加载」
                   compatibility.md 自己不在任何加载清单里
                          ↓
                   planner.md 的 requires 才真正加载 triage.md
                          ↓
                   planner.md 的 trigger_event 是 TASK_RECEIVED
                   「什么时候派 planner」没有写
                          ↓
                   回到 START-HERE：任务书里没有「先派 planner」
```

**这是一个三节点的环**：
- `triage.md` 说「主 Agent 收到任务后、派发第一个 Agent 之前加载」（`triage.md:5`、`:11`）。
- 但 `triage.md` 自己**不被任何入口加载**，所以这句话没人读到。
- 唯一加载它的是 `planner.md`，而 `planner.md` 的触发条件 `TASK_RECEIVED` 需要一个**外部事件**——没有任何文件承诺会发生这个事件。

**这就是「导致它永远不被加载」的完整机制**：不是某一个引用断了，而是**每一环都依赖上一环先发生，而第一环没有触发者**。

### 4.5 加重：`planner.md` 自己给了三条「可以跳过你」的理由，且没有一条要求留下可验证痕迹

`framework/wrappers/planner.md:59-63`：

> 「**什么时候可以跳过你**：
> | 任务是纯闲聊/纯问答 | 不需要面板 |
> | 用户已明确指定「就用 N 个 agent，这 N 个角色」 | 用户已代你判定 |
> | T0 且只有一条命令要跑 | 直接「执行+审查」更快 |
>
> **跳过不等于不判定**：哪怕跳过，主 Agent 也必须在账本记一条 `triage_skipped: <理由>`。」

三条豁免理由中，第二条是致命的：

> 「用户已明确指定「就用 N 个 agent，这 N 个角色」→ 用户已代你判定」

**在实测场景里，用户说的是「修复 round{N}」——这既没有指定 N，也没有指定角色。** 但这条豁免的字面结构是「用户指定了 agent 数 ⇒ 跳过」。模型完全可以读成「用户给了明确指令 ⇒ 我按指令做 ⇒ 不需要面板」。

而 `triage_skipped` 的落点——`planner.md:61` 要求写进「账本」。核对该字段是否在 `state.json` schema 里：

```
grep "triage_skipped" framework/artifacts/run-state.md  →  0 命中
```

**这是一个「要求往一个不存在的地方写」的规则**，与 `START-HERE.md:189-190` 自己承认的 `fix_contracts` 事故是同一形状（`wave4-fix.md:60` 的 ⚠ 修正说明：「`state.json` 里此前也没有 `fix_contracts` 字段，规则要求往一个不存在的地方写」）。

`check-state.mjs` 是否会拒绝没有 `triage_skipped` 的 state？核对：`check-state.mjs` 校验 `slices`/`attempt`/`failure.error_type` 等字段，**没有任何一条检查 `triage_skipped`**。所以这条自检不会被执行，也不会被拦住。

### 4.6 `check-plan.mjs` 为什么拦不住

`tools/check-plan.mjs:5-7` 的自我说明：
> 「为什么需要它：规划 Agent 的产出决定「开多大面板」。如果它给的 `member_count` 少于 TIER 要求，或递归深度超界，整个面板制就失效了。」
> 「用法: node check-plan.mjs <plan.md 路径>」

**它的输入是一份 `<plan.md>`**。也就是说：

| 环节 | 是否有机械检查 |
|---|---|
| `planner` 产出了 `plan.md` | ❌ 无（`report-naming.md` 里没有 `00-plan` 这个 stage；`check-deliverables.mjs:11-12` 只要求 `final-report` + `ledger`） |
| `plan.md` 合规 | ✅ `check-plan.mjs` |
| `plan.md` **存在** | ❌ 无人检查 |

**校验器校验一个可能根本不被产出的文件。** 这与 `START-HERE.md:190` 记录的 `check-wrapper-integrity` 情形同构——检查通过不代表被检查的东西存在。

### 4.7 所以「实际用了 1 个」在规则上是被允许的

综合 4.1-4.6：

1. TIER 下限（T0=3）只在 `triage.md` 里，而 `triage.md` 不在入口加载链上。
2. `planner` 是唯一加载 `triage.md` 的角色，而 `planner` 的派发事件 `TASK_RECEIVED` 没有触发者。
3. 即使模型读到 `planner.md`，它可以用「用户已明确指定」这条豁免跳过。
4. 即使跳过，`triage_skipped` 要求写进一个不存在的字段，`check-state.mjs` 不校验它。
5. 即使写了 `plan.md`，`check-plan.mjs` 校验它——但没有任何检查要求 `plan.md` 存在。

**5 个环节里，0 个环节存在「必须发生」的强制点。** 全部是「如果发生了，就会被检查」。

---

## 五、`protocol.md` 的「harness 优先原则」对 dsh 是否空转？

### 5.1 原则的原文（`protocol.md:16-28`）

> 「## 0.0 harness 优先原则（2026-11-09 新增，凌驾于本文件其余调度规则）
>
> **你的 harness 已经提供的运行时能力，本文件不再重复实现。**
>
> ```
> 派发一个任务之前，先问：这件事 harness 能不能做？
>
>   并发控制 / 批次调度  → harness 原生，本文件 §6 不适用
>   任务终态查询        → harness 原生，§4 的重试计数只在无原生能力时用
>   Runtime / token 统计 → harness 原生，本文件从不计量
>   相位编排            → 若 harness 有 Phase 概念，用它的；本文件 §3 作为补充
>   模型选择            → harness 原生，本文件**从未涉及**（这是原设计的遗漏）
> ```
>
> **判定表**：
>
> | 能力 | harness 原生 | 本文件的对应规则 | 该用哪个 |
> |---|---|---|---|
> | 并发上限 | ✅ | §6 并发与总量护栏 | **harness** |
> | 重试/attempt 计数 | ✅（多数） | §4.1 `CONTRACT_VIOLATION` 计数 | **harness**，§4.1 仅作无原生能力时的回退 |
> | 任务状态 | ✅ | §2 状态账本 | **harness** 为事实源，账本只做投影 |
> | 耗时统计 | ✅ | 无（此前靠 mtime 猜） | **harness** |
> | token 计量 | ✅ | **无**（原设计遗漏） | **harness** |
> | 模型选择 | ✅ | **无**（原设计遗漏） | **harness** |
> | 波次门控 | 部分 | §3 波次门控 | harness 有 Phase 时用 harness，语义由 §3 补充 |
> | 审什么 / 证据标准 / 交付物形状 | ❌ | 各 templates / components | **本框架** |」

### 5.2 对 dsh 的实际效果：**部分空转，且空转的那一半正是「派几个」**

dsh（本次实测环境）的能力集：**有 `subagent`，无 Workflow**。按 `compatibility.md:41` 的定义即 **L-B**（「有子 Agent + 并发，无 Workflow 脚本」）。

把 §0.0 的 8 行判定表套到 L-B：

| 能力 | dsh 是否有 | §0.0 说什么 | 对 dsh 的实际效果 |
|---|---|---|---|
| 并发上限 | ✅（subagent 上限 20） | 用 harness 的 | **这条**说的是「同时能跑几个」，**不说「要不要派」** |
| 重试/attempt | 部分 | 用 harness 的 | 与派发量无关 |
| 任务状态 | ✅（`subagent-settled`，但 73% 通知丢失，见 `START-HERE.md:191`） | 用 harness 的 | 与派发量无关 |
| 耗时统计 | ✅ | 用 harness 的 | 无关 |
| token 计量 | ✅ | 用 harness 的 | 无关 |
| 模型选择 | ✅ | 用 harness 的 | 无关 |
| **波次门控** | 部分 | harness 有 Phase 时用 harness，**语义由 §3 补充** | **`§3` 补充的语义里没有「每波派几个」** |
| 审什么/证据标准/交付物 | ❌ | 本框架 | 无关 |

**结论：§0.0 的 8 行里，7 行讲的是「并发上限 / 重试 / 状态 / 耗时 / token / 模型 / 门控」，全部是「派出去之后怎么管」，没有一行是「要不要派、派几个」。**

剩下的那一行（波次门控）指向 `§3`。而 `§3`（`protocol.md:1009-1020`）的波次四闭合条件写的是：
> 「- **波次四（修复）闭合条件**：每一条 `UPHELD` 的发现都有对应的修复Agent返回 `SUCCESS`…」

**这是闭合条件（怎么算完），不是派发条件（怎么开始）**。而且它的措辞「每一条…都有对应的修复Agent」在语法上允许「一个 Agent 顺序处理全部条目」。

### 5.3 空转的具体机制：`scale-mapping.md` §0.1 把**全部算术**交了出去

`framework/orchestrator/scale-mapping.md:27-41`：

> 「### 0.1 判定流程
>
> ```
> 你的 harness 是否有原生能力？
>   ├─ 有并发批次 / 任务状态 / token 计量
>   │    → 第 2~6 节的并发与预算算术**全部跳过**
>   │    → 只保留第 1 节的输入契约（那是数据格式，不是调度策略）
>   │    → **派发量由 harness 在运行时决定，本文件不预设**
> ```

**这一行是致命的**：

> 「**派发量由 harness 在运行时决定，本文件不预设**」

dsh 有「并发批次」和「任务状态」和「token 计量」——三条全中。因此按 §0.1，`scale-mapping.md` 第 2-6 节（含 `planned_sweep_agents` 的算术、`concurrency_window` 的算术、`admission_ceiling`）**全部跳过**。

**但对 dsh 来说，「派发量由 harness 决定」是一件不存在的事**：dsh 的 `subagent` 工具是**主 agent 逐个调用**的（这正是实测里 `delegationDepth: 0` 的含义——没有派就没有子 session）。**harness 不替你决定派几个，它只提供「调用了就执行」的能力。**

于是形成：

```
scale-mapping §0.1 说「派发量由 harness 决定，本文件不预设」
        ↓
dsh 的 harness 没有「决定派发量」这个能力（只有 subagent 原语）
        ↓
没有任何文件预设派发量
        ↓
派发量 = 主 agent 的临场裁量
        ↓
实测：0
```

**这就是「空转」的准确形状**：不是「§0.0 说错了」，而是**§0.0 的判定条件「有并发批次」被 dsh 满足了（它有 subagent 并发），但 §0.0 想让 harness 承担的那个职责（决定派多少）dsh 根本没有**。

「有并发能力」≠「有编排能力」。`environment-probe.md:20` 的分类其实分得清：
> 「□ 其他（纯 subagent，无编排层）」

但 §0.1 的判定树（`scale-mapping.md:30-31`）用的条件是「有并发批次 / 任务状态 / token 计量」——**这三个条件全部可以被「纯 subagent，无编排层」的 harness 满足**。分类标准与判定条件不一致，导致 L-B/dsh 被错误地归入「交给 harness」的分支。

### 5.4 加重：`environment-probe.md` 明确说「按第三行执行」，但第三行是「完整 Markdown 编排 = 全部文件」

`framework/orchestrator/environment-probe.md:52`：
> 「**现在的正确做法**：具有 Workflow 能力（L-A）的 harness，**暂时按第三行「完整 Markdown 编排」执行**，不要去找那个脚本。」

表格第三行（`environment-probe.md:45`）：
> 「| **其他 harness（纯 subagent）** | **完整 Markdown 编排**（现有 `protocol.md` + `scale-mapping.md`） | 全部 |」

即：dsh 应该加载**全部**文件。但 `START-HERE.md:43-46` 只列了 3 个。**「全部」和「3 个」之间没有任何桥。**

---

## 六、`compatibility.md` 的 L-A/B/C/D：框架有没有一步要求「先判定自己哪级」？

### 6.1 有一条要求，但它不可机械执行

`framework/orchestrator/compatibility.md:236`（第 6 节自检）：
> 「| harness 级别已定 | L-A / L-B / L-C / L-D 四选一 |」

`compatibility.md:216`：
> 「**探测结果决定了你在 §2.2 表里的哪一列。** 探测不到的项标 `unknown`，按最保守的级别处理（L-C）。」

**这是全仓库唯一一句要求「先定级别」的话**，位于 `compatibility.md` 第 6 节——而 `compatibility.md` **不在 `START-HERE.md` 的加载清单里**（见 §4.3）。

### 6.2 判据不可机械执行：`detect-harness.mjs` 从不输出级别

`tools/detect-harness.mjs` 的输出字段（`:214-232`）：

```
OS / harness / Workflow 可用 / 并发上限(workflow, subagent) / 建议使用 / 超时(stall, harness 重试) / 证据 / 警告
```

**没有 `level` 字段，没有 `L-A`/`L-B`/`L-C`/`L-D`。** 全仓库核对：

```
grep -rn "L-A\|L-B\|L-C\|L-D" tools/  →  只有 tools/lint-autonomy.mjs:536 的一条正则
                                          { re: /L-A|L-B|L-C|L-D/, name: 'harness 能力分级' }
```

这条正则检查的是「`compatibility.md` 文本里有没有出现这四个字符串」——**它检查文档写了分级，不检查运行时判了级**。

### 6.3 分级判据本身是**二维表**，不是一棵判定树

`compatibility.md:39-42` 的四级定义：

| 级别 | 定义 | 判据维度 |
|---|---|---|
| L-A | 有 Workflow 脚本 **+** 原生并发 **+** 状态查询 **+** token 计量 | 4 项全有 |
| L-B | 有子 Agent **+** 并发，**无** Workflow | 2 有 1 无 |
| L-C | 有子 Agent，**无**并发控制（或极低） | 1 有 1 无 |
| L-D | 无法派子 Agent | 1 无 |

问题在于**「并发控制」这个词没有定义**。dsh 有 `subagent` 工具，可以并发调用（`START-HERE.md:191` 实测「一次并行派发 11 个 subagent」）。那么 dsh 是 L-B 还是 L-C？

- 按「能并发调用 subagent」→ **L-B**。
- 按「没有并发控制机制（不能设并发上限、不能声明批次）」→ **L-C**。

`compatibility.md:216` 的兜底规则是「探测不到的项标 `unknown`，按最保守的级别处理（**L-C**）」。如果模型严格照这条，它会把自己判成 **L-C**，而 `compatibility.md:50` 的 L-C 列写的是：

> 「| **T2（9 成员）** | … | … | **9 串行，无递归** | … |」

**即：按「最保守」这条兜底读，dsh 应该 9 个成员「串行」执行。** 这**直接授权了串行**，并且是在一个「降级不等于打折」的诚实性框架下授权的。

### 6.4 判据可机械执行吗？——逐项核对

| 判据项 | 有探测命令 | 有判定函数 | 可机械执行 |
|---|---|---|---|
| 有子 Agent | ❌ | ❌ | 靠模型自省 |
| 有 Workflow | ✅ `detect-harness.mjs`（版本 ≥ 2.1.150） | ✅ | ✅ |
| 有原生并发 | ⚠️ 只能读到「上限数字」 | ❌ | 数字 ≠ 能力 |
| 有状态查询 | ❌ | ❌ | 靠模型自省 |
| 有 token 计量 | ❌ | ❌ | 靠模型自省 |

**5 项判据里只有 1 项（Workflow）可机械执行。** 其余 4 项要求模型对自己运行时的能力做内省——而 `compatibility.md:216` 的兜底规则会把它推向 L-C，也就是「9 串行」。

### 6.5 一个具体的自相矛盾：`compatibility.md:221-227` 的「这台机器」实测

> 「**这台机器的实测**：
> ```
> harness       claude-code (2.1.289)
> Workflow 可用  likely        → L-A
> 并发上限      16（workflow）/ 20（subagent）
> stall 重试    5 次（原生）
> ```
> **所以这台机器应该走 L-A 列：T2 = 9 并行 + 3 层递归。**」

这段把「Workflow 可用 = likely」直接映射成 L-A，再映射成「9 并行」。

**但 `environment-probe.md:52` 说得很清楚**：
> 「能力探测（`detect-harness.mjs` 报 `Workflow 可用`）只说明 **harness 具备编排能力**，不等于**本框架提供了编排器**」

而 `environment-probe.md:48` 说 `templates/workflow-audit.mjs` **不存在**（「`framework/templates/` 下只有 6 个 `.md`，全框架零个可执行文件」）。

**于是 `compatibility.md` 说「走 L-A = 9 并行」，而 `environment-probe.md` 说「L-A 的编排器不存在，请按 L-B 的第三行执行」。** 两份文件对同一个 harness 给出相反的执行路径，而 `compatibility.md` 是「先于 triage」加载的那份。

### 6.6 dsh 的真实级别判定链（把它走一遍）

```
1. environment-probe 探测：dsh 无 Workflow 工具 → workflow.available = unavailable
2. 查 compatibility §2.1：无 Workflow → 不是 L-A
3. 有子 Agent → 不是 L-D
4. L-B 与 L-C 的差别是「无并发控制（或极低）」——dsh 能并发调 subagent，但
   不能声明批次/上限（只能自己数）→ 判据不明确
5. compatibility §216 兜底：「按最保守的级别处理（L-C）」
6. L-C 列 → T2 = 9 串行，无递归
7. 「降级不等于打折：必须声明」→ 报告顶部加「9 成员串行」声明
8. 于是「串行」成为一个**已声明、已合规**的行为
```

**第 7-8 步是关键**：`compatibility.md:56-66` 的「降级声明」机制，把「串行」从「失败」变成了「一种需要声明的合法模式」。**一旦串行是合法的，就没有任何理由去并行。**

而实测里那次修复运行**连降级声明都没有加**——说明它连 level 判定这一步都没走到。也就是说：这一整套 L-A/B/C/D 分级**在实测中根本没有被触发**，因为它所在的文件不在加载清单里。

---

## 七、框架定义了「调度者」角色吗？L0 只有禁令没有产出的后果

### 7.1 「调度者」只以「主 Agent」的名义存在，没有任何一处定义它的**产出**

核对全仓库的「调度者 / 调度员」：

```
grep -rn "调度者\|调度员"  →  0 命中
```

`protocol.md:12` 的职责边界是唯一接近定义的一句：
> 「> **职责边界**：只定义调度行为，不含任何"如何审查代码"的内容。」

「主 Agent」在 `protocol.md:1.2` 里被定义为**受禁令约束的角色**：

`protocol.md:699-707`（L0 七条禁令）：

> 「| 禁止行为 | 理由 |
> |---|---|
> | 读取**源代码内容**（用 Read/Grep 看实现） | 上下文隔离的第一性原理，整套框架的地基 |
> | 亲自**写代码或修改文件**（除账本、报告、状态机） | 破坏「第二个人独立看过」这一层 |
> | 自行**提高并发上限**超过 `concurrency_window` | round31 的教训：槽位释放条件是**进入终态**，不是「文件已落盘」 |
> | 自行**降低门控标准**放行不合格输出 | 契约底线 |
> | **裁决冲突**（自己决定谁对） | 必须派 Arbiter |
> | **缩小任务范围后重派** | 必须原样重派新实例 |
> | 修改已冻结的 `scale_decision`（除 L1 允许的项） | 冻结的意义在此 |」

**这 7 条全部是「不能做什么」。**

### 7.2 唯一一条正向义务，藏在 `protocol.md` 的旧版引文里

`protocol.md:670`（在 §1.1「原禁令与其失效」里，作为**被修正的历史**引用）：

> 「> **你不得使用任何代码读取、文件写入、搜索或分析工具。你唯一允许执行的动作是 `spawn_agent` 和 `read_agent_result`。任何需要"看一眼"才能做的决定，都必须转化为一个子Agent任务。**」

注意这一句的**结构**：「你唯一允许执行的动作是 `spawn_agent`」——**这是全仓库唯一一句把「派发」定义为主 Agent 的默认动作的话**。而它：

1. 出现在 §1.1「原禁令与其失效」——即**被标记为「已失效 / 已修正」**的小节。
2. `protocol.md:673-683` 紧接着说这条路线的「零裁量」失效了，改为 L1 留痕制。
3. 它从未被重新表述为「新的正向义务」。

**结果**：这句「唯一允许的动作是 spawn_agent」被**降级成历史文献**，而替代它的 L0 七条禁令**全部是负向的**。

### 7.3 后果：一个只有禁令的角色，在「没有任务」时会选择不动

这是本报告最核心的一条推断，值得说清机制：

| 角色状态 | 模型的行为倾向 |
|---|---|
| 有正向义务（「必须产出 X」） | 会为了产出 X 而采取动作，包括派发 |
| 只有负向禁令（「不得做 Y」） | 会**避免** Y；若「不做任何事」也不违反禁令，则不动是安全的 |

**L0 七条禁令的合取，在修复相位等价于「你可以什么都不派，因为这七条一条都不会被违反」。**

具体核对：一个不派任何 subagent、自己用 Edit/Write 修所有缺陷的主 agent，会违反哪条？
- L0-1「读取源代码内容」→ **违反**（它必须读代码才能修）。
- L0-2「亲自写代码或修改文件」→ **违反**（修就是写）。

所以理论上它会被 L0 抓住。但**实测里 3 次运行共 545 次工具调用**——它必然大量读了代码、大量写了文件。这说明 **L0 在实际运行中完全没有被执行**。原因见 7.4。

### 7.4 L0 的执法者是谁？——`Skeptic`，而 Skeptic 只在波次三，修复相位不存在

`protocol.md:751-757`（§1.4 谁检查裁量）：

> 「**Skeptic 的固有职责已扩展**：它是唯一被授权**用机械比对检查 `discipline_log`** 的角色。必须做三件事：
> 1. 把 `discipline_log` 与实际派发记录（`wave2_completed`、产物文件列表）**逐条比对**，找出**未申报的裁量**；
> 2. 检查每条 L1 裁量的 `mechanical_check` 是否**真的可执行**；
> 3. 输出 `discipline_violations[]`，每条附证据。」

**这是 L0/L1 的唯一执法者。** 核对它的存在条件：

| 问题 | 答案 | 依据 |
|---|---|---|
| Skeptic 属于哪个波次？ | 波次三 | `wrappers/critique-panel.md:8` `wave: 3`；`trigger_event: WAVE_2_CLOSED` |
| 修复是哪个波次？ | 波次四 | `wrappers/fix-worker.md:8` `wave: 4` |
| 波次三在波次四之前还是之后？ | **之前** | `MANUAL.md:302` 步骤 3 锐评 → `:333` 步骤 5 修复 |
| 修复相位有 Skeptic 吗？ | **没有** | 全仓库 `critique-panel` 只出现在波次三 |

**执法链的断点在这里**：

```
波次三（锐评）：Skeptic 比对 discipline_log → 检查主 Agent 有没有违规
        ↓ 波次三闭合
波次四（修复）：主 Agent 派 fix-worker → 主 Agent 自己排序、自己决定并行/串行
        ↓
        没有任何角色检查主 Agent 在波次四的裁量
        ↓
        （波次五 verifier 检查的是「修复对不对」，不检查「主 Agent 有没有违规派发」）
```

`verifier.md:20` 的职责：
> 「你不信任审计结论、不信任仲裁裁决、尤其不信任修复者的自我声明。」

**它不信任修复者，但它不检查主 Agent。** 而且 `verifier.md:35` 的独立性硬约束只要求「验收 Agent 与修复 Agent 不同实例」——**没有要求「验收 Agent 检查主 Agent 的派发合规性」**。

### 7.5 更糟：修复相位是「独立启动」的，因此连波次三的结尾检查也不跑

`protocol.md:196-208` 的 FIX 路径伪代码：
```
【可选路径 · 有副作用】FIX（独立启动，不是默认流程的一部分）
  修复 → 验收
  输入是默认路径报告里 UPHELD 的发现
```

`MANUAL.md:334`：
> 「> **默认路径到此结束。** 以下内容只有用户发出「修复 round{N}」指令时才执行。」

**「修复 round{N}」是一次从零开始的运行**：它拿一份已有的报告，进入步骤 5。它**不跑步骤 3（锐评）**，因此**不派 Skeptic**。

于是：

| 相位 | 有 L0 禁令 | 有 Skeptic 执法 | 结果 |
|---|---|---|---|
| 审计（波次 1-3） | ✅ | ✅ | L0 有执行者 |
| 修复（波次 4-5） | ✅（常驻加载） | **❌** | **L0 无人执行** |

**这就是问题的完整答案**：框架有「调度者」这个概念，但没有「调度者的产出物」；L0 七条禁令没有正向对偶（「必须派 N 个」）；而 L0 的唯一执法者 Skeptic 在修复相位**不存在**——因为修复相位是一次独立启动，跳过了 Skeptic 所在的波次三。

**一个只有禁令、没有产出、且执法者缺席的角色，在「不派」和「派」之间，理性选择是不派。** 因为：
- 不派：0 条禁令被违反，0 个执法者会发现任何问题。
- 派：要处理 `fix-worker.md:33` 的「共享文件必须串行」冲突，要写 `discipline_log`（L1），要承担 `subagent` 通知丢失 73% 的风险（`START-HERE.md:191`）。

**框架自己把「派」的成本写得比「不派」高得多。**

---

## 八、把实测任务书放回来对账：这才是真正的根因层

前面七章都在框架内部找缺陷。但**实测任务书**（`experiments/hilltop-dsh/`）一摆出来，因果链的形状变了。

### 8.1 六份任务书的词频

| 任务书 | 用途 | `subagent` | `并行` | 引用 `framework/` 次数 |
|---|---|---:|---:|---:|
| `task.md` | 全仓库审计（走完整框架） | 0 | 0 | **12** |
| `task-core.md` | 审计 core 模块 | **1** | 0 | 4 |
| `task-core2.md` | 审计 core（第二次） | 0 | 0 | 4 |
| `task-b2.md` | 审计 arena/mechanics/ai | **1** | **1** | 1 |
| `task-b3.md` | 审计剩余模块 | **1** | **1** | 1 |
| `task-repair.md` | **修复 5 条** | **0** | **0** | **1（是产物目录，非框架文件）** |
| `task-repair-8.md` | **修复 1 条** | **0** | **0** | **0** |

### 8.2 审计相位那句话的逐字原文（`task-b2.md:12`）

> 「**并行派 3 个 subagent，每个负责一个模块。** 不要一个 agent 串行读三个模块——那样会因上下文超限而草率收尾。」

`task-b3.md:3`：
> 「按风险分成 3 组，**并行派 3 个 subagent**，每个负责一组：」

`task-core.md:9`：
> 「用 subagent 工具派一个审计 agent 去读这些文件，找**真实的代码缺陷**。」

**这三句话有两个共同结构**，缺一不可：

1. **数量**（3 / 3 / 1）——不是「派 agent」，是「派 **N 个** agent」。
2. **否定式反面**（`task-b2.md:12`）：「**不要一个 agent 串行读三个模块**」。

第 2 点是 §2.1 里那个「零件 ②」在**任务书层**的对应物。框架层面 `sweep-scout.md:71` 有零件 ②，任务书层面 `task-b2.md:12` 也有零件 ②。**两层都有，所以审计相位派了。**

### 8.3 修复相位任务书的逐字原文——`task-repair.md` 全文没有一句提到框架

`task-repair.md` 里出现 `framework` 字样的地方只有 **1 处**，且那是**产物输出目录**（`:74`），不是框架规则文件：

> 「`D:/.../multi-agent-audit-framework/experiments/hilltop-dsh/repair/done-<编号>.md`」

**它没有引用 `framework/wrappers/fix-worker.md`，没有引用 `framework/templates/wave4-fix.md`，没有引用 `framework/MANUAL.md`，没有引用 `protocol.md`。** 它对「怎么修」的全部规定是 `task-repair.md:56-70` 的 4 条硬性要求（写红测试、跑全量、不改测试迁就代码、用 `build.cmd`）。

`task-repair-8.md` 更彻底：**`framework/` 引用 0 次**。

对照 `task.md:10-12`（审计相位，明确要求加载框架）：

> 「1. 先读框架的入口：`.../START-HERE.md`
> 2. 按它指出的流程派 recon（侦察）→ sweep（宽扫）→ audit（深挖）→ critique（锐评）
> 3. 每个角色的规则在 `.../framework/wrappers/` 下，**必须加载对应 wrapper 全文**，不许自己编简化版任务书——实测过：绕过 wrapper 手写任务书，**16 份产物 0 份合规**。」

**这就是完整答案**：

```
审计相位：任务书 → 明确要求加载 framework/wrappers/*.md + 明确写「并行派 3 个 subagent」
         → 框架被加载 → 派了 3 个 ✓

修复相位：任务书 → 完全没提框架 → 框架一个字都没被加载
         → 框架里所有关于派发的规则（无论写得好不好）全部不生效
         → 模型按任务书字面执行：一个人顺序修 5 条 → 0 派发
```

### 8.4 但这不构成「框架没问题」的免责——框架有一个结构性缺陷放大了它

如果框架是健康的，那么「修复阶段的入口在哪里」这个问题应该有唯一答案。实际核对：

| 问题 | 框架的答案 |
|---|---|
| 修复阶段该读哪个文件？ | `START-HERE.md` 说：「默认只读：跑完 侦察 → 宽扫 → 深挖 → 锐评 → 报告 就结束。**修复是另一件事**」（`:52`） |
| 「另一件事」要读什么？ | **`START-HERE.md` 全文没有说。** 它只说「等我明确说"修复 round{N}"才启动」，没有说启动后读哪几个文件 |
| 有没有一份「修复阶段入口文档」？ | **没有**。`framework/` 下没有 `FIX-HERE.md`，`MANUAL.md` 的步骤 5 藏在 333 行处，无入口指引 |
| `MANUAL.md` 是不是入口？ | `START-HERE.md:204` 说「完整操作手册 `framework/MANUAL.md`（**注意：部分章节已知过期**，见文末缺陷表）」——**「已知过期」这四个字直接降低了它作为入口的可信度** |

**这是「缺失」而非「写错了」，而且是最严重的一类缺失**：

> 框架把「审计」写成了一个有入口、有清单、有可粘贴任务书的**完整产品**（`START-HERE.md` 全文 217 行几乎都在讲审计）。
> 而「修复」被写成了一个**附录**：它有角色（`fix-worker`）、有模板（`wave4-fix`）、有契约（`output-contract/fix.md`）、有重派规则（`wave4-fix.md` §6）——**唯独没有入口**。

于是任何人在启动修复时，唯一能写的任务书就是 `task-repair.md` 那种——纯业务描述，零框架引用。**框架的所有修复侧规则在实测中从未被加载过一次。**

### 8.5 一个反证：框架自己的历史事故用的是同一个形状

`START-HERE.md:190` 记录：

> 「**5 份 wrapper 的内容永久缺失（行数低于事故前基线）** … `fix-worker` 少 33% …」

核对 `tools/fixtures/wrapper-baseline.json`：
```json
"fix-worker": 109,
```
实际 72 行。**缺失的 37 行（33%）正好可能是那个「实例唯一性」段所在的段落。**

而 `check-wrapper-integrity.mjs:40-46` 的 `REQUIRED_SECTIONS` 只检查五个固定小节：
```js
{ re: /^## ?1\. ?身份声明/m, ... },
{ re: /^## ?2\. ?触发条件/m, ... },
{ re: /^## ?3\. ?强制加载/m, ... },
{ re: /^## ?4\. ?产物格式（硬要求）/m, ... },
{ re: /^## ?5\. ?返回要求/m, ... },
```

**「实例唯一性」不在五节之列**——它本来应该是 `## 2. 触发条件` 里的一个表格行或一段，而 `minBody: 120` 的检查只看字数。

所以：`check-wrapper-integrity` 在 `fix-worker` 丢失 33% 内容后**仍然全过**（`START-HERE.md:190` 明说「结构已按契约补齐（`check-wrapper-integrity` 全过）」）。**它不能发现「实例唯一性段丢了」，因为那段从来不是必检项。**

**这才是最深的一层**：`sweep-scout` 有零件 ②，`fix-worker` 曾经可能有、现在丢了，而**没有任何机械检查能发现这个丢失**——因为检查器只认五个固定小节的标题和字数。

---

## 九、按严重度排序的清单

### S1 —— 单独足以解释 0 次 subagent

**S1-1｜修复相位没有入口文档，`START-HERE.md` 明确把修复排除在自身之外，且不指向任何替代入口**

- 位置：`START-HERE.md:52`、`START-HERE.md:204`
- 逐字：`:52`「默认只读：跑完 侦察 → 宽扫 → 深挖 → 锐评 → 报告 就结束。**修复是另一件事**，等我明确说"修复 round{N}"才启动。」
- 后果：启动修复时无人知道该加载什么。实测 `task-repair.md` 对框架路径的引用 **0 次**（唯一的 `.../multi-agent-audit-framework/experiments/...` 串是**产物输出路径**，不是框架规则文件）；`task-repair-8.md` **0 次**。框架的修复侧全部规则（`fix-worker.md`、`wave4-fix.md`、`wave5-verify.md`、`output-contract/fix.md`）**一次都没被加载**。
- 类别：**缺失**。这是唯一一条**单独**足以解释「0 次 subagent」的——因为规则没进上下文，写得多好都没用。

**S1-2｜修复相位没有任何「必须派 N 个」的强制句；唯一带「必须」的词指向串行**

- 位置：`wrappers/fix-worker.md:33`、`MANUAL.md:337`
- 逐字（`fix-worker.md:33`）：「| 并发约束 | 不同 `target_files` 的修复可并行；**共享同一文件的修复必须串行**，由主Agent排序 |」
- 后果：即使 S1-1 被修好（框架被加载），这两句的净信息仍是「串行是强制、并行是许可」。同句里「可并行」无强制力，「必须串行」有，「由主Agent排序」把决策降为 L1 裁量。
- 类别：**写错了**（有并发约束行，语义反向）。

**S1-3｜`fix-worker` / `verifier` / `wave4-fix` / `wave5-verify` 均无「实例唯一性」段，且无任何机械检查会因此失败**

- 位置：`wrappers/fix-worker.md`（0 次「实例」）、`wrappers/verifier.md:35`（只约束「两角色不同实例」，不约束基数）、`templates/wave4-fix.md:152,162`（「实例」只在重派语境）、`templates/wave5-verify.md:149`（同）
- 对照：`wrappers/sweep-scout.md:71`「**实例唯一性**：**一个切片一个实例**…**不得让一个实例承担多个切片**。」
- 后果：修复链路的「实例」一词被**独占于失败重派**，从未作为派发计量单位。且 `check-wrapper-integrity.mjs:40-46` 的必检五节不含此项，丢失无法被发现（`wrapper-baseline.json` 记 `fix-worker: 109`，实际 72 行，检查仍全过）。
- 类别：**缺失**。

### S2 —— 叠加后必致（任一单独可能不足，但组合起来必然）

**S2-1｜`triage.md` 的 T0=3/T1=5/T2=9 在运行时路径上无触发者（三重环）**

- 位置：`START-HERE.md:43-46`（加载清单只有 3 个文件，无 `triage.md`）、`triage.md:5`、`triage.md:11`、`compatibility.md:5`（声明 triage 的加载时机，但 compatibility 自己也 abstain）、`wrappers/planner.md:9`（`trigger_event: TASK_RECEIVED`，无触发者）
- 逐字（`triage.md:224`）：「**七项缺一不可。缺任何一项不得派发。**」——规则极硬，但读不到。
- 后果：TIER 下限从未被计算过。实测修复用 1 个，低于 T0 下限 3。
- 类别：**缺失**（加载链断裂）。

**S2-2｜`planner.md:59-63` 的「可跳过」豁免 + `triage_skipped` 字段不存在 → 跳过不可检出**

- 位置：`wrappers/planner.md:61`、`triage.md:90`
- 逐字（`planner.md:61`）：「**跳过不等于不判定**：哪怕跳过，主 Agent 也必须在账本记一条 `triage_skipped: <理由>`。」
- 核对：`grep -c "triage_skipped" framework/artifacts/run-state.md` → **0**。`check-state.mjs` 不校验该字段。`report-naming.md` 的 stage 表（`:47-54`）无 `00-plan`，`check-deliverables.mjs:11-12` 只要求 `final-report` + `ledger`。
- 后果：跳过面板**不留痕、不被校验、plan 文件不要求存在**。`check-plan.mjs` 校验一个可能永不产出的文件。
- 类别：**缺失 + 写错了**（要求往不存在的地方写）。

**S2-3｜`scale-mapping.md:34`「派发量由 harness 在运行时决定，本文件不预设」在 L-B/dsh 上把全部算术交出去，而 harness 无此职责**

- 位置：`orchestrator/scale-mapping.md:27-41`
- 逐字（`:34`）：「→ **派发量由 harness 在运行时决定，本文件不预设**」
- 后果：dsh 有 `subagent` 并发 → 满足 §0.1「有并发批次/任务状态/token 计量」→ 第 2-6 节算术全部跳过 → 但 dsh 的 harness **只提供 `subagent` 原语，不决定派几个**。审计相位的 `planned_sweep_agents = min(effective_slices, sweep_budget)`（`wave2a-sweep.md:203`）因此失效。
- 类别：**写错了**（判定条件误判了 L-B 的能力边界）。

**S2-4｜L0 七条禁令全负向，唯一正向义务「唯一允许的动作是 spawn_agent」被降级为历史文献；执法者 Skeptic 在修复相位不存在**

- 位置：`protocol.md:670`（旧版引文，被 §1.1 标为「已失效」）、`protocol.md:699-707`（L0 七条，全为禁令）、`protocol.md:751-753`（Skeptic 是唯一执法者）、`wrappers/critique-panel.md:8`（`wave: 3`）、`wrappers/fix-worker.md:8`（`wave: 4`）、`protocol.md:206`（FIX「独立启动」）
- 逐字（`protocol.md:753`）：「**Skeptic 的固有职责已扩展**：它是唯一被授权**用机械比对检查 `discipline_log`** 的角色。」
- 后果：修复相位从波次三之后独立启动，跳过 Skeptic。**L0 在修复相位没有任何执行者**，而 L0 全部是「不能做什么」，不含「必须产出什么」。
- 类别：**缺失**（正向义务缺失 + 执法链断裂）。

### S3 —— 加重但不独立

**S3-1｜`protocol.md:208`「按发现逐条推进」是 FIX 路径的唯一执行形态描述**

- 逐字：「可分批、可中断、**按发现逐条推进**」
- 「逐条推进」的中文默认读法是一次一条、按顺序；同块伪代码无任何派发数量词。
- 类别：**写错了**（想表达并发，写成顺序）。

**S3-2｜`protocol.md:1009`「波次之间不是并行扇出」加粗了否定并行的那半句**

- 逐字：「波次之间不是并行扇出，而是**顺序波次 + 验证门控**；每一波本身是一个 `parallel-agent-dispatch` 调用…」
- 「不是并行扇出」+「顺序波次+验证门控」都在加粗/强调位，正确的后半句「每一波本身是一个 parallel-agent-dispatch 调用」无强调。
- 类别：**写错了**（重心偏移）。

**S3-3｜`compatibility.md` 的 L-A/B/C/D 判据 5 项里只有 1 项可机械执行；兜底推向 L-C（9 串行）**

- 位置：`compatibility.md:39-42`（四级定义）、`:216`（兜底「按最保守的级别处理（L-C）」）、`:50`（L-C 列 = 「9 串行，无递归」）
- 核对：`detect-harness.mjs` 输出无 `level` 字段（`:214-232`）；`grep -rn "L-A\|L-B\|L-C\|L-D" tools/` 只命中 `lint-autonomy.mjs:536` 的一条**文本存在性**正则。
- 后果：判定不可机械执行；「最保守」兜底把串行变成**已声明合规**的行为。
- 类别：**写错了**（判据不可执行 + 兜底方向鼓励串行）。

**S3-4｜`compatibility.md:227` 与 `environment-probe.md:48-52` 对同一 harness 给出相反路径**

- `compatibility.md:227`：「**所以这台机器应该走 L-A 列：T2 = 9 并行 + 3 层递归。**」
- `environment-probe.md:48`：「`templates/workflow-audit.mjs` **在仓库里不存在**」；`:52`：「**暂时按第三行「完整 Markdown 编排」执行**」
- 类别：**写错了**（两份文件互相矛盾，且 compatibility 被声明为「先于 triage」加载）。

**S3-5｜`MANUAL.md:298` 的「加载顺序」章节不存在（悬挂引用）**

- 逐字：「而 MANUAL 是主 Agent 唯一加载的操作文档（见下方「加载顺序」）」
- 核对：`MANUAL.md` 目录（`:9-21`）无此节；全文无匹配标题。
- 类别：**写错了**（引用指向不存在的锚点，使「MANUAL 是唯一加载源」这一关键结论失去依据）。

**S3-6｜`wave2a-sweep.md:468`「而不是一上来就 6 维扇出」被写成设计取向**

- 逐字：「**因此本波的设计取向是「先用便宜的广度换覆盖率，再对少数热点付费买深度」，而不是一上来就 6 维扇出**。」
- 带「因此」因果连接词，读作原则而非局部取舍；搬到修复相位字面仍成立。
- 类别：**写错了**（局部取舍写成了普遍原则）。

**S3-7｜`fix-worker.md` 内容缺失 33%，丢掉的 37 行可能包含实例唯一性段，且检查器无法发现**

- 位置：`tools/fixtures/wrapper-baseline.json`（`"fix-worker": 109`）、实际 72 行、`check-wrapper-integrity.mjs:40-46`（必检五节不含「实例唯一性」）
- 类别：**缺失**（不可恢复，但恰好是本次缺口的形状）。

---

## 十、一句话结论

**框架在审计相位是一个产品（有入口、有清单、有算术、有禁令），在修复相位是一个零件库（有角色、有模板、有契约、无入口）。**

实测的两句话差异不是「巧合的一句话」——它是**框架唯一一个把「必须派」写进任务书的地方**（`task.md:12`「必须加载对应 wrapper 全文」+ `task-b2.md:12`「并行派 3 个 subagent，**不要一个 agent 串行读三个模块**」）。修复阶段没有对应的那句话，**因为框架从来没有为修复阶段准备过一份可粘贴的入口任务书**。

要让修复相位也派发，最小改动不是往 `fix-worker.md` 加一句「必须并行」——而是：

1. 建 `START-HERE-FIX.md`，给出与 `START-HERE.md:25-60` 同构的**可粘贴任务书**，其中必须包含「派 N 个 fix-worker」+「不要一个 agent 串行修全部条目」；
2. 把 `MANUAL.md:337` 的「派一个修复实例」升级为带算术的公式（`planned_fix_agents = len(upheld_findings)` 的去重后值），并加「不得让一个实例承担多条 finding」；
3. 给 `check-wrapper-integrity.mjs` 的 `REQUIRED_SECTIONS` 加一项「实例唯一性」（或等价的 `subagent`/`并发约束` 语义检查），使 S3-7 那类丢失可被发现；
4. 把 `START-HERE.md:43-46` 的加载清单补上 `triage.md` + `compatibility.md`，或改写 `planner.md:9` 的 `trigger_event` 使其不再依赖一个不存在的 `TASK_RECEIVED` 事件。




