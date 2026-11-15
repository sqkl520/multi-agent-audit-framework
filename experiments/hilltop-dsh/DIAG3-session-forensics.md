# DIAG3 · 会话取证：主 agent 为什么全程没派子 agent

**日期**：2026-11-15
**性质**：只读取证。所有数字均由本机 dsh 日志机械解析得出，未运行 dsh，未改动任何非产物文件。
**状态**：COMPLETE —— 五个问题全部有直接证据；每个计数都可按文中给出的事件类型复现。

---

## 先给结论

| 问题 | 答案 |
|---|---|
| **1. 是「没想到」还是「想到但判断不该做」？** | **「没想到」**。三个修复 session 共 **295 条非空 reasoning / 485,097 字符**，`subagent` 出现 **0 次**；`并行`、`分解`、`decompos`、`委派`、`分工` 也全部为 0。没有任何一段在权衡、列举或否决「派子 agent」。 |
| **2. 压缩有没有丢掉任务书的分工要求？** | **没有，因为任务书里本来就没有分工要求。** `a40f0162` 压缩 5 次、42 次 prune、共 20.4 万 token；原始任务书 `seq 8` **从未被 prune**，5 份摘要每次都完整保留 5 条缺陷与测试纪律。摘要里也没有任何 `subagent`/`parallel`/`并行` 字样——源头就没有。 |
| **3. `subagent` 工具描述有没有保守措辞？审计/修复两阶段有无差别？** | **没有任何「除非用户要求否则不要用」类措辞。** 描述 560 字符，纯正向能力说明。审计与修复阶段的 system prompt、25 个工具 schema、`subagent` schema **哈希完全相同**（`bc9f677b65e0e81f`）。唯一的保守措辞挂在 `workflow` 上，而且紧接着一句就是「一到两次委派优先用普通 subagent」。 |
| **4. 审计阶段 3 次成功派发的触发是什么？** | **任务书直接写了「并行派 3 个 subagent」。** 主 agent 的 reasoning 只是把这句话复述成自己的计划（"Need 3 subagents parallel, each module" → "Need dispatch now"），随后在**同一条 assistant message** 里发出 3 个 `subagent` 调用。不是它自己判断出该并行，是指令进了计划。 |
| **5. 三个修复 session 收到的任务书与磁盘文件是否一致？** | **一致（`a40f0162`/`d5ad7820` 逐字节一致，仅差文件末尾换行）。** `e0582c67` 收到的是 `task-repair.md` 的**上一版**，差异仅为构建命令（`build.sh` → `build.cmd`）和一段运行环境说明。三份修复任务书中 `subagent`/`并行`/`parallel`/`分工`/`分解`/`delegate` **全部为 0**；`d5ad7820` 唯一一个「派」是用户说「这条我现在正式派给你」。 |

**一句话**：缺陷不在工具、不在模型、不在压缩，而在**修复任务书没有任何「把工作拆开派出去」的触发条件**；同一套 harness 在审计任务书明确写「并行派 3 个 subagent」时，每次都稳定派出 3 个。

---

## 0. 解码方法与字段位置

用 Node 26 内置 zstd 解码：

```js
const fs=require('fs'), z=require('zlib');
const out = z.zstdDecompressSync(fs.readFileSync(path)).toString();
const L = out.split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l)}catch(e){return null}}).filter(Boolean);
```

字段位置（实测确认，均非猜测）：

| 数据 | 位置 |
|---|---|
| 委派深度 | `session` 事件的**顶层** `delegationDepth` |
| 工具调用 | `tool/call` → `.data.name` + `.data.arguments`（arguments 是 JSON 字符串） |
| reasoning | `assistant/message` → `.data.message.content[]` 中 `type === 'reasoning'`，文本在 `.text` |
| 工具 schema | `request/header` → `.data.header.tools[]` |
| 注入任务书 | `agent/inbox/spliced` → `.data.inserted[].content[].text` |
| 压缩 | `compaction/start` / `compaction/summary` / `compaction/end` / `compaction/prune` |

### 受检 session

| 标签 | session id | 目录 | depth | steps | 工具调用 | subagent 调用 | 结束状态 |
|---|---|---|---|---|---|---|---|
| 修复 #1 | `e0582c67-6bed-41a1-9cb7-0e3e59872be0` | audit-framework | 0 | 66 | 113 | **0** | **日志截断，无 `turn/end`** |
| 修复 #2 | `a40f0162-d036-49ca-8677-efb40f821c06` | Hilltop plugin | 0 | 196 | 303 | **0** | 完成（57.5 分钟） |
| 修复 #3 | `d5ad7820-e3c4-4c04-a260-bcb8cafe1ac0` | Hilltop plugin | 0 | 82 | 129 | **0** | 完成（19.0 分钟） |

