---
file: orchestrator/protocol.md
title: 主Agent调度协议
group_order: 1
loaded: 主Agent在整个生命周期中常驻加载
source: https://chat.deepseek.com/share/yn99k1mum4qp5fqwj8 (第 5 轮)
---

# orchestrator/protocol.md

> **加载时机**：主Agent在整个生命周期中常驻加载。
> **职责边界**：只定义调度行为，不含任何“如何审查代码”的内容。
>
> 本文由 DeepSeek 分享对话第 5 轮抽取，正文为原文。

## 0.0 harness 优先原则（2026-11-09 新增，凌驾于本文件其余调度规则）

**你的 harness 已经提供的运行时能力，本文件不再重复实现。**

```
派发一个任务之前，先问：这件事 harness 能不能做？

  并发控制 / 批次调度  → harness 原生，本文件 §6 不适用
  任务终态查询        → harness 原生，§4 的重试计数只在无原生能力时用
  Runtime / token 统计 → harness 原生，本文件从不计量
  相位编排            → 若 harness 有 Phase 概念，用它的；本文件 §3 作为补充
  模型选择            → harness 原生，本文件**从未涉及**（这是原设计的遗漏）
```

**判定表**：

| 能力 | harness 原生 | 本文件的对应规则 | 该用哪个 |
|---|---|---|---|
| 并发上限 | ✅ | §6 并发与总量护栏 | **harness** |
| 重试/attempt 计数 | ✅（多数） | §4.1 `CONTRACT_VIOLATION` 计数 | **harness**，§4.1 仅作无原生能力时的回退 |
| 任务状态 | ✅ | §2 状态账本 | **harness** 为事实源，账本只做投影 |
| 耗时统计 | ✅ | 无（此前靠 mtime 猜） | **harness** |
| token 计量 | ✅ | **无**（原设计遗漏） | **harness** |
| 模型选择 | ✅ | **无**（原设计遗漏） | **harness** |
| 波次门控 | 部分 | §3 波次门控 | harness 有 Phase 时用 harness，语义由 §3 补充 |
| 审什么 / 证据标准 / 交付物形状 | ❌ | 各 templates / components | **本框架** |

**为什么这条要放在最前面**：2026-11-09 观察到的 harness 原生数据显示，单个 agent 的 Runtime 常态是 **47 分钟**，而本框架按「8–10 分钟」估计并据此设了误杀阈值（见 `run-state.md` §4.4.2 的修订）。**当一个框架在 harness 已经精确的地方用推测去覆盖，它不是简化，是降级。**

**框架该管的是 harness 管不了的**：审什么、什么算证据、什么结论不成立、报告长什么样。这四件事才是 6113 行里真正值钱的部分。

### 0.0.1 关于 Claude Code 的 Workflow（2026-11-09 加，官方文档核实）

**如果你的 harness 是 Claude Code，先看这条——它直接决定本框架哪一半该留。**

Claude Code 有一个官方一等特性 **dynamic workflows**（`/workflows`，Agent SDK 里是 `Workflow` 工具）。官方原文：

> "A dynamic workflow is a JavaScript script that orchestrates many subagents at once. Claude writes the script for the task you describe, and a runtime executes it in the background while your session stays responsive."
> —— https://code.claude.com/docs/en/workflows.md

**官方给出的对比表（逐字照录，这张表决定了本框架的定位）：**

| | Subagents | Workflows |
|---|---|---|
| Who decides what runs next | Claude, turn by turn | **The script** |
| Where intermediate results live | Claude's context window | **Script variables** |
| What's repeatable | The worker definition | **The orchestration itself** |
| Scale | A few delegated tasks per turn | **Dozens to hundreds of agents per run** |
| Interruption | Restarts the turn | **Resumable in the same session** |

> "A workflow moves the plan into code. ... A workflow script holds the loop, the branching, and the intermediate results itself, so Claude's context holds only the final answer."

**这对本框架意味着什么**

| 本框架写的 | Workflow 是否已提供 | 结论 |
|---|---|---|
| 五波次 + 门控（`protocol.md` §3） | ✅ `phase()` + `/workflows` 进度视图 | **可交给 harness** |
| 扇出 N 个 agent、并发控制 | ✅ 默认 16 并发，可调 1–256 | **交给 harness** |
| `state.json` + 断点续跑 | ✅ 原生 journal + `resumeFromRunId`（同 session） | **交给 harness** |
| §4.1 `attempt` 计数与重派 | ✅ 原生 stall retry（最多 5 次重启）+ 结构化输出重试（5 次） | **交给 harness** |
| token 预算 | ✅ `/workflows` 显示、`maxBudgetUsd` 硬上限 | **交给 harness** |
| 逐阶段模型选择 | ✅ 脚本可为 stage 指定 model | **交给 harness** |
| **审什么**（切片、维度） | ❌ | **本框架** |
| **什么算证据**（门 0） | ❌ | **本框架** |
| **什么结论不成立**（锐评） | ❌ | **本框架** |
| **报告长什么样**（交付物） | ❌ | **本框架** |

**⚠️ 一处必须澄清**：Workflow 的 `phase()` **只是展示分组，不是 barrier**。官方明确：阶段之间要人工签核，得「把每个 stage 拆成独立 workflow」。所以本框架 §3 的**门控语义**（波次闭合条件）仍有价值，但**执行机制**该用 harness 的。

**⚠️ 另一处**：Workflow **不允许运行中途的用户输入**（`No mid-run user input`）。这恰好支持本框架 §0.7 的「默认只读路径」选择——**一个不需要中途签核的流程，才适合放进 workflow**。

> **这份核实的来源**：`code.claude.com/docs/en/workflows.md`、`sub-agents.md`、`agent-sdk/typescript`。调研记录见本仓库 `audit-runs/research-workflow-vs-agent.md`（32KB，逐条附 URL，区分「官方/社区/推断/未找到」）。

## 0. 零写入原则：不得改动被审仓库（最高优先级，凌驾于一切其他规则）

### 0.1 规则

**除非用户在本次对话中明确要求，主 Agent 与所有子 Agent 均不得对「被审仓库」做任何写入操作。**

这里「写入」包括但不限于：

| 禁止动作 | 说明 |
|---|---|
| `git commit` / `git push` / `git tag` | **绝对禁止**，无例外 |
| `git add` / `git stash` / `git reset` / `git checkout --` | 改变仓库状态，禁止 |
| `git branch` / `git merge` / `git rebase` / `git worktree` | 改变仓库结构，禁止 |
| 编辑/删除被审仓库的**任何文件** | 包括配置、文档、`.gitignore` |
| 创建新文件到被审仓库 | 包括「顺手」的 notes、todo |
| 改 `.git/hooks`、`.gitattributes`、`.gitconfig` | 影响仓库行为 |
| 安装依赖、跑会写盘的构建（`npm install`、`gradle build`） | 未明确授权的副作用 |

**审计是只读活动。** 报告写到哪里见 0.2。

### 0.1.1 连「问用户要不要提交」都不该发生

上表已经写了 `git commit` 绝对禁止、无例外。但实测中还有一种**变体违规**：
agent 不提交，却停下来问「这些改动怎么处理 / 要不要我提交」。
这同样违反零写入——**它把「不动」这个已经定好的默认值，重新拿去征求同意**。

**正确行为**：
- 审查/审计任务结束后，工作区里有什么就留着什么。**不改、不提交、不清理、不问。**
- 在最终报告里列出「工作区当前状态」（`git status` 的摘要），供人自行处理。
- 只有用户**明确说**「提交」「回滚」「清理」时才动手，且只动他指定的范围。

**为什么单独写这一条**：问题看起来无害（毕竟没真的提交），但它有两个实际代价：
1. 打断用户，而答案永远是「我没让你提交」——这是纯噪音；
2. 更糟的是它**暗示提交是一个合理选项**，让下一个读到这段对话的 agent 觉得「原来可以问」。

> **2026-11-16 实例**：一次实战验证结束后，agent 列出目标仓库有 20 个文件未提交，
> 然后问「这些改动怎么处理？保持未提交 / 提交 / 回滚」。用户回答：
> 「你不需要动 git，包括提示词在任何时候都不需要管仓库的任何任何事，只负责审查代码，除非用户要求。」
> **默认值早就写在 §0.1 里了，不需要再问一次。**


### 0.2 产物的唯一合法位置

审计产物**必须**写到被审仓库**之外**，或用**显式隔离的目录**：

```
首选：被审仓库之外的路径（如 workspace/reports/round{N}/）
次选：被审仓库内、且已被 .gitignore 覆盖的目录（需先确认 .gitignore 确实覆盖它）
禁止：任何会被 git 跟踪的位置
```

**若必须在被审仓库内写产物**，写之前**必须**先验证：

```bash
git check-ignore -q <目标路径> && echo "已忽略，安全" || echo "会被跟踪，禁止写入"
```

**验证不通过就换位置，不得「先写了再说」。**

#### 0.2.1 `.work/` 算不算「写进被审仓库」——算允许的工作目录

**不算违规。`.work/` 属于允许的工作目录**，与「改被审代码」是两件事。

理由三条，缺一不可：

1. 它通常被 `.gitignore` 排除，不进入版本控制；
2. 它的语义就是「工作过程中的临时产物」，不是产品的一部分；
3. §0 的**目的**是「不污染被审代码、不改变仓库状态」——`.work/` 不构成两者的任何一种。

> **这条是补一个真实暴露的缺口**：2026-11-15 某次任务的产物 `<OUTDIR>` 指定在框架仓库，执行者却写到了 `<TARGET_REPO>/.work/round1/`。§0 只写了「不得对被审仓库做任何写入」，没写 `.work/` 算不算，于是执行者要么不敢写、要么写得心里没底。**含糊的边界会同时制造越界和瘫痪两种失败。**

**但 `.work/` 例外仅限产物与账本。** 以下仍然禁止：

- 修改 `.work/` 以外的任何文件
- 在 `.work/` 里放可执行的构建配置（会被误认为是项目的一部分）
- 用 `.work/` 绕过「产物必须可被 OUTDIR 定位」这条（产物路径必须写进 `state.json`）

**降级路径（合法，但必须声明）**：如果 harness 的 workspace 限制导致写不进 `<OUTDIR>`（实战中就是这样——`workspace-write` 拒绝了框架仓库的路径），**写入 `.work/` 是合法的降级**，但必须在最终报告里**显式声明**「因 workspace 限制，产物落在 `.work/` 而非 OUTDIR」。**不声明的降级等于私改落点**——下一个读实验记录的人会在 OUTDIR 里找不到东西，且不知道去哪里找。

### 0.3 为什么这条要放在最前面

**理由一：审计的价值在于可信，而不可信的第一步就是改动被审对象。** 一旦审过的代码被改过，所有证据链的时间点都无法自证——「我引用的这一行」在被改过的文件里已不存在。

**理由二：这条规则在真实场景里最容易因为「善意」被违反。** 典型违规路径：

- 「顺手修一下这个明显的 bug」→ 违反 L0 禁止亲自修改（`protocol.md` 第 1.2 节）
- 「先 commit 一下免得丢了」→ 违反本节
- 「写个审计笔记到仓库里方便下次看」→ 污染工作区、可能被误提交
- 「跑个构建验证一下」→ 产生大量构建产物，改变 git status

**理由三：commit 是不可逆的对外动作。** 即使后续 `git reset`，reflog 与远端推送都可能已经留下痕迹。**这类操作必须由用户明确授权，不能由 Agent 自行判断「应该没影响」。**

### 0.4 与「修复波」的关系

**这不与框架的修复能力冲突，而是给它划定了授权边界**：

```
默认路径（AUDIT_ONLY）：全程只读。零写入。
可选路径（FIX）：只有在用户显式说「修复这一轮」之后，
                 才获得写入被审仓库的授权，且：
                 - 只能改 target_files 内的文件
                 - 不得 commit / push（除非用户再次明确要求）
                 - 每次改动前必须确认 rollback_command 可用
```

**「修复」授权不等于「提交」授权。** 改了文件 ≠ 可以 commit。这是两道独立的授权门。

