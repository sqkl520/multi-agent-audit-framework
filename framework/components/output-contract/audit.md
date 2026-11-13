<!--
  自动生成，请勿手改。母文件：framework/components/output-contract.md
  重跑：node tools/gen-contract-slices.mjs
  本文件 = 母文件的通用节 + audit 角色那一节，其它角色的分支已裁掉。
-->

---
file: components/output-contract/audit.md
title: 统一返回契约
group_order: 2
loaded: 所有子Agent在返回任何结果前加载
source: https://chat.deepseek.com/share/yn99k1mum4qp5fqwj8 (第 8 轮)
---

# components/output-contract/audit.md

## 文件头部：强制加载与优先级

> audit.md（output-contract 的 audit 角色切片）
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
  "role": "planner | recon | sweep | audit | critique | fix | verify",
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

## 第 2 节：Payload 的角色分支

`payload` 使用 `oneOf` 按 `role` 分支。每个分支有独立的必填字段，但共享“证据结构”的定义（引用 `evidence-policy.md` 的 `Evidence` / `Inference` 字段）。

#### 2.2 审计角色（`role: "audit"`）

```json
{
  "payload": {
    "slice_id": "string",
    "searched_scope": {
      "files_read": ["path/to/file.ext"],
      "files_in_slice": 7,
      "shared_dependencies_read": ["path/to/shared.ext"], "files_scanned_without_findings": ["clean.ext"],
      "dimension_checklist": ["条件分支", "循环边界"]
    },
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
        "status": "CONFIRMED | NO_EVIDENCE_FOUND | GATE_0_FAILED | UNREADABLE | EVIDENCE_GAP",
        "runtime_evidence": { "method": "string", "command": "string", "observed": "string", "reproducible": true }
      }
    ],
    "self_checks": {
      "identifier_reconcile": {
        "status": "DONE | SKIPPED | NOT_APPLICABLE",
        "note": "string — SKIPPED / NOT_APPLICABLE 时必填，至少 10 字"
      },
      "self_check_audit": { "status": "DONE | SKIPPED | NOT_APPLICABLE", "note": "string" },
      "runtime_validation": { "status": "DONE | SKIPPED | NOT_APPLICABLE", "note": "string" }
    }
  }
}
```

**`self_checks` 为什么是必填**：`templates/wave2-audit.md` §6 把「标识符对账」「自带自检抽验」「运行时验证」列为**三项必做**，各对应一类纯读代码发现不了的缺陷（机制级拼写失效 / 自检脚本本身是坏的 / 只有跑一遍才知道的状态漂移）。但在加这个字段之前，**契约里没有任何地方承载这三件事的结果**——子 Agent 做了主 Agent 也看不到，不做也没人知道。这和「15 个产物 100% 没有 JSON 信封」是同一类缺陷：**要求写在模板里，格式里没有位置**。

**三个字段的判定**（`tools/check-payload.mjs` 机械校验）：

| 情形 | 写法 |
|---|---|
| 确实做了 | `"status": "DONE"`，并在产物正文写出结果（对账差集、抽验脚本名、运行时命令与输出） |
| 项目不适用（例如纯文档仓库没有可跑的代码） | `"status": "NOT_APPLICABLE"` + `note` 说明为什么 |
| 该做但没做成（环境起不来、权限不足） | `"status": "SKIPPED"` + `note` 说明卡在哪 |

**`SKIPPED` / `NOT_APPLICABLE` 不给 `note` 一律 `CONTRACT_VIOLATION`。** 「静默跳过」和「做过了」在账本上必须可区分——否则这三项必做会和以前的自检清单一样，退化成「模型声称自己检查过了」。

**`findings[]` 每个字段的必填性**（2026-11-14 补登）：

| 字段 | 必填性 | 说明 |
|---|---|---|
| `finding_id` | **必填** | 下游锐评 / 修复 / 验收都靠它挂接。写成 `id` 属 `wrong_field_name` |
| `dimension` | **必填** | 闭集，见上方枚举 |
| `severity` | **必填** | 闭集 `CRITICAL \| HIGH \| MEDIUM \| LOW`；`CRITICAL` 另有准入门槛（见 `wave2-audit.md` §3.3） |
| `evidence` | **必填，且必须是对象** `{file, line, quote}` | **写成数组属 `evidence_wrong_shape`**。门 0 的载体，quote 必须逐字来自本回合读到的原文 |
| `inference` | **必填，且必须是对象** `{claim, basis, alternatives}` | **写成字符串属 `inference_wrong_shape`**。这会让 `CRITICAL` 准入门槛检查**静默失效**（它读 `inf.claim`，字符串上取到 `undefined`） |
| `status` | **必填** | 闭集 `CONFIRMED \| NO_EVIDENCE_FOUND \| GATE_0_FAILED \| UNREADABLE \| EVIDENCE_GAP`。**省略即 `missing_finding_status`**——「没查」和「查了没发现」必须可区分 |
| `runtime_evidence` | 条件必填 | 仅当发现涉及运行时可观察行为时必填；`method` / `command` / `observed` 三项见 `wave2-audit.md` §4.5 |