**必须标注的采样偏差**：`e0582c67` 是**不完整日志**——仅 9.4 分钟，最后一个事件是 step 66 的 `job/registered`，没有 `turn/end`。它的 59 条 reasoning 只覆盖已记录部分。这不影响结论（59 条 / 11.6 万字符中 `subagent` 仍为 0，任务书关键词也为 0），但不应把它描述成一次完整修复。承重样本是 `a40f0162` 与 `d5ad7820` 这两个完整单轮。

工具调用直方图（来自 `tool/call`）：

- `e0582c67`（113）：`read` 62、`pwsh` 29、`grep` 15、`job_output` 4、`write` 3
- `a40f0162`（303）：`read` 124、`pwsh` 64、`edit` 59、`grep` 43、`write` 9、`todo_write` 2、`glob` 1、`working_directory` 1
- `d5ad7820`（129）：`read` 45、`grep` 26、`pwsh` 23、`edit` 23、`glob` 6、`write` 3、`job_output` 2、`job_kill` 1

三者合计：`subagent` 0、`subagent_fork` 0、`workflow` 0、`send_message` 0、`list_agents` 0、`interrupt_agent` 0。

---

## 1. 核心问题：是「没想到」还是「想到但判断不该做」？

### 1.1 定量结果

从每个 `assistant/message` 的 `reasoning` 块提取全文，大小写不敏感检索。

| session | 非空 reasoning 条数 | 含空块总数 | reasoning 字符数 | `subagent` | `sub-agent` | `子agent` | `子代理` | `并行` | `parallel` | `分解` | `decompos` | `委派` | `delegate` | `分工` | `派`（任意） |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `e0582c67`（修复1） | 59 | 132 | 116,425 | **0** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | **0** |
| `a40f0162`（修复2） | 165 | 392 | 239,342 | **0** | 0 | 0 | 0 | 0 | **3** | 0 | 0 | 0 | **1** | 0 | **0** |
| `d5ad7820`（修复3） | 71 | 164 | 129,330 | **0** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | **1** |
| **合计** | **295** | **688** | **485,097** | **0** | **0** | **0** | **0** | **0** | **3** | **0** | **0** | **0** | **1** | **0** | **1** |

> **明确写法：295 条非空 reasoning 中，`subagent` 出现 0 次。** 若把空块也算入，分母是 688，命中仍是 0。`子agent` / `子代理` / `并行` / `分解` / `decompos` / `委派` / `分工` 同样为 0。只有 `parallel`（3 次）、`delegate`（1 次）、`派`（1 次）出现过，且全部是假阳性，下面逐字引用以便审计。

dsh 会在多数 assistant 消息上挂一个 `reasoning` 块，但多数是空字符串（688 块中只有 295 块有文本）。上表只统计非空文本；把空块算进去不改变任何关键词计数。

### 1.2 暴露量 vs 检索量：词一直在上下文里，只是没进思考

`request/header` 会在每次模型请求时重发，因此可以统计 `subagent` 这个词实际出现在 prompt 里的次数：

| session | `request/header`（工具 schema） | `system/message` | 自己产出的 `assistant` 文本/reasoning | `user/message` | `tool/result` |
|---|---|---|---|---|---|
| `e0582c67` | **105** | 4 | **0** | 0 | 0 |
| `a40f0162` | **240** | 4 | **0** | 0 | 0 |
| `d5ad7820` | **120** | 4 | **0** | 0 | 0 |

`request/header` 分别出现 7 / 16 / 8 次，每次携带 `subagent`、`subagent_fork`、`list_agents`、`interrupt_agent`、`send_message` 的描述，合计每个 header 约 15 次「subagent」字样。

也就是说，`a40f0162` 在 196 个 step 里被重复展示 `subagent` 工具 **240 次**，外加 4 次 system prompt 的正面指引，它自己一次都没写出这个词。这不是「没看见」，而是**检索/触发失败**：工具在，但当前任务的任何特征都没有映射到它。

### 1.3 5 处松散命中全部是假阳性（逐字引用）

1. `a40f0162` seq 43，step 1.3 —— `parallel`：
   > "Need read relevant chunks. ConfigManager 1250-1660, 400-450, merge method, normalizeWaveTimeout, hasUnsaved. Also GameConfig fields/setters. MainConfigMenu. NodeListener. ExplodeBeetle. ArenaReset. Tests. **Use parallel reads.**"

   指同一步发多个 `read` 调用，与子 agent 无关。