### 0.5 违规的判定

| 情形 | 判定 |
|---|---|
| 未经授权 commit / push | **严重违规**。必须立即向用户报告，说明提交了哪些内容、如何回退 |
| 未经授权修改被跟踪文件 | 严重违规。必须报告并给出恢复方法 |
| 在被审仓库内创建了会被跟踪的产物 | 违规。必须清理并改写到合法位置 |
| 只读操作（Read/Grep/git log/git status/diff） | **合法**，不受本节限制 |

**只读的 git 命令是明确允许的**：`git log`、`git status`、`git diff`、`git show`、`git ls-files`、`git blame`、`git check-ignore`。它们是审计必需的取证手段。

### 0.6 每次运行的自检

主 Agent 在生成最终报告前**必须**执行并记录：

```bash
# 证明本轮未改动被审仓库
git -C <被审仓库> status --short | grep -E '^ ?[MDARC]' && echo "有改动 —— 违规" || echo "跟踪文件零改动 ✓"
```

**把这条输出原样附在报告末尾。** 这是审计可信度的一部分——不只声称没改，而是给出可复核的证据。

---

本节定义**默认执行路径**。它与下文所有波次规则并列，**冲突时以本节为准**。

## 0.7 两条路径：默认只读，修复另行启动

### 0.7.1 为什么默认路径不含修复

框架原设计是五波次连跑（含修复与验收）。真实运行（round31）证明这是**跑不完的唯一原因**：

| 事实 | 数值 |
|---|---|
| 锐评波后的待修复发现 | **83 条**（60 UPHELD + 23 DOWNGRADED） |
| 实际完成修复 | **1 条** |
| 最终状态 | `IN_PROGRESS`，**无最终报告** |

根因不是预算不够，而是**修复是唯一有写权限、有副作用的角色**，它的规则最严（`rollback_command`、`affected_issues`、`files_touched` 边界、变异验证），每一步都可能触发需要人工介入的情形。把它放在默认路径里，等于**让最脆弱的环节决定整轮能否结束**。

### 0.7.2 两条路径

```
【默认路径 · 只读】AUDIT-ONLY
  侦察 → 宽扫 → 深挖 → 锐评 → 出报告
  全程无写权限、无副作用
  终止状态必然是 CLOSED 或 PARTIALLY_CLOSED，不得是 IN_PROGRESS
  ↓ 报告产出，本轮使命结束
  产出物天然可交付：用户拿去决定修什么

【可选路径 · 有副作用】FIX（独立启动，不是默认流程的一部分）
  修复 → 验收
  输入是默认路径报告里 UPHELD 的发现
  可分批、可中断、按发现逐条推进
  每条独立记账，一条卡住不影响其他条
```

**硬规则**：

1. **默认路径终止时必须已产出最终报告。** 「跑完了但没有报告」不是合法终态。若因任何原因停止，先出报告再退出（见 `artifacts/final-report.md`）。
2. **默认路径的终止状态不得是 `IN_PROGRESS`。** 只允许 `CLOSED`（全部闭合）或 `PARTIALLY_CLOSED`（存在人工阻塞项，见第 3 节）。
3. **修复路径的启动必须显式。** 用户或调度器发出「修复 round{N}」指令才启动，不得由默认路径自动续跑。
4. **修复路径不重跑审计。** 它消费默认路径报告里的 `finding_id`，不重新侦察、不重新切片。
5. **修复路径的每条发现独立记账。** 一条修复失败（回滚、需人工、环境不可用）只影响该条，不阻塞其他条，绝不影响默认路径已产出的报告。

### 0.7.3 这条改动解决了什么

| 原问题 | 改动后 |
|---|---|
| 一次对话跑不完 | 默认路径**没有理由跑不完**（全只读，无回滚、无副作用、无人工裁决触发点） |
| 用户要擦屁股 | 默认路径必然交付报告；修复按需启动，可随时停 |
| 83:1 的塌方 | 不再是同一条流程里的两个阶段，而是两次独立任务 |

**代价（必须承认）**：默认路径**不产出修复后的代码**。如果用户要的是「修好」，他需要跑第二步。这是刻意取舍——**先保证「读得完、报得清」，再谈「修得动」**。

---

### 0.8 交付粒度——一次交付到底交什么（2026-11-10 新增，硬规则）

**这一节回答一个框架此前从未写过的问题：什么算「完成了一次交付」。**

#### 0.8.1 问题

框架有 17 条静态检查专治「停下来等用户」，但它们检查的都是**规则里有没有写「自动续轮」**。而在真实执行中，最常见的失败不是「不续轮」，是：

> 主 Agent 每做完**一个切片的宽扫**、或**一个波次的一个子步骤**，就停下来输出一段总结，然后问「接下来要继续吗」。

这种执行**每一条静态检查都合规**——因为它确实在推进，也确实会在最后出报告。但用户体验是灾难：他要全程盯着，每几分钟回答一次「继续」。

**根因是这个框架从未定义「一次交付」的粒度。** 没有定义，执行者就按「做完一件小事」交付，次次合规。

#### 0.8.2 定义

**一次交付 = 一个完整的相位（phase），不是单个任务、单个波次、单个切片。**

| 相位 | 起 | 止 | 交付物 |
|---|---|---|---|
| **侦察相位** | `state.phase = wave1` | 全部切片定义落盘 + `scale_decision` 冻结 | 切片清单 + 入口点 + 排除报告 |
| **发现相位** | `phase = wave2a` | 宽扫**全部**派完 → 深挖**按预算**全部派完 → 全部 agent 到终态 | 所有产物文件 + `wave2_completed` 账本完整 |
| **锐评相位** | `phase = wave3` | 三种角色全部返回 + Arbiter 裁决完 | 裁决记录 + 冲突表 |
| **收尾相位** | `phase = report` | 最终报告落盘 + `status` 置为终态 | 最终报告 + 账本 |

**相位之间可以停。相位之内不许停。**

> **一句话**：一次交完，不是一步一交。交付范围是**整个相位**，不是单个任务、单个波次、单个切片。

#### 0.8.3 相位内的行为要求

```
相位开始 → 写计划（见 0.8.4）→ 连续执行直到相位闭合 → 出相位交付物 → 才能向用户汇报
```

**禁止**：
- 派了 3 个 agent 就汇报「已派出 3 个」
- 一个波次跑完就总结「宽扫完成，接下来深挖吗」
- 遇到需要判断的地方就停下来问（该判断的按 §1.2 裁量分级自行判断并留痕）

#### 0.8.4 相位开始时必须写计划

**每个相位开始前**，主 Agent 必须先把计划写进 `state.json` 的 `current_plan` 字段：

```json
"current_plan": {
  "phase": "wave2a",
  "written_at": "ISO8601",
  "steps": [
    { "id": 1, "action": "派 16 个宽扫 agent", "done_when": "16 个全部到终态" },
    { "id": 2, "action": "读全部 sweep 产物，算 lead 总数", "done_when": "lead 数落盘" },
    { "id": 3, "action": "按预算派深挖 agent", "done_when": "deep_dive_cost ≤ 预算" }
  ],
  "exit_condition": "全部 agent 终态 + 账本更新完",
  "current_step": 1
}
```

**没有 `current_plan` 就开始执行 = 违规。** `tools/check-state.mjs` 在 `phase ∈ {wave2a, wave2b, wave3}` 时校验该字段存在。

**计划可以改**（执行中发现问题时），但改必须留痕：`current_plan.revised_at` + `revision_reason`。**不许悄悄改变范围**。

##### 0.8.4.1 计划必须带重规划钩子（否则比不做计划更差）

**这是一个必须写下来的反例，因为直觉是反的。**

ADaPT（arXiv:2311.05772）在同一 GPT-3.5 executor 上做过消融：

| 方法 | ALFWorld | WebShop | TextCraft |
|---|---|---|---|
| ReAct（无计划，边做边看） | 29.0 | 32.0 | 19.0 |
| **Plan-and-Execute（先出完整计划，照做）** | **17.0** | **17.0** | 27.0 |
| ADaPT（失败才分解，自适应） | 44.0 | 44.0 | 52.0 |

**「先出完整计划然后照做」在 ALFWorld 上比完全不做计划还低 12 个绝对点。**

论文给的原因有两条，都对这套框架成立：

1. **静态计划一旦某一步失败，整条报废且无法回收**（"failure to execute any single sub-task can sink the whole task"）；
2. 为了让每一步「可直接执行」，计划不得不写得更详细——**而更详细的计划恰恰更容易在真实观测到来时失配**。

所以 §0.8.4 的 `current_plan` **必须**配一个重规划钩子，否则我就是在把框架往负收益的方向推。

**规则**：

| 情形 | 动作 |
|---|---|
| 某一步的 `done_when` 达成 | `current_step += 1`，正常推进 |
| 某一步**执行失败**或观测到与计划假设不符 | **不重写整条计划**，只替换**剩余步骤**，并把失败的那一步标 `status: "FAILED"` + `failure_reason` |
| 计划的**前提**被证明是错的（例如以为有 16 片、实际 40 片） | 允许重写剩余步骤，但 `revision_reason` 必须引用**具体证据**（`file:line` 或命令输出） |

**明确禁止**：

- 按「计划太理想化了」为由重写
- 在没有具体证据的情况下改 `exit_condition`（那是把靶子挪到箭落点）

**计划粒度也受这条约束**：`steps` 应写**可判定的里程碑**（「16 个 agent 全部到终态」），不要写「仔细审查每个切片」这种无法判定完成的细粒度动作。**越细的计划越容易失配，这是反例的直接推论。**

##### 0.8.4.2 计划要粗、要自然语言（有实证）

Plan-and-Act（arXiv:2503.09572）的 planner system prompt 把粒度写成硬约束，可直接借用：

> - **Minimize the number of steps by clustering related actions into high-level, logical units.** Focus on logical progression instead of detailing low-level interactions.
> - Describe **WHAT** needs to be accomplished rather than **HOW**.
> - 反例：不要写成「点击搜索框 / 输入关键词 / 点击搜索」三步，应合并成「在搜索框里搜 X」。

另一条更强的证据在**格式**上：arXiv:2408.02442 测得 GSM8K 上自然语言 94.57 vs JSON-Mode 86.95；LLaMA-3-8B 在 Last Letter 上差距达 38.15 个点，而**解析错误率仅 0.148%**——掉分不是解析失败，是**约束本身损害了推理**。作者结论：「stricter format constraints generally lead to greater performance degradation」。

**对 §0.8.4 的含义**：

| 该做 | 不该做 |
|---|---|
| `steps[].action` 用一句自然语言写清「做什么」 | 拆成参数级字段（`{"tool":"dispatch","count":16,"role":"sweep"}`） |
| `done_when` 写客观可判定的状态 | 写「仔细审查完」「质量达标」这种主观判据 |
| 3–7 步覆盖整个相位 | 20 步逐步指令 |

**为什么不能用参数级 schema**：本框架的 `current_plan` 是给**主 Agent 自己看的**（用于判断相位有没有闭合），不是给执行器解析的。把它写成执行器 schema 会同时付出两个代价——推理质量下降 + 每相位多占 token——而收益是零。

> **旁证**：Anthropic 已经在更新的模型上**默认关闭 `TodoWrite` 等任务追踪工具**，理由原文是「On newer models, Claude keeps track of multi-step work without a written checklist, and the tools' definitions and reminders take up context」——这是「过度显式计划有净成本」的官方背书。所以本框架只要求**相位计划**（一个相位一条），不要求任务级 checklist。

##### 0.8.4.3 计划能管什么、不能管什么（实证）

**《How Strongly Should Task State Influence an LLM Agent?》(arXiv 2609.25686) 用 128 episodes/cell 的配对实验测了「任务状态以多强的形式抵达 agent」的 4 级阶梯**：

| 阶梯 | Qwen3-235B S=10 | 说明 |
|---|---|---|
| 只有原始对话 | 0.38 | 基线 |
| 给一份**准确的外部清单** | 0.55 | 提升有限 |
| 每轮由状态机推导指令 | 0.84 | 强 |
| **拒绝违反状态的动作**（enforcement gate） | **0.98** | 最强 |

