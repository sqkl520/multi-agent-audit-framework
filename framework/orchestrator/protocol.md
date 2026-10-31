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

## 1. 角色禁令（放在最前面，不可协商）

搜索到的 Supervisor 角色定义明确区分了编排与执行：Supervisor 的职责是分析意图、路由请求、管理跨轮上下文，**绝不亲自执行领域任务**；Worker 的职责是在明确边界内执行并返回结果，**绝不路由或做域外决策**[^ref0]。Martin-Aziz 的 supervisor-designer 规范进一步把这一点写成硬拒绝条件：**任何让 Lead 自己使用工具的编排设计都应被直接拒绝**，Lead 只计划与综合，只读 worker 摘要，不读原始源内容。

对应到 `protocol.md`，主Agent的工具白名单必须收窄到只允许三类动作：

1. `spawn_agent(template_id, task_payload)`——按模板派发子Agent；
2. `read_result(agent_id)`——读取子Agent返回的结构化契约结果；
3. `write_ledger(entry)`——更新状态账本。

**禁止**主Agent使用任何代码读取、文件写入、搜索或分析工具。任何“需要看一眼才能决定”的动作，都必须转化为一个子Agent任务，而不是由主Agent亲自执行。

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

主Agent**只读这个账本做调度决策**，不读任何子Agent的正文报告。子Agent的产出文件路径写入 `artifact_path`，主Agent在最终汇总时只做路径拼接，不重写内容。

## 3. 波次门控：每一波的闭合条件必须是确定性的

Workflow Wave Dispatch 的纪律是：波次之间不是并行扇出，而是**顺序波次 + 验证门控**；每一波本身是一个 `parallel-agent-dispatch` 调用，波次 N+1 只在波次 N 达到合并/闭合条件后触发。`goal-workflow` 的 `graph` 模式也描述了“波次之间 fan-in barrier 合并结果并重新规划下一波”的机制[^ref5]。

`protocol.md` 中每一波的闭合条件应写成布尔判定，而不是“大部分成功即可”：

- **波次一（侦察）闭合条件**：侦察Agent返回 `SUCCESS`，且 `slice_count` 为整数、`audit_slices` 非空、`unverified` 已标注。若任一缺失，重派侦察Agent（全新实例，不缩小任务）。
- **波次二（发现）闭合条件**：`spawned_agents` 中所有切片的审计Agent状态均为 `SUCCESS`，且没有 `CONTRACT_VIOLATION`。**不要求“零发现”**——没有发现本身可以是一个合法结果，但必须是带证据的“No evidence found”。
- **波次三（锐评）闭合条件**：Skeptic 和 Devil's Advocate 均返回 `SUCCESS`；`conflicts` 中每一项的 `resolution` 不再是 `PENDING`（要么已由Arbiter裁决，要么标记为 `ARBITRATING` 并已派发仲裁Agent）。
- **波次四（修复）闭合条件**：每一条 `UPHELD` 的发现都有对应的修复Agent返回 `SUCCESS`，且修复Agent的返回中带有 `affected_issues` 列表（说明该修改可能影响的其他已发现缺陷）。
- **波次五（验收）闭合条件**：每一个修复对应的验收Agent都返回了**终态**（`SUCCESS` 或 `RETRYABLE_FAILURE`），且每个有 `verdict` 的修复都明确给出了结论。三种情形分别处理：
  - `verdict: PASS` + `escalation_required: false` → 正常闭合，该项关闭；
  - `verdict: FAIL`（归因 `FIX_INCOMPLETE` / `FIX_INCORRECT`）→ **回到波次四**，不回到波次二；
  - `verdict: PASS` + `escalation_required: true`，或归因为 `BASELINE_INVALID` → 该缺陷**不进入修复波**，但本轮**允许以「部分闭合」状态终止**（见下方"人工阻塞项不可无限阻塞"规则）。

**人工阻塞项不可无限阻塞**：`HUMAN_DECISION_REQUIRED` 与 `REVOKED` 是 `blocking: true` 的项，但自动化流程**没有任何机制能清除它们**——它们只能由人裁决。因此：

1. 这两类 `blocking` 项**不阻止本轮终止**，只阻止把该缺陷记为"已修复"；
2. 主Agent在波次五闭合时，若剩余 `blocking: true` 的项**全部**属于 `HUMAN_DECISION_REQUIRED` 或 `REVOKED`，则本轮状态置为 `PARTIALLY_CLOSED`（不是 `FAILED`，也不是 `CLOSED`），并照常生成最终报告；
3. 最终报告必须把这类项列在「待人工裁决」清单中，并明确写出"本轮未据此记为已修复"。

**为什么必须这样**：如果严格按"所有 blocking 项清空才能闭合"执行，一旦出现需要人工裁决的项，流程会永久卡在波次五，既不能推进也不能结束——这在无人值守场景下等于挂死。区分 `PARTIALLY_CLOSED` 让流程能正常收尾，同时不牺牲结论的诚实性：该缺陷既没被记为已修复，也没被静默丢弃。

**什么才算真正的阻塞**：只有未被处理的 `UNRESOLVED_FINDING`、`EVIDENCE_GAP`、`COVERAGE_GAP`、`REGRESSION_SCAN_REQUIRED` 才是流程必须处理的阻塞项——它们都有对应的自动动作（派仲裁、派补采、派审计、追加回归扫描）。`HUMAN_DECISION_REQUIRED` 与 `REVOKED` 没有自动动作，因此不能按同样方式阻塞。

门控失败时的行为必须写死：**主Agent不得自行降低门控标准，不得将失败子任务合并到主线程执行，不得缩小任务范围后重派**。

