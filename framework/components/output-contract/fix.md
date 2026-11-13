<!--
  自动生成，请勿手改。母文件：framework/components/output-contract.md
  重跑：node tools/gen-contract-slices.mjs
  本文件 = 母文件的通用节 + fix 角色那一节，其它角色的分支已裁掉。
-->

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

## 第 0 节：产物的物理形态（所有角色适用，2026-11-09 新增）

**你的产物文件必须以一个 json 代码块结尾，里面是本契约定义的信封。**

```
<产物文件>
├── Markdown 正文（随便写：分析、grep 输出、判断依据、表格）
└── 最后一个代码块：完整的 JSON 信封
    { "schema_version": "output-contract-v1", ... }
```

**这不是「示例」，是格式要求。** 正文写多少都行，但**最后一个代码块必须是完整、可解析的 JSON 信封**。

### 0.1 为什么要专门写这一节

**2026-11-09 实测：15 个真实产物，0 个含 JSON 信封（100% 不合规）。**

根因不是子 Agent 不听话，是**本契约和各模板此前只在示例里出现过一次 JSON 块，从没有一句「必须写」**。

价格是可测的：

| 代价 | 数字 |
|---|---|
| `verify-artifacts.mjs` 总长 | 717 行 |
| 其中 `salvageFromMarkdown()` 专门做降级猜测 | **73 行** |
| 加上 `matchQuality` / `stripGrepPrefix` 等宽容匹配 | 约 100 行 |

**我们写了约 100 行代码，去补偿自己没约束住的输出格式。**

> 这是 2026-11-09 对比 `dsh-superagent` 后确定的教训。它用 `z.object().strict().refine()`
> 让「字段缺失」变成**工具调用失败**——错误在产生的那一刻被挡住。
> 而我们是**事后猜**。同一件事，前者是护栏，后者是补丁。

### 0.2 发送前自检（强制）

```bash
node <FRAMEWORK_ROOT>/tools/check-payload.mjs <你的产物文件> --role <你的角色>
```

| 退出码 | 含义 | 动作 |
|---|---|---|
| `0` | 契约合规 | 可以返回 |
| `1` | 违规 | **不得返回**，按输出给的修法补齐后重跑 |
| `2` | 用法错误 | 检查参数 |

**主 Agent 在收到任何子 Agent 返回后，也必须跑一次。** 不合规当场判 `CONTRACT_VIOLATION`，不要让格式问题流到下游再靠 `salvage` 猜。

---

## 第 1 节：统一返回信封（Envelope）

所有子Agent，无论角色，必须返回**同一顶层信封**。角色差异只体现在 `payload` 字段的内部结构上。这借鉴了 `agent-contracts` 的 `allOf` 组合模式：公共字段共享，角色特定内容通过 `payload` 承载[^ref4]。

