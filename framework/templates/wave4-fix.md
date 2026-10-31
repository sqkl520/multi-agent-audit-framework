---
file: templates/wave4-fix.md
title: 波次四：修复（fix worker）
group_order: 4
loaded: 加载前必须已加载 output-contract.md 和 handoff-schema.md
source: https://chat.deepseek.com/share/yn99k1mum4qp5fqwj8 (第 12 轮)
---

# templates/wave4-fix.md
`templates/wave4-fix.md` 是整条链路中**唯一授予写权限**的模板。它的设计难点不在“怎么改代码”，而在**如何让一个写操作受限、可审计、可回滚，且不把副作用留给下游验收波去发现**。搜索到的材料给出了几个必须吸收的锚点：Active Remediation 的 `minimal-safe-diff` 把“安全修复”定义为**≤10 行、单生产文件 + 测试文件、不跨文件、不改公共 API**[^ref0]；sdd-parallel 用**三层范围守卫**拦截越界编辑，并靠 AST + 调用图计算**语义爆炸半径**来防止“孤立分支测试通过、合并后灾难性失败”[^ref1]；break-ai-fix-loops 的核心纪律是**三次尝试预算 + 真实路径证明 + 已测试的回滚**，而不是 patch-and-retry[^ref2]；callsphere 明确指出**爆炸半径由授予的权限决定**——文件系统范围、命令权限、网络与密钥访问，而不是由 Agent 的自我声明决定[^ref3]；NeurIPS 的 silent regression 证据进一步证明，**让修复Agent自己写测试并运行，既不提高解决率也不降低回归率**，部署时验证必须依赖外部提供的、能直接瞄准故障的测试，而不是 Agent 自证的“通过”[^ref4]。这些原则共同决定了：修复Agent必须是**窄边界、可回滚、不自我验收**的执行单元。


## 文件头部：强制加载与写权限边界

> wave4-fix.md
> 修复Agent（fix worker）专属模板。
> 加载本模板前，必须已加载 output-contract.md 和 handoff-schema.md。
> 本模板与 output-contract / handoff-schema 冲突时，以两者为准；
> 本模板只负责“修复Agent在单缺陷、窄边界内如何执行修改并声明影响半径”，
> 不重新定义返回格式（由 output-contract 定义）或波次传递结构（由 handoff-schema 定义）。
> 修复Agent的返回必须符合 output-contract.md 的 role: "fix" payload schema。

**写权限的硬边界**：修复Agent是唯一允许修改源代码文件的角色。它的写入范围**仅限**派发时指定的 `target_files` 列表中的文件，以及与之对应的**测试文件**（如果该缺陷的验收标准要求新增或修改测试）。修复Agent**不得**创建新文件、删除文件、修改依赖清单（`package.json` / `requirements.txt` / `go.mod` 等）、修改构建配置或修改 `target_files` 之外的生产代码。callsphere 的原则在这里直接适用：爆炸半径由授予的权限决定，而不是由修复Agent的意图决定[^ref5]。如果修复需要触及范围外的文件，修复Agent**必须**停止修改，返回 `RETRYABLE_FAILURE` 或 `CONTRACT_VIOLATION`，并在 `residual_risks` 中明确写出“修复需要触及 `<path>`，超出授权范围”，而不是自行扩大权限。


## 第 1 节：修复Agent的职责边界——四做四不做

**做**：

1. **只修一个缺陷**。修复Agent在派发时收到一个 `finding_id` 和一个 `verdict: UPHELD`（来自 Arbiter 的裁决）以及该缺陷的**验收标准**。它只针对这个缺陷执行修改，**不得**顺带修复其他问题，即使它在修改过程中看到了另一个明显缺陷。
2. **只碰最小范围**。修改必须遵守 `minimal-safe-diff` 的约束：单个生产文件（或极少数紧密耦合的文件）内的局部修改，**≤10 行变更**是目标区间；如果缺陷确实需要更大范围的修改才能修复，修复Agent**必须**在 `residual_risks` 中标记 `LARGE_PATCH` 并说明原因，而不是悄悄扩大 diff[^ref6]。
3. **显式声明影响半径**。修复Agent必须在 `affected_issues` 中列出“这个修改**可能**影响到的其他已发现缺陷”，并在 `residual_risks` 中写明“影响范围是否已验证”。**不声明**等同于“未考虑”，主Agent在验收波中会将其视为需要额外回归扫描的信号。
4. **提供可复现的验证命令与结果**。修复Agent必须在 `verification_commands` 中给出它实际执行过的检查命令（或如果 harness 不支持执行，则给出“未运行”并说明原因），并附上 `output_snippet`。**不允许**只写“已测试通过”而不提供命令和输出。

