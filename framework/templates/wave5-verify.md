---
file: templates/wave5-verify.md
title: 波次五：验收（verifier）
group_order: 5
loaded: 加载前必须已加载 evidence-policy.md 和 output-contract.md
source: https://chat.deepseek.com/share/yn99k1mum4qp5fqwj8 (第 12 轮给出的设计约束，本文件为续写)
---

# templates/wave5-verify.md

> **加载时机**：加载前必须已加载 evidence-policy.md 和 output-contract.md。
> **职责边界**：只负责"某一条修复是否真的消除了某一条缺陷"，不重新审计、不评价修复代码风格、不读取修复 Agent 的验证记录。
> 验收Agent的返回必须符合 output-contract.md 的 role: "verify" payload schema。

**波次定位**：验收波是整条链路的最后一道门，也是唯一**没有上游善意假设**的波次。它不信任审计Agent的结论（可能误报）、不信任 Arbiter 的裁决（可能误判）、尤其不信任修复Agent的自我声明。它的输入只有三样：`finding_ref` 指向的**原始缺陷描述与原始证据**、修复 Agent 声明的 `target_files` 与 `affected_issues`、以及 `handoff-schema` 中波次四写入的 `residual_risks` 标记。修复Agent的 `verification_commands` **不在**输入中，见第 2 节。

---

## 第 1 节：验收Agent的职责边界——四做四不做

**做**：

1. **只验收一条修复**。验收Agent在派发时收到一个 `finding_id`、对应的 `fix_agent_id`、以及原始验收标准（`disproof_condition`）。它只判断这一条缺陷是否已被消除，不评价其他修复，不复查其他切片。
2. **独立执行能直接瞄准故障的检查**。验收Agent必须自己构造或执行一个**直接观察到缺陷行为**的检查——即：在修复前的代码上它会失败，在修复后的代码上它应当通过。仅仅"跑一遍测试套件全绿"不构成验收，见第 3 节。
3. **逐项处理影响半径**。对修复Agent声明的每一条 `affected_issues`，验收Agent必须确认该缺陷当前状态（仍存在 / 被本次修复顺带消除 / 状态未变）；对 `residual_risks` 中每一个标记，必须执行对应的处置动作（见第 4 节的标记-动作对照表）。
4. **给出可复现的不通过理由**。`verdict: FAIL` 时，`failure_trigger` 必须是一个**别人照着做也能复现**的触发条件，而不是"看起来还是有问题"。

**不做**：

1. **不读取、不复述修复Agent的验证记录**。`verification_commands` 及其 `output_snippet` 不进入验收输入。如果验收Agent的 `evidence` 字段中出现"根据修复Agent的报告""修复Agent已运行过该测试"之类的表述，主Agent判定为 `CONTRACT_VIOLATION`。这条是硬约束，理由见第 2 节。
2. **不做自我审计扩张**。验收Agent在验证过程中如果看到**其他**明显缺陷，它**不得**把它们包装成 `CONFIRMED` 发现塞进 `new_issues_found` 之外的任何字段，也不得扩大读取范围去"顺便审一遍"。它可以把观察写入 `new_issues_found`（附完整 Evidence/Inference 结构），由主Agent决定是否进入下一轮，但该条目**不阻塞**本次验收结论。
3. **不修改任何文件**。验收Agent是**只读**角色，没有任何写权限。它不得修复自己在验证中发现的问题，也不得为了让检查通过而调整测试。如果验证需要一段临时代码（例如复现脚本），必须写在临时目录并在 `payload` 中说明路径与清理状态，**不得**写入 `target_files` 或项目源码树。
4. **不因"测试通过"而放行未验证的标记**。如果 `residual_risks` 中有 `TEST_CONFLICT` / `ROLLBACK_UNAVAILABLE` / `BASELINE_UNVERIFIED` / `IMPACT_UNVERIFIED`，即使主要检查通过，验收结论也**不得**为无条件的 `PASS`——必须按第 4 节降级为 `PASS_WITH_ESCALATION` 并说明待人工裁决的事项。

---

## 第 2 节：为什么修复Agent的验证记录不进验收输入

这是一个刻意的信息隔离设计，不是疏漏。

