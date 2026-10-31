---
file: components/output-contract.md
title: 统一返回契约
group_order: 2
loaded: 所有子Agent在返回任何结果前加载
source: https://chat.deepseek.com/share/yn99k1mum4qp5fqwj8 (第 8 轮)
---

# components/output-contract.md

## 文件头部：强制加载与优先级

> output-contract.md
> 所有子Agent在返回任何结果前加载。
> 主Agent只消费符合本契约的结构化输出；不符合的输出一律判定为 CONTRACT_VIOLATION。
> 本文件与 evidence-policy.md 的字段约定冲突时，以 evidence-policy.md 的证据结构为准；
> 本文件负责把 evidence-policy 的状态和结构纳入统一信封。
> 禁止任何“宽容解析”或“尽力修复后放行”——违反契约的输出必须在检查点被拒绝，不得进入下游。

---

## 第 1 节：统一返回信封（Envelope）

所有子Agent，无论角色，必须返回**同一顶层信封**。角色差异只体现在 `payload` 字段的内部结构上。这借鉴了 `agent-contracts` 的 `allOf` 组合模式：公共字段共享，角色特定内容通过 `payload` 承载[^ref4]。

#### 顶层字段（必填，缺一即 `CONTRACT_VIOLATION`）

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "string",
  "role": "recon | audit | critique | fix | verify",
  "status": "SUCCESS | RETRYABLE_FAILURE | CONTRACT_VIOLATION | PERMANENT_FAILURE",
  "contract_valid": true,
  "payload": { },
  "error": null
}
```

**字段语义**：

| 字段 | 类型 | 约束 |
|---|---|---|
| `schema_version` | string | 必须精确匹配 `"output-contract-v1"`。版本不匹配直接拒绝，不尝试向后兼容。 |
| `agent_id` | string | 全局唯一，由主Agent在派发时分配，子Agent原样回显。 |
| `role` | enum | 必须是五个角色之一。角色决定 `payload` 的 schema 分支。 |
| `status` | enum | 必须是四个顶层状态之一。**不允许自定义状态值**。 |
| `contract_valid` | boolean | 由子Agent在返回前自行对 `payload` 做一次 schema 校验后写入。如果子Agent无法保证合规，必须写 `false` 并在 `error` 中说明，而不是“尽力凑一个看起来合规的 payload”。 |
| `payload` | object | 按角色分支的 schema，见第 2 节。 |
| `error` | object\|null | 仅当 `status` 不是 `SUCCESS` 时必填，结构见第 3 节。 |

**状态枚举的收敛**：顶层 `status` 只保留四个值，与上一轮 `protocol.md` 的状态账本对齐。`Wazir` 的材料显示 A2A 协议使用七个任务状态（`submitted`、`working`、`input-required`、`completed`、`failed`、`canceled`、`rejected`），但那些覆盖了任务生命周期中的中间态[^ref5]。我们的子Agent是**一次性返回结果的执行单元**，不需要 `working` 或 `input-required`（这些由主Agent的账本管理），因此四个终态足以覆盖子Agent的返回语义。`evidence-policy` 中的 `GATE_0_FAILED`、`NO_EVIDENCE_FOUND`、`UNREADABLE` **不作为顶层状态**，而是作为 `payload.findings` 数组内的条目状态，见第 4 节。

**`PENDING` 与 `RUNNING` 的归属**：`protocol.md` 第 2 节的账本状态枚举有六个值（`PENDING | RUNNING | SUCCESS | RETRYABLE_FAILURE | CONTRACT_VIOLATION | PERMANENT_FAILURE`），比本契约多两个。这不是不一致，而是**两个枚举分属不同主体**：

| 枚举 | 主体 | 是否出现在子Agent返回中 |
|---|---|---|
| `PENDING` / `RUNNING` | **主Agent账本**的内部调度状态 | **否**。子Agent还没返回时不存在返回；返回了就已经是终态 |
| `SUCCESS` / `RETRYABLE_FAILURE` / `CONTRACT_VIOLATION` / `PERMANENT_FAILURE` | **子Agent返回**的顶层 `status` | 是，四选一 |

**机械判定规则**：主Agent在接收子Agent返回时，只接受四个终态；若子Agent返回 `PENDING` 或 `RUNNING`，视为 `CONTRACT_VIOLATION`（这是一次性执行单元，不存在"我先挂起一会儿"的语义）。反过来，账本中的 `PENDING` / `RUNNING` 只能由主Agent自己写入，**不得**从子Agent返回中读取。

---

## 第 2 节：Payload 的角色分支

`payload` 使用 `oneOf` 按 `role` 分支。每个分支有独立的必填字段，但共享“证据结构”的定义（引用 `evidence-policy.md` 的 `Evidence` / `Inference` 字段）。

#### 2.1 侦察角色（`role: "recon"`）

侦察Agent的产出直接喂给 `scale-mapping.md`，因此字段名必须与 `scale-mapping` 的输入契约精确对齐。

```json
{
  "payload": {
    "slice_count": 0,
    "audit_slices": [
      {
        "slice_id": "string",
        "files": ["path/to/file.ext"],
        "rationale": "string — 为什么这些文件构成一个独立切片"
      }
    ],
    "unverified": [
      { "target": "path", "reason": "string" }
    ],
    "entry_points": ["path:line"],
    "covered_modules": [],
    "harness_concurrency_cap": 4
  }
}
```

**硬约束**：`slice_count` 必须等于 `len(audit_slices)`。如果不一致，主Agent不做仲裁，直接 `CONTRACT_VIOLATION`。

#### 2.2 审计角色（`role: "audit"`）

```json
{
  "payload": {
    "slice_id": "string",
    "findings": [
      {
        "finding_id": "string",
        "dimension": "logic | concurrency | security | error-handling | data-consistency | contract",
        "severity": "CRITICAL | HIGH | MEDIUM | LOW",
        "evidence": {
          "file": "path/to/file.ext",
          "line": 0,
          "quote": "string — 本回合读取的原文，不得来自记忆"
        },
        "inference": {
          "claim": "string",
          "basis": "string",
          "alternatives": ["string"]
        },
        "status": "CONFIRMED | NO_EVIDENCE_FOUND | GATE_0_FAILED | UNREADABLE | EVIDENCE_GAP"
      }
    ]
  }
}
```

**`findings` 数组的最小长度**：如果审计Agent在切片中**没有发现任何有证据支撑的问题**，`findings` 仍然必须包含**至少一个条目**，其 `status` 为 `NO_EVIDENCE_FOUND`，并在 `evidence` 中写明 `searched_scope` 和 `searched_methods`。空数组一律视为 `CONTRACT_VIOLATION`，因为“没查”和“查了没发现”在契约上必须可区分。

**`GATE_0_FAILED` 的处理**：如果某条发现未通过 `evidence-policy` 的门 0，该条目的 `status` 写 `GATE_0_FAILED`，并且该条目**不进入下游锐评波**。审计Agent的顶层 `status` 仍然可以是 `SUCCESS`（它诚实地报告了“我尝试了但证据不足以声称一个问题”），但主Agent在账本中必须将该 `finding_id` 标记为 `INVALID_EVIDENCE`，不得进入修复。

#### 2.3 锐评角色（`role: "critique"`）

锐评Agent的 `payload` 按子角色分支：

```json
{
  "payload": {
    "critique_role": "skeptic | devils_advocate | arbiter",
    "target_finding_ids": ["string"],
    "verdicts": [
      {
        "finding_id": "string",
        "verdict": "UPHOLD | DOWNGRADE | REVOKE | EVIDENCE_GAP",
        "reason": "string — 必须引用具体证据或指出具体缺失",
        "missing_evidence": "string|null"
      }
    ],
    "coverage_gaps": [
      { "uncovered_module": "string", "reason": "string" }
    ]
  }
}
```

**Arbiter 的额外约束**：当 `critique_role` 为 `arbiter` 时，`verdicts` 中每一条的 `verdict` **不得**为 `EVIDENCE_GAP`。Arbiter 的职责是在双方证据的基础上做出终局裁决；如果证据不足以裁决，Arbiter 应当返回 `RETRYABLE_FAILURE` 并说明需要补采什么证据，而不是把 `EVIDENCE_GAP` 当作裁决结果推回给主Agent。

#### 2.4 修复角色（`role: "fix"`）

```json
{
  "payload": {
    "finding_id": "string",
    "files_touched": [
      { "path": "string", "change_summary": "string" }
    ],
    "verification_commands": [
      { "command": "string", "result": "passed | failed | not_run", "output_snippet": "string" }
    ],
    "affected_issues": ["finding_id"],
    "residual_risks": ["string"]
  }
}
```

**`affected_issues` 的语义**：修复Agent必须显式列出“这个修改**可能**影响到的其他已发现缺陷”，而不是只报告自己修的那一个。如果修复Agent无法判断影响范围，必须在 `residual_risks` 中写明“影响范围未验证”，并且主Agent据此在验收波中为该修复追加一个回归扫描。

#### 2.5 验收角色（`role: "verify"`）

```json
{
  "payload": {
    "finding_id": "string",
    "fix_agent_id": "string",
    "verdict": "PASS | FAIL",
    "escalation_required": false,
    "evidence": {
      "original_trigger_retested": true,
      "regression_scan_performed": true,
      "user_journey_aligned": true,
      "mutation_check": "performed | skipped"
    },
    "residual_risk_disposition": [
      {
        "flag": "LARGE_PATCH | PUBLIC_API_CHANGE | BASELINE_UNVERIFIED | TEST_CONFLICT | ROLLBACK_UNAVAILABLE | IMPACT_UNVERIFIED | OBSERVED_BUT_OUT_OF_SCOPE | AFFECTED_ISSUES_EMPTY_CONFIRMED",
        "action_taken": "string — 验收Agent实际执行的处置动作",
        "satisfied": true
      }
    ],
    "affected_issues_status": [
      {
        "finding_ref": "string",
        "status": "STILL_EXISTS | RESOLVED_BY_THIS_FIX | UNCHANGED | NOT_FOUND"
      }
    ],
    "new_issues_found": [
      {
        "evidence": {},
        "inference": {}
      }
    ],
    "failure_trigger": "string|null — 当 verdict 为 FAIL 时，必须给出可复现的触发条件",
    "failure_category": "FIX_INCOMPLETE | FIX_INCORRECT | BASELINE_INVALID | ENVIRONMENT | null",
    "notes": "string — 仅供追溯，不参与 verdict 判定"
  }
}
```

**字段语义**（本分支特有）：

| 字段 | 必填 | 说明 |
|---|---|---|
| `escalation_required` | 是 | `true` 表示本次验收存在必须由人裁决的未决事项。`verdict: PASS` + `escalation_required: true` 即"带保留通过"，**不得**写入已闭合集合 |
| `evidence.mutation_check` | 是 | `performed` 表示做过微变异检验（把修复改回原样确认检查失败）；`skipped` 时必须在 `notes` 说明原因 |
| `residual_risk_disposition` | 是（无标记时可为空数组） | 修复Agent声明的**每一个** `residual_risks` 标记都必须在此有对应条目。缺任一条目即 `CONTRACT_VIOLATION` |
| `affected_issues_status` | 是（无声明时可为空数组） | 每一条 `affected_issues` 的当前状态 |
| `failure_category` | `verdict: FAIL` 时必填 | 归因，决定回波次四还是标记 `REVOKED`；`ENVIRONMENT` 时应改用 `RETRYABLE_FAILURE` 顶层状态而非 `FAIL` |

**验收Agent的独立性硬约束**：`payload` 中**不得**包含对修复Agent说明的引用或复述。验收必须从原始用户旅程和缺陷的验收标准出发，而不是从"修复Agent说它修了什么"出发。如果验收Agent的 `evidence` 字段中出现"根据修复报告"之类的表述，主Agent判定为 `CONTRACT_VIOLATION`。

**本分支与 `templates/wave5-verify.md` 的关系**：该模板第 5 节引入的"第三态"（带保留通过）**不是**新增的 `verdict` 枚举值，而是由 `verdict: PASS` + `escalation_required: true` 两个已有字段表达。这保证了 `verdict` 的枚举仍然是闭集 `PASS | FAIL`，不破坏第 1 节"不允许自定义状态值"的规则。

---

## 第 3 节：错误对象（Error）

当 `status` 不是 `SUCCESS` 时，`error` 必填。结构参考 `Wazir` 的四字段错误报告格式（`error_type`、`message`、`context`、`suggestions`）。

```json
{
  "error": {
    "error_type": "InputValidationError | APIFailure | Timeout | SchemaViolation | EvidenceGateFailure | ToolError | Unknown",
    "message": "string — 人类可读，但不得替代结构化字段",
    "context": {
      "attempted_action": "string",
      "failed_at": "string — 文件路径/工具名/步骤",
      "harness_capability_missing": "string|null"
    },
    "suggestions": ["retry_same_task", "escalate_to_arbiter", "request_evidence_recollection"]
  }
}
```

**`error_type` 的严格枚举**：与顶层 `status` 一致，不允许自定义值。`SchemaViolation` 专门用于 `contract_valid = false` 的情况；`EvidenceGateFailure` 专门用于 `evidence-policy` 门 0 失败；`harness_capability_missing` 用于 harness 本身不支持某操作（例如无法读取文件），此时主Agent应当考虑是否所有同类Agent都会遇到同样问题，而不是简单重派。

---

## 第 4 节：契约验证——主Agent的机械检查清单

主Agent在接收到子Agent返回后，**必须**按以下顺序执行验证。任何一步失败，该Agent的 `status` 被覆盖为 `CONTRACT_VIOLATION`，**其全部输出作废**，不得作为下游输入。

| 检查序 | 检查项 | 通过条件 | 失败处理 |
|---|---|---|---|
| 1 | JSON 可解析 | 返回体是合法 JSON | 作废，重派全新实例 |
| 2 | 信封完整性 | 六个顶层字段全部存在且类型正确 | 作废，重派全新实例 |
| 3 | `schema_version` | 精确等于 `"output-contract-v1"` | 作废；如果连续 2 个实例版本错误，主Agent标记 `PERMANENT_FAILURE` 并写入 `unverified` |
| 4 | `role` 与派发模板一致 | 回显的 role 等于派发时指定的 role | 作废，重派全新实例 |
| 5 | `status` 枚举 | 属于四个合法值 | 作废，重派全新实例 |
| 6 | `contract_valid` 与 `status` 一致性 | 如果 `status = SUCCESS`，`contract_valid` 必须为 `true` | 作废，重派全新实例 |
| 7 | `payload` 按 `role` 分支校验 | 对应分支的必填字段全部存在，枚举值合法 | 作废，重派全新实例 |
| 8 | 证据结构 | `findings` / `verdicts` 中的每个条目包含 `evidence` 和 `inference`（或 critique 分支的 `reason`），且 `evidence` 非空 | 该条目标记 `GATE_0_FAILED`；如果整个 payload 没有任何合规条目，作废整个返回 |
| 9 | 侦察切片一致性 | `slice_count == len(audit_slices)` | 作废，重派全新侦察Agent |
| 10 | 修复/验收的独立性 | 验收 payload 中不出现对修复说明的引用；修复 payload 中 `affected_issues` 字段存在（即使是空数组） | 作废，重派全新实例 |

**“先检查、后处理”的硬纪律**：验证步骤必须在主Agent的账本写入**之前**执行。`Telemetry Blindness` 的教训是，如果先“宽容修复”再检查，违规会被静默吸收，计数器读数为零但下游已经拿到损坏数据[^ref7]。因此主Agent**不得**对返回体做任何“看起来差不多就放行”的修正（例如自动补全缺失字段、把字符串 `"success"` 映射为 `SUCCESS`、把 `null` 的 `payload` 替换为空对象）。所有这些都必须在第 8 步之前被拒绝。

---

## 第 5 节：状态转换规则（子Agent视角）

顶层 `status` 的四值之间**不允许任意转换**。子Agent在一次返回中只能报告一个终态。转换规则如下：

```
SUCCESS
  → 无后续转换。主Agent写入账本，进入下一波。