#### 顶层字段（必填，缺一即 `CONTRACT_VIOLATION`）

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "string",
  "role": "recon | sweep | audit | critique | fix | verify",
  "status": "SUCCESS | RETRYABLE_FAILURE | CONTRACT_VIOLATION | PERMANENT_FAILURE",
  "contract_valid": true,
  "artifact_path": "string",
  "payload": { },
  "error": null
}
```

**`artifact_path` 是必填顶层字段**（2026-11-03 新增）：指向本 Agent 写出的产物文件的**仓库外绝对路径或 `<OUTDIR>` 相对路径**（命名规则见 `artifacts/report-naming.md`，落盘位置约束见 `protocol.md` 第 0.2 节）。

| 情形 | 判定 |
|---|---|
| `status == SUCCESS` 但 `artifact_path` 为 `null`、空串，或指向的文件不存在 | **`CONTRACT_VIOLATION`**，`violated_fields: ["artifact_path"]` |
| `status != SUCCESS` 时 `artifact_path` 可为 `null` | 合法（失败时可能没有产物） |

> **为什么它必须进契约而不是留在模板里**：`report-naming.md` 第 5 节要求「每个子Agent只允许写入属于自己的产物文件」，但**没有任何角色被授予 `Write`**，且这份文件的加载时机写的是「子 Agent 在写出产物文件**前**加载」——一个还没被授权写产物的 Agent，不会被触发去加载「怎么写产物」的规则。**这是一个自指的空转**：规则假设产物已经存在，产物的存在又依赖规则先被加载。
>
> round31 的实测结果正是这个空转的产物：`83` 条待修复发现、`1` 条实际修复、`IN_PROGRESS`、**无最终报告**。此前把它归因为「修复波太脆弱」，但它还有一条独立的失效路径——**上游产物从未真正落盘**，主Agent 手里的 `artifact_ref` 全是悬空路径，拼不出报告。
>
> 现在这道校验是机械的：`artifact_path` 指向的文件不存在 = 违规，无论 Agent 的 payload 多么完整。**「格式完美但结论为空」不再能通过门控。**

**字段语义**：

| 字段 | 类型 | 约束 |
|---|---|---|
| `schema_version` | string | 必须精确匹配 `"output-contract-v1"`。版本不匹配直接拒绝，不尝试向后兼容。 |
| `agent_id` | string | 全局唯一，由主Agent在派发时分配，子Agent原样回显。 |
| `role` | enum | 必须是**六个**角色之一（`recon` / `sweep` / `audit` / `critique` / `fix` / `verify`）。角色决定 `payload` 的 schema 分支。 |
| `status` | enum | 必须是四个顶层状态之一。**不允许自定义状态值**。 |
| `contract_valid` | boolean | 由子Agent在返回前自行对 `payload` 做一次 schema 校验后写入。如果子Agent无法保证合规，必须写 `false` 并在 `error` 中说明，而不是“尽力凑一个看起来合规的 payload”。 |
| `artifact_path` | string\|null | 产物文件路径。`SUCCESS` 时必填且文件必须存在；非 `SUCCESS` 时可为 `null`。见下方「`artifact_path` 是必填顶层字段」。 |
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
    "violated_fields": ["string — JSON Pointer 或字段路径"],
    "suggestions": ["retry_same_task", "escalate_to_arbiter", "request_evidence_recollection"]
  }
}
```

**`violated_fields` 的定义**（2026-11-03 新增，此前 `protocol.md` 第 4.1 节引用它但本节未定义——又是一次「规则引用契约里不存在的东西」）：

| 属性 | 规定 |
|---|---|
| 何时必填 | `error_type == "SchemaViolation"` 时**必填**（至少一项）；其他 `error_type` 可为空数组 |
| 内容 | 违反契约的字段路径，用 **JSON Pointer 风格**，不用自然语言 |
| 粒度 | 精确到**最深的失败字段**，不要写到顶层就停 |
| 排序 | 按字典序，**去重**——同一批字段每次必须产生完全相同的数组 |

**正确与错误的写法**：

```
✅ 精确到字段，可机械比较
   "violated_fields": ["/payload/findings/0/evidence/quote"]

❌ 太粗：无法判断两次违规是否同一原因
   "violated_fields": ["/payload"]

❌ 自然语言：无法机械比较
   "violated_fields": ["审计Agent没有引用原文"]
```

**为什么这一项的规范性重要**：`protocol.md` 第 4.1 节用它判断「连续两次违规是否同一原因」——若两次的数组写法不一致（一次写 `/payload`，一次写 `/payload/findings`），比较会失败，死锁判定失效，流程退回无限重派。**这个字段的全部价值在于可比性，而可比性来自格式规范。** 字典序 + 去重 + 最深粒度三条合起来才保证「同一原因必得同一数组」。

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
  → 派发全新实例，attempt + 1（**不归零**，见 protocol.md §4.1）。
  → violation 计数按 (task_payload_digest) 累计；连续 2 次 violated_fields 相同 → 直接 PERMANENT_FAILURE。
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
