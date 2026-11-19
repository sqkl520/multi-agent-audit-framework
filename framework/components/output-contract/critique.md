<!--
  自动生成，请勿手改。母文件：framework/components/output-contract.md
  重跑：node tools/gen-contract-slices.mjs
  本文件 = 母文件的通用节 + critique 角色那一节，其它角色的分支已裁掉。
-->

---
file: components/output-contract/critique.md
title: 统一返回契约
group_order: 2
loaded: 所有子 Agent在返回任何结果前加载
source: https://chat.deepseek.com/share/yn99k1mum4qp5fqwj8 (第 8 轮)
---

# components/output-contract/critique.md

## 文件头部：强制加载与优先级

> critique.md（output-contract 的 critique 角色切片）
> 所有子 Agent在返回任何结果前加载。
> 主Agent只消费符合本契约的结构化输出；不符合的输出一律判定为 CONTRACT_VIOLATION。
> 本文件与 evidence-policy.md 的字段约定冲突时，以 evidence-policy.md 的证据结构为准；
> 本文件负责把 evidence-policy 的状态和结构纳入统一信封。
> 禁止任何“宽容解析”或“尽力修复后放行”——违反契约的输出必须在检查点被拒绝，不得进入下游。

## 第 0 节：产物的物理形态（所有角色适用，2026-11-09 新增）

> **本框架对「规则」本身的两条硬要求**（2026-11-19 补：此前只写在
> `tools/check-rule-ledger.mjs` 的文件头里，契约正文没有承载，导致
> `discretionary_without_reason` / `new_rule_without_validator` 两条规则
> 在契约里找不到落点）：
>
> | 要求 | 违反时 | 校验器规则 |
> |---|---|---|
> | 标了 `DISCRETIONARY` 的规则必须给出 ≥10 字理由 | 无法执行的规则应被删掉，而不是被标注 | `discretionary_without_reason` |
> | 新增/修改的规则句必须有机器出口（点名校验器脚本、`rule:` 名，或标 `DISCRETIONARY`） | 从写下那天起就没人读它 | `new_rule_without_validator` |
>
> 用法：`node tools/check-rule-ledger.mjs --gate --since <ref>`。
> 为什么这条要写进契约而不是只写在校验器注释里：**同一个文件头注释里的道理，
> 不写进契约就没人执行**——这正是本框架反复出现的形态。

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

所有子 Agent，无论角色，必须返回**同一顶层信封**。角色差异只体现在 `payload` 字段的内部结构上。这借鉴了 `agent-contracts` 的 `allOf` 组合模式：公共字段共享，角色特定内容通过 `payload` 承载[^ref4]。

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

> **为什么它必须进契约而不是留在模板里**：`report-naming.md` 第 5 节要求「每个子 Agent只允许写入属于自己的产物文件」，但**没有任何角色被授予 `Write`**，且这份文件的加载时机写的是「子 Agent 在写出产物文件**前**加载」——一个还没被授权写产物的 Agent，不会被触发去加载「怎么写产物」的规则。**这是一个自指的空转**：规则假设产物已经存在，产物的存在又依赖规则先被加载。
>
> round31 的实测结果正是这个空转的产物：`83` 条待修复发现、`1` 条实际修复、`IN_PROGRESS`、**无最终报告**。此前把它归因为「修复波太脆弱」，但它还有一条独立的失效路径——**上游产物从未真正落盘**，主Agent 手里的 `artifact_ref` 全是悬空路径，拼不出报告。
>
> 现在这道校验是机械的：`artifact_path` 指向的文件不存在 = 违规，无论 Agent 的 payload 多么完整。**「格式完美但结论为空」不再能通过门控。**

**字段语义**：