**三条对 §0.8 直接有用的结论**：

**(a) 「自己写」> 「别人给」**
> agent 自己维护的**未经验证的**清单（0.70 / 0.79）**胜过**外部提供的**始终准确**的清单（0.55 / 0.59）。论文原话：「**writing state binds behavior more strongly than reading it**」。

→ 这解释了为什么 `current_plan` 必须由**主 Agent 自己写**，而不能由模板预填或外部生成。

**(b) 清单管不了「禁令」**
模型会**写下正确规则然后立刻违反**。所以：

| 类型 | 载体 |
|---|---|
| 「这个相位要做哪几步」 | `current_plan`（清单能管） |
| 「相位内不许停下来汇报」 | **必须靠工具层拒绝**（`stop-hook.mjs`），不能只写在 §0.8.3 |

**这就是 `stop-hook.mjs` 存在的原因**——§0.8.3 的禁令如果只有文字，等于没有。

**(c) 清单是最贵的方案**
text checklist 的 token 消耗是 raw transcript 的 **1.34×–1.58×**，原因是每轮重渲染的清单在对话历史里累积。

→ 教训：`current_plan` 应当**覆写**而非**追加**。`state.json` 是文件不是对话历史，天然满足这一点；但如果把计划写进对话里，就会踩这个坑。

#### 0.8.5 什么情况下才允许中途停下来问用户

**一句话判据**（来自 Anthropic `permission-modes.md` + `measuring-agent-autonomy`）：

> **问「不可逆 / 目标模糊 / 缺凭据」；不问「可逆 / 可验证 / 已在授权范围内」。**

| # | 情形 | 为什么必须问 |
|---|---|---|
| 1 | 需要**写入被审仓库**（而用户没说可以） | 零写入原则是最高优先级 |
| 2 | 需要**删除或覆盖用户已有文件** | 不可逆（`rm -rf` 关键路径连 allow 规则都批不了） |
| 3 | 发现**与用户原始意图冲突**的事实（例如用户说「只读」但任务需要写） | 需要人重定范围 |
| 4 | 需要**花钱的不可逆操作**（发 PR、发邮件、部署、改 CI/权限/证书/DNS） | 外向动作 |
| 5 | 探测结果显示**当前 harness 无法完成该相位**（例如 L-D 单 agent 跑不了并行波） | 能力不足，不是判断问题 |
| 6 | **目标本身模糊**，且**只在相位开始时问** | 见下方「必须早问」 |

**⚠ 第 6 条的时间限制（2026-11-10 实测研究新增）**：

目标类澄清有**硬拐点**——执行 **10% 之后几乎完全失效**，任何澄清拖过中段**比不问还差**（arXiv 2605.07937，pass@3 从 0.78 掉回 baseline）。

因此策略是「**开局问一次，问准，然后跑到底**」，而不是「边做边问」：

```
❌ 错误：做着做着发现目标不清 → 停下来问 → 用户回答 → 继续
✅ 正确：相位开始前检查目标是否可判定 → 不清晰就在动手前一次性问清 → 之后不再问
```

**如果已经开工过半才发现目标模糊**：不要停下来问。按当前最合理解释继续，把不确定性写进 `state.json.discipline_log` 和最终报告，由用户在报告阶段决定是否重跑。

**不在此列、绝不许问的**（这些是 80% 的打断来源）：
- 「要不要继续下一波」→ 继续
- 「这个 agent 失败了，要重派吗」→ 按 §4.1 的重派规则办
- 「发现 12 条线索，要深挖哪些」→ 按 §0.8.2 的预算规则算
- 「要开新轮吗」→ 按 `round-detection.md` 的判据算
- 「报告写好了，要交付吗」→ 交付
- **纯进度汇报**（「已完成 3/16 个 agent」）→ 这不是一个回合的终点，见 §0.8.7
- 「**我抽查了几个，剩下的要不要全查**」→ **全部单独查**。抽样不是验证，是采样偏差；
  「要不要做完整验证」这个问题本身就是错的——验证的完整性不是一个可选项
- 「**下一步做什么**」→ 按当前阶段的门控条件走，不清晰就回去读 `START-HERE.md` / `START-FIX.md`
- 「**中间产物留还是清**」→ 留。历史报告是「这套东西为什么长成这样」的唯一证据，
  体积问题用归档解决，不用删除
- 「**这些改动怎么处理**」（可逆、且用户没授权写被审仓库）→ 不动，报告出来等人

**2026-11-16 的实例（写给后来者）**：一次会话里 agent 一次性问了 4 个问题，
按本节判据只有 1 个（「是否写入被审仓库」）该问，其余 3 个都属上面这张清单。
用户的回答是「咱提示词白做了吗」。**规则写在文档里不等于会被执行**——
问之前对照这张清单过一遍，是执行者的责任。


#### 0.8.5.1 为什么提示词不是主要手段（研究结论）

**这一节必须写下来，否则后来者会以为「在提示词里写清楚就能解决」。**

Anthropic 官方文档把手段强弱排了序（`best-practices.md`）：

> - **写在提示词里**：「跑完测试，一直跑到通过为止」。**Claude decides for itself when it's satisfied.** 最弱一档。
> - **`/goal <条件>`**：由**另一个模型**在每回合结束后判定条件是否满足，不满足就自动开下一回合。官方原文点名：「**where Claude sometimes ends a turn with a progress summary while items are still open**，and the goal sends it back」。
> - **Stop hook**：由 **harness 强制**，回合结束前跑你的脚本，`exit 2` 把 stderr 回灌给模型当「你还不能结束」的理由。

**根因是机械的，不是模型懒**：

```
Agent 循环的退出条件 = "本轮回复里没有 tool call"
「汇报进度」天然没有 tool call
→ 汇报就等于交差
```

> 出处：`agent-sdk/agent-loop.md`「Turns continue until Claude produces output with no tool calls」；
> `best-practices.md`「Claude stops when the work looks done」。

**因此**：

| 层次 | 本框架能做的 | 强度 |
|---|---|---|
| 提示词（本文 §0.8） | 定义交付粒度、例外清单 | **弱**——Agent 可以判定某条不适用 |
| 状态校验（`check-state.mjs`） | `current_plan` 必填、`done_when` 必填 | **中**——机械可查，但只在写盘时生效 |
| **harness 机制** | Stop hook / `/goal` / 可判定的 pass-fail 检查 | **强**——唯一无法被「觉得不适用」绕过的 |

**本框架的定位是「审计方法论」，不是 harness。** 所以 §0.8 只能做到弱+中两层；要拿到强层，必须由运行它的 harness 提供 Stop hook 或 `/goal`。这一点必须对使用者说清楚，而不是承诺一个提示词就能解决。

#### 0.8.5.2 强层的落地：`tools/stop-hook.mjs`

框架提供了一份可直接用的 Stop hook 脚本，它在**回合结束时**检查相位是否闭合，未闭合就以退出码 2 拒绝结束（stderr 内容会回灌给模型作为理由）。

```json
// Claude Code settings.json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "node <FRAMEWORK_ROOT>/tools/stop-hook.mjs --state <OUTDIR>/state.json"
      }]
    }]
  }
}
```

**它检查四种情形**：

| 情形 | 判定 |
|---|---|
| 执行相位（wave2a/2b/3）没有 `current_plan` | 拒绝结束 |
| `current_plan` 缺 `exit_condition` 或 `steps` 为空 | 拒绝结束 |
| `in_flight` 里有 agent 没到终态 | 拒绝结束 |
| 相位声明完成但交付物没落盘 | 拒绝结束 |

#### 0.8.5.3 怎么判断一个子 Agent「还在跑」还是「已经做完了」

**2026-11-12 真实事故**：主 Agent 连续 **35 分钟**声称某个子 Agent「还在跑」，而它的产物 22:39 就写完了。根因只有一句：

> **用一个和任务成功标准无关的指标当进度。**

当时盯的是 JSONL 转录文件的大小，而那个文件从启动起一直是 0 字节；产物则写在子 Agent 自己的工作目录里。**不是等太久，是看错了地方。**

**判据必须按这个优先级，不能颠倒：**

| 优先级 | 看什么 | 说明 |
|---|---|---|
| **1** | **声明的产物路径存在且非空** | 这是唯一和「任务成功」直接相关的指标。→ `DONE` |
| 2 | 工作目录 N 分钟内有活动 | 只作辅助。产物没出来但还有动静 → `RUNNING` |
| 3 | 产物没有 + 工作目录也 N 分钟没动 | → `STALLED`，**不要再等**，去查或重派 |

**工具**：`node tools/agent-status.mjs --artifact <预期产物> --workdir <工作目录>`

输出 `DONE` / `RUNNING` / `STALLED` / `UNKNOWN` 四态，退出码 0/1/2/1。

**`--artifact` 必须传文件，不能传目录。** 2026-11-13 实测踩到：把 scratch 目录本身当产物传进去，
四个**早已交付**的 agent 全被判 `STALLED`（Windows 上目录 `stat.size` 通常为 0，于是走「产物不存在」
分支）。工具现在会直接退出 2 拒绝目录输入。**错误的「它没交付」比没有结论更危险**——它会让人
去重派一个已经完成的任务。

**前提：派发时必须写下产物路径。** 没有预期路径，这个判据就无法执行——这也是为什么契约要求 `artifact_path` 是必填顶层字段（`output-contract.md` §1）。

**`stop-hook.mjs` 已同步这个判据**：`in_flight` 里的 agent 若 `artifact_path` 已落盘，提示语从「还在飞」改为「账本没跟上」——**数组是主 Agent 自己维护的，它忘了更新，判断就会一直错下去**。

**三个必须知道的实现细节**（来自官方 `hooks.md`，写错会出问题）：

1. **`stop_hook_active` 必须检查**——否则会在一个永远不成立的条件上死循环。脚本已处理。
2. **官方有 8 次连续续跑上限**，之后 harness 会强制结束回合。可用 `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` 调整。
3. **`state.json` 不存在或损坏时退出码是 0**（不拦）。宁可漏拦也不要误拦——误拦会让正常任务卡死。

**自测**：`node tools/stop-hook.test.mjs`，8 个用例覆盖「该拦」和「不该拦」两侧。

#### 0.8.5.4 机制层面为什么会漏掉产物（2026-11-13 dsh 实测）

§0.8.5.3 讲的是「主 Agent 看错了地方」。这一节讲**更根本的一层：框架本身就没打算让父级自动看到子级**。

在 dsh `0.2.1-rc.2` 上实测（本地 mock LLM，无真实上游依赖，见 `experiments/dsh-probe/DSH-EXPERIMENT.md`），
`subagent` 工具的**返回值是「已启动」，不是「已完成」**：

```
tool result:  "started subagent 82757119-cfd1-45d1-8807-d5f82d3f52e6"
```

真正的结论走另一条路——子 Agent 结束后，运行时往父 Agent 的**下一轮**注入一条
`agent/inbox/spliced` 事件，`source.kind = "subagent-settled"`：

```json
{"type":"agent/inbox/spliced","data":{"inserted":[{
  "content":[{"text":"Background subagent 827... finished and will do no further work unless you send it more."},
             {"text":"Its closing message:"},{"text":"CHILD_REPORT"}],
  "source":{"kind":"subagent-settled","senderSessionId":"827..."}}]}}
```

两个直接后果：

1. **只看工具返回值 = 只看到「已启动」。** 调用方若在这一步就总结，会得到「任务还在跑」的假象。
   反过来，若它把 turn 1 的答复当作最终答案，会得到「跑完了但没有内容」的假象。
   **这两个假象都不来自模型疏忽，来自返回值语义。**
2. **dsh 自己的子 Agent 提示词就明说了这件事**：

   > Your parent agent id is "session-...". Before you finish, send your result to that agent with
   > `send_message(...)`. **The parent shares your workspace but does not automatically receive your
   > transcript, tool output, or reasoning.**

**所以「父级漏掉子级产物」不是偶发 bug，是必须显式补偿的默认行为。**

**检查工具**：`node tools/dsh-session-audit.mjs --sessions <dsh sessions 根> --project <项目目录>`