2. `a40f0162` seq 1417，step 1.190 —— `parallel`（2 次）：
   > "Also test full. **Parallel: full suite and list.** Then copy after."
   > "We can run and simultaneously list artifacts? Independent. **Use multi_tool parallel.**"

   指本地并行跑构建和列目录。

3. `a40f0162` seq 994，step 1.133 —— `delegate`：
   > "Existing call sites nodes use overload 6 args **delegates** true."

   Java 方法重载委托（`abort(...)` → `abort(..., true, ...)`），与 agent 无关。

4. `d5ad7820` seq 296，step 1.39 —— `派`：
   > "这条我现在正式**派**给你，编号 #8「reload 消息说谎」。"

   这是模型在 reasoning 中**复述用户任务书**、讨论范围。是用户在派活，不是 agent 在考虑委派。

`multi-agent` 的出现同样是背景词：`a40f0162` seq 1428 指框架目录名 `multi-agent-audit-framework`；`e0582c67` seq 417/426 指「这是一个自动化多 agent 审计实验」的任务背景。**reasoning 中没有任何一处提议、评估或否决委派。**

### 1.4 判定

**是「没想到」。更准确地说：不是「考虑后放弃」，而是这个选项根本没有进入推理词汇表。**

在 485,097 字符里，没有任何一段出现下列任何一种结构：
- 把「派子 agent」列为可选项；
- 比较串行做与并行派的成本；
- 以「上下文开销 / 协调成本 / 任务原子性 / 沙箱限制」为理由拒绝；
- 把某个子任务标记为「可以独立交给子 agent」。

失败模式是 **无触发、无检索**：工具在 schema 里（见 §3），system prompt 甚至有正向提示（见 §3.2），但这个选项从未进入 deliberation。

对提示词设计的直接含义：
- **不是**「删掉某条保守的『除非用户要求否则别用』」——`subagent` 上根本没有这条（见 §3）。
- **不是**「纠正一个错误的价值判断」——没有任何价值判断可供纠正。
- 需要补的是**具体、任务形状的触发条件**，能在长单轮实现任务中被规划阶段模式匹配到，而不是一句泛泛的能力介绍。

### 1.5 旁证：推理预算大量花在「局部范围仲裁」上

`a40f0162` 尤其明显：seq 994（4,202 字符）、seq 1417（3,098 字符）这类长 reasoning 全部用于讨论——改哪个 Java 重载、某个边界情况算不算范围内、要不要扩大修复。196 个 step 里，它从未把「这项工作有可独立的并行部分」当作一个类别。

任务本身**是可分解的**：任务书列了 5 条编号缺陷（#7、#3、#1、#6、#4），其中 #7 还是 #1/#6 的前置。即便如此，编号子项也没有触发分解。这说明「任务里有多个独立条目」本身不足以成为触发条件。

### 1.6 规划阶段旁证：第一份 todo 就是串行的

遗漏在第一个规划 step 就可见，早于任何上下文增长或压缩。

`a40f0162` step 1.1 的首次 `todo_write`（seq 15），7 项全部串行：

1. "Inspect repo state, config loading, repair flow, explosion and reset code/tests"
2. "#7 Add failing tests, then clamp load/merge values and mark normalization pending"
3. "#3 Assess reload intent from messages.yml and implement/test chosen fix"
4. "#1 Add failing tests, implement planRepair settlement and wire listener"
5. "#6 Add failing test, separate explosion power from node-damage multiplier"
6. "#4 Add failing test, choose safe reset ordering/rollback and implement"
7. "Run full builds after each fix, write done-*.md artifacts and SUMMARY.md"

没有 dispatch / delegate / parallel / subagent 任何一项，就是 5 条缺陷的线性清单。

对照组 `d6a9f092` step 1.1 的首次 `todo_write`（seq 17）：

1. "Inspect output contract, checker, and target module inventory"
2. **"Launch 3 parallel audit subagents (A/B/C) with strict evidence and output requirements"**
3. "Review outputs, run per-file payload checks, repair failures"
4. "Summarize paths, validation results, and finding counts"

第 2 项就是委派，而且在读任何模块之前就写进了计划。**这是全数据集最干净的单点对照**：同模型、同工具、同 system prompt、同「先做计划」行为，唯一差别是任务书是否把委派放进计划。

`e0582c67` 与 `d5ad7820` 根本没调用 `todo_write`；它们的计划是散文式的（`d5ad7820` seq 14：read → 红测 → 跑 → 修 → 全量 → 产物，六步纯串行）。