| 字段 | 类型 | 约束 |
|---|---|---|
| `schema_version` | string | 必须精确匹配 `"output-contract-v1"`。版本不匹配直接拒绝，不尝试向后兼容。 |
| `agent_id` | string | 全局唯一，由主Agent在派发时分配，子 Agent原样回显。 |
| `role` | enum | 必须是**六个**角色之一（`recon` / `sweep` / `audit` / `critique` / `fix` / `verify`）。角色决定 `payload` 的 schema 分支。 |
| `status` | enum | 必须是四个顶层状态之一。**不允许自定义状态值**。 |
| `contract_valid` | boolean | 由子 Agent在返回前自行对 `payload` 做一次 schema 校验后写入。如果子 Agent无法保证合规，必须写 `false` 并在 `error` 中说明，而不是“尽力凑一个看起来合规的 payload”。 |
| `artifact_path` | string\|null | 产物文件路径。`SUCCESS` 时必填且文件必须存在；非 `SUCCESS` 时可为 `null`。见下方「`artifact_path` 是必填顶层字段」。 |
| `payload` | object | 按角色分支的 schema，见第 2 节。 |
| `error` | object\|null | 仅当 `status` 不是 `SUCCESS` 时必填，结构见第 3 节。 |

**状态枚举的收敛**：顶层 `status` 只保留四个值，与上一轮 `protocol.md` 的状态账本对齐。`Wazir` 的材料显示 A2A 协议使用七个任务状态（`submitted`、`working`、`input-required`、`completed`、`failed`、`canceled`、`rejected`），但那些覆盖了任务生命周期中的中间态[^ref5]。我们的子 Agent是**一次性返回结果的执行单元**，不需要 `working` 或 `input-required`（这些由主Agent的账本管理），因此四个终态足以覆盖子 Agent的返回语义。`evidence-policy` 中的 `GATE_0_FAILED`、`NO_EVIDENCE_FOUND`、`UNREADABLE` **不作为顶层状态**，而是作为 `payload.findings` 数组内的条目状态，见第 4 节。

**`PENDING` 与 `RUNNING` 的归属**：`protocol.md` 第 2 节的账本状态枚举有六个值（`PENDING | RUNNING | SUCCESS | RETRYABLE_FAILURE | CONTRACT_VIOLATION | PERMANENT_FAILURE`），比本契约多两个。这不是不一致，而是**两个枚举分属不同主体**：

| 枚举 | 主体 | 是否出现在子 Agent返回中 |
|---|---|---|
| `PENDING` / `RUNNING` | **主Agent账本**的内部调度状态 | **否**。子 Agent还没返回时不存在返回；返回了就已经是终态 |
| `SUCCESS` / `RETRYABLE_FAILURE` / `CONTRACT_VIOLATION` / `PERMANENT_FAILURE` | **子 Agent返回**的顶层 `status` | 是，四选一 |

**机械判定规则**：主Agent在接收子 Agent返回时，只接受四个终态；若子 Agent返回 `PENDING` 或 `RUNNING`，视为 `CONTRACT_VIOLATION`（这是一次性执行单元，不存在"我先挂起一会儿"的语义）。反过来，账本中的 `PENDING` / `RUNNING` 只能由主Agent自己写入，**不得**从子 Agent返回中读取。

---

## 第 2 节：Payload 的角色分支