它读 zstd 压缩的 `session.v4.jsonl.zstd`，报四类问题：

| kind | 含义 |
|---|---|
| `parent_missed_child` | 子 Agent 有产出，父 session 里没有对应 settle 注入 |
| `child_no_output` | 子 Agent 开了 turn 但零 assistant 文本 |
| `turn_without_output` | 任何 session 开了 turn 却零 assistant 消息（附最后 `finish.reason` 与重试次数） |
| `orphan_child` | 子 session 声明的 `parentSession` 在本目录找不到 |

**在真实数据上跑出来的第一件事**：本机 9 个 session 里 **4 个有 `turn/start` 但 0 条 assistant 消息**。
检查器直接报出了每次失败的 `finish.reason`（`error:TRANSPORT (Stream ended without finish_reason)`、
`error:SERVER (503 ... 无可用渠道)`），而不是笼统的「失败了」。
**这正是「静默失败」的反面：失败必须能说出原因码。**

**自测**：`node tools/dsh-session-audit.test.mjs`，12 个用例（合成 session 目录，不依赖真实上游）。

#### 0.8.5.5 完成通知本身会丢（2026-11-14 实测，73% 丢失率）

上一节讲的是「父级看不到子级产物」。这一节讲**更靠前的一层：子级干完了，但「我干完了」这句话没送到父级**。

**实测**：一次并行派发 11 个 subagent（5 个盘查 + 6 个 wrapper 验证）。

| 批次 | 派发数 | 收到完成通知 | 丢失 |
|---|---|---|---|
| 第一批（盘查） | 5 | 2 | **3（60%）** |
| 第二批（wrapper 验证） | 6 | 1 | **5（83%）** |
| 合计 | 11 | 3 | **8（73%）** |

**所有产物都已落盘**（`/tmp/wrapper-test-*/` 下 5 份全部通过 `check-payload --role`），
只是主 Agent **不知道它们已经完成**。

**更关键的是这条反直觉事实：**

> `tasks/<agentId>.output` 的文件大小与「通知是否送达」**完全无关**。
>
> - 收到通知的那几个：`.output` 全是 **0 字节**
> - 没收到通知的那几个：`.output` 也是 0 字节，直到主 Agent 发消息唤醒后才变成 2.4MB
>
> 也就是说，**盯着 `.output` 大小判断「agent 跑完没」这条路根本没有信号**。
> 实测中主 Agent 因为这条思路连续误判两次——先说「还在跑」，实际产物一个多小时前就写好了。

**为什么会误判两次**：第一次是只看转录音量（当时盯的是 jsonl 转录，0 字节）；
第二次是只看 `.output` 大小（也是 0 字节，但原因完全不同）。
两次都是**用了一个和任务成功标准无关的指标当进度**——这正是 §0.8.5.3 那条教训的复发。

**可用的判据（按可靠性排序）**：

| 优先级 | 看什么 | 说明 |
|---|---|---|
| **1** | **产物的 mtime** | 唯一和「任务成功」直接相关的信号。产物在且非空 → 已完成 |
| 2 | 显式记录「我收到了哪些通知」 | 用 `--notified` 传给扫描器，才能识别「有产出但没通知」 |
| 3 | `.output` 大小 | **无信号**。0 字节既可能是「已送达」也可能是「通知丢失」 |
| 4 | 转录 jsonl 大小 | **无信号**。同上 |

**工具**：`node tools/scan-agent-outcomes.mjs --tasks <tasks目录> --scratch-map <json> --notified <id列表>`

新增两类结局：

| kind | 含义 |
|---|---|
| `WORKED_BUT_NOT_NOTIFIED` | **有产出但没收到完成通知** —— 通知投递失败。产物在，去读它 |
| `TRANSCRIBED_BUT_NOT_NOTIFIED` | 转录有内容但没收到通知 —— 同样去读转录取结论 |

**`--notified` 不传时全部按「未知」处理**（不是「没收到」）——避免把「没记录」误判成「丢失」。

**操作纪律**：派发后如果超过预期时间没收到通知，**不要去查转录大小**，直接：
1. 查预期产物路径是否存在且非空
2. 存在 → 它已完成，去读产物
3. 不存在 → 才考虑重派，并用更明确的任务书（把产物路径写死）

**自测**：`node tools/scan-agent-outcomes.mjs --self-test`，12 个用例，
其中 5 个专测通知维度（含「同样 0 字节转录，送达与否必须判出不同结局」）。

#### 0.8.6 与自动续轮的关系

§0.8 管**相位之内**，`round-detection.md` 管**相位之间（轮与轮）**。两者不冲突：

```
轮开始 → [相位1 → 相位2 → 相位3 → 相位4] → 出报告 → 自动判是否开新一轮
         ↑ 这段内不许停                      ↑ 这里才允许停/续
```

**唯一的对外输出点是「报告落盘之后」**，不是相位之间。相位之间只更新 `state.json`，不打扰用户。

#### 0.8.7 进度汇报的正确位置（2026-11-10 研究新增）

**这一条解释了一个反直觉的事实：写一段进度汇报，本身就会终结这一回合。**

Agent 循环的退出条件是机械的——**本轮回复里没有 tool call 就结束**。而「我已完成 X，接下来做 Y」这段话天然没有 tool call，所以它一写出来，控制权就回到了用户手里。

```
❌ 错误序列：
   tool_call → tool_call → 「已完成 3/16 个 agent」→ [回合结束] → 等用户敲「继续」

✅ 正确序列：
   tool_call → tool_call → tool_call → ... → [相位闭合] → 写报告 → 「完成」
```

**因此 §0.8.3 里「不许中途汇报」不是风格要求，是机制要求。**

**做法**：

| 场景 | 做法 |
|---|---|
| 相位执行中需要记录进度 | 写进 `state.json` 的 `current_plan.current_step`，**不要写进对话** |
| 长任务中想让人看到进展 | 由 harness 的 UI 显示（Claude Code 会显示工具调用），而不是靠模型写一段话 |
| 必须向用户说明某个中间结果 | 那次说明**必须附带下一个 tool call**，否则就是交差 |

**本框架能做的极限**：`check-state.mjs` 能校验 `current_plan` 有没有被正确推进，但**拦不住「模型写了一段话就结束回合」**——那发生在对话层，不在产物层。这一层只能靠 harness 的 Stop hook / `/goal`。

---

## 1. 角色禁令与裁量边界（2026-11-01 修订：从「零裁量」改为「裁量留痕」）

### 1.1 原禁令与其失效

原设计写的是**绝对禁令**：

> **你不得使用任何代码读取、文件写入、搜索或分析工具。你唯一允许执行的动作是 `spawn_agent` 和 `read_agent_result`。任何需要"看一眼"才能做的决定，都必须转化为一个子 Agent任务。**

**这条路线的收益是真实的**：主 Agent 的上下文里永远只有结构化任务描述和结果摘要，不会被代码和报告全文污染。这个第一性原理**保留**。

**但「零裁量」在真实运行中失效了。** round31 有两处违规，性质完全不同：

| 违规 | 表现 | 性质 |
|---|---|---|
| 并发超限 | 实际峰值 **7**，`concurrency_window = 4` | **纯失守**。以「产物已落盘」推断「Agent 已终态」就补位；用户指出后才核验 |
| 维度偏离 | **9/40** 片未按轮转指派维度 | **为质量而违规**。为了让 `ExpressionHelper` / `SourceAdapterChange` 等关键文件进入审计，按文件内容调整了维度 |

**关键判断**：第二处违规是**正确的行为**——如果不调整，那些关键文件就不会被审。它之所以成为"违规"，是因为框架没有为它提供合法路径。

**结论：禁令没有消除裁量，只是把裁量逼成了不申报。** 一个遵守规则的好 Agent 会葬送审计质量；一个追求质量的好 Agent 会违反规则且不声张。两种结果都不可接受。

> **另需承认**：原文这一节引用的 Supervisor 角色定义（`[^ref0]` 等 5 个脚注）经核实**全部指向同一个返回 403 的 Oracle 博客锚点**，无法核实。因此上述第一性原理的正当性**不来自外部文献，而来自本框架自己的推理**：只要主 Agent 不读代码，上下文漂移就无从发生。这个推理本身成立，与引用是否可核实无关。

### 1.2 新规则：裁量分级

裁量分三级，**按级处理**：

| 级别 | 定义 | 处理 |
|---|---|---|
| **L0 · 禁止裁量** | 会破坏可审计性或安全边界的行为 | **绝对禁止**，违反即作废该轮结论 |
| **L1 · 允许但必须留痕** | 影响派发顺序/数量、但不改变判断内容 | 可做，**每次必须写 `discipline_log`** |
| **L2 · 自由** | 不影响结论的技术性动作 | 无需记录 |

#### L0 · 绝对禁止（这些不放宽）

| 禁止行为 | 理由 |
|---|---|
| 读取**源代码内容**（用 Read/Grep 看实现） | 上下文隔离的第一性原理，整套框架的地基 |
| 亲自**写代码或修改文件**（除账本、报告、状态机） | 破坏「第二个人独立看过」这一层 |
| 自行**提高并发上限**超过 `concurrency_window` | round31 的教训：槽位释放条件是**进入终态**，不是「文件已落盘」 |
| 自行**降低门控标准**放行不合格输出 | 契约底线 |
| **裁决冲突**（自己决定谁对） | 必须派 Arbiter |
| **缩小任务范围后重派** | 必须原样重派新实例 |
| 修改已冻结的 `scale_decision`（除 L1 允许的项） | 冻结的意义在此 |

#### L1 · 允许但必须留痕（这些放开）

| 允许的裁量 | 必须记录的内容 | 为什么放开 |
|---|---|---|
| 按**可达性**（`reachability`）调整派发顺序 | 哪些切片、原顺序、新顺序 | 可达性是**结构特征**（引用关系），非内容特征；round31 证明它能把 72% 预算从死代码里救回来 |
| 按**线索密度**决定深挖哪些切片 | 阈值、命中列表 | 两遍制的核心机制，不可能预先写死每个项目的阈值 |
| 按**线索指向的维度**指派深挖维度 | 每条线索 → 维度的映射 | 比无依据的轮转更合理；round31 的轮转被证明会漏掉关键文件 |
| 在**预算耗尽**时选择截断哪些深挖 | 截断列表、依据（必须是确定性规则） | 必须做，但必须留痕以便复核 |
| 在**同优先级**内调整 FIFO 顺序 | 调整理由（必须是可机械验证的结构理由） | 例如「同 `reachability` 档内按 `lead_count` 降序」 |

**留痕格式（写进账本 `discipline_log`，每次一条）**：

```json
{
  "seq": 1,
  "wave": "wave-2a",
  "discretion_type": "REACHABILITY_ORDERING | DEEP_DIVE_SELECTION | DIMENSION_ASSIGNMENT | BUDGET_TRUNCATION | FIFO_REORDER",
  "action": "把 slice-31..slice-40 的可达性标记为 UNREACHABLE 并移出深挖队列",
  "basis": "宽扫返回 reachability=UNREACHABLE；非测试代码中对这些文件零引用",
  "evidence_ref": "docs/reports/round31/round31-02-sweep-slice-31.md",
  "mechanical_check": "每个被移动的切片都有 reachability 字段，复核者可逐条比对 grep 结果",
  "reversible": true
}
```

**`mechanical_check` 字段是硬要求**：必须写明「复核者如何用机械手段验证这条裁量」。**如果写不出机械复核方法，这条裁量就不被允许**——它已经退化成 L0 禁止的主观判断了。

#### L2 · 自由

不影响结论的技术性动作：重试瞬时失败、调整日志措辞、决定先读哪个结果、给报告加索引。

### 1.3 违规的判定与后果

| 情形 | 判定 | 后果 |
|---|---|---|
| L0 行为 | 违规 | 该轮结论**作废**，必须在报告中声明 |
| L1 行为**已留痕**且 `mechanical_check` 可执行 | **合法** | 正常推进，裁量记录进最终报告附录 |
| L1 行为**未留痕** | 违规 | 该轮结论**作废**（与 L0 同等严厉） |
| L1 留痕但 `mechanical_check` 不可执行 | 违规 | 视为伪装成 L1 的 L0，该条裁量无效，需回退 |