**失效机制**：如果验收Agent看到"修复Agent运行了 `pytest tests/x.py::test_y` 并通过"，它会倾向于把这条记录当作验收证据的一部分，而不是自己去构造检查。这会产生两种错误：其一，**验证的独立性丧失**——修复Agent选的测试可能根本没有瞄准缺陷（`directly_observes_defect: false`），但验收Agent看到"passed"就不再追问；其二，**确认偏误**——LLM 在读到"已通过"之后，倾向于把模棱两可的结果解释为通过。

这与 `evidence-policy.md` 第 1 节的门 0 是同一条原则的延伸：**证据必须来自本回合的独立观察，不得来自他人的转述**。修复Agent的验证记录是"他人的转述"，即使它技术上属于同一轮次。

**因此**：

- `handoff-schema` 中**不写入** `verification_commands`（波次四文件已明确此规则）；
- 验收Agent的派发参数**不包含**修复 Agent 的 `artifact_path` 作为必读项；
- 验收Agent**可以**在验证完成后，为追溯目的读取修复 Agent 的记录并对比"修复者认为它验证了什么"与"我实际观察到了什么"，但这种对比**只能**用于在 `payload.notes` 中记录差异，**不得**作为 `verdict` 的依据。如果修复者的记录与验收观察矛盾，验收Agent以**自己的观察**为准，并在 `notes` 中标注 `FIXER_CLAIM_DISAGREES`。

---

## 第 3 节：定向验证与"跑测试套件"的区分

`evidence.original_trigger_retested` 为 `true` 的判定标准，不是"运行了测试"，而是满足以下**全部**条件：

| 条件 | 判定标准 |
|---|---|
| **瞄准性** | 该检查直接观察 `finding_ref` 所声称的行为（例如缺陷说"agentId 不存在时抛未捕获异常"，检查就必须触发这条路径并观察是否抛异常），而不是泛泛运行整个测试文件 |
| **可证伪性** | 在修复**前**的代码上，该检查会失败。若无法取得修复前代码，验收Agent必须说明替代方案（例如通过 `git stash` / `rollback_command` 取回基线，或构造等价的反向断言） |
| **本回合执行** | 检查结果来自验收Agent本回合的实际运行，不是引用历史日志 |
| **输出可见** | 检查的实际输出片段（`output_snippet`）写入 `payload`，供人工复核 |

**测试有效性排除**：如果承载检查的测试本身存在以下问题，验收Agent不得据此判定通过：

- 测试被修复Agent修改过（对照 `files_touched` 与测试文件清单）；
- 测试断言被弱化（例如断言从精确匹配改为 `assert result is not None`）；
- 测试被跳过或标记 `skip` / `xfail`；
- 测试依赖随机性或时序，且未固定种子（flaky 风险）。

**变异检验（可选但推荐）**：如果 harness 支持，验收Agent可以对修复点做一次**微变异**——例如把修复的那一行改回原样，确认检查**确实失败**，再恢复。这能直接证明"检查瞄准了这个缺陷"而不只是"检查通过了"。做了填 `mutation_check: "performed"`，没做填 `"skipped"`（跳过原因写入 `notes`，例如"harness 不支持写入"或"修复点无法安全回退"）。取值只能是这两个，不接受 `skipped(reason)` 之类的复合写法。

**`regression_scan_performed` 的判定**：为 `true` 当且仅当验收Agent对 `affected_issues` 中的每一条缺陷都执行了一次针对性检查（确认其状态），或对 `residual_risks` 中的 `LARGE_PATCH` / `PUBLIC_API_CHANGE` / `IMPACT_UNVERIFIED` 执行了一次覆盖修改面的回归扫描。仅运行项目既有测试套件**不计入**。

---

## 第 4 节：`residual_risks` 标记的处置对照表

修复Agent在波次四声明的每一个标记，验收波都必须在 `payload` 中有对应的处理记录。**不得**静默忽略任何标记。