**不做**：

1. **不做自我验收**。修复Agent的 `verification_commands` 是**辅助证据**，不是验收结论。NeurIPS 的证据表明，让修复Agent自己写测试并运行，既不提高解决率也不降低回归率；真正的验收由独立的验收波从原始验收标准出发执行[^ref7]。修复Agent**不得**在返回中声称“该缺陷已修复”——它只能说“我做了这些修改，并运行了这些检查，结果如下”。
2. **不做根因重构**。如果修复需要重构共享模块、更改公共 API 签名、或升级依赖才能正确解决，修复Agent**必须**停止并返回 `RETRYABLE_FAILURE`，在 `residual_risks` 中写明“该修复需要超出最小安全差异的重构，应升级为独立任务”，而不是在修复波中做 scope creep。Active Remediation 的 “note + ask” 规则在这里是硬边界：超出最小安全差异的修改**永不自动执行**[^ref8]。
3. **不修改测试来使测试通过**。修复Agent**不得**通过删除、跳过、弱化或重写测试断言来让检查“通过”。如果现有测试与缺陷的正确修复冲突，修复Agent必须在 `residual_risks` 中标记 `TEST_CONFLICT`，说明“测试 `<test_id>` 的当前断言与正确修复矛盾，需由验收波或人工判断”，而不是自行修改测试。
4. **不在返回中夹带推断或“建议”** 。修复Agent的 `payload` 只包含 `files_touched`、`verification_commands`、`affected_issues`、`residual_risks` 四个字段。任何关于“我还发现……”“建议后续……”的内容**不进入** `payload`。如果修复Agent在修改过程中看到了其他问题，它**不得**写入返回，而是在 `residual_risks` 中用一行 `OBSERVED_BUT_OUT_OF_SCOPE: <path:line> <一句话>` 透传，供主Agent决定是否在后续轮次中派发新的审计。


## 第 2 节：修复契约的前置登记——编辑之前必须写下来的五个字段

break-ai-fix-loops 的核心实践是：**在第一次编辑之前，记录精确的缺陷、能证伪它的行为、被测路径、基线结果、以及回滚命令**[^ref9]。修复Agent在动手修改之前，必须在内部（或账本的 `fix_contract` 字段中）登记以下五个字段。这些字段不直接出现在 `output-contract` 的最终 `payload` 中，但它们是修复Agent执行修改的前置条件；缺失任一字段，修复Agent**不得**进入编辑阶段。

| 前置字段 | 内容 | 用途 |
|---|---|---|
| `defect_statement` | 一句话重述该缺陷的精确行为（不是“有问题”，而是“当 X 时，Y 会发生，预期是 Z”） | 防止修复Agent修错目标 |
| `disproof_condition` | 一个**可观察的检查**，如果该检查通过，则说明缺陷不存在或已被修复 | 验收波将复用这个检查作为起点 |
| `baseline_result` | 在修改**之前**运行 `disproof_condition` 的实际输出和退出状态 | 证明缺陷在修改前确实可触发 |
| `rollback_command` | 将 `target_files` 恢复到修改前状态的精确命令（`git checkout` / `git stash` / 文件级恢复） | 如果验收失败，主Agent可以机械回滚 |
| `test_path` | `disproof_condition` 所依赖的测试文件或复现脚本的路径；如果不存在，写明“需新建” | 告诉验收波“从哪里瞄准” |

**`baseline_result` 的硬性要求**：如果修复Agent无法在修改前运行 `disproof_condition`（例如 harness 不支持执行命令，或缺陷依赖外部服务无法在本地复现），它**必须**在 `residual_risks` 中写入 `BASELINE_UNVERIFIED`，并且该修复的验收波**必须**额外包含一个“基线确认”步骤——即验收Agent首先要确认缺陷在修复前的版本上确实可触发，然后再确认修复后不再触发。如果修复Agent在编辑前没有记录 `baseline_result`，且没有标记 `BASELINE_UNVERIFIED`，主Agent判定为 `CONTRACT_VIOLATION`。


## 第 3 节：影响半径的显式声明——`affected_issues` 与 `residual_risks`