> **为什么必须写成表**：在这张表存在之前，`check-payload.mjs` 已经在执行 `missing_finding_status` 等规则，而契约里**没有任何一句**要求这些字段——**校验器比契约严**。结果是子 Agent 照契约写会被判违规，且修法提示指向一段不存在的规范。这与 `self_checks` 那条「要求写在模板里、格式里没有位置」是同一个病的反方向：**格式里有了、文档里没有位置**。

**`searched_scope` 的适用规则**（2026-11-10 红队实测新增）：**当 `findings` 中有任何 `NO_EVIDENCE_FOUND` 条目时必填**。

**为什么**：`evidence-policy.md` §4 和 `wave2-audit.md` §4 都要求「`NO_EVIDENCE_FOUND` 必须写明 `searched_scope` 和 `searched_methods`」，但这两段话**只存在于散文里，契约没有承载位置**。红队实测：一个 `quote` 为空、`basis` 只有 `"looked"` 六个字母的 `NO_EVIDENCE_FOUND` 条目，**拿到了「✅ 契约合规」**。

这让「什么都不做」成为最廉价的攻击——攻击者只需要让每个 Agent 都返回 `NO_EVIDENCE_FOUND`，而框架明令主 Agent 不得因此判定 Agent「没干活」。

**机械校验**（`check-payload.mjs`）：

| 情形 | 判定 |
|---|---|
| 有 `NO_EVIDENCE_FOUND` 但无 `searched_scope`，或 `files_read` / `dimension_checklist` 为空 | **`CONTRACT_VIOLATION`** |
| `NO_EVIDENCE_FOUND` 的 `inference.basis` 少于 15 字 | **`CONTRACT_VIOLATION`**——「我查了没发现」必须证明「我真查了」 |

> **这条的普适教训**：「我做了但没找到」和「我什么也没做」在产物上必须可区分。任何允许「空结果」的契约，都必须同时要求**证明搜索过程**的证据——否则空结果就是免罪符。

**`findings` 数组的最小长度**：如果审计Agent在切片中**没有发现任何有证据支撑的问题**，`findings` 仍然必须包含**至少一个条目**，其 `status` 为 `NO_EVIDENCE_FOUND`，并在 `evidence` 中写明 `searched_scope` 和 `searched_methods`。空数组一律视为 `CONTRACT_VIOLATION`，因为”没查”和”查了没发现”在契约上必须可区分。

> **2026-11-12 复测：这句话写在这里将近一个月，但校验器一直到今天才真正执行它。**
>
> 构造 `findings: []` 的产物，`check-payload.mjs` 返回「✅ 契约合规」。同一轮复测还发现另一条：`status=CONFIRMED` + `quote: “”` + `basis: “looked”` 也判合规——根因是判据写成 `ev.quote != null`，而空字符串不是 `null`。
>
> 两条都已修（规则 `empty_findings` / `confirmed_without_evidence` 现在要求 quote 是**非空且非纯空白**的字符串），并有回归测试（`check-payload.test.mjs` case 68–70）。
>
> **教训**：散文里写了「一律视为 `CONTRACT_VIOLATION`」不等于校验器会这么做（2026-11-12 全量对照：19 条判据里 3 条从未被执行，见 `experiments/CONTRACT-PROBE.md`）。**契约的每一条硬判据都必须有对应的测试用例，否则它只是一句愿望。** 这个框架里「三层闭环」（模板 / 契约 / 校验器）的第三条腿，正是最容易缺的那条。

**`GATE_0_FAILED` 的处理**：如果某条发现未通过 `evidence-policy` 的门 0，该条目的 `status` 写 `GATE_0_FAILED`，并且该条目**不进入下游锐评波**。审计Agent的顶层 `status` 仍然可以是 `SUCCESS`（它诚实地报告了“我尝试了但证据不足以声称一个问题”），但主Agent在账本中必须将该 `finding_id` 标记为 `INVALID_EVIDENCE`，不得进入修复。

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
