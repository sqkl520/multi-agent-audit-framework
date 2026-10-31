---
file: components/handoff-schema.md
title: 波次间 Resume Packet 结构
group_order: 3
loaded: 主Agent在每个波次闭合时加载，用于构造 Resume Packet
source: https://chat.deepseek.com/share/yn99k1mum4qp5fqwj8 (第 9 轮)
---

# components/handoff-schema.md
`components/handoff-schema.md` 是主Agent在波次之间传递状态的**唯一序列化格式**。它的设计原则可以概括为一条硬规则：**Resume Packet 携带指针、摘要和裁决，不携带任何子Agent的原始正文**。搜索到的材料反复验证了这一点——`Delivery Packet` 明确指出交付包“携带指针、摘要和裁决，而不是专家内容本身”，当字段与专家产物可能说同一件事时，包内只放路径加一行摘要，详细内容留在产物里[^ref0]。`Handoffs and Coordination Contracts` 同样强调“传递结论，不传递记录”，因为接收方需要的是“做了什么、发现了什么、需要注意什么、什么未解决”，而不是原始探索日志[^ref1]。

同时，`multi-agent-patterns` 给出了一个必须吸收的工程约束：**把每一次交接当作版本化 API 来处理，带 JSON Schema 校验和 trace_id 跨Agent传播**，因为“大多数Agent失败发生在交接处，而不是单个Agent内部”。`statebus` 的实践进一步证明了版本历史和可重放性对多Agent工作流的价值：每次写入都带 schema 版本，handoff 可回放，读者永远知道手里拿的是哪个形状的数据[^ref3]。


## 文件头部：强制加载与定位

> handoff-schema.md
> 主Agent在每个波次闭合时加载，用于构造 Resume Packet。
> 本文件定义的是“波次之间的传递格式”，不是子Agent的返回格式。
> 子Agent的返回格式由 output-contract.md 定义；本文件只消费已验证的 output-contract 结果。
> 硬规则：Resume Packet 不得包含任何子Agent的原始正文或完整 findings 数组。
> 只允许包含：指针（artifact_path）、摘要（summary）、裁决（verdict）、以及未闭合项的结构化表示。
> 违反此规则的 Resume Packet 视为 CONTRACT_VIOLATION，不得进入下一波。

## 第 1 节：Resume Packet 的顶层结构

Resume Packet 是一个**不可变快照**，在每个波次闭合时由主Agent生成，写入账本。下一波的主Agent调度只读取这个包，不回头读上一波的子Agent产出正文。

搜索到的 `Orchestrator Handoff JSON Schema` 给出了一个值得直接借用的约束：handoff 文件按 `handoffs/phase-N-handoff-TIMESTAMP.md` 命名，`summary` 字段有约 100 token 的预算，强制做“2–4 句话的浓缩”。这个 token 预算的设计意图不是限制，而是**防止 Resume Packet 退化成第二份报告**。

```json
{
  "schema_version": "handoff-schema-v1",
  "round_id": "RN",
  "wave_id": "wave-1 | wave-2 | wave-3 | wave-4 | wave-5",
  "wave_status": "CLOSED | PARTIALLY_CLOSED | FAILED",
  "trace_id": "string — 全轮次唯一，跨所有波次和子Agent传播",
  "generated_at": "ISO8601",
  "closed_waves": [ ],
  "open_items": [ ],
  "conflicts": [ ],
  "covered_modules": [ ],
  "scale_decision": { },
  "deferred_items": [ ],
  "packet_digest": "sha256:..."
}
```

**顶层字段语义**：