RETRYABLE_FAILURE
  → 主Agent派发同一模板的全新实例（attempt + 1）。
  → 新实例不得继承旧实例的任何 payload 或 partial output。
  → 最多重试 2 次；第 3 次仍失败 → 主Agent标记 PERMANENT_FAILURE。

CONTRACT_VIOLATION
  → 主Agent作废该实例全部输出。
  → 派发全新实例，attempt 从 0 重新计数。
  → 旧输出不得作为新实例的输入或上下文。

PERMANENT_FAILURE
  → 主Agent不得缩小范围后重派。
  → 将失败写入 unverified，最终报告中显式暴露“未能覆盖”。
```

**`SUCCESS` 不要求零发现**：`NO_EVIDENCE_FOUND` 是一个合法的 `SUCCESS` 结果，只要它包含了搜索范围和搜索方法的记录。主Agent不得因为 `findings` 中全是 `NO_EVIDENCE_FOUND` 就判定该Agent“没干活”。

---

## 第 6 节：与 `handoff-schema.md` 的边界

`output-contract` 只定义**单次返回**的结构，不定义波次之间的传递。以下内容**不属于**本文件，留给 `handoff-schema.md`：

- 波次闭合后主Agent写入账本的 `resume packet` 结构；
- 已闭合波次、未闭合项、冲突列表的跨波次表示；
- 轮次号 `RN` 和已覆盖模块标记的持久化格式。

本文件与 `handoff-schema` 的交接点是：`output-contract` 保证每个子Agent的返回可被主Agent机械验证；`handoff-schema` 保证验证后的结果可以被安全地传递给下一波，而不需要主Agent重新阅读任何散文。

---

---

## 参考来源

[^ref4]: [agent-contracts - producers: [main-architect]](https://www.npmjs.com/package/agent-contracts/v/0.12.2?activeTab=versions#2)
[^ref5]: [Life of a Task](https://agent2agent.info/docs/topics/life-of-a-task/)
[^ref7]: [Telemetry Blindness at the Agent-Business Boundary: A Controlled Measurement of Output-Contract Enforcement](https://zenodo.org/records/21842518/files/Authored_Plan_Agents.pdf?download=1#1#3#1)