**为什么未留痕比做错更严厉**：round31 的教训是，违规一旦不申报就**无法被发现**（并发那次是用户指出才核验的）。留痕机制的价值不在「允许更多裁量」，而在**让裁量可见、可复核**。

### 1.4 谁检查裁量

**Skeptic 的固有职责已扩展**：它是唯一被授权**用机械比对检查 `discipline_log`** 的角色。必须做三件事：

1. 把 `discipline_log` 与实际派发记录（`wave2_completed`、产物文件列表）**逐条比对**，找出**未申报的裁量**；
2. 检查每条 L1 裁量的 `mechanical_check` 是否**真的可执行**；
3. 输出 `discipline_violations[]`，每条附证据。

> **实测依据**：round31 的 9 处维度偏离，正是 **Devil's Advocate 用机械比对发现**的（ledger `dimension_deviation_disclosed_by`），主 Agent 事先并未申报。这说明机械比对有效——把它从「偶然发现」变成「Skeptic 的固定职责」。

### 1.5 主 Agent 的工具白名单（放宽后）

```
允许：
  调度类    spawn_agent / read_result / write_ledger / write_report / update_state
  只读核验  Bash（白名单命令，见下表）
禁止：
  Read / Grep / Glob 作用于「被审仓库的源代码」   ← L0，见 1.2
  Edit / Write 作用于「被审仓库的任何文件」        ← L0，见 0.1
  任何代码分析工具（AST、lint、semgrep 等）        ← 那会把源码内容拉进上下文
```

**2026-11-03 修订：主 Agent 必须拥有受限的 `Bash`，否则三处规则无法执行。**

此前白名单只有 `spawn_agent / read_result / write_ledger / write_report / update_state`，但另外三处把它当作必须用 `Bash` 执行：

| 要求出处 | 要求执行的命令 | 原先的后果 |
|---|---|---|
| `protocol.md` 第 0.6 节 | `git -C <repo> status --short \| grep ...` | 零写入自证**无法产出**——报告只能声称「我没改」，拿不出证据 |
| `artifacts/final-report.md` 第 7 节 | 同上 + `git status --short \| grep -c '^??'` | 同上，且第 9 节要求每个数字附「口径 + 命令 + 原始输出」，命令跑不出来 |
| `templates/wave2a-sweep.md` 第 9 节 | `wc -l` / `ls` 核验切片行数与文件存在性 | 派发前无法核验任务书，只能原样转发错误行数（round1 已实测发生） |

**这不是放宽 L0，而是把「只读核验」与「读取源代码」分开。** 两者的区别是上下文是否被代码内容污染：

| 命令 | 是否把源码内容拉进上下文 | 判定 |
|---|---|---|
| `git status --short` / `git diff --stat` / `git log --oneline` | 否，只有路径与计数 | ✅ 允许 |
| `git check-ignore -q <path>` | 否，只有退出码 | ✅ 允许 |
| `wc -l <files...>` / `ls` / `find <dir> -type f` | 否，只有行数与文件名 | ✅ 允许 |
| `jq '.findings \| length'` 作用于**产物文件** | 否，只取计数 | ✅ 允许 |
| `mkdir -p "<OUTDIR>/round${N}"` | — | ✅ 允许，**唯一被允许的写盘命令**，见下方 |
| `node <FRAMEWORK_ROOT>/tools/verify-artifacts.mjs` | 否，只输出校验结论与路径 | ✅ 允许，见 §1.6 |
| `git diff` / `git show` / `git blame`（无反引号行） | **是**，输出代码正文 | ❌ 禁止，派子 Agent |
| `cat` / `head` / `grep` 作用于源代码 | **是** | ❌ 禁止（L0） |
| 任何 `>` `>>` `sed -i` `tee` 作用于被审仓库 | — | ❌ 禁止（L0，见 0.1） |

**Bash 白名单的执行约束**：

1. **命令必须落上表**。不在表内的，一律先问「它的输出会不会包含源代码正文」——会，就派子 Agent。
2. **输出必须可复核地贴进报告**。核验命令的价值在于证据，跑完不贴等于没跑。
3. **组合命令按「读取的数据源」判定，不按「出现的命令名」判定。** 判据是**管道里流的是什么**：
   - `git status --short | grep -E '^ ?[MDARC]'` → ✅ 允许。流的是 `git status` 的**路径与状态字符**，不是代码正文（`final-report.md` 第 7 节要求的就是这条）。
   - `git status --short | wc -l` → ✅ 允许。
   - `git status --short | xargs grep TODO` → ❌ 禁止。`xargs grep` 的文件参数来自 git，读的是**源码正文**——前半在表内，后半是 L0。
   - `grep -rn 'TODO' src/` → ❌ 禁止（直接读源码）。
4. **一旦违反**，按第 1.3 节「L0 行为」处理：该轮结论作废。

**`mkdir` 的边界（唯一的写盘例外）**：主 Agent 必须能在**仓库外**的产物目录下建本轮目录（`report-naming.md` §5.1），否则每个子 Agent 的 `artifact_path` 都无法落地，契约校验会全线失败。

```bash
mkdir -p "<OUTDIR>/round${N}"     # ✅ 唯一允许的写盘命令
```

| 约束 | 说明 |
|---|---|
| 目标必须在 `<OUTDIR>` 内 | `<OUTDIR>` 是用户指定的**仓库外**产物目录 |
| **绝不可指向被审仓库** | 若产物必须落在仓库内，先过 §0.2 的 `git check-ignore` 验证；验证不通过就换位置，**不得建目录** |
| 只建本轮目录，不建其他 | 与 `report-naming.md` §5「不创建额外目录」一致 |
| 建完立刻写 `state.json` 的 `report.dir_ready = true` | 未置位前不得派发任何子 Agent |

### 1.6 机械校验器：把能算的东西算出来

**框架里有一批规则本来就是机械可验证的，此前却全部靠提示词约束、靠 LLM 互相检查。** 现提供 `tools/verify-artifacts.mjs`（零依赖，只读），主 Agent **必须**在两处调用它。

```bash
node <FRAMEWORK_ROOT>/tools/verify-artifacts.mjs \
  --repo "<被审仓库>" \
  --artifacts "<OUTDIR>/round{N}"
```

| 检查 | 内容 | 此前靠什么 |
|---|---|---|
| **G0** 门 0 回显 | `evidence.quote` 是否真的出现在 `evidence.file:line` | 靠提示词「不得凭记忆引用」+ 另一个 LLM 抽查 |
| **G1** 文件存在性 | `files_read` / `evidence.file` 路径是否真实存在 | 无任何检查 |
| **G2** 产物真实性 | `SUCCESS` 的 `artifact_path` 文件是否存在且非空 | 无任何检查（这是「格式完美、结论为空」的防线） |
| **G3** 覆盖完整性 | `files_read` 是否覆盖切片声明的 `files[]` | 靠 Devil's Advocate 人工集合差 |
| **G4** 账本对账 | `discipline_log` 与 `wave2_completed` 是否对得上、`mechanical_check` 是否为空 | 靠 Skeptic 逐条比对 |
| **G5** 自述数字自洽 | `lead_count` / `slice_count` / histogram 之和是否与实际数组长度一致 | 无任何检查 |
| **G6** 产物 JSON | 产物里的 JSON 块是否语法合法 | 无任何检查 |

**两个强制调用点**：

| 时机 | 命令 | 失败处理 |
|---|---|---|
| **每次收到子 Agent 返回后**（单条验收） | 校验该条产出的 `artifact_path` 目录 | 有 `FAIL` → 判 `CONTRACT_VIOLATION`，按 §4.1 计数重派 |
| **生成最终报告前**（全轮体检） | 校验整个 `round{N}/` | 有 `FAIL` → 报告顶部必须声明「本轮存在 N 条机械校验失败」，并逐条列出。**不得静默通过** |
| **声明本轮 `CLOSED` 之前**（交付体检） | `check-deliverables.mjs`（见 §1.9） | 有 `FAIL` → **本轮不得写 `CLOSED`**，只能是 `PARTIALLY_CLOSED` 或 `BLOCKED` |

**退出码**：`0` 全通过 / `1` 有 FAIL / `2` 用法错误 / `3`（`--strict`）有 WARN。

**它不检查什么，必须说清楚**：证据是否支持主张、严重性是否合理、可达性判断对不对、缺陷重不重要——**这些是 LLM 的判断，脚本不碰**。校验器把「可计算的」部分拿走，留下的恰好是框架真正该做的那部分。

> **为什么这条改动重要**：`files_read` 可以零成本捏造，这是 `START-HERE.md` 已知缺陷表里挂了很久的一条。它挂了那么久，是因为一直假设「要解决它得靠更强的提示词」。**实际上验证它只需要打开文件比对字符串。** 同类还有 G2/G5/G6——它们全都不需要任何智能判断。
>
> 而 `tools/verify-artifacts.test.mjs` 里的 22 个用例证明它抓得住真问题：构造一条 `--r` vs `--rot` 的编造引用，它能精确报出两个字符串的差异。

### 1.7 轮次链判定器：自动续轮不能靠读散文

自动续轮（`run-state.md` §6.5）是**用户不必每轮催一次**的唯一机制。它的规则此前全是自然语言，而 2026-11-04 的静态核查发现 §6 与 §6.5 在 `PARTIALLY_CLOSED` 上**给出相反指令**——恰好是「预算耗尽」这个最常见分支。

```bash
# 决策：这一轮跑完之后，该续跑、该开新轮、还是该停
node <FRAMEWORK_ROOT>/tools/check-round-chain-live.mjs "<OUTDIR>/round{N}/state.json"
```

**主 Agent 在每次写完结轮报告后、以及每次会话恢复时，必须执行它。**

| 输出 | 含义 | 动作 |
|---|---|---|
| `RESUME_SAME_ROUND` | 本轮 `status: RUNNING`，还没出报告 | 续跑同一轮 |
| `OPEN_NEXT_ROUND` | 已收口且有 `DEFERRED` | 自动开 `round{N+1}`，`DEFERRED` 作为输入 |
| `STOP` | 已收口且无 `DEFERRED` | 正常结束 |
| `✗ 两条规则冲突` | 规则自相矛盾 | **停止并报告**，不得自行选一条执行 |

```bash
# 规则自洽性：改了 §6 / §6.5 之后必须重跑
node <FRAMEWORK_ROOT>/tools/simulate-round-chain.mjs
```

23 个用例覆盖：多轮覆盖、`max_rounds` 触顶、零容量必须 `STALLED` 而非死循环、`RUNNING` 必须续跑、以及**静态检查 §6 的可执行规则块里没有旧判据**。

> **为什么这条必须机械化**：自动续轮是唯一「跑错就会让用户重新开始值守」的机制，而它的输入只有一个 `state.json`。**一个字段、三条分支的判断，没有任何理由交给 LLM 读三段散文来决定。** 用它之前和之后各跑一次，冲突会当场暴露——这正是机械化的价值：不是让规则更强，是让规则的矛盾无处可藏。

### 1.8 一条命令跑完全部检查

```bash
node <FRAMEWORK_ROOT>/tools/check-all.mjs
```

| 检查器 | 覆盖 | 用例数 |
|---|---|---|
| `verify-artifacts.test.mjs` | 门 0 回显、产物真实性、账本对账、自述数字 | 35 |
| `simulate-round-chain.mjs` | 自动续轮：多轮推进、`max_rounds`、`STALLED`、§6/§6.5 一致 | 23 |
| `classify-failures.test.mjs` | 失败分类：`NO_OUTPUT` / `SKELETON_ONLY` / `EMPTY_RESULT` 及重派策略 | 16 |
| `check-deliverables.test.mjs` | 交付物：两类必交付、报告六节、账本四节、自由命名、子目录 | 13 |
| `detect-harness.test.mjs` | 环境探测：版本比较、unknown 不猜值 | 11 |
| `check-payload.test.mjs` | 契约准入：JSON 信封、顶层字段、角色必填、计数自洽 | 17 |
| `check-state.test.mjs` | state.json：枚举、FAILED 诊断、DONE 产物、attempt、budget | 18 |
| `attempt-ledger.test.mjs` | attempt 计数：digest 对 agent_id 不敏感、连续同因即停 | 15 |
| `gate.test.mjs` | 门禁系统：4 道门的放行与拒绝路径 | 18 |
| `lint-autonomy.mjs` | **不得要求用户值守**等 L1–L11 共 11 条规则 | 11 条规则 |