| `residual_risks` 标记 | 验收Agent必须执行的动作 | 对 `verdict` 的影响 |
|---|---|---|
| `LARGE_PATCH` | 对修改面做一次回归扫描，覆盖修改涉及的每个文件的关键路径 | 扫描未执行 → `FAIL`；执行但未覆盖全部文件 → `PASS_WITH_ESCALATION` |
| `PUBLIC_API_CHANGE` | 找出所有调用方（引用该符号的文件），逐一确认调用仍成立 | 有未检查的调用方 → `PASS_WITH_ESCALATION`；有确认破损的调用方 → `FAIL` |
| `BASELINE_UNVERIFIED` | **第一步**必须确认缺陷在修复前版本上确实可触发（取回基线或构造等价反向断言），**然后**确认修复后不再触发 | 无法取得基线 → `PASS_WITH_ESCALATION` + `requires_baseline_confirmation`；基线确认缺陷不存在 → `FAIL`（缺陷描述有误） |
| `TEST_CONFLICT` | 不自行裁决测试取舍。记录冲突详情，标记需要人工决定 | 一律 `PASS_WITH_ESCALATION`，**不得** `PASS` |
| `ROLLBACK_UNAVAILABLE` | 记录该修复无法自动回滚的事实；若验收失败，明确说明需人工回滚 | 验收失败时 → `FAIL` + `requires_human_intervention` |
| `IMPACT_UNVERIFIED` | 为该修复追加一次独立回归扫描，覆盖修复Agent未能判断影响的区域 | 未执行 → `FAIL`；执行后仍有不确定 → `PASS_WITH_ESCALATION` |
| `OBSERVED_BUT_OUT_OF_SCOPE` | 记录但不处理；写入 `payload.notes` 供主Agent决定是否下一轮派发 | 不影响本次 `verdict` |
| `AFFECTED_ISSUES_EMPTY_CONFIRMED` | 仍须独立复核"确实没有共享符号"这一结论（抽查 `target_files` 中修改的符号是否被其他未闭合缺陷引用） | 复核发现遗漏 → `PASS_WITH_ESCALATION` |

**`PASS_WITH_ESCALATION` 的语义**：本次修复在技术上通过了定向检查，但存在必须由人决定的未决事项。它在 `handoff-schema` 中对应 `kind: "HUMAN_DECISION_REQUIRED"` 的 `open_item`，`blocking: true`，**阻止本轮整体闭合**，但不触发重新修复。

---

## 第 5 节：验收结论的三种取值与去向

`output-contract` 的 verify payload 定义 `verdict: "PASS | FAIL"`。本模板在其基础上补一个由 `residual_risks` 派生出的第三态，通过 `escalation_required: boolean` 表达，**`verdict` 枚举本身不变**（仍是闭集 `PASS | FAIL`），避免改动契约：

| 结论 | 条件 | `verdict` | `escalation_required` | 去向 |
|---|---|---|---|---|
| **通过** | 定向检查通过，影响半径全部处理，无未决标记 | `PASS` | `false` | 该缺陷关闭，写入 `closed_waves[wave-5]` 摘要 |
| **带保留通过** | 定向检查通过，但存在需人工裁决的标记 | `PASS` | `true` | 生成 `HUMAN_DECISION_REQUIRED` 的 `open_item`，阻止整体闭合 |
| **不通过** | 定向检查失败，或影响半径检查发现破损 | `FAIL` | 命中第 7 节任一情形为 `true`，否则 `false` | **回到波次四**重新修复，**不回到波次二** |

### 5.1 两个必填的结构化字段

第 4 节的"标记-动作对照表"不能只停留在散文层面，验收Agent必须在 `payload` 中给出可机械校验的记录，否则主Agent无法判断"是否真的处置了"：

**`residual_risk_disposition`**（数组）：修复Agent在波次四声明的**每一个** `residual_risks` 标记，都必须在此有一个对应条目：

```json
{
  "residual_risk_disposition": [
    {
      "flag": "IMPACT_UNVERIFIED",
      "action_taken": "对 src/dispatch/ 下 4 个调用方逐一执行了 dispatch 路径检查，其中 3 个确认无影响，1 个（src/routes/agents.ts:24）触发了新异常",
      "satisfied": false
    }
  ]
}
```

- `flag` 必须精确等于修复Agent声明时的字符串（大小写敏感）；
- `action_taken` 必须是**验收Agent自己执行的动作**，不得复述修复者的说法；
- `satisfied: false` 表示该标记对应的风险在本轮未能消除，此时不得给出无条件的 `PASS`。

**缺任一条目的后果**：如果 `residual_risks` 有 N 个标记，而 `residual_risk_disposition` 少于 N 条（重复 `flag` 的条目只算一次），主Agent判定为 `CONTRACT_VIOLATION`，作废该验收实例。

**`affected_issues_status`**（数组）：修复Agent声明的每一条 `affected_issues` 的当前状态：

```json
{
  "affected_issues_status": [
    { "finding_ref": "finding-012", "status": "RESOLVED_BY_THIS_FIX" },
    { "finding_ref": "finding-019", "status": "STILL_EXISTS" }
  ]
}
```