| 字段 | 类型 | 用途 | 缺失时行为 |
|---|---|---|---|
| `schema_version` | string | 精确等于 `"handoff-schema-v1"`。版本不匹配时，主Agent不得尝试兼容，必须标记 `PERMANENT_FAILURE` 并写入 `unverified` | 拒绝整个包 |
| `round_id` | string | 由轮次探测Agent返回的 `RN`，例如 `"round30"` | 拒绝整个包 |
| `wave_id` | string | 当前波次标识，固定枚举 | 拒绝整个包 |
| `wave_status` | enum | `CLOSED` 表示该波所有子Agent达到终态且门控通过；`PARTIALLY_CLOSED` 表示部分切片 `DEFERRED` 或 `PERMANENT_FAILURE`；`FAILED` 表示波次级失败 | 拒绝整个包 |
| `trace_id` | string | 全轮次唯一，必须由主Agent在波次一启动时生成并**原样注入每个子Agent的派发参数**，子Agent在返回中回显 | 拒绝整个包；如果某子Agent返回的 `trace_id` 与派发时不一致，该子Agent的返回作废 |
| `generated_at` | ISO8601 | 包生成时间 | 允许缺失，主Agent补当前时间 |
| `packet_digest` | string | 包内容的 SHA256，用于完整性校验和去重；下一波主Agent在加载前验证 digest，不一致则拒绝 | 允许缺失；如果存在但不匹配，拒绝整个包 |

**`trace_id` 的传播规则**（直接来自 `multi-agent-patterns` 的 handoff 标准）：`trace_id` 在派发子Agent时写入 `task_payload`，子Agent在 `output-contract` 的 `agent_id` 之外**额外回显 `trace_id`**。主Agent在验证子Agent返回时，`trace_id` 不匹配即判定 `CONTRACT_VIOLATION`。这确保 Resume Packet 里的每一条记录都可以追溯到具体的子Agent实例。


## 第 2 节：`closed_waves`——已闭合波次的摘要

`closed_waves` 是一个数组，每个元素对应一个已经闭合的波次。它**不复制**该波次的完整结果，只记录“这个波次做了什么、产出了哪些文件、门控是否通过”。

```json
{
  "closed_waves": [
    {
      "wave_id": "wave-1",
      "closed_at": "ISO8601",
      "agent_count": 3,
      "artifact_paths": [
        "docs/reports/round30-01-recon-slices.md"
      ],
      "summary": "3个侦察Agent返回了17个切片，slice_count=17，unverified=2，entry_points=4。",
      "gate_result": "PASS | PASS_WITH_DEFERRED | FAIL",
      "deferred_count": 0
    }
  ]
}
```

**`summary` 的硬约束**：不超过 2–4 句话，且**只允许陈述结构化事实**（数量、状态、路径），不允许嵌入任何代码引用、缺陷描述或推断性语言。这借鉴了 `Orchestrator Handoff JSON Schema` 的 `summary` token 预算设计：约 100 token，强制浓缩。

**`artifact_paths` 的语义**：指向该波次子Agent产出的原始文件（`docs/reports/round{RN}-...md`）。Resume Packet 不包含这些文件的内容，只包含路径。下一波如果需要引用某个具体发现，它读的是 `artifact_paths` 指向的文件，而不是 Resume Packet 里的摘要。这是 `Delivery Packet` “指针而非重复”原则的直接应用[^ref7]。


## 第 3 节：`open_items`——未闭合项的结构化表示

`open_items` 是 Resume Packet 中**唯一允许携带“待处理内容”的字段**，但它仍然只携带**结构化引用**，不携带完整证据。

搜索到的 `Handoffs and Coordination Contracts` 明确区分了“需要注意的项”和“未解决的项”：前者是下一波必须处理的工作，后者是阻塞性未知[^ref8]。`handoff_create` 也把 `unresolvedQuestions` 列为必需字段，并强调 durable record 必须保留每一个字段[^ref9]。

```json
{
  "open_items": [
    {
      "item_id": "string",
      "kind": "UNRESOLVED_FINDING | EVIDENCE_GAP | DEFERRED_SLICE | PERMANENT_FAILURE | UNVERIFIED_TARGET | COVERAGE_GAP | AFFECTED_BY_FIX | REGRESSION_SCAN_REQUIRED | HUMAN_DECISION_REQUIRED | REVOKED",
      "source_wave": "wave-1 | wave-2 | wave-3 | wave-4 | wave-5",
      "source_agent_id": "audit-slice-07",
      "artifact_ref": "docs/reports/round30-02-audit-slice-07.md",
      "finding_ref": "finding-017",
      "blocking": true,
      "next_action": "ASSIGN_TO_ARBITER | REASSIGN_TO_NEW_AUDIT | MARK_UNVERIFIED | REQUIRE_EVIDENCE_RECOLLECTION | REASSIGN_TO_FIX | REASSIGN_TO_VERIFY | REQUIRE_HUMAN_DECISION | MARK_REVOKED | SCHEDULE_REGRESSION_SCAN | NONE",
      "summary": "一句话描述该未闭合项的性质，不含推断"
    }
  ]
}
```