---

## 2. 压缩：`a40f0162` 压缩 5 次，任务书从未丢失

### 2.1 计数

`a40f0162` 在**单个 turn 内跑了 196 个 step**（约 57.5 分钟，`turn/end.reason.kind = "completed"`）。

| 指标 | a40f0162 | d5ad7820 | e0582c67 |
|---|---|---|---|
| steps | 196 | 82 | 66 |
| `compaction/start` | **5** | 2 | 2 |
| `compaction/end` | 5 | 2 | 2 |
| `compaction/summary` | 5 | 2 | 2 |
| `compaction/prune` 事件 | **42** | 19 | 19 |
| `shadowedTokenCount` 合计 | **204,445** | 85,653 | 66,943 |
| 单次最大 prune | 12,491 | 12,491 | 12,491 |

`a40f0162` 的压缩位置：

| # | compaction id | 发生在 step | 摘要字符数 | 摘要耗时 |
|---|---|---|---|---|
| c1 | `71fe119e` | 22 | 13,556 | 22.4 s |
| c2 | `9df30acd` | 63 | 19,671 | 28.1 s |
| c3 | `22d3cd41` | 109 | 12,363 | 18.8 s |
| c4 | `f55f9d29` | 151 | 15,084 | 21.7 s |
| c5 | `e13166ff` | 184 | 17,202 | 23.4 s |

### 2.2 任务书里的「分工要求」被丢掉了吗？

**没有——因为任务书里从来没有分工要求。**

两项独立检查：

**第一，原始任务书从未被 prune。** 三个修复 session 中，`compaction/prune` 遮蔽的全部是单条 `tool/result` 事件——80 个被遮蔽事件（19 + 42 + 19）逐个回查类型，**80/80 均为 `tool/result`**，没有一条 user/assistant 消息。第一条 user message（`seq 8`）不在任何 `shadowedSeqs` 集合里：

- `e0582c67`：`brief seq8 shadowed? false`（共 19 个被遮蔽 seq）
- `a40f0162`：`brief seq8 shadowed? false`（共 42 个）
- `d5ad7820`：`brief seq8 shadowed? false`（共 19 个）

**第二，每份摘要都完整复述缺陷清单与硬性纪律。** `a40f0162` 五份摘要的关键词保留情况：

| 摘要 | `#7` | `#1` | `#6` | `#4` | `#3` | "write a test" | "fails on unfixed" | "artifact per defect" | 基线数字 |
|---|---|---|---|---|---|---|---|---|---|
| c1 | 7 | 4 | 4 | 3 | 7 | 1 | 1 | 1 | 863 ×2 |
| c2 | 9 | 7 | 7 | 6 | 7 | 1 | 1 | 1 | 863 ×3 |
| c3 | 4 | 4 | 7 | 4 | 4 | 1 | 1 | 1 | 863 ×1 |
| c4 | 3 | 4 | 7 | 8 | 3 | 1 | 1 | 1 | 863 ×1 |
| c5 | 3 | 3 | 6 | 7 | 4 | 1 | 1 | 1 | 863 ×1, 877 ×2 |

c5 的 `## Primary Request and Intent` 开头仍然是：

> "Repair 5 defects in `<TARGET_REPO>`. Prior work fixed #2 (`TabListManager` task accumulation) and #5 (`AirdropSpawnGoal` NPE); do not redo them."

同段仍保留：

> "Mandatory workflow per defect: write a test that fails on unfixed code, prove the failure, fix, then prove green. After each fix run full `cmd.exe /c build.cmd -o test`; baseline was **863 tests, 0 failures**."

**唯一轻微漂移**：`do first / prerequisite`（#7 先做）在 c1–c3 有，c4–c5 没有；但 #7 始终排在第一位，且这不涉及委派。属于顺序措辞的轻微损失，不影响任务执行。

**Q2 结论：压缩不是成因。** 主 agent 在上下文里始终有完整 5 条缺陷任务书（seq 8 未被 prune），每份摘要也保留了。五份摘要中没有任何 `subagent`、`parallel`、`并行` 或分解指令——因为源任务书就没有。

---

## 3. `subagent` 工具描述：逐字原文，且没有保守措辞

### 3.1 逐字原文（5 个 session 完全一致）

来自 `request/header` → `.data.header.tools[]`，`name === "subagent"`，描述长度 560 字符：

> "Delegate a self-contained task to a subagent (a separate agent that works in its own context) to offload focused, independent work — research, a scoped implementation, an analysis — so it does not consume this conversation's context. The subagent returns its result, not its intermediate steps. This tool starts an independently managed subagent and immediately returns its id. The runtime notifies you when it finishes. The child reports results with `send_message`; use `send_message` to steer it while running or continue its conversation after it finishes."