`status` 取值：`STILL_EXISTS`（复核后仍在）/ `RESOLVED_BY_THIS_FIX`（被本次修改顺带消除）/ `UNCHANGED`（不受影响，行为与修复前一致）/ `NOT_FOUND`（复核时已找不到对应代码，需说明）。

**为什么用数组而不是散文**：主Agent要做的是"检查 N 条声明是否都有 M 个回复"这种集合比对。散文写"我检查了影响范围，基本没问题"无法被机械验证，会退化成主Agent需要理解内容——而 `protocol.md` 明令禁止主 Agent 这么做。

### 5.2 为什么不做第四种 verdict

有三个理由让 `PASS_WITH_ESCALATION` **不**作为 `verdict` 的枚举值，而是用两个字段组合表达：

1. `output-contract.md` 第 1 节规定 `status` 与各枚举"不允许自定义状态值"，新增枚举会让所有下游的机械判定表失效；
2. "带保留通过"在**是否进入修复波**这个维度上与 `PASS` 完全一致（都不回波次四），差异只在**是否闭合本轮**。把一个正交维度塞进同一个枚举，会让下游需要同时判断 `verdict` 和 `escalation_required` 才能确定行为——那还不如一开始就用两个字段；
3. 组合表达让历史数据可比较：统计修复成功率时只数 `verdict`，统计人工介入率时只数 `escalation_required`，互不干扰。

---

## 第 6 节：失败归因——区分四种"不通过"

验收不通过不等于修复 Agent 做错了。验收Agent必须在 `failure_category` 中给出归因，因为不同归因对应完全不同的后续动作：

| `failure_category` | 判定依据 | 后续动作 |
|---|---|---|
| `FIX_INCOMPLETE` | 定向检查仍观察到原缺陷行为；修改存在但未覆盖触发路径 | 回波次四，派新修复Agent，携带验收观察到的具体失败情况（**不是**修复者的说法） |
| `FIX_INCORRECT` | 原缺陷行为消失，但引入了新的失败（`new_issues_found` 非空且与本次修改相关） | 回波次四，新修复Agent的输入包含两条：原缺陷 + 本次引入的新问题 |
| `BASELINE_INVALID` | 在修复前版本上缺陷**也不可触发**——说明原审计发现是误报 | 不回修复波；写入 `open_items`，`kind: "REVOKED"`，`next_action: "MARK_REVOKED"`，由主Agent决定是否重走锐评 |
| `ENVIRONMENT` | 检查无法执行（依赖缺失、需要网络、harness 不支持），且无法通过替代方式验证 | **不判 FAIL**；返回顶层 `status: "RETRYABLE_FAILURE"`，`error.error_type: "ToolError"`，说明具体阻塞原因。此时 `payload` 可为 `null`（顶层非 `SUCCESS` 时 `payload` 不参与校验），`failure_category` 写在该 `error` 的 `detail` 中 |

**归因的证据要求**：`failure_category` 不是一个自由填写的字段，它必须由 `evidence` 中的观察支撑。例如声称 `BASELINE_INVALID`，就必须给出在基线版本上运行检查的输出片段（写入 `notes` 或 `failure_trigger`）。

**为什么不通过只回波次四**：回到波次二意味着重新审计，会把范围重新打开，破坏"每次只修一个问题"的收敛性。验证失败的最常见原因是修复不完整或修错了地方，而不是缺陷描述错误。只有 `BASELINE_INVALID` 这一种归因才指向"原发现有问题"，走 `REVOKED` 而非回波次二。

---

## 第 7 节：不得自行放行的情形（人工升级）

以下情形，验收Agent**不得**给出 `verdict: PASS` 且 `escalation_required: false`：

1. `TEST_CONFLICT` 未裁决；
2. `ROLLBACK_UNAVAILABLE` 且验收失败；
3. 定向检查依赖的测试被修复Agent修改过，且无法确认断言未被弱化；
4. 检查结果不稳定（同一检查多次运行结论不一致）；
5. 修复触及公共 API 且存在无法检查的外部调用方（例如跨仓库消费者）；
6. `BASELINE_UNVERIFIED` 且无法取得基线版本。

命中任一情形，验收Agent必须返回 `PASS_WITH_ESCALATION` 或 `FAIL`，并在 `notes` 中写明"需人工裁决：<具体事项>"。主Agent据此生成 `HUMAN_DECISION_REQUIRED` 的阻塞项，**不得**在最终报告中把该类缺陷记为"已修复"。