**`kind` 的枚举语义**：

| `kind` | 产生波次 | 含义 | 下一波动作 |
|---|---|---|---|
| `UNRESOLVED_FINDING` | wave-2 / wave-5 | 有证据的发现，尚未经过锐评波裁决；或验收波发现的、本轮不追的新问题 | 进入锐评波，由 Skeptic/Arbiter 处理 |
| `EVIDENCE_GAP` | wave-3 / wave-5 | 某条发现缺少关键证据 | 派发证据补采Agent，**不是**由主Agent判断“够不够” |
| `DEFERRED_SLICE` | wave-1 / wave-2 | 因 `admission_ceiling` 触达而未派发的切片 | 在下一轮或人工介入后处理；最终报告必须标注“覆盖不完整” |
| `PERMANENT_FAILURE` | 任意波次 | 子Agent连续重试仍失败 | 写入 `unverified`，最终报告显式暴露“未能覆盖” |
| `UNVERIFIED_TARGET` | wave-1 | 侦察Agent标记为 `unverified` 的路径/模块 | 作为追加切片进入下一轮发现波，或在最终报告中标注 |
| `COVERAGE_GAP` | wave-3 | Devil's Advocate 指出的覆盖缺口（切片未被审计、文件未被读取、维度被省略、入口未映射） | 由主Agent决定是否在后续轮次补派审计；**不由 Devil's Advocate 自行补审** |
| `AFFECTED_BY_FIX` | wave-4 | 修复Agent声明“可能受本次修改影响”的其他已发现缺陷 | 转验收波复核，`next_action: REASSIGN_TO_VERIFY` |
| `REGRESSION_SCAN_REQUIRED` | wave-4 | 修复声明了 `LARGE_PATCH` / `PUBLIC_API_CHANGE` / `IMPACT_UNVERIFIED`，必须追加回归扫描 | 验收波必须包含回归扫描，否则不得闭合 |
| `HUMAN_DECISION_REQUIRED` | wave-4 / wave-5 | 存在必须由人裁决的事项（`TEST_CONFLICT`、`ROLLBACK_UNAVAILABLE` 且验收失败、基线无法确认等） | **不自动放行**，阻止本轮整体闭合，等待人工 |
| `REVOKED` | wave-3 / wave-5 | 经裁决或复验确认原发现不成立（误报、不可触发、越界推断） | 不进入修复波；保留记录供审计追溯 |

**`next_action` 的枚举语义**：

| `next_action` | 含义 | 与 `kind` 的对应 |
|---|---|---|
| `ASSIGN_TO_ARBITER` | 派 Arbiter 裁决 | `UNRESOLVED_FINDING`（来自 wave-2） |
| `REASSIGN_TO_NEW_AUDIT` | 派新的审计实例重查 | `COVERAGE_GAP` |
| `REQUIRE_EVIDENCE_RECOLLECTION` | 派证据补采实例 | `EVIDENCE_GAP` |
| `REASSIGN_TO_FIX` | 回波次四重新修复 | `UNRESOLVED_FINDING`（验收失败且归因为 `FIX_INCOMPLETE` / `FIX_INCORRECT`） |
| `REASSIGN_TO_VERIFY` | 转验收波复核 | `AFFECTED_BY_FIX` |
| `SCHEDULE_REGRESSION_SCAN` | 验收波必须追加回归扫描 | `REGRESSION_SCAN_REQUIRED` |
| `REQUIRE_HUMAN_DECISION` | 阻塞，等待人工裁决 | `HUMAN_DECISION_REQUIRED` |
| `MARK_REVOKED` | 标记该发现作废 | `REVOKED` |
| `MARK_UNVERIFIED` | 标记未能覆盖 | `PERMANENT_FAILURE` / `UNVERIFIED_TARGET` |
| `NONE` | 无后续动作（`blocking: false` 的透传项） | 任意非阻塞 kind |