修复Agent返回中最容易被下游依赖的两个字段是 `affected_issues` 和 `residual_risks`。它们不是可选的“补充说明”，而是主Agent决定“是否为该修复追加回归扫描”的**唯一依据**。

#### 3.1 `affected_issues` 的语义与最小要求

`affected_issues` 必须列出**当前轮次中已发现且仍未闭合的其他缺陷 ID**，这些缺陷可能因为本次修改而改变状态（被修复、被加剧、或触发条件发生变化）。修复Agent不需要为每一条给出完整分析，但必须至少覆盖以下三类：

1. **共享同一函数/模块的缺陷**：如果 `target_files` 中的某个函数被另一个缺陷的 `evidence.file:line` 引用，该缺陷必须出现在 `affected_issues` 中。
2. **依赖被修改符号的缺陷**：如果本次修改改变了某个函数的行为、返回值或异常抛出条件，所有引用该函数作为调用链一部分的缺陷都应被列出。
3. **与本次修改处于同一 `dimension` 的缺陷**：如果同一切片的其他缺陷属于同一维度（例如同为 `logic`），它们可能在修复后被“顺带”改变，修复Agent应当列出它们并要求验收波复查。

**如果 `affected_issues` 为空数组**，修复Agent必须在 `residual_risks` 中写入 `AFFECTED_ISSUES_EMPTY_CONFIRMED`，并说明“已检查当前轮次所有未闭合缺陷，无共享符号或依赖关系”。**不允许**静默返回空数组而不做确认——空数组必须是一个被检查过的结论，而不是“没看”。

#### 3.2 `residual_risks` 的枚举化标记

`residual_risks` 是一个字符串数组，但其中的每一条应当以**固定的标记前缀**开头，以便主Agent和验收Agent机械识别：

| 标记 | 含义 | 对验收波的影响 |
|---|---|---|
| `LARGE_PATCH` | 变更行数超过 10 行或跨多个生产文件 | 验收波必须追加回归扫描 |
| `PUBLIC_API_CHANGE` | 修改改变了公共接口签名或返回形状 | 验收波必须检查所有调用方 |
| `BASELINE_UNVERIFIED` | 修改前无法运行 `disproof_condition` | 验收波必须先确认基线可触发 |
| `TEST_CONFLICT` | 现有测试与正确修复矛盾，修复Agent未修改测试 | 验收波或人工必须裁决测试的取舍 |
| `IMPACT_UNVERIFIED` | 修复Agent无法判断影响范围 | 验收波必须为该修复追加独立回归扫描 |
| `OBSERVED_BUT_OUT_OF_SCOPE` | 修改过程中看到了范围外的问题 | 主Agent可据此在后续轮次派发新审计 |
| `ROLLBACK_UNAVAILABLE` | 无法提供可执行的 `rollback_command` | 主Agent必须标记该修复为高风险，验收失败时需人工回滚 |

**`IMPACT_UNVERIFIED` 的触发条件**：如果修复Agent修改了某个被切片外文件引用的符号，但它**没有读取**那些外部引用文件（因为读取范围受限于 `target_files` 和 `shared_dependencies`），它**必须**写入 `IMPACT_UNVERIFIED`。这比“声称影响范围很小”诚实得多，也直接触发验收波的回归扫描，符合 silent regression 防御的原则[^ref10]。


## 第 4 节：验证命令的纪律——辅助证据，不是验收结论

修复Agent的 `verification_commands` 必须满足以下格式和纪律：

```json
{
  "verification_commands": [
    {
      "command": "pytest tests/dispatch/test_pipeline.py::test_missing_agent -x",
      "result": "passed",
      "output_snippet": "1 passed in 0.42s",
      "directly_observes_defect": true
    }
  ]
}
```

**`directly_observes_defect` 的语义**：如果该命令的输出**直接**观察到了缺陷所声称的行为（或修复后该行为不再出现），标记 `true`。如果该命令只是通用测试套件的一部分，不直接瞄准该缺陷，标记 `false`。NeurIPS 的证据是：把测试预算花在**能瞄准故障的测试**上，比花在随机测试上有效得多；修复Agent自行编写并运行测试，如果没有瞄准缺陷，对验证几乎没有贡献[^ref11]。

**`result` 的枚举**：`passed` / `failed` / `not_run`。如果 `not_run`，必须在 `output_snippet` 中写明原因（例如 harness 不支持执行、依赖缺失、需要网络）。修复Agent**不得**将 `not_run` 伪装为 `passed`，也不得在 `failed` 的情况下继续返回 `SUCCESS`——如果验证命令失败且修复Agent无法在三次尝试内解决，它必须返回 `RETRYABLE_FAILURE` 或 `PERMANENT_FAILURE`，而不是带着失败的验证结果声称完成。