参数：
- `description`：3-5 词，用于展示；
- `prompt`："The complete, self-contained task for the subagent. It does not share this conversation's context, so include everything it needs."
- `cwd`：可选，子 agent 初始工作目录。

另有 `subagent_fork`（描述 661 字符），用于需要继承当前对话的任务：

> "Delegate a task to a subagent that inherits this conversation: a child agent seeded with all completed turns so far (it does not see the current in-flight turn). Use this when the subtask builds on this conversation's context — a follow-up analysis, a review, a continuation — without consuming this conversation's context for the work itself. …"

### 3.2 有没有「除非用户要求否则不要用」？

**没有。**

对 `subagent` 描述做正则扫描：`unless | only when | do not use | don't use | avoid | prefer not | not unless | explicitly ask | user asks | 除非 | 不要 | 仅在` —— **0 命中**。

描述是纯正向能力框定：「offload focused, independent work — research, a scoped implementation, an analysis」。

**工具集里唯一的保守措辞挂在 `workflow` 上**，不在 `subagent`。来自 `system/message`（2,727 字符，所有 session 完全一致）：

> "Use the workflow tool **ONLY when the user explicitly asks for a workflow or for large multi-agent orchestration**: you write a JavaScript script (the tool description documents the exact format) that fans work out across many subagents with phases and structured results. **For one or two delegations, prefer plain subagent calls.**"

紧接着下一段：

> "**Start independent delegations with `subagent` or `subagent_fork` together in one assistant message and continue useful work while they run.**"

也就是说，system prompt 明确**正向**要求使用 `subagent`，并且把「一到两次委派」显式**导向** `subagent`、远离 `workflow`。理论上模型可能把 `workflow` 的限制过度泛化成「所有委派都要用户明确要求」，但 485k 字符 reasoning 中没有任何这类推理痕迹（见 §1）。而且原文是 "Use the workflow tool ONLY when…"，限定对象写得很清楚，紧接一句就改推 `subagent`；若读成全局禁令，那本身也是读取失败，而不是提示词给了错误的价值判断。

### 3.3 审计阶段 vs 修复阶段：逐字节相同

| session | 阶段 | system prompt SHA-256（前16） | 完整工具数组 SHA-256 | `subagent` 工具 SHA-256 |
|---|---|---|---|---|
| `e0582c67` | 修复 #1 | `5a6d63b646c9bae3` | `5225a85180411512` | `bc9f677b65e0e81f` |
| `a40f0162` | 修复 #2 | `5a6d63b646c9bae3` | `5225a85180411512` | `bc9f677b65e0e81f` |
| `d5ad7820` | 修复 #3 | `5a6d63b646c9bae3` | `5225a85180411512` | `bc9f677b65e0e81f` |
| `04d1692d` | 审计主 #1 | `5a6d63b646c9bae3` | `5225a85180411512` | `bc9f677b65e0e81f` |
| `d6a9f092` | 审计主 #2 | `5a6d63b646c9bae3` | `5225a85180411512` | `bc9f677b65e0e81f` |

五个 session 均为 `provider: audit`、`model: virtual/opus`、`maxTokens: 32000`、25 个工具，包含 `subagent`、`subagent_fork`、`workflow`、`list_agents`、`send_message`、`interrupt_agent`。

另外，三个修复 session 内部各有 7/16/8 个 `request/header` 快照，每个快照里的 `subagent` schema 也都相同（distinct schema 数 = 1）。

**Q3 结论：工具面在「派了的阶段」和「没派的阶段」完全一致；`subagent` 上不存在保守措辞。**

---

## 4. 对照组：审计阶段那 3 次成功派发

### 4.1 触发源：任务书直接写「并行派 3 个 subagent」

审计主 session `04d1692d` 收到的注入任务书（`agent/inbox/spliced seq 3`，1,534 字符，**与磁盘 `task-b2.md` 逐字节一致**）开头：

> "## 任务
>
> **并行派 3 个 subagent，每个负责一个模块。** 不要一个 agent 串行读三个模块——那样会因上下文超限而草率收尾。
>
> 每个子 agent 的 prompt 里必须包含：
> 1. 它负责的模块绝对路径
> 2. 「必须用 read 工具真的打开每个文件，不许凭文件名猜」
> 3. 「每条发现必须带 file:line 和逐字引用的代码原文，引用必须来自你这一轮实际读到的那一行」
> 4. 产物路径（见下）"