## 4. 重派与失败处理：区分“可重跑”和“不可重跑”

搜索到的重试实践给出了一个关键区分：**只读的评审者、研究者、报告撰写者可以安全地从零重跑**；有副作用的子Agent（写代码、部署）不应默认无限重跑，因为失败尝试可能留下部分产物。`SpawnWithRetry` 的默认最大重试次数是 3，且每次重跑获得**全新的超时预算**，但消息投递在重试边界上保持 at-most-once[^ref7]。

`protocol.md` 中对应规则：

- **`RETRYABLE_FAILURE`**（超时、限流、工具瞬时错误）：**同一模板、同一任务负载原样重派一个新实例**，attempt +1，最多 2 次重试（即总尝试 3 次）。重试实例获得全新超时预算，但**不继承前一次的 partial output**。
- **`CONTRACT_VIOLATION`**（缺少必需字段、无证据、越权写文件）：作废该Agent的全部输出，**派一个全新实例从原始任务描述重新执行**，attempt 从头计数，旧输出不得作为新实例的输入。
- **`PERMANENT_FAILURE`**（连续 3 次重试仍失败，或 harness 明确返回不可恢复错误）：该子任务标记为 `PERMANENT_FAILURE`，主Agent**不得缩小范围后重派**，而是将该失败写入 `unverified`，在最终报告中显式暴露为“未能覆盖”。
- **多失败窗口**：如果同一波次内 2 个以上Agent在 60 秒内同时失败，主Agent应暂停该波次的新派发，记录 `phase_level_failure`，等待人工介入或按 harness 的 fallback 策略处理，而不是继续扇出。

## 5. 冲突处理：主Agent只负责“把冲突送进仲裁”，不裁决

Saalis 的仲裁层设计提供了可借用的策略：当多个Agent产出冲突时，使用可配置的解决策略、策略执行、可解释性和审计日志，而不是让协调者隐式拍板[^ref10]。ADP（Agentic Dispute Protocol）把证据提交标准和仲裁者角色标准化[^ref11]。

`protocol.md` 中的冲突规则：

1. 主Agent检测到两个子Agent对**同一 `issue_id`** 给出互斥结论（一个判可触发，一个判不可触发）时，在 `conflicts` 中创建一条 `PENDING` 记录，**不自行选择任何一方**。
2. 主Agent派一个**新的 Arbiter 实例**（不携带先前波次的倾向），输入是双方的证据包和 `issue_id`，输出是 `UPHELD` / `DOWNGRADED` / `REVOKED` 三选一，并附理由。
3. 主Agent将裁决结果写回 `conflicts.resolution`，然后按裁决结果决定是否进入修复波。
4. **主Agent不得以“综合一下”或“取中间值”的方式消除冲突**；如果 Arbiter 返回 `ARBITRATING`（证据不足），主Agent应派发一个**证据补采Agent**，而不是自己判断。

## 6. 并发与总量护栏

搜索到的实践给出了具体数值：`Pool` 通过信号量限制最大并发数[^ref12]；重试预算分歧的失败案例显示，如果路由器自身的计数上限和任务终止状态不一致，会产生“任务已终止但第4个孤儿worker仍被派出”的问题。OpenPI 的设计文档也区分了**计划总量、扇出宽度和瞬时并发**三个不同的数字。

`protocol.md` 中写死：

- **单波瞬时并发上限**：从 `scale-mapping.md` 读取，**主Agent不得自行提高**。如果 harness 的并发上限更低，取下限。
- **单次运行总Agent数上限 = 60**（硬护栏）。`total_agent_count` 触达 60 时，主Agent停止派发新Agent，将当前账本状态和未闭合项写入最终报告，**不得压缩剩余波次的任务来“挤进”上限**。
- **计划量 ≠ 并发量**：`planned_agents` 可以大于 `concurrency_cap`，主Agent按 FIFO 排队派发，**不得因为排队时间长就合并切片或减少计划量**。

---

## 参考来源

[^ref0]: [Best Practices for Prompts in AI Agent Studio](https://blogs.oracle.com/fusioncoe/best-practices-for-prompts-in-ai-agent-studio#1)
[^ref2]: [Best Practices for Prompts in AI Agent Studio / name: supervisor-designer - name: supervisor-designer](https://blogs.oracle.com/fusioncoe/best-practices-for-prompts-in-ai-agent-studio#1)
[^ref3]: [Best Practices for Prompts in AI Agent Studio / name: supervisor-designer - name: supervisor-designer](https://blogs.oracle.com/fusioncoe/best-practices-for-prompts-in-ai-agent-studio#1)
[^ref5]: [graph — smallnest/goal-workflow](https://www.skills.sh/smallnest/goal-workflow/graph)
[^ref7]: [subagent - func (*Orchestrator) SpawnWithRetry ¶ added in v0.0.23](https://pkg.go.dev/github.com/dimetron/pi-go@v0.1.4/internal/subagent#Orchestrator#2)
[^ref10]: [Best Practices for Prompts in AI Agent Studio / name: supervisor-designer - name: supervisor-designer](https://blogs.oracle.com/fusioncoe/best-practices-for-prompts-in-ai-agent-studio#1)
[^ref11]: [Best Practices for Prompts in AI Agent Studio / name: supervisor-designer - name: supervisor-designer](https://blogs.oracle.com/fusioncoe/best-practices-for-prompts-in-ai-agent-studio#1)
[^ref12]: [subagent - func (*Orchestrator) SpawnWithRetry ¶ added in v0.0.23](https://pkg.go.dev/github.com/dimetron/pi-go@v0.1.4/internal/subagent#Orchestrator#2)