**枚举扩展的纪律**：`kind` 与 `next_action` 必须是**闭集**。任何波次模板需要使用新的 `kind` 时，**必须先在本文档中登记**，否则该 `open_item` 视为 `CONTRACT_VIOLATION`。这是防止各模板各自发明字段导致 Resume Packet 无法被主Agent机械解析的唯一手段。

**`blocking` 的语义**：`true` 表示该项**阻止下一波闭合**。主Agent在门控判定时，只检查 `blocking: true` 的 `open_items` 是否已被处理或显式转为 `DEFERRED`。`blocking: false` 的项可以随包传递，但不阻止波次推进。


## 第 4 节：`conflicts`——冲突列表与裁决状态

`conflicts` 是 Resume Packet 中最容易膨胀的部分。搜索到的材料给出了两个关键约束：`Handoffs and Coordination Contracts` 强调“结构化 JSON 优于散文笔记”，因为字段提取是确定性的，不依赖接收方解析自由文本[^ref10]；`statebus` 的 `ConflictError` 模式表明，冲突应当被**显式捕获并携带当前版本和冲突方**，而不是静默覆盖[^ref11]。

```json
{
  "conflicts": [
    {
      "conflict_id": "string",
      "finding_ref": "finding-017",
      "parties": [
        {
          "agent_id": "audit-slice-07",
          "position": "TRIGGERABLE",
          "artifact_ref": "docs/reports/round30-02-audit-slice-07.md#finding-017"
        },
        {
          "agent_id": "critique-skeptic-01",
          "position": "NOT_TRIGGERABLE",
          "artifact_ref": "docs/reports/round30-03-skeptic-01.md#finding-017"
        }
      ],
      "resolution": "PENDING | ARBITRATING | UPHELD | DOWNGRADED | REVOKED",
      "arbiter_agent_id": "string|null",
      "arbiter_artifact_ref": "string|null",
      "resolution_reason": "string|null"
    }
  ]
}
```

**硬约束**：

- `resolution` 为 `PENDING` 或 `ARBITRATING` 的冲突，**不得**让下一波开始修复。主Agent在门控中必须检查：如果存在 `resolution` 为 `PENDING` 的冲突，且该冲突对应的 `open_item.blocking = true`，则波次不得闭合。
- `parties` 中每一条必须携带 `artifact_ref`，指向该方立场的**证据出处**。Resume Packet 本身不复制证据正文。
- 当 `resolution` 为 `UPHELD` / `DOWNGRADED` / `REVOKED` 时，`arbiter_artifact_ref` 必填，指向仲裁Agent的产出文件。主Agent**不得**自己填写 `resolution`；这个字段只能由 Arbiter 的 `output-contract` 返回结果填充。

**为什么冲突不内联**：如果把双方的完整论据塞进 Resume Packet，包会迅速膨胀到不可维护，且主Agent会倾向于“读一下双方说了什么然后自己判断”——这直接违反“主Agent不亲自下场”的禁令。指针化设计强制冲突只能通过 Arbiter 的独立Agent实例来裁决。


## 第 5 节：`covered_modules`——已覆盖模块标记

这个字段服务于 `scale-mapping.md` 的历史轮次折减逻辑。它记录的是**哪些模块已经被本轮或历史轮次深度审计且结论为 `SUCCESS`**，而不是“哪些模块被提到过”。

```json
{
  "covered_modules": [
    {
      "module_id": "src/dispatch",
      "paths": ["src/dispatch/pipeline.ts", "src/dispatch/worker-pool.ts"],
      "round_id": "round29",
      "audit_verdict": "SUCCESS | PARTIAL | FAILED",
      "finding_count": 3,
      "upheld_count": 2,
      "last_verified_at": "ISO8601"
    }
  ]
}
```