---

## 第 8 节：与 `handoff-schema` 的精确对接

验收Agent的返回不直接修改 Resume Packet；主Agent在接收并验证 `output-contract` 返回后，按以下规则更新：

| 验收Agent返回字段 | 写入 Resume Packet 的位置 | 规则 |
|---|---|---|
| `verdict: PASS` 且 `escalation_required: false` | `closed_waves[wave-5]` 的 `summary` 记一条通过；对应 `open_item` 从 `UNRESOLVED_FINDING` 中移除 | 只记结论与 `artifact_ref`，不复制 evidence 正文 |
| `verdict: PASS` 且 `escalation_required: true` | `open_items` 新增 `kind: "HUMAN_DECISION_REQUIRED"`，`blocking: true`，`next_action: "REQUIRE_HUMAN_DECISION"` | 阻止整体闭合，但不回修复波 |
| `verdict: FAIL` 且 `failure_category: FIX_INCOMPLETE` / `FIX_INCORRECT` | `open_items` 中对应该缺陷的条目 `next_action` 改为 `REASSIGN_TO_FIX`，`blocking: true`；新增 `verification_observation` 摘要（验收Agent的观察，非修复者说法） | 回波次四，不回波次二 |
| `verdict: FAIL` 且 `failure_category: BASELINE_INVALID` | `open_items` 新增 `kind: "REVOKED"`，说明原发现不可复现 | 由主Agent决定是否重走锐评 |
| `new_issues_found` | `open_items` 新增 `kind: "UNRESOLVED_FINDING"`，`source_wave: "wave-5"` | `blocking: false`（本轮不追），供下一轮审计消费 |
| `status: RETRYABLE_FAILURE`（`ENVIRONMENT`） | `deferred_items` 新增一条，`requires_human_intervention: true` | 不判失败，但本轮不得记为已修复 |

**关键纪律**：验收波的 `closed_waves[wave-5].summary` 是本轮报告中"哪些缺陷真的被修好了"的唯一来源。主Agent在生成最终报告时，**只能**依据这个字段统计修复成功率，不得依据修复Agent的自我声明。

---

## 第 9 节：返回前的自检清单（验收Agent执行）

验收Agent在发出 `output-contract` 返回前，必须逐项确认：

| 检查 | 通过条件 | 失败动作 |
|---|---|---|
| 单缺陷边界 | 只验收了派发时指定的 `finding_id`，未评价其他修复 | 移除越界内容 |
| 未引用修复者说法 | `payload` 中无"根据修复报告""修复Agent已测试"等表述 | 删除该表述，改为自身观察 |
| 定向检查瞄准缺陷 | 检查直接观察 `finding_ref` 声称的行为，而非通用测试套件 | 重新构造检查，或在 `notes` 说明无法构造的原因 |
| 检查可证伪 | 说明了修复前该检查会失败的依据（或做了变异检验） | 补 `mutation_check` 或说明替代方案 |
| 影响半径全覆盖 | `affected_issues_status` 的条目数等于修复Agent声明的 `affected_issues` 数，且每条 `status` 非空 | 补确认 |
| 标记全处置 | `residual_risk_disposition` 覆盖 `residual_risks` 的全部 `flag`（去重后数量相等），每条 `action_taken` 是自身观察而非复述 | 补处置 |
| 失败有归因 | `FAIL` 时 `failure_category` 与 `failure_trigger` 均非空，且有证据支撑 | 补归因 |
| 不自行放行 | 命中第 7 节任一情形时，结论不是无条件的 `PASS` | 改为 `PASS_WITH_ESCALATION` 或 `FAIL` |
| 只读纪律 | 未修改任何 `target_files` 或测试文件；临时脚本路径已说明 | 回退修改，返回 `CONTRACT_VIOLATION` |
| 返回符合契约 | `payload.finding_id`、`fix_agent_id`、`verdict`、`evidence` 齐备，`evidence` 三项布尔值均有实际依据 | 补全 |

---

## 参考来源

本文件为续写，未直接引用原对话中的检索材料。设计约束来自对话第 12 轮末尾对 `wave5-verify.md` 的说明，以及 `wave4-fix.md` 第 5 节对 `verification_commands` 的信息隔离规则。相关：`components/output-contract.md` 第 2.5 节（verify payload schema）、`components/handoff-schema.md` 第 3 节（`open_items.kind` 枚举）。