**改任何规则后必须跑一次。** 为什么要有这个总入口：框架有 9 个检查器，分散调用必然漏跑一个——而「漏跑一个」已经造成过真实损失：`protocol.md` 修了 `attempt` 归零的死锁，但 `README.md`、`MANUAL.md`、`output-contract.md` 里同样的旧规则还活着，直到 `lint-autonomy.mjs` 把它们扫出来。

### 1.8.1 门禁：把检查变成绕不过去的关口（2026-11-09 新增）

**`check-all.mjs` 报全绿，只代表那 9 个脚本没报错**——它不阻止任何事，只是「记得要跑才跑」。

`tools/gate.mjs` 把它们组织成**四道生命周期门**，每道门返回放行/拒绝：

| 门 | 何时 | 检查什么 | 拒绝后果 |
|---|---|---|---|
| `--gate dispatch` | **每次派发子 Agent 之前** | attempt 计数、state.json 合法性 | **不得派发** |
| `--gate accept` | **每次收到返回后** | 契约合规（`check-payload`）、门 0 回显（`verify-artifacts`） | 判 `CONTRACT_VIOLATION`，**不得进下游** |
| `--gate close` | **声明 `CLOSED` 之前** | state.json 合法性、交付物齐全 | **不得写 `CLOSED`** |
| `--gate release` | **交给用户之前** | 状态自洽、框架规则未被改坏 | **报告不得交付** |

```bash
# 派发前
node tools/gate.mjs --gate dispatch --payload <task.json> --ledger <attempt.json> --state <state.json>

# 收到返回后
node tools/gate.mjs --gate accept --artifact <产物.md> --role sweep --repo <被审仓库>

# 声明 CLOSED 前
node tools/gate.mjs --gate close --state <state.json> --round-dir <round{N}>

# 交付前
node tools/gate.mjs --gate release --state <state.json>
```

**四道门都是强制的，不得跳过。** 退出码 `0` 放行 / `1` 拒绝 / `2` 用法错误。

> **为什么需要门而不是脚本**：2026-11-09 对比 `dsh-superagent` 后确定。它把「字段缺失」做成**工具调用失败**——
> 错误在产生那一刻被挡住，不是靠「记得检查」。我们的 13 个脚本全是「记得要跑」。
>
> 差别在失效模式：脚本漏跑时**一切看起来正常**；门禁漏跑时**流程根本走不下去**。

### 1.9 交付物检查：跑完之后用户拿什么

**规范写在 `artifacts/report-naming.md` §4，这里只给调用点。**

```bash
node <FRAMEWORK_ROOT>/tools/check-deliverables.mjs --round-dir "<OUTDIR>/round{N}"
```

| 规则 | 检查什么 | 级别 |
|---|---|---|
| **D1** | `round{N}-final-report.md` 与 `round{N}-ledger.md` 都存在且非空 | FAIL |
| **D2** | 最终报告七节齐全，且覆盖率写成 `N/N = xx%` | FAIL / WARN |
| **D3** | 账本四节必备齐全 | FAIL |
| **D4** | 目录里没有无法归入任何规范的文件 | WARN |
| **D5** | 目录是扁平的（无子目录） | WARN |

**`CLOSED` 的前置条件**：D1~D3 全部 `PASS`。

> **为什么这条要强制执行**：2026-11-05 之前，框架只规定了「波次产物叫什么名字」，**从没规定「一次运行结束后用户该拿走什么」**。实测结果是交付物很乱——11.6KB 到 25.0KB 的文件长什么样全凭 agent 心情，用户要翻七八个文件才能拼出结论。
>
> 现在两类必交付：**报告给人读（结论），账本给机器读（状态）**。其余波次产物降级为过程日志，供追溯但不作交付。
>
> **一句判据**：一次运行结束后，如果用户要自己翻若干个文件才能拼出结论，这次交付就算失败。

> **`lint-autonomy.mjs` 检查的是这一整套框架最初的病**：不是「审得不准」，是**每做完一段就停下来**。老版本（git HEAD）里「等待人工介入」5 处、「人工裁决」10 处，而全框架 `自动续` / `max_rounds` / `state.json` 的命中数**全为 0**——没有任何机制能让流程自己往下走。
>
> 静态检查把它钉住的理由是：**这个毛病不会因为改过一次就自动消失**，同一个规则在本框架里被复制到 3–5 个文件，改一处必须同步全部。人记不住，脚本记得住。

> **为什么这条要写到这么细**：`git status | grep` 是 `final-report.md` 第 7 节的强制命令，而 `grep` 又出现在 L0 的禁用清单里。若只写「grep 禁止」，主 Agent 面对「必须跑 grep」和「禁止 grep」两条规则，只能二选一——**要么违反零写入自证的要求，要么违反工具禁令**。第 3 条把判据从「命令名」改成「数据源」，这个矛盾才消失。

> **为什么这次修订本身值得记一笔**：一条规则要求做 X，另一条规则禁止工具 Y，而 X 只能通过 Y 完成——这是**规则之间的矛盾，不是执行者的失误**。原设计假设「主 Agent 不碰 shell 也能调度」，但零写入自证和任务书核验都需要一个不读源码的执行通道。补上受限 `Bash` 比删掉那三处要求更保守：删要求会让「我没改仓库」变成一句无法验证的自述。

**注意**：主 Agent **仍然不得读取源代码内容**——这是 L0，不放宽。它读取的是**账本、结构化返回、状态机文件、自己写的报告**，以及上表那些**只返回元信息**的命令输出。

---

## 2. 状态账本：唯一的事实来源

搜索到的任务账本模式有两个值得直接借用的设计：任务状态和预算从消息文件派生，**不单独存储**；账本本身是持久化的，可以支撑“八 agent 竞争同一张表”的并发场景[^ref2]。Open Engine 的协调层也把票据状态机、审计日志和委托引擎作为核心组件[^ref3]。

`protocol.md` 里账本的最小字段集建议如下（字段名固定，不随模型变化）：

```
ledger:
  round_id: "RN"                     # 由轮次探测Agent返回
  wave: 1|2|3|4|5
  slice_count: int|null              # 侦察波次后写入
  planned_agents: int                # 本波计划派发数
  spawned_agents: int                # 实际已派发数（含重派）
  concurrency_cap: int               # 从 scale-mapping 读取
  total_agent_count: int             # 累计派发数（护栏用）
  agents:
    - agent_id: string
      template: string
      status: PENDING|RUNNING|SUCCESS|RETRYABLE_FAILURE|CONTRACT_VIOLATION|PERMANENT_FAILURE
      attempt: int
      artifact_path: string|null
      findings_count: int|null
  conflicts:                         # 仅记录“互斥结论对”
    - issue_id: string
      agents: [agent_id, agent_id]
      resolution: PENDING|ARBITRATING|UPHELD|DOWNGRADED|REVOKED
  covered_modules: [string]          # 供后续轮次复用
  unverified: [string]               # 侦察返回的UNKNOWN集合
```

主Agent**只读这个账本做调度决策**，不读任何子 Agent的正文报告。子 Agent的产出文件路径写入 `artifact_path`，主Agent在最终汇总时只做路径拼接，不重写内容。

## 3. 波次门控：每一波的闭合条件必须是确定性的

Workflow Wave Dispatch 的纪律是：波次之间不是并行扇出，而是**顺序波次 + 验证门控**；每一波本身是一个 `parallel-agent-dispatch` 调用，波次 N+1 只在波次 N 达到合并/闭合条件后触发。`goal-workflow` 的 `graph` 模式也描述了“波次之间 fan-in barrier 合并结果并重新规划下一波”的机制[^ref5]。

`protocol.md` 中每一波的闭合条件应写成布尔判定，而不是“大部分成功即可”：

- **波次一（侦察）闭合条件**：侦察Agent返回 `SUCCESS`，且 `slice_count` 为整数、`audit_slices` 非空、`unverified` 已标注。若 `slice_count` 与 `len(audit_slices)` 不一致（契约违规），按第 4.1 节计数重派；达到 `PERMANENT_FAILURE` 时按下方「波次闭合的终态规则」处理。
- **波次二（发现）闭合条件**：`agents` 中所有切片的状态均**已进入终态**（`SUCCESS` / `PERMANENT_FAILURE`），且没有**待重派的** `CONTRACT_VIOLATION`。**不要求「零发现」**——没有发现本身可以是一个合法结果，但必须是带证据的 "No evidence found"。**不要求「全部 SUCCESS」**——见下方「波次闭合的终态规则」。

> **2026-11-20 修正**：本句此前写的是「`spawned_agents` 中所有切片的状态均已进入终态」。
> 那是**字段用错了**：按上方 §2 的账本 schema，`spawned_agents` 是一个 **`int`**（实际已派发数），
> 不是容器；承载「每个切片/实例的状态」的是 **`agents`** 数组（`agents[].status` / `agents[].attempt`）。
>
> 这不是措辞问题。一个读实现的人会看到两个互相矛盾的定义：
> - `:1040` `spawned_agents: int   # 实际已派发数（含重派）`
> - `:1067` 「`spawned_agents` **中**所有切片的状态」← 把它当成列表
>
> 而 `grep -rn spawned_agents tools/` 是 **0 命中** —— 这条闭合条件从来没有被任何东西执行过，
> 所以两种含义并存了这么久也没人发现。**「有规则、没检测器」的代价不是规则写错了，
> 是规则写错也不会有人知道。**
- **波次三（锐评）闭合条件**：Skeptic 和 Devil's Advocate 均返回 `SUCCESS`（或已进入 `PERMANENT_FAILURE` 且对应发现按下方规则标记为 `unverified`）；`conflicts` 中每一项的 `resolution` 不再是 `PENDING`（要么已由Arbiter裁决，要么标记为 `ARBITRATING` 并已派发仲裁Agent）。
- **波次四（修复）闭合条件**：每一条 `UPHELD` 的发现都有对应的修复Agent返回 `SUCCESS`（或 `PERMANENT_FAILURE` 并已记入 `unverified`），且修复Agent的返回中带有 `affected_issues` 列表（说明该修改可能影响的其他已发现缺陷）。
- **波次五（验收）闭合条件**：每一个修复对应的验收Agent都返回了**终态**（`SUCCESS` 或 `RETRYABLE_FAILURE`），且每个有 `verdict` 的修复都明确给出了结论。三种情形分别处理：
  - `verdict: PASS` + `escalation_required: false` → 正常闭合，该项关闭；
  - `verdict: FAIL`（归因 `FIX_INCOMPLETE` / `FIX_INCORRECT`）→ **回到波次四**，不回到波次二；
  - `verdict: PASS` + `escalation_required: true`，或归因为 `BASELINE_INVALID` → 该缺陷**不进入修复波**，但本轮**允许以「部分闭合」状态终止**（见下方"人工阻塞项不可无限阻塞"规则）。

### 3.1 波次闭合的终态规则（2026-11-03 修订，修 F1 死锁）

**原缺陷**：波次二的闭合条件写的是「所有切片的审计Agent状态均为 `SUCCESS`」，但第 4 节又规定 `PERMANENT_FAILURE` 是**合法终态**且**禁止重派**。两者叠加：

```
某个切片 → 连续失败 → PERMANENT_FAILURE（合法终态，禁止重派）
  → 该切片状态永远 ≠ SUCCESS
  → 波次二闭合条件永远为 false
  → 流程永久卡在波次二
  → 终态 IN_PROGRESS，无报告
```