**语义约束**：

- `audit_verdict` 必须来自该模块上一轮审计波次的**门控结果**，不是主Agent的推断。如果上一轮该模块有 `PERMANENT_FAILURE` 或 `DEFERRED_SLICE`，`audit_verdict` 不得为 `SUCCESS`。
- `finding_count` 和 `upheld_count` 用于 `scale-mapping` 的折减判断：如果 `upheld_count = 0` 且 `audit_verdict = SUCCESS`，该模块才**有资格**被标记为 `eligible_for_skip`。`scale-mapping` 的 30% 折减上限仍然生效。
- 如果 `covered_modules` 为空数组，`scale-mapping` 的折减步骤**完全跳过**。主Agent不得自行推测“这个模块以前可能审过了”。


## 第 6 节：`scale_decision`——规模决策的持久化

`scale-mapping.md` 的输出写入账本的 `scale_decision` 字段，Resume Packet 必须携带这个字段的**只读副本**，以确保下一波的主Agent不会在运行中热改规模决策。

```json
{
  "scale_decision": {
    "effective_slices": 17,
    "planned_discovery_agents": 17,
    "concurrency_window": 8,
    "admission_ceiling": 60,
    "critique_roles": ["Skeptic", "Devil's Advocate", "Arbiter"],
    "critique_extra": "cross-pattern-scan",
    "skipped_slices": [],
    "deferred_slices": [],
    "decision_digest": "sha256:..."
  }
}
```

**硬规则**：Resume Packet 中的 `scale_decision` 是**只读快照**。下一波的主Agent不得修改任何字段。如果运行中发现 `effective_slices` 的初始计算有误，唯一合法的修复方式是**派一个全新的侦察Agent重新执行切片**，生成一个新的 `scale_decision` 并写入新的 Resume Packet，而不是在旧包上热改。


## 第 7 节：`deferred_items`——显式延迟项

`deferred_items` 与 `open_items` 中的 `DEFERRED_SLICE` 有重叠，但 `deferred_items` 是**波次级**的独立列表，用于最终报告的“未覆盖”部分。它的存在是为了让主Agent在生成最终报告时，不需要回头扫描所有 `open_items` 来提取延迟项。

```json
{
  "deferred_items": [
    {
      "item_id": "string",
      "kind": "SLICE | FINDING | VERIFICATION",
      "reason": "ADMISSION_CEILING | HARNESS_CAP | PERMANENT_FAILURE | CONTRACT_VIOLATION_UNRESOLVED",
      "artifact_ref": "string|null",
      "requires_human_intervention": true
    }
  ]
}
```

**最终报告的硬连接**：如果 `deferred_items` 非空，主Agent在最终报告中**必须**包含一个“未覆盖项”章节，逐条列出 `deferred_items`，并标注 `requires_human_intervention`。如果 `deferred_items` 的数量超过 `effective_slices` 的 50%，最终报告必须显式标注“本轮覆盖不完整”。


## 第 8 节：波次之间的使用规则

Resume Packet 在每个波次闭合时生成，**不跨波次修改**。每一波生成一个新的 Resume Packet，携带上一波的 `closed_waves` 和新闭合的波次。

| 波次转换 | 读取的 Resume Packet 字段 | 禁止行为 |
|---|---|---|
| wave-1 → wave-2 | `scale_decision`、`open_items`（`UNVERIFIED_TARGET`）、`covered_modules` | 主Agent不得重新计算 `effective_slices` |
| wave-2 → wave-3 | `open_items`（`UNRESOLVED_FINDING`、`EVIDENCE_GAP`）、`conflicts` | 主Agent不得自行裁决冲突；`conflicts.resolution` 只能由 Arbiter 填充 |
| wave-3 → wave-4 | `conflicts`（`UPHELD`）、`open_items`（`EVIDENCE_GAP` 已补采） | 只对 `UPHELD` 的发现派发修复Agent；不得派发 `DOWNGRADED` 或 `REVOKED` 的 |
| wave-4 → wave-5 | `closed_waves`（wave-4 的 `affected_issues`）、`open_items`（修复未验证的） | 验收Agent不得读取修复Agent的说明正文；只从 `artifact_ref` 和原始验收标准出发 |
| wave-5 → 最终报告 | `deferred_items`、`open_items`（`PERMANENT_FAILURE`）、`covered_modules` | 最终报告只拼接路径和摘要，不重写任何子Agent结论 |