第二个审计主 session `d6a9f092` 的任务书（1,196 字符，**与磁盘 `task-b3.md` 逐字节一致**）：

> "按风险分成 3 组，**并行派 3 个 subagent**，每个负责一组："

### 4.2 派发前主 agent 的 reasoning

`04d1692d` 第一条 reasoning（`seq 16`，step 1.1）：

> "We need act as coding agent. Need audit target absolute outside workspace D:/Server/... but read likely allowed? … **Need 3 subagents parallel, each module.** Need produce three files in experiments/hilltop-dsh/out. … **Then delegate.** …"

`04d1692d` `seq 42`，step 1.3：

> "… Could ask 3 subagents in parallel via one message with 3 subagent calls. … **Need models? Default.** Each module 4k/6k lines, within subagent context maybe read all. …"

`04d1692d` `seq 54`，step 1.4（紧接调用前）：

> "**Need dispatch now.** Construct prompts. Ensure exact output file paths. … Need ensure agent returns no long prose but product. …"

`d6a9f092` `seq 16`，step 1.1：

> "**We need execute audit with three parallel subagents.** Need inspect workspace, output contract example, checker, target paths. Need likely write prompts carefully including hard requirements, file output, check command, JSON envelope format. …"

注意措辞：模型并没有**自行判断**该委派。它把任务书的话**复述成自己的计划**（"Need 3 subagents parallel"），然后执行。这是「指令进入计划」，不是「模型自主检索到并行机会」。

补充量化对照（reasoning 中提到 `subagent` 的块数）：

| session | 阶段 | 非空 reasoning 块 | 提到 subagent 的块 | 占比 |
|---|---|---|---|---|
| `04d1692d` | 审计主 | 75 | **29** | 38.7% |
| `d6a9f092` | 审计主 | 103 | **18** | 17.5% |
| `e0582c67` | 修复 | 59 | **0** | 0% |
| `a40f0162` | 修复 | 165 | **0** | 0% |
| `d5ad7820` | 修复 | 71 | **0** | 0% |

### 4.3 实际调用

`04d1692d` —— 三个调用在**同一条 assistant message**（step 1.4）：

| 调用 | seq | description | prompt 字符数 |
|---|---|---|---|
| 1 | 55 | 审计 arena 模块 | 2,798 |
| 2 | 56 | 审计 mechanics 模块 | 3,072 |
| 3 | 57 | 审计 ai 模块 | 2,819 |

`d6a9f092` —— 三个调用在同一条 assistant message（step 1.6）：

| 调用 | seq | description | prompt 字符数 |
|---|---|---|---|
| 1 | 60 | 组 A 配置与统计审计 | 3,405 |
| 2 | 61 | 组 B 命令与权限审计 | 3,428 |
| 3 | 62 | 组 C 外围模块审计 | 3,570 |

六份 prompt 结构一致（round-2 为 2.8–3.1k 字符，round-3 为 3.4–3.6k）：

1. 角色句：「你是本轮 Hilltop Village 插件审计的 <module> 模块审计员。只做静态代码审计，不改源码。」（round-3 变体：「你是第三轮…组 A 审计员（三个并行组之一）…」）
2. **绝对路径**的审计目录。
3. 精确文件数 + 约行数；「必须逐个文件完整阅读；大文件超过 read 默认 2000 行时用 offset/limit 分段读到 EOF」。
4. 任务书要求的硬性证据纪律：必须真的用 `read` 打开每个文件；每条发现带 `file:line` 和本轮实际读到的逐字原文；禁止改写/拼接/省略号/凭记忆补全。
5. 模块特定的搜索提示（concurrency、data-consistency、error-handling、数值边界、资源泄漏）。
6. 产物绝对路径 + 正文结构 + 严格 JSON 信封 schema。
7. **强制自检命令**（含精确路径与 `--role audit`），「不通过就修到通过」。
8. 最终回复只允许：产物路径、check 结果、发现条数、每条一句话标题。

需要指出：round-2 的子 prompt **不是**任务书的逐字转发。父 agent 把 4 条硬要求保留了下来，但整体重写成了一份自包含的详细 brief（模块清单、逐文件阅读纪律、证据规则、契约 schema、校验命令）。这说明：**任务书提供了「有几个孩子、各自负责什么」的委派决策与扇出形状；prompt 工程是模型自己完成的。** 模型有能力写好子任务 prompt，缺的只是「该派」这个决策。

### 4.4 受控对照

同 harness、同模型、同 25 个工具、同 system prompt、同 `subagent` 描述。唯一实质差别是任务书：