**这不是理论推演**：`protocol.md` 第 0.7.1 节自己记录了 round31 的结局正是 `IN_PROGRESS`、无最终报告。当时的归因是「修复波最脆弱」，但**波次二这道门本身打不开**是同一结局的另一条独立路径——只要有一个切片永久失败，无论修复波多么健壮，都到不了修复波。

**新规则：闭合条件从「全部成功」改为「全部进入终态」。**

```
波次闭合 ⟺ ∀ agent ∈ 本波：agent.status ∈ {SUCCESS, PERMANENT_FAILURE}
             ∧ 不存在 status == CONTRACT_VIOLATION 且 attempt ≤ 3 的 agent
```

**关键区别**：`CONTRACT_VIOLATION` 在 `attempt ≤ 3` 时**不是终态**（还能重派），超过后**转化为** `PERMANENT_FAILURE`（见第 4.1 节）。所以「进入终态」这个条件**一定可达**——每个 agent 最多 3 次尝试就会落到终态之一。

**`PERMANENT_FAILURE` 进入下一波还是终止本轮？**

先定**分母**（这一步不做，下面的百分比全是空话）：波次二有 `2a` 宽扫与 `2b` 深挖两个**独立队列**，两波的失败不能混在一个百分比里——宽扫一个切片失败，只丢那一片的线索；深挖一个切片失败，丢的是那一片的全部发现。两者的后果不等价。

| 队列 | 分母 | 分子 | 阈值含义 |
|---|---|---|---|
| **2a 宽扫** | `scale_decision.planned_sweep_agents` | 实际 `PERMANENT_FAILURE` 的宽扫实例数 | 失败切片不进深挖队列 |
| **2b 深挖** | 本轮**实际派发**的深挖实例数（`spawned_deep_dive`，不是 `discovery_budget`） | 实际 `PERMANENT_FAILURE` 的深挖实例数 | 见下表 |

> **2b 的分母为什么不是 `discovery_budget`**：预算是**计划**，实派数是**事实**。用预算当分母，会在「预算没用完就因为别的原因停了」时把 20% 算小，从而错误地放行一轮覆盖不足的审计。**只在已派发的实例里算失败率**，才反映真实覆盖。

**2b 深挖的处置**：

| 情形 | 处置 |
|---|---|
| 深挖失败率 ≤ 20% | **正常进入波次三**。失败切片写入 `unverified`，Devil's Advocate 必须把它们标为 `COVERAGE_GAP`；最终报告在「覆盖说明」中显式列出 |
| 深挖失败率 > 20% | **跳过波次三与修复波，直接出报告**，终态 `PARTIALLY_CLOSED`。理由：超过两成切片完全没有发现时，锐评的「覆盖完整性攻击」没有可攻击的对象——它攻击的是覆盖结论，而覆盖本身已经不成立 |

**2a 宽扫的处置**：宽扫失败**不单独触发终止**，只做两件事——① 该切片的 `reachability` 记为 `UNKNOWN`，**一律进入深挖队列**（宁可贵一点，不可静默丢弃）；② 写入 `unverified`。理由：宽扫的产出是线索，线索少不等于没缺陷，把它当作终止条件会把「扫描器失灵」误判成「项目干净」。

**其余波次的处置**：

| 情形 | 处置 |
|---|---|
| 波次三中 Skeptic 或 Devil's Advocate `PERMANENT_FAILURE` | 对应发现全部标记为 `unverified`，**不得**默认 `UPHELD`。终态 `PARTIALLY_CLOSED` |
| 波次四中某条修复 `PERMANENT_FAILURE` | 该条记入 `unverified`，其余条继续；不阻塞本轮（与第 0.7.2 节「每条独立记账」一致） |
| 波次五中某条验收 `PERMANENT_FAILURE` | 该条修复的结论标记为「未经独立验证」，**不得**记为已修复 |

**为什么阈值是 20%**：这是一个**可调参数，不是科学常数**。选它的理由是分界清晰——低于 20% 时，锐评仍能对剩余 80% 做有意义的覆盖攻击；高于 20% 时，报告的「覆盖说明」会占据主要篇幅，此时锐评的结论对读者的价值低于直接看覆盖缺口清单。**修改这个值不需要改结构**，只需改这一行。

**硬规则：任何终止路径都必须出报告。** 无论波次在哪个位置因何种原因终止（含 `PERMANENT_FAILURE` 超阈值、`total_agent_count` 触顶、`phase_level_failure`、人工中断），**先出报告再退出**。报告里 `PARTIALLY_CLOSED` 是合法终态，`IN_PROGRESS` 不是。

**人工阻塞项不可无限阻塞**：`HUMAN_DECISION_REQUIRED` 与 `REVOKED` 是 `blocking: true` 的项，但自动化流程**没有任何机制能清除它们**——它们只能由人裁决。因此：

1. 这两类 `blocking` 项**不阻止本轮终止**，只阻止把该缺陷记为"已修复"；
2. 主Agent在波次五闭合时，若剩余 `blocking: true` 的项**全部**属于 `HUMAN_DECISION_REQUIRED` 或 `REVOKED`，则本轮状态置为 `PARTIALLY_CLOSED`（不是 `FAILED`，也不是 `CLOSED`），并照常生成最终报告；
3. 最终报告必须把这类项列在「待人工裁决」清单中，并明确写出"本轮未据此记为已修复"。

**为什么必须这样**：如果严格按"所有 blocking 项清空才能闭合"执行，一旦出现需要人工裁决的项，流程会永久卡在波次五，既不能推进也不能结束——这在无人值守场景下等于挂死。区分 `PARTIALLY_CLOSED` 让流程能正常收尾，同时不牺牲结论的诚实性：该缺陷既没被记为已修复，也没被静默丢弃。

**什么才算真正的阻塞**：只有未被处理的 `UNRESOLVED_FINDING`、`EVIDENCE_GAP`、`COVERAGE_GAP`、`REGRESSION_SCAN_REQUIRED` 才是流程必须处理的阻塞项——它们都有对应的自动动作（派仲裁、派补采、派审计、追加回归扫描）。`HUMAN_DECISION_REQUIRED` 与 `REVOKED` 没有自动动作，因此不能按同样方式阻塞。

门控失败时的行为必须写死：**主Agent不得自行降低门控标准，不得将失败子任务合并到主线程执行，不得缩小任务范围后重派**。

## 4. 重派与失败处理：区分“可重跑”和“不可重跑”

搜索到的重试实践给出了一个关键区分：**只读的评审者、研究者、报告撰写者可以安全地从零重跑**；有副作用的子 Agent（写代码、部署）不应默认无限重跑，因为失败尝试可能留下部分产物。`SpawnWithRetry` 的默认最大重试次数是 3，且每次重跑获得**全新的超时预算**，但消息投递在重试边界上保持 at-most-once[^ref7]。

### 4.0 「全量重跑」为什么不成立（2026-11-09 新增，优先级高于本节其余规则）

> **背景**：用户曾要求「期间如有 agent 因任何问题报错，都必须全量重跑，不要有任何缩水」。
> **经 6 个专家 Agent 交叉审查，这条在数学上不成立，本条给出替代方案。**

**数学事实**：设单 agent 失败率为 p，n 个 Agent 并行，全部成功的概率是 `(1-p)^n`，期望重跑次数是 `1/(1-p)^n`。

| p（失败率） | n=5 | n=11 | n=31（递归一层） |
|---|---|---|---|
| 18%（本项目最干净的数字） | 2.7× | 8.9× | **470×** |
| 25% | 4.2× | 23.7× | 7,466× |
| 38%（实测未返回率） | 10.9× | 192× | **2,728,083×** |

**31 个 Agent 在 18% 失败率下，期望要跑 470 次。**

**更关键的是**：本项目唯一有 transcript 证据支持的失败根因是**产物路径含空格导致工具调用被静默拒绝**。若根因未修复，重跑会以**完全相同的方式再失败**——**重跑不解决问题，只放大问题**。

**所以「全量重跑」必须替换为「分类重派」**：

```
agent 报错时，先分类（tools/classify-failures.mjs），再决定动作：

NO_OUTPUT / ToolError        → 重派【该 agent】，不重跑整批
SKELETON_ONLY                → 先查 harness 状态，不得据此判失败
CONTRACT_VIOLATION           → 重派【该 agent】，attempt 按 digest 累计
HARNESS_REPORTED_TIMEOUT     → 按 harness 重试语义
EMPTY_RESULT                 → 不重派，记 NO_FINDINGS

作用域：只重跑失败的那个 agent。已完成的 agent 结果【复用】，不丢弃。
上限：同一 agent 重跑 3 次；同 error_type 连续 2 次 → 停止，记 unverified。
```

**这满足「不许缩水」吗？** 满足——失败的那份产出仍然是空的，仍然要重跑。
**差别只在于**：不把 30 个已完成的 Agent 一起丢掉。

| | 全量重跑 | 分类重派 |
|---|---|---|
| 失败 agent 的产出 | 空 | 空（仍要重跑） |
| 成功 agent 的产出 | **丢弃** | **保留** |
| 31 agent / 18% 失败率的期望成本 | 470× | 1.1× |
| 根因未修时 | 必然复现失败 | 同样复现，但只损失 1 个 agent |

### 4.0.1 各终态的处置

- **`RETRYABLE_FAILURE`**（超时、限流、工具瞬时错误）：**同一模板、同一任务负载原样重派一个新实例**，attempt +1，最多 2 次重试（即总尝试 3 次）。重试实例获得全新超时预算，但**不继承前一次的 partial output**。
- **`CONTRACT_VIOLATION`**（缺少必需字段、无证据、越权写文件）：作废**该Agent**的全部输出，派一个全新实例从原始任务描述重新执行。旧输出不得作为新实例的输入。**不影响同批次其他失败的 Agent。**
- **`PERMANENT_FAILURE`**（连续 3 次重试仍失败，或 harness 明确返回不可恢复错误）：该子任务标记为 `PERMANENT_FAILURE`，主Agent**不得缩小范围后重派**，而是将该失败写入 `unverified`，在最终报告中显式暴露为“未能覆盖”。
- **多失败窗口**：如果同一波次内 2 个以上 Agent 在 60 秒内同时失败，主 Agent 应暂停该波次的新派发，记录 `phase_level_failure`，然后**按顺序执行自动降级**，而不是无限等待人工：

  | 步骤 | 动作 |
  |---|---|
  | 1 | 把当前波次已失败/未完成的切片全部标 `DEFERRED`，**不重派** |
  | 2 | 若连续失败 ≥3 次同因（同 `violated_fields` 或同 `error_type`），判定为系统性缺陷，**立即出报告并终止本轮**，`status: PARTIALLY_CLOSED` |
  | 3 | 否则出本轮报告，**自动开 `round{N+1}`**，把 `DEFERRED` 作为新轮输入（见 `run-state.md` §6.5） |
  | 4 | 最终报告里单列「本波次因连续失败暂停，原因：<X>」，供用户回来时查阅 |

  **不得**「暂停并等待人工介入」——那会让一次可自动降级的技术故障，变成用户必须值守的停机。

### 4.1 `CONTRACT_VIOLATION` 的尝试计数（2026-11-03 修订）

**原缺陷**：本节原文写「`CONTRACT_VIOLATION` … attempt **从头计数**」，而 `RETRYABLE_FAILURE` 有「最多 2 次重试」的上限。两者叠加的后果是：

```
审计Agent 每次返回都缺一个必需字段
  → 判 CONTRACT_VIOLATION
  → 重派，attempt 归 0
  → 又缺字段 → 再判 → 再归 0
  → 无限循环，永不进入 PERMANENT_FAILURE
```

**这不是理论推演**：`CONTRACT_VIOLATION` 最可能的成因恰恰是**系统性**的——某个 wrapper 的 frontmatter 漏了字段、某个模板的 schema 与契约不同版、上下文过长导致返回被截断。这些**每一次重派都会复现**。attempt 归 0 等于把「失败可复现」的情况排除在兜底之外，恰好是最需要兜底的那一类。

**新规则：`attempt` 按 `(agent_id, task_payload_digest)` 累计，不因失败类型重置。**