`payload` 使用 `oneOf` 按 `role` 分支。每个分支有独立的必填字段，但共享“证据结构”的定义（引用 `evidence-policy.md` 的 `Evidence` / `Inference` 字段）。

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
        "dimension": "logic | concurrency | security | error-handling | data-consistency | contract | null",
        "verdict": "<见下方「裁决枚举按子角色分支」，三选一>",
        "reason": "string — 必须引用具体证据或指出具体缺失",
        "missing_evidence": "string|null",
        "direct_contradiction": "string|null",
        "sub_claims": [
          {
            "claim": "string — 一个可独立判定的子主张",
            "verdict": "holds | refuted | untested",
            "evidence_ref": "path:line",
            "direct_contradiction": "string|null",
            "reason": "string|null"
          }
        ],
        "runtime_applicable": "true | false",
        "path_correction": {
          "claimed_path": "string",
          "actual_path": "string|null",
          "how_found": "string"
        },
        "runtime_evidence": {
          "method": "headless_chrome | node_cli | test_runner | http_probe | null",
          "command": "string — 实际执行的完整命令",
          "observed": "string — 原始输出，不是结论",
          "control_case": "string — 已知会通过/会失败的对照，证明探针本身有效",
          "reproducible": true
        },
        "five_step": {
          "evidence_opened": true,
          "evidence_supports_claim": true,
          "path_reachable": "true | false | untested",
          "already_handled": "true | false | untested",
          "failure_chain_holds": true
        }
      }
    ],
    "coverage_gaps": [
      {
        "gap_id": "string",
        "kind": "SLICE_UNCOVERED | FILE_UNREAD | DIMENSION_OMITTED | ENTRY_UNCOVERED",
        "target": "string",
        "evidence": { "observation": "string", "source": "string" },
        "potential_impact": "string",
        "recommended_action": "string"
      }
    ],
    "slice_scan_performed": true,
    "file_scan_performed": true,
    "dimension_scan_performed": true,
    "entry_scan_performed": true,
    "pattern_sweep": {
      "performed": true,
      "patterns_checked": []
    },
    "discipline_audit": {
      "performed": true,
      "log_entries_checked": 0,
      "dispatch_records_checked": 0,
      "undeclared_discretions": [],
      "mechanical_check_failures": [],
      "l0_violations": [],
      "overall": "CLEAN | VIOLATIONS_FOUND"
    }
  }
}
```

**裁决枚举按子角色分支**（2026-11-03 修订。此前本节只登记了 `UPHELD | DOWNGRADED | REVOKED | EVIDENCE_GAP`，与 `wave3-critique.md` 中 Skeptic 的 `refuted` / `holds` / `untested` 完全不相交——Skeptic 按模板返回会被判 `CONTRACT_VIOLATION`，这是两份文件直接打架）：

| `critique_role` | 输出载体 | 说明 |
|---|---|---|
| `skeptic` | **`verdicts[]`**，`verdict` 取 `holds` \| `refuted` \| `untested` | **不得**返回 `UPHELD` / `DOWNGRADED` / `REVOKED`——那是裁决，不是攻击结论 |
| `devils_advocate` | **`coverage_gaps[]`**，**不填 `verdicts`**（必须为空数组） | 它不评发现，只评覆盖。往 `verdicts` 里写任何发现级裁决 = 越界 |
| `arbiter` | **`verdicts[]`**，`verdict` 取 `UPHELD` \| `DOWNGRADED` \| `REVOKED` | **不得**返回 `EVIDENCE_GAP`（见下方 Arbiter 约束），也不得返回 Skeptic 的三值 |

> **为什么 `devils_advocate` 不是「另一套 verdict 枚举」**：它的产出形态根本不同——`coverage_gaps` 是**缺口列表**，不是对某条发现的裁决。此前我在本表里给它编过 `coverage_gap | no_gap` 两个值，那是**凭空发明的枚举**：模板里 `devils_advocate` 从不返回 `verdicts`，凭空加一个枚举会让它「两条路都不合规」（不填 `verdicts` 违反必填，填了又说没有合法值）。**正确的修订是承认它的输出载体不同，而不是给它也造一套裁决词。**

**`devils_advocate` 的四个覆盖扫描布尔**（2026-11-14 补登）：`slice_scan_performed`、`file_scan_performed`、`dimension_scan_performed`、`entry_scan_performed`，**四者必须均为 `true`**。

> 这四个字段此前**只存在于 `wave3-critique.md:493` 的检查清单里**，契约没有承载位置，校验器也不检查。而 DA 是锐评波里唯一负责覆盖完整性的角色——它「有没有真的扫四类」完全靠自述，等于把二值可判的事实退化成信任。现在校验器对 `critique_role == "devils_advocate"` 逐个检查，缺一即 `missing_scan_flag`。

**`direct_contradiction` 的适用规则**（2026-11-03 新增字段）：**仅 `critique_role == "skeptic"` 时可能出现**。当 `finding_id` 属于内存安全 / 并发 / 声明一致性 / 行为兼容性变更 / 未使用参数这五个领域时，`verdict: "refuted"` **必须**携带该字段（一行直接与主张矛盾的代码引用）；非敏感领域可为 `null`。判定规则与理由见 `templates/wave3-critique.md` 第 2.2 节。

> **为什么此前必须补**：`wave3-critique.md` 有 5 处要求 `direct_contradiction`，本契约 0 处登记。契约是唯一校验入口，未登记的字段在 `contract_valid` 自检时会被判为「多余字段」——**规则要求的东西，校验器不认识**。同族的还有 `five_step` 的五个布尔字段（`wave3-critique.md` 第 2.1 节要求逐条返回，契约原先未登记）。

**`five_step` 的适用规则**：**仅 `critique_role == "skeptic"` 时必填**。五个字段就是 `wave3-critique.md` 第 2.1 节五步测试的输出。任何一步缺失 = 该条五步测试未执行完 = 该 `verdict` 作废。`devils_advocate` 与 `arbiter` 返回该字段即越界。

**`runtime_applicable` 的适用规则**（2026-11-10 新增）：**仅 `critique_role == "skeptic"` 时必填，且每条 `verdict` 都要有**。

**为什么必须显式声明**：`templates/wave3-critique.md` §6 早已要求「若发现声称的是运行时可观察行为，且项目可跑，必须至少跑一次真实执行」。但这条规则**从来没有强制力**——契约层不知道哪条发现「涉及运行时行为」，所以永远是「模型自己决定跑不跑，然后声称自己跑过了」。

**改成两段式**：

| 字段 | 语义 |
|---|---|
| `runtime_applicable: true` | 这条发现声称的是**运行时可观察**的行为（点击无反应、状态不更新、渲染值不符、可聚焦性、静默失效） |
| `runtime_applicable: false` | 这条发现是**纯静态**可判定的（拼写不一致、死代码、契约不符） |

机械校验：

| 情形 | 判定 |
|---|---|
| 缺 `runtime_applicable` | **`CONTRACT_VIOLATION`** |
| `true` 但无 `runtime_evidence` | **`CONTRACT_VIOLATION`**——声明了要跑就必须跑 |
| `false` 却给了 `runtime_evidence` | 警告（跑得比要求多，不算错） |

**这解决了什么**：以前「该跑没跑」是无法验证的。现在 Skeptic 必须**先回答这个问题**，而一旦答了 `true`，跑没跑就是可验证的事实。**把「需不需要做」和「做没做」拆成两步，前者是声明（可核对），后者是证据（可验证）。**

> 同样的思路适用于任何「按情况决定要不要做」的规则：**先要求声明适用性，再验证执行**。不要指望「模型会自己判断该不该做然后如实报告」。

**`sub_claims` 的适用规则**（2026-11-10 实测新增）：**仅 `critique_role == "skeptic"`，且该发现的 `verdict` 为 `holds` 但 `reason` 中含有对原危害/后果的否定时必填**。

**为什么需要它**：三值枚举假设一条发现是原子的（全对或全错）。实测中这个假设不成立——有一条发现的**机制完全正确**（`break` 的位置和语义逐字核实无误），但**危害方向说反了**（声称「权限放行」，实际是 fail-closed）。三值枚举装不下，Skeptic 只能自造 `UPHELD_ON_MECHANISM / REFUTED_ON_CONSEQUENCE`。

**裁决作用在子主张上，不在整条发现上。** 机械校验：

| 检查 | 条件 |
|---|---|
| 有 `sub_claims` 时，每条必须带 `claim` + `verdict` | 缺任一 = 无效子主张 |
| 子主张的 `verdict` 只能取 `holds` / `refuted` / `untested` | 用别的值 = 又发明枚举 |
| 子主张 `refuted` 时必须给 `direct_contradiction` 或 `reason` | 空口反驳 |
| **必须至少有一条子主张被聊到「机制 vs 后果」**：如果一条发现既有 `holds` 子主张又有 `refuted` 子主张，`reason` 必须说明哪类是机制、哪类是后果 | 否则下游无法判断该不该降级 |

**`pattern_sweep` 的适用规则**：**仅 `critique_role == "devils_advocate"` 时，且本轮存在 `HIGH`/`CRITICAL` 发现时必填**。语义见 `templates/wave3-critique.md` 第 2.4 节。其他子角色返回即越界。

**`discipline_audit` 的适用规则**（2026-11-01 新增）：**仅 `critique_role == "skeptic"` 时必填**。`devils_advocate` 与 `arbiter` 不得返回该字段（返回即越界，判 `CONTRACT_VIOLATION`）。语义与判定规则见 `templates/wave3-critique.md` 第 2.3 节。

**`path_correction` 与 `runtime_evidence` 的适用规则**（2026-11-10 实测新增）：

这两个字段此前**都不存在**，而 `wave3-critique.md` §6 的自检清单要求 Skeptic「引用定位失败时先去找真实位置」「有 runtime_evidence 时优先真跑」——又一次「要求写了，契约装不下」。实测中三个 finding package 有两个路径是错的，Skeptic 都靠自觉去找了真实位置；`runtime_evidence` 更是只在正文散文里写，无法机械校验。

| 字段 | 何时必填 | 缺失判定 |
|---|---|---|
| `path_correction` | 当 `evidence.file` 与实际位置不符时 | 声称发现了路径问题却没填 = 未完成职责 |
| `runtime_evidence` | 当该发现的 `inference.claim` 涉及**运行时可观察行为**（点击无反应、状态不更新、渲染值不符、可聚焦性），**且**项目可运行 | 该跑没跑，`verdict` 只能是 `untested`，**不得**为 `holds` |

**`control_case` 为什么是必填而不是可选**：没有对照的实验不可采信。实测中 F2（主 CTA 无绑定）最有价值的一层证据不是「点击后 mutations 为空」，而是**同一个探针在同目录另一个文件上测出 `mutations: 303`**——那才证明「空」不是探针失灵。规则：`control_case` 为空时，`runtime_evidence` 整段不采信。

> **为什么必须是必填而非可选**：`discipline_audit.performed` 若可省略，它会退化成"想查就查"。而 round31 的教训是——未申报的裁量**只有被主动找出来**才能发现（当时是 Devil's Advocate 偶然撞上的）。因此 `skeptic` 缺失该字段 = 未完成职责，其全部 `verdicts` 作废。

**Arbiter 的额外约束**：当 `critique_role` 为 `arbiter` 时，`verdicts` 中每一条的 `verdict` **不得**为 `EVIDENCE_GAP`。Arbiter 的职责是在双方证据的基础上做出终局裁决；如果证据不足以裁决，Arbiter 应当返回 `RETRYABLE_FAILURE` 并说明需要补采什么证据，而不是把 `EVIDENCE_GAP` 当作裁决结果推回给主Agent。

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

主Agent在接收到子 Agent返回后，**必须**按以下顺序执行验证。任何一步失败，该Agent的 `status` 被覆盖为 `CONTRACT_VIOLATION`，**其全部输出作废**，不得作为下游输入。

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

## 第 5 节：状态转换规则（子 Agent视角）

顶层 `status` 的四值之间**不允许任意转换**。子 Agent在一次返回中只能报告一个终态。转换规则如下：

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

本文件与 `handoff-schema` 的交接点是：`output-contract` 保证每个子 Agent的返回可被主Agent机械验证；`handoff-schema` 保证验证后的结果可以被安全地传递给下一波，而不需要主Agent重新阅读任何散文。

---

---

## 参考来源

[^ref4]: [agent-contracts - producers: [main-architect]](https://www.npmjs.com/package/agent-contracts/v/0.12.2?activeTab=versions#2)
[^ref5]: [Life of a Task](https://agent2agent.info/docs/topics/life-of-a-task/)
[^ref7]: [Telemetry Blindness at the Agent-Business Boundary: A Controlled Measurement of Output-Contract Enforcement](https://zenodo.org/records/21842518/files/Authored_Plan_Agents.pdf?download=1#1#3#1)