| 阶段 | 任务书写了「subagent / 并行派」 | subagent 调用数 |
|---|---|---|
| 审计主 `04d1692d` | **有**（`task-b2.md`） | **3** |
| 审计主 `d6a9f092` | **有**（`task-b3.md`） | **3** |
| 修复 `e0582c67` | **无** | **0** |
| 修复 `a40f0162` | **无** | **0** |
| 修复 `d5ad7820` | **无** | **0** |
| 审计子 session ×6（depth 1） | 自身 prompt 未要求再委派 | **0** |

另：两个审计主 session 都大量使用 `list_agents`（12 次 / 9 次）；`04d1692d` 还用了 3 次 `send_message`，`d6a9f092` 一次没用（依赖子 agent 完成通知）。无论哪种，一旦委派框架建立，编排闭环（spawn → 轮询/通知 → 收集）就正常运行。

六个审计子 session（`14165c62`、`26f73cfa`、`716a534e`、`ae9ddb35`、`d44062f5`、`da9aa858`）均为 `delegationDepth: 1`，工具表中仍有 `subagent`/`workflow`，但委派调用为 0。这与「它们的 prompt 是单模块范围审计、没有要求再分派」一致。**工具可用本身不产生委派；任务形状的指令才产生委派。**

一个容易误读的细节：round-3 的三个子 session（`14165c62`、`d44062f5`、`ae9ddb35`）第一条 user message 里**确实有 `subagent` 字样**（「你是第三轮…组 A 审计员（三个并行组之一）」）。但那是在描述**它们自己在父级扇出中的位置**，不是要求它们继续委派；三者仍然 0 调用。这进一步说明：**泛泛提到 subagent/并行，不足以触发委派；指令必须把委派指派为读者的动作。**

---

## 5. `agent/inbox/spliced` 任务书 vs 磁盘文件

### 5.1 修复 session

| session | 注入 brief seq | 字符数 | 磁盘文件 | 是否一致 |
|---|---|---|---|---|
| `e0582c67` | 3 | 2,737 | **`task-repair.md` 的上一版** | 与当前磁盘文件不一致 |
| `a40f0162` | 3 | 3,139 | `task-repair.md` | **一致**（仅文件末尾换行差异） |
| `d5ad7820` | 3 | 2,680 | `task-repair-8.md` | **一致**（仅文件末尾换行差异） |

归一化后 SHA-256（前16）：

- `a40f0162` inbox `aecfe291d127346d` = `task-repair.md` `aecfe291d127346d`
- `d5ad7820` inbox `fedf4e1cab6f6e0a` = `task-repair-8.md` `fedf4e1cab6f6e0a`
- `e0582c67` inbox `64a1f388fd465801`；当前 `task-repair.md` 为 `aecfe291d127346d`（不匹配）

`e0582c67` 收到的是构建命令修正前的旧版；与当前 `task-repair.md` 的差异仅为构建命令和新增的「运行环境」段：

```diff
- 基线：`./build.sh -o test` → Tests run: 863, Failures: 0
+ 基线：`build.cmd -o test` → Tests run: 863, Failures: 0
+ ## 运行环境（这次运行已修正，务必照做）
+ - **用 `cmd.exe /c build.cmd -o test`，不要用 `./build.sh`。** …
...
- 2. **每修完一条，跑全量** `./build.sh -o test`，必须保持 0 失败。基线是 863。
+ 2. **每修完一条，跑全量** `cmd.exe /c build.cmd -o test`，必须保持 0 失败。基线是 863。
```

这段差异与委派无关。

### 5.2 三份修复任务书的关键词审计

| 任务书 | 字符数 | `subagent` | `并行` | `parallel` | `分工` | `分解` | `delegate` | `派` |
|---|---|---|---|---|---|---|---|---|
| `e0582c67`（2737） | 2,737 | 0 | 0 | 0 | 0 | 0 | 0 | **0** |
| `a40f0162`（3139） | 3,139 | 0 | 0 | 0 | 0 | 0 | 0 | **0** |
| `d5ad7820`（2680） | 2,680 | 0 | 0 | 0 | 0 | 0 | 0 | **1** |

`d5ad7820` 唯一的「派」在第 20 行：

> "**这条我现在正式派给你，编号 #8「reload 消息说谎」。**"

这是**用户把活派给主 agent**，方向相反，而且只指派了一个任务，不是多个独立单元。

对照两份审计任务书：

| 任务书 | 字符数 | `subagent` | `并行` |
|---|---|---|---|
| `task-b2.md`（注入 `04d1692d`） | 1,534 | **1** | **1** |
| `task-b3.md`（注入 `d6a9f092`） | 1,196 | **1** | **1** |