| 失败类型 | `attempt` 变化 | 判定为 `PERMANENT_FAILURE` 的条件 |
|---|---|---|
| `RETRYABLE_FAILURE` | +1 | `attempt > 3` |
| `CONTRACT_VIOLATION` | +1 | `attempt > 3`，**或**连续 2 次违规的 `violated_fields` 完全相同 |
| `PERMANENT_FAILURE` | — | 立即终态 |

**第二条判定（「同字段连续违规」）比计数更快**：如果两次违规缺的是同一批字段，第三次大概率还是同一批——**这是确定性缺陷，不是随机波动**。此时不值得再消耗一次派发，直接按 `PERMANENT_FAILURE` 处理，原因写 `SYSTEMATIC_CONTRACT_DEFECT`，并把缺失字段清单写进 `unverified`。

**为什么保留第一次重派的机会**：`CONTRACT_VIOLATION` 也可能是一次性的（模型偶发截断、单次 token 超限）。但要区分这两类，**必须记录 `violated_fields`**，否则第二次违规时无从比较。该字段的格式规范（JSON Pointer、最深粒度、字典序去重）定义在 `output-contract.md` 第 3 节——**格式规范是这条判定的前提**，写法不一致会让「同一原因」的比较失效。

**`task_payload_digest` 的计算方式**（必须写死，否则「同一个任务」无法机械判定）：

```bash
# 对派发时传给子 Agent 的完整任务负载取摘要
# 负载 = payload 全文，排除每次都会变的部分
jq -S 'del(.trace_id, .agent_id, .spawned_at)' task_payload.json \
  | sha256sum \
  | cut -d' ' -f1
# → 记作 "sha256:<hex>"
```

> **不要写 `sha256sum <<< "$(...)"`**。here-string 会**额外追加一个换行符**，而 `$(...)` 命令替换**吃掉**尾部换行——两者的净效果取决于具体 shell 与末尾是否有多个换行，导致同一份负载在不同环境下算出不同摘要。**摘要算法的第一步是「输入必须逐字节确定」，任何依赖 shell 换行处理细节的写法都会破坏这一点。** 上面用管道直连，`jq` 的输出原样进入 `sha256sum`，没有中间层。

| 规则 | 说明 |
|---|---|
| 计算对象 | `payload` 全文，**排除** `trace_id` / `agent_id` / `spawned_at`，**以及重派时必然改变的产物路径类字段**（`output_path` / `artifact_path` / `artifact_paths` / `output_file` / `output_dir` / `outdir` / `instance_id` / `attempt` / `retry_id` / 各时间戳） |
| 序列化 | `jq -S`（键排序），保证同一负载产生同一字符串 |
| 换行处理 | 管道直连，不用 here-string；`jq` 默认输出末尾带一个换行，**这是确定的**，可以依赖 |
| 何时计算 | 派发前，写入账本 |
| 何时比较 | 收到 `CONTRACT_VIOLATION` 时，与上一次**同一任务键**的摘要比对 |

> **为什么排除 `agent_id`**：重派时必然换新 `agent_id`。若把它算进摘要，每条重派的摘要都不同，「按 (agent_id, digest) 累计 attempt」就会退化成「永远是新任务」——与本次修订要解决的死锁是同一个形状。**累计键的语义是「同一个任务的重试」，不是「同一个实例的重试」。**
>
> **注意 `attempt` 的累计键与摘要的关系**：`agent_id` 每次重派都换新，所以「按 `(agent_id, digest)` 累计」里真正起稳定作用的是 `digest`。**实现时应以 `digest` 为主键维护重试计数**，`agent_id` 只是记录「哪一次尝试」。这是原文措辞容易误导的地方——照字面实现会得到一个永远为 1 的计数器。

> **2026-11-14 红队实测：这个死锁曾经原样存在，只是换了一个键。**
>
> 上面那段只排除了 3 个字段，**漏掉了产物路径**。而 `run-state.md:300` 要求重派时
> 「你的产物请写到 `<独立路径>`，不要碰 `<原路径>`」。调用方把该路径放进 payload 后：
>
> ```
> 按规则重派 6 次（每次都换独立产物路径）
>   第 1..6 次  已尝试=1/3  放行
> 同一 payload 重复 6 次（对照组）
>   第 3 次起   状态=EXHAUSTED  **已拦**
> ```
>
> **护栏本身是好的，是累计键的选取让它形同虚设。** 这与第 1198 行自己警告的
> 「退化成永远是新任务——与本次修订要解决的死锁是同一个形状」是同一个形状，
> 只是这次漏的是路径而不是 `agent_id`。
>
> 修法：把「重派时必然改变但语义上仍属同一任务」的字段全部排除
> （产物路径、实例 id、attempt 计数、各类时间戳）。判据不是「这个字段会不会变」，
> 而是「它变了之后，这还算不算同一个任务的重试」。

```json
// 账本中每个 agent 的记录必须含这两项
{
  "agent_id": "...",
  "attempt": 2,
  "failure_type": "CONTRACT_VIOLATION",
  "violated_fields": ["payload.findings[0].evidence.quote"],
  "task_payload_digest": "sha256:..."
}
```

**`PERMANENT_FAILURE` 之后的处置不变**：写入 `unverified`，在最终报告中显式暴露为「未能覆盖」，**不得缩小任务范围后重派**。区别只在于：现在它**一定会有机会**成为终态，而不是被无限重派吊死。

## 5. 冲突处理：主Agent只负责“把冲突送进仲裁”，不裁决

Saalis 的仲裁层设计提供了可借用的策略：当多个Agent产出冲突时，使用可配置的解决策略、策略执行、可解释性和审计日志，而不是让协调者隐式拍板[^ref10]。ADP（Agentic Dispute Protocol）把证据提交标准和仲裁者角色标准化[^ref11]。

`protocol.md` 中的冲突规则：

1. 主Agent检测到两个子 Agent对**同一 `issue_id`** 给出互斥结论（一个判可触发，一个判不可触发）时，在 `conflicts` 中创建一条 `PENDING` 记录，**不自行选择任何一方**。
2. 主Agent派一个**新的 Arbiter 实例**（不携带先前波次的倾向），输入是双方的证据包和 `issue_id`，输出是 `UPHELD` / `DOWNGRADED` / `REVOKED` 三选一，并附理由。
3. 主Agent将裁决结果写回 `conflicts.resolution`，然后按裁决结果决定是否进入修复波。
4. **主Agent不得以“综合一下”或“取中间值”的方式消除冲突**；如果 Arbiter 返回 `ARBITRATING`（证据不足），主Agent应派发一个**证据补充Agent**，而不是自己判断。

### 5.1 汇总权与判断权分离（2026-11-09 新增）

> **背景**：用户曾要求「主Agent负责汇总冲突并输出最优解」。
> 这与第 4 条直接冲突。以下是调和方式。

**主 Agent 拥有两类权力，不拥有第三类**：

| 权力 | 内容 | 能不能做 |
|---|---|---|
| **汇总权** | 收集所有 Agent 的结论、识别哪些互相冲突、去重、组织成裁决表 | ✅ 能 |
| **表达权** | 决定最终报告的措辞、顺序、结构、强调什么 | ✅ 能 |
| **判断权** | 判定「专家 A 和专家 B 谁说得对」 | ❌ **不能** |

**为什么不能有判断权**：`protocol.md` §1.2 的 L0 禁止主 Agent 读源码。**它没有判断谁对的信息基础**——让它裁决等于让一个没看过证据的人当法官。

**具体流程**：

```
专家 A 和专家 B 结论冲突
  → 主 Agent 识别冲突，写进 conflicts[]（汇总权）
  → 派 Arbiter（干净上下文，只看结构化裁决依据）
  → Arbiter 判定谁对（判断权在 Arbiter）
  → 主 Agent 把裁决组织进最终报告（表达权）
```

**所以「主 Agent 汇总冲突并输出最优解」的正确执行是**：

- 「汇总冲突」= 汇总权 ✅
- 「输出」= 表达权 ✅
- 「最优解」= 由 Arbiter 裁决，主 Agent 负责呈现 ✅

**一句话**：主 Agent 是**编辑**，不是**法官**。

## 6. 并发与总量护栏

搜索到的实践给出了具体数值：`Pool` 通过信号量限制最大并发数[^ref12]；重试预算分歧的失败案例显示，如果路由器自身的计数上限和任务终止状态不一致，会产生“任务已终止但第4个孤儿worker仍被派出”的问题。OpenPI 的设计文档也区分了**计划总量、扇出宽度和瞬时并发**三个不同的数字。

`protocol.md` 中写死：

- **单波瞬时并发上限**：从 `scale-mapping.md` 读取，**主Agent不得自行提高**。如果 harness 的并发上限更低，取下限。
  > **2026-11-09 修订**：harness 有原生并发控制时（见 §0.0），本条不适用——用 harness 的。
- **单次运行总Agent数上限**：
  - 默认 **60**（`scale-mapping.md` 的 `total_budget`）；
  - **T2 任务**（`triage.md` §2）上限放宽到 **200**，因为用户明确要求「token 不是约束」，且 panel 制需要 7 人 × 多轮；
  - 无论哪种，触达上限时**必须出报告**，`status: PARTIALLY_CLOSED`，不得静默停止。
- **计划量 ≠ 并发量**：`planned_agents` 可以大于 `concurrency_cap`，主Agent按 FIFO 排队派发，**不得因为排队时间长就合并切片或减少计划量**。

---

## 参考来源

> **引用分级说明（2026-11-01 核实后新增）**：本节原有 5 个脚注（`ref0`/`ref2`/`ref3`/`ref10`/`ref11`）**全部指向同一个 Oracle 博客的同一个 `#1` 锚点**，却分别支撑「Supervisor 职责」「任务账本」「协调层组件」「仲裁层」「ADP 协议」五个不同论断。经核实该 URL 返回 **403，无法访问**，且精确标题检索无命中——**因此这 5 处引用不得再承担举证责任**。
>
> 下表把这 5 条论断的来源等级重新标定。**凡标 `D` 级的，本文的表述必须写成「设计约定」而非「依据某项研究」**。

| 论断 | 原脚注 | 等级 | 处置 |
|---|---|---|---|
| 主 Agent 不亲自执行领域任务（角色禁令） | `ref0`/`ref2`/`ref3` | **D · 无法核实** | 改写为「本框架的第一性原理是上下文隔离，由此推出主 Agent 只调度」——**从原理推导，不再假装有出处** |
| 冲突送仲裁、主 Agent 不裁决 | `ref10`/`ref11` | **D · 无法核实** | 同上，改为设计约定 |
| 只读角色可安全从零重跑 | `ref7`（`pi-go` 的 `SpawnWithRetry`） | **B · 工程文档** | 保留，但注明「某 Go 库的实现做法」，非研究证据 |
| 并发与重试预算 | `ref12`（同上） | **B · 工程文档** | 保留，措辞降为「实现惯例」 |
| 波次门控 / DAG 合并 | `ref5`（`goal-workflow` skill） | **B · 工程文档** | 保留 |

**脚注定义（保留编号以免其他文件引用错位，但已标注实际状态）**：

[^ref0]: **（无法核实，已降级）** 原指向 Oracle FUSION CoE 博客 `best-practices-for-prompts-in-ai-agent-studio#1`，返回 403，精确标题检索无命中。**本条不再作为举证依据。**
[^ref2]: **（同 `ref0`，已降级）**
[^ref3]: **（同 `ref0`，已降级）**
[^ref5]: [graph — smallnest/goal-workflow](https://www.skills.sh/smallnest/goal-workflow/graph) — B 级工程文档。
[^ref7]: [subagent - func (*Orchestrator) SpawnWithRetry](https://pkg.go.dev/github.com/dimetron/pi-go@v0.1.4/internal/subagent) — B 级工程文档（该 Go 库的默认重试次数确为 3）。
[^ref10]: **（同 `ref0`，已降级）**
[^ref11]: **（同 `ref0`，已降级）**
[^ref12]: [subagent - func (*Orchestrator) SpawnWithRetry](https://pkg.go.dev/github.com/dimetron/pi-go@v0.1.4/internal/subagent) — B 级工程文档。