## 第 9 节：完整性校验与重放

借鉴 `statebus` 的版本历史和回放能力[^ref12]，Resume Packet 必须支持**只读重放**：主Agent可以在任何时刻通过 `packet_digest` 和 `artifact_paths` 重建“当时这一波看到了什么”。

**校验步骤**（主Agent在加载 Resume Packet 时执行）：

1. `schema_version` 匹配；
2. `packet_digest` 与包内容重新计算的 SHA256 一致；
3. `trace_id` 与当前轮次的 `trace_id` 一致；
4. `closed_waves` 中每个 `artifact_paths` 指向的文件存在（如果不存在，标记 `ARTIFACT_MISSING`，但**不阻塞**波次推进——缺失的产物在最终报告中显式暴露）；
5. `conflicts` 中 `resolution` 为 `UPHELD` 的条目，`arbiter_artifact_ref` 存在且可读。

**校验失败的处理**：`schema_version` 或 `packet_digest` 失败 → 拒绝整个包，主Agent标记 `PERMANENT_FAILURE`，写入 `unverified`。`artifact_paths` 缺失 → 记录 `ARTIFACT_MISSING`，继续推进，但在最终报告中标注。`arbiter_artifact_ref` 缺失 → 将对应冲突的 `resolution` 回退为 `PENDING`，派发新的 Arbiter 实例，**不得**让修复波基于未验证的裁决继续。


## 第 10 节：与 `output-contract.md` 的边界

`handoff-schema` 和 `output-contract` 的分工必须严格保持：

| | `output-contract.md` | `handoff-schema.md` |
|---|---|---|
| 作用对象 | **单个子Agent的返回** | **波次之间的状态传递** |
| 生命周期 | 一次请求-响应 | 跨波次持久化 |
| 内容粒度 | 完整 `payload`，含 `findings` 数组和证据 | 指针、摘要、裁决、未闭合项的结构化引用 |
| 验证者 | 主Agent在接收时逐条校验 | 主Agent在波次闭合时生成，下一波加载时校验 |
| 是否含原始证据 | 是 | **否**（只含 `artifact_ref`） |

Resume Packet 中的每一条 `artifact_ref` 指向的文件，其内容必须已经通过 `output-contract` 的验证。主Agent在生成 Resume Packet 时，**不重新阅读**这些文件，只使用 `output-contract` 验证时已经提取的结构化字段（`status`、`finding_id`、`severity`、`verdict` 等）来填充摘要和 `open_items`。

---

## 参考来源

[^ref0]: [Delivery Packet](https://raw.githubusercontent.com/magnus919/agent-skills/refs/heads/main/neckbeard/references/delivery-packet.md#1)
[^ref1]: [Handoffs and Coordination Contracts](https://learn.agentpatterns.ai/multi-agent/handoffs-and-contracts/)
[^ref3]: [statebus](https://pypi.org/project/statebus/)
[^ref7]: [Delivery Packet](https://raw.githubusercontent.com/magnus919/agent-skills/refs/heads/main/neckbeard/references/delivery-packet.md#1)
[^ref8]: [Handoffs and Coordination Contracts](https://learn.agentpatterns.ai/multi-agent/handoffs-and-contracts/)
[^ref9]: [aqm · PyPI - handoffs | list | [] | Routing rules — see Handoff format below / agent - type HandoffKind string](https://pypi.org/project/aqm/1.3.1/#2)
[^ref10]: [Handoffs and Coordination Contracts](https://learn.agentpatterns.ai/multi-agent/handoffs-and-contracts/)
[^ref11]: [statebus](https://pypi.org/project/statebus/)
[^ref12]: [statebus](https://pypi.org/project/statebus/)