**Q5 结论：三个修复 session 收到的任务书里没有任何委派词汇。** `task-repair.md` 与 `task-repair-8.md` 中没有 `subagent`、没有 `并行`、没有 `parallel`、没有 `分工`、没有 `分解`、没有 `delegate`。注入内容与磁盘文件一致（`e0582c67` 为旧版，差异只在构建命令），因此这不是注入丢失或截断造成的。

---

## 6. 总判定

**是「没想到」，不是「想到但判断不该做」。**

证据链：

1. **295 条非空 reasoning / 485,097 字符**，`subagent`、`sub-agent`、`子agent`、`子代理`、`并行`、`分解`、`decompos`、`委派`、`分工` 全部为 0。仅有的 3 次 `parallel` 是本地并行读/跑，1 次 `delegate` 是 Java 重载，1 次 `派` 是引用用户任务书。没有任何一块在权衡、列举或否决委派。
2. **工具存在且描述正向**，每个阶段都在。`subagent` 描述没有「除非用户要求」限定。system prompt 明确要求「独立的委派用 `subagent`/`subagent_fork` 放在同一条 message 里」，并要求「一到两次委派优先用普通 subagent」。
3. **工具面与 system prompt 逐字节相同**（审计 3 次 vs 修复 0 次）。差别不在能力、模型或工具提示。
4. **任务书恰好差在关键处。** 两份审计任务书写「并行派 3 个 subagent」；三份修复任务书完全没提 subagent 或并行。审计每次 3 个调用（同一条 message），修复每次 0 个。
5. **压缩没有抹掉任何东西。** 原始任务书（seq 8）从未被 prune；`a40f0162` 五份摘要都保留了编号缺陷和测试纪律。摘要里没有委派要求，是因为任务书里本来就没有。
6. **任务可分解，但不足够。** `a40f0162` 有 5 条编号缺陷（#7、#3、#1、#6、#4）、196 个 step，仍然全程串行。编号子项本身不触发分解。对照组的触发是**明确的派发指令**，不是「存在独立工作」这个事实。

### 对提示词设计的含义

可以排除两种修法：

- **不是**「删掉保守的护栏」——`subagent` 上没有护栏。
- **不是**「纠正错误的价值判断」——没有发生价值判断。

缺的是一条**任务形状的触发条件**，要写进实现/修复任务书。审计任务书之所以有效，是因为它同时给出了：机制名（`subagent`）、数量（3）、映射（每个模块/每组一个）、并行方式（`并行`、同一条 message）。而修复任务书只给了「5 条编号缺陷、测试先行、跑全量」，模型就把它执行成一份串行清单。

一个最小可用的触发条件应当同样具体，例如：

> 「本轮 N 条缺陷分别落在互不重叠的文件/模块。**在一条 assistant message 里为每个独立单元派一个 `subagent`**；集成、全量验证和最终产物留在主 agent。」

这是否是正确策略是另一个设计问题；取证结论是：**没有这样一句话，这个模型根本不会检索到「委派」这个选项。**

---

## 附录：证据索引

| 结论 | 来源 |
|---|---|
| 三个修复 session 均 depth 0、subagent 0 | `session` 事件 `delegationDepth`；`tool/call` 直方图 |
| 295 条非空 reasoning、`subagent` 0 次 | 全部 `assistant/message` → `content[type=reasoning]` |
| 精确关键词计数 | §1.1 表；对解压后的 JSONL 逐块正则 |
| 审计对照 3 次调用、同一条 message | `04d1692d` seq 55/56/57；`d6a9f092` seq 60/61/62 |
| 审计触发措辞 | 注入任务书 `seq 3`；与 `task-b2.md` / `task-b3.md` 逐字节一致 |
| 修复任务书缺委派词汇 | `agent/inbox/spliced seq 3`；与磁盘文件哈希比对 |
| 压缩次数与位置 | `compaction/start|summary|end|prune` |
| 任务书未被 prune | `compaction/prune.shadowedSeqs` 不含 seq 8；80/80 个被遮蔽事件均为 `tool/result` |
| 工具描述一致 | `request/header.data.header.tools` 的 SHA-256 |
| 无保守措辞 | `subagent.description` 正则扫描；system prompt 逐字引用 |
| 首次 todo 串行 vs 委派 | `a40f0162` seq 15；`d6a9f092` seq 17 |

本报告用到的原始提取物只写在操作系统临时目录；除本报告外，未修改仓库内任何文件。
