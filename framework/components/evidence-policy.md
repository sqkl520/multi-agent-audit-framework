---
file: components/evidence-policy.md
title: 证据基线（门 0）
group_order: 1
loaded: 所有子Agent（侦察/审计/锐评/修复/验收）在产出任何发现前加载
source: https://chat.deepseek.com/share/yn99k1mum4qp5fqwj8 (第 7 轮)
---

# components/evidence-policy.md

> **加载时机**：所有子Agent（侦察/审计/锐评/修复/验收）在产出任何发现前加载。
> **职责边界**：与任何模板指令冲突时，以本文件为准。违反本文件的发现一律判定为 CONTRACT_VIOLATION。
>
> 本文由 DeepSeek 分享对话第 7 轮抽取，正文为原文。

## 第 1 节：门 0——反捏造前置检查（不可跳过）

在子Agent发出**任何**结论之前，必须先执行门 0。这是所有其他检查的前置条件，未通过则不得进入后续任何步骤。

**门 0 的操作定义**：

如果子Agent要报告一个问题，它必须在本回合的输出中**逐字回显**它所判断的源产物：

- **代码发现**：回显 `file:line` 以及该行（或该符号）的**原文引用**，且该引用必须来自**本回合**的文件读取，不得来自会话早期的记忆、训练数据或“根据架构推测”。
- **配置/依赖发现**：回显配置文件中的确切键值对或依赖声明行。
- **行为声明**：回显支撑该行为判断的调用链、测试输出或日志片段，**不能只引用函数定义位置**。

**门 0 的失败条件**（任一即触发）：

- 引用来自“记忆”而非本回合读取；
- 引用使用模糊表述（“大致在 line 42”“应该在 dispatch 方法里”）；
- 行为声明只有定义位置，没有控制流证据；
- 回显的原文与子Agent声称的问题不一致（例如声称有竞态，但引用的代码是纯同步的）。

**门 0 失败的处理**：子Agent不得输出该发现，必须在 `findings` 中写入 `{"status": "GATE_0_FAILED", "reason": "<具体原因>"}`，主Agent据此判定为 `CONTRACT_VIOLATION`。

---

## 第 2 节：证据与推断的强制分离

子Agent产出的每一条发现，其内部结构必须包含明确的 **Evidence** 与 **Inference** 两个字段，**不允许将二者混写在同一段叙述中**。这是 codebase-audit 规范的核心要求：所有主张必须可被读者机械地区分为“看到了什么”和“得出了什么结论”。

**Evidence 字段的准入标准**：

证据必须是**可直接观察的事实**，至少满足以下一项：

- 文件路径 + 行号 + 原文引用（`path/to/file.ext:line` 或 `start-end`）[^ref8]；
- 符号名（函数/类/方法签名）+ 定义位置；
- 配置键 + 值；
- 测试或 fixture 的引用；
- 日志/输出的原文片段（适用于运行行为声明）。

**Evidence 字段的禁止内容**：

- “这段代码看起来会……”；
- “根据架构，这里应该……”；
- “可能”“大概”“通常”等未绑定到具体引用的推测性语言。

**Inference 字段的准入标准**：

推断必须**在逻辑上从 Evidence 可推导**，并且必须**可被新证据推翻**。如果存在多种合理解释，Inference 字段必须列出所有合理解释，而不是只选一个最“像 bug”的。

**结构要求**：