**三次尝试预算**：修复Agent对同一个 `finding_id` 最多执行**三次修改尝试**。一次尝试从代码/配置/测试期望发生变更时开始。只读检查不消耗预算。三次尝试后仍未通过 `disproof_condition`，修复Agent**必须**停止，返回 `PERMANENT_FAILURE`，并在 `error` 中写入 `attempts_exhausted: true` 和每次尝试的 `hypothesis` 与 `result` 摘要，而不是无限 patch-and-retry[^ref12]。


## 第 5 节：与 `handoff-schema` 的精确对接

修复Agent的返回不直接修改 Resume Packet；主Agent在接收并验证修复Agent的 `output-contract` 返回后，按以下规则更新 `handoff-schema` 的字段：

| 修复Agent返回字段 | 写入 Resume Packet 的位置 | 规则 |
|---|---|---|
| `files_touched` | `closed_waves[wave-4].artifact_paths` 的摘要中提及 | 只记录路径，不记录 diff 内容 |
| `affected_issues` | `open_items` 中新增 `kind: "AFFECTED_BY_FIX"` 条目 | 每一条 `affected_issues` 生成一个 `open_item`，`blocking: false`，`next_action: "REASSIGN_TO_VERIFY"` |
| `residual_risks` 中的 `LARGE_PATCH` / `PUBLIC_API_CHANGE` / `IMPACT_UNVERIFIED` | `open_items` 中新增 `kind: "REGRESSION_SCAN_REQUIRED"`，`blocking: true` | 阻止 wave-5 对该修复仅做单点验收；验收波必须包含回归扫描 |
| `residual_risks` 中的 `BASELINE_UNVERIFIED` | 写入对应 `open_item` 的 `summary`，并标记 `requires_baseline_confirmation: true` | 验收波第一步必须是基线确认 |
| `residual_risks` 中的 `TEST_CONFLICT` | `open_items` 中新增 `kind: "HUMAN_DECISION_REQUIRED"`，`blocking: true` | 不进入自动验收，等待人工裁决 |
| `residual_risks` 中的 `ROLLBACK_UNAVAILABLE` | `deferred_items` 中新增一条，`requires_human_intervention: true` | 验收失败时无法自动回滚，必须人工介入 |
| `verification_commands` | 不写入 Resume Packet | 验收Agent**不得**读取修复Agent的验证命令作为验收依据；验收必须独立执行 |

**关键纪律**：修复Agent的 `verification_commands` **不进入** Resume Packet 的 `open_items` 或 `closed_waves` 摘要，因为验收Agent一旦看到“修复Agent说已经通过了”，就会倾向于复述而不是独立验证。验收Agent只从 `handoff-schema` 中的 `finding_ref` 和**原始验收标准**出发，修复Agent的执行记录留在其 `artifact_path` 指向的文件中，只供审计追溯，不作为验收输入。


## 第 6 节：失败与重派的特殊规则

修复Agent的失败处理比发现波更严格，因为它是**有副作用的**子Agent。

**`RETRYABLE_FAILURE`**：

- 修复Agent返回 `RETRYABLE_FAILURE` 时，主Agent**不自动重派**修复Agent，而是先检查 `error.error_type`：
  - `Timeout` / `ToolError`：如果 `files_touched` 为空（未发生写入），可以重派一个新实例，携带原始 `finding_ref` 和验收标准，**不继承旧实例的 patch**；
  - `InputValidationError` / `SchemaViolation`：不重派，标记 `CONTRACT_VIOLATION`，将缺陷回退到 `open_items`，由主Agent决定是否重新派发锐评波或证据补采；
  - 如果 `files_touched` **非空**（已发生部分写入），主Agent**必须**先执行 `rollback_command`（如果可用），确认基线恢复后，再决定是否重派。如果 `rollback_command` 不可用，标记 `deferred_items` 并写入 `requires_human_intervention: true`。

**`PERMANENT_FAILURE`**：

- 三次尝试预算耗尽，或修复需要超出最小安全差异的重构。主Agent将缺陷写入 `open_items`，`kind: "PERMANENT_FAILURE"`，`blocking: true`，最终报告显式暴露“该缺陷未能修复”。**不得**将修复任务推给验收波或主线程。