```json
{
  "evidence": {
    "file": "src/dispatch/pipeline.ts",
    "line": 64,
    "quote": "const worker = this.workers.get(agentId);\nif (!worker) throw new Error(`Agent \"${agentId}\" not found`);"
  },
  "inference": {
    "claim": "当 agentId 不存在时，dispatch 会同步抛出未捕获的异常，而不是返回错误状态。",
    "basis": "第 64–65 行的代码路径在 if (!worker) 分支中直接 throw，且该函数签名未声明 throws 或返回 Result 类型。",
    "alternatives": ["如果上层调用方有全局异常捕获中间件，实际影响可能被缓解。"]
  }
}
```

---

## 第 3 节：运行时行为声明的特殊规则

这是证据策略中最容易被违反、也最需要硬约束的部分。Assay 和 Evidence Rules 都明确区分了“代码存在”与“代码行为”：**函数被定义不等于被调用；异常被抛出不等于会传播；参数被声明不等于被生效**；配置项存在不等于会被读取。

**规则**：任何关于运行时行为的发现（崩溃、数据泄露、竞态、静默失败、性能退化等），其 Evidence 字段**不得仅包含定义位置**，必须至少包含以下之一：

1. **调用链证据**：从入口到该代码路径的实际调用序列（函数名 + 文件行号）；
2. **测试输出**：运行测试或复现步骤后的实际输出片段；
3. **日志片段**：可证明该路径在运行时被触达的日志；
4. **控制流证据**：条件分支、异常传播路径、并发原语的等待/唤醒关系。

如果子Agent无法提供上述任一证据，它**可以**报告一个“怀疑但未证实”的问题，但必须将 `confidence` 标记为 `LOW`，并在 `inference` 中明确写出“缺少运行时证据”以及“什么检查可以证实/证伪”。这类发现**不得**在发现波中标记为 `HIGH` 或 `CRITICAL` 严重性。

---

## 第 4 节：缺失证据时的 UNKNOWN 纪律

“不知道”是合法且必须被显式记录的状态，**不得用推测填充空白**[^ref14]。

**规则**：

- 如果子Agent无法读取某个文件（权限、路径不存在、工具失败），它**必须**写入 `{"status": "UNREADABLE", "target": "<path>", "reason": "<工具返回的错误>"}`，**不得**猜测该文件的内容。
- 如果子Agent在某个切片中**没有发现任何有证据支撑的问题**，它**必须**输出 `{"status": "NO_EVIDENCE_FOUND", "searched_scope": "<实际检查的文件范围>", "searched_methods": ["grep pattern", "file_read"]}`。这是一个合法的、有价值的结论，**不是失败**。没有发现不等于没查，但必须证明“查过了”[^ref16]。
- 如果某个问题的一部分有证据、另一部分依赖推断，必须在 `inference.alternatives` 中显式列出不确定分支，**不得**将不确定部分写成确定结论。

---

## 第 5 节：证据锚定格式——`file:line` 的精确性要求

所有引用必须遵循 `path/to/file.ext:line` 或 `path/to/file.ext:start-end` 的格式，**禁止**使用 `~42`、`约 line 42`、`在 dispatch 方法附近` 等模糊表述[^ref18]。

**行号验证**：子Agent在引用行号前，必须实际读取该文件并确认行号与内容对应。如果文件在读取后发生变化（例如其他Agent正在修改），以**本回合实际读到的内容**为准，并在 Evidence 中记录读取时的文件哈希或 `git diff` 摘要（如果 harness 支持），以便下游Agent判断证据是否仍然新鲜。

**多行引用的边界**：引用一个代码块时，必须同时给出起始行和结束行，且引用内容**不得省略中间行**（用 `...` 省略可能导致上下文丢失，使下游无法验证推断的合理性）。

---

## 第 6 节：证据合规的机械检查（供锐评波与验收波使用）

这个文件不仅约束发现者，也为下游的 Skeptic 和 Arbiter 提供了一个**可机械执行的检查清单**。下游Agent在评估一条发现时，按以下顺序检查，任一失败即标记该发现为 `EVIDENCE_INSUFFICIENT`：

| 检查项 | 通过条件 | 失败含义 |
|---|---|---|
| 门 0 回显 | 存在本回合读取的原文引用 | 反捏造失败，发现作废 |
| Evidence 可定位 | `file:line` 存在且引用内容与该行匹配 | 证据不可验证 |
| Evidence/Inference 分离 | 两个字段独立存在，推断未混入证据 | 结构违规 |
| 推断可推翻性 | `inference.alternatives` 非空或明确标注“无其他合理解释” | 推断过度自信 |
| 运行时证据（如适用） | 行为声明附带调用链/测试/日志，而非仅定义 | 行为声明未证实 |
| UNKNOWN 诚实性 | 无证据处标记为 UNKNOWN，未用推测填充 | 隐藏不确定性 |

**Skeptic 的专用权限**：Skeptic 可以要求“证据补采”——如果它认为某条发现的 Evidence 不充分，可以向主Agent返回 `{"status": "EVIDENCE_GAP", "finding_id": "<id>", "missing": "<具体缺少什么>"}`，主Agent据此派发一个**证据补采Agent**，而不是由 Skeptic 自己下场补证据，也不是由主Agent判断“够不够”。

---

## 第 7 节：失败模式速查

| 失败模式 | 示例 | 判定 |
|---|---|---|
| 记忆冒充证据 | 引用上一轮会话中读过的代码，本回合未重新读取 | `CONTRACT_VIOLATION` |
| 定义代替行为 | “函数 X 会抛异常”但只引用了 `def X` | 运行时声明未证实，降级为 `LOW` |
| 模糊锚定 | “大约在 line 42” | 门 0 失败 |
| 推断伪装证据 | “这里明显有竞态”但没有引用并发原语 | Evidence 字段不合规 |
| 沉默代替 UNKNOWN | 没发现问题就不写任何输出 | 缺少 `NO_EVIDENCE_FOUND`，视为未完成 |
| 回显与声明不一致 | 声称有注入，引用的代码是静态常量 | 门 0 失败，发现作废 |

---

---

## 参考来源

[^ref8]: [Orchestration Schemas (the review runtime's data contracts)](https://raw.githubusercontent.com/pedrohcgs/claude-code-my-workflow/refs/heads/main/.claude/references/orchestration-schemas.md#1)
[^ref14]: [phionyx-pipeline-mcp / 用 AI 扫 AI：一个把"证据链"当底线的 Agent 代码安全扫描器 - 448](https://pypi.org/project/phionyx-pipeline-mcp/0.1.0/#files#1)
[^ref16]: [Orchestration Schemas (the review runtime's data contracts)](https://raw.githubusercontent.com/pedrohcgs/claude-code-my-workflow/refs/heads/main/.claude/references/orchestration-schemas.md#1)
[^ref18]: [Orchestration Schemas (the review runtime's data contracts)](https://raw.githubusercontent.com/pedrohcgs/claude-code-my-workflow/refs/heads/main/.claude/references/orchestration-schemas.md#1)