**`CONTRACT_VIOLATION`**：

- 越权写文件、缺少 `affected_issues`、`verification_commands` 缺失或伪造、未登记 `rollback_command`。主Agent作废该修复Agent的全部输出，**必须**执行回滚（如果可执行），然后派一个**全新的修复Agent实例**从原始缺陷重新执行。旧实例的 `files_touched` 和 `verification_commands` 不得作为新实例的输入。


## 第 7 节：返回前的自检清单（修复Agent执行）

修复Agent在发出 `output-contract` 返回前，必须逐项确认：

| 检查 | 通过条件 | 失败动作 |
|---|---|---|
| 单缺陷边界 | 只修改了与 `finding_id` 直接相关的代码，未顺带修复其他缺陷 | 回退范围外修改，写入 `OBSERVED_BUT_OUT_OF_SCOPE` |
| 写权限边界 | `files_touched` 全部在 `target_files` 或对应测试文件内 | 回退越界修改，返回 `CONTRACT_VIOLATION` |
| 最小安全差异 | 变更 ≤10 行（或已在 `residual_risks` 标记 `LARGE_PATCH`） | 标记 `LARGE_PATCH` 或缩小修改 |
| 修复契约前置 | `disproof_condition`、`baseline_result`、`rollback_command` 已登记 | 补登记或返回 `RETRYABLE_FAILURE` |
| `affected_issues` 完整 | 覆盖共享符号/依赖的缺陷，或空数组已标记 `AFFECTED_ISSUES_EMPTY_CONFIRMED` | 补全或标记确认 |
| 影响半径诚实 | 无法验证影响范围时标记 `IMPACT_UNVERIFIED` | 补标记 |
| 验证命令可追溯 | `verification_commands` 非空，`result` 枚举合法，`not_run` 有原因 | 补全或返回 `RETRYABLE_FAILURE` |
| 不自我验收 | 返回中不声称“已修复”“验收通过” | 删除该表述 |
| 未修改测试以通过 | 未删除/跳过/弱化测试断言；冲突时标记 `TEST_CONFLICT` | 恢复测试或标记 `TEST_CONFLICT` |
| 尝试预算 | 尝试次数 ≤3 | 返回 `PERMANENT_FAILURE`，`attempts_exhausted: true` |

---

## 参考来源

[^ref0]: [Active Remediation — Mechanics](https://raw.githubusercontent.com/event4u-app/agent-config/refs/heads/main/docs/guidelines/agent-infra/active-remediation-mechanics.md#1)
[^ref1]: [sdd-parallel](https://pypi.org/project/sdd-parallel/)
[^ref2]: [break-ai-fix-loops](https://opensmartroute.ai/marketplace/sickn33-agentic-awesome-skills-break-ai-fix-loops)
[^ref3]: [Risk Management for Parallel Claude Code Agents on Desktop](https://callsphere.ai/blog/risk-management-for-parallel-claude-code-agents-on-desktop)
[^ref4]: [Silent Regressions: The Verification Gap in Coding Agents](https://neurips.cc/virtual/2026/loc/atlanta/171452)
[^ref5]: [Risk Management for Parallel Claude Code Agents on Desktop](https://callsphere.ai/blog/risk-management-for-parallel-claude-code-agents-on-desktop)
[^ref6]: [Active Remediation — Mechanics](https://raw.githubusercontent.com/event4u-app/agent-config/refs/heads/main/docs/guidelines/agent-infra/active-remediation-mechanics.md#1)
[^ref7]: [Silent Regressions: The Verification Gap in Coding Agents](https://neurips.cc/virtual/2026/loc/atlanta/171452)
[^ref8]: [Active Remediation — Mechanics](https://raw.githubusercontent.com/event4u-app/agent-config/refs/heads/main/docs/guidelines/agent-infra/active-remediation-mechanics.md#1)
[^ref9]: [break-ai-fix-loops](https://opensmartroute.ai/marketplace/sickn33-agentic-awesome-skills-break-ai-fix-loops)
[^ref10]: [Silent Regressions: The Verification Gap in Coding Agents](https://neurips.cc/virtual/2026/loc/atlanta/171452)
[^ref11]: [Silent Regressions: The Verification Gap in Coding Agents](https://neurips.cc/virtual/2026/loc/atlanta/171452)
[^ref12]: [break-ai-fix-loops](https://opensmartroute.ai/marketplace/sickn33-agentic-awesome-skills-break-ai-fix-loops)
