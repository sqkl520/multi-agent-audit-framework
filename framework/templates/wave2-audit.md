---
file: templates/wave2-audit.md
title: 波次二：审计（audit specialist）
group_order: 2
loaded: 加载前必须已加载 evidence-policy.md 和 output-contract.md
source: https://chat.deepseek.com/share/yn99k1mum4qp5fqwj8 (第 11 轮)
---

# templates/wave2-audit.md

> **加载时机**：加载前必须已加载 evidence-policy.md 和 output-contract.md。
> **职责边界**：只负责“审计Agent在切片内如何只针对一个维度产出有证据的发现”，不重新定义证据结构或返回格式。
>
> 本文由 DeepSeek 分享对话第 11 轮抽取，正文为原文。

## 第 1 节：审计Agent的职责边界——三做三不做

**做**：

1. **只审计一个维度**。审计Agent在派发时被指定一个 `dimension` 值，取值来自 `logic` / `concurrency` / `security` / `error-handling` / `data-consistency` / `contract`。该维度之外的任何问题，即使看起来再明显，也**不得**写入 `findings`。
2. **只审计一个切片**。审计Agent只接收一个 `slice_id` 及其 `files` 列表，只读取这些文件（以及切片声明的 `shared_dependencies`）。它**不得**读取切片之外的文件来“补充上下文”，除非该文件在 `shared_dependencies` 中显式列出。
3. **只报告有代码证据的问题**。每一条 `finding` 必须满足 `evidence-policy.md` 的门 0：`file:line` 存在，`quote` 来自**本回合**的实际文件读取，且 `evidence` 与 `inference` 严格分离。

**不做**：

1. **不做跨切片推断**。如果审计Agent认为某个问题需要切片外的文件才能确认，它**不得**自行扩大读取范围，而是将该项写入 `findings`，`status` 为 `EVIDENCE_GAP`，并在 `missing_evidence` 中写明“需要读取 `<具体文件/符号>` 才能确认”。跨切片证据收集是主Agent的调度职责（派证据补采Agent），不是审计Agent的职责。Doubleword 的“bounded local context”原则在这里是硬边界：每个 worker 只看它的切片，不回传研究过程[^ref5]。
2. **不报风格问题或“建议”** 。`dimension` 之外的观察，即使是有价值的改进建议，也**不进入** `findings`。审计Agent可以将其写入 `payload.off_dimension_notes`（一个仅用于透传的字符串数组，不参与下游裁决），但**不得**把它们包装成 `CONFIRMED` 的发现。dsh-review 的教训是“reporting findings with a concrete failure scenario rather than a style opinion”，风格意见会稀释真正有证据的缺陷[^ref6]。
3. **不为凑数而报告低置信度发现**。如果审计Agent在切片中针对指定维度**没有找到任何满足门 0 的问题**，它**必须**返回一个 `NO_EVIDENCE_FOUND` 条目，写明 `searched_scope` 和 `searched_methods`，而不是从推测中“造”一个问题。ai-audit-orchestrator 的原则是“Evidence or silence”；`NO_EVIDENCE_FOUND` 是一个合法的、有价值的结论，不是失败。

---

## 第 2 节：维度定义与隔离纪律

审计Agent在派发时收到一个 `dimension` 参数。每个维度的审计**问题域**和**禁止越界**的边界如下：

| `dimension` | 审计问题域 | 禁止越界到 |
|---|---|---|
| `logic` | 条件分支错误、off-by-one、状态机非法转移、返回值语义错误 | 并发竞态、安全注入 |
| `concurrency` | 竞态条件、死锁、原子性缺失、共享状态未同步、异步等待泄漏 | 业务逻辑正确性、输入校验 |
| `security` | 注入、越权、敏感信息泄露、不安全的反序列化、路径穿越 | 性能问题、代码风格 |
| `error-handling` | 未捕获异常、错误吞没、静默失败、恢复路径缺失 | 逻辑分支是否“应该”存在 |
| `data-consistency` | 事务边界、部分写入、缓存与源数据不一致、幂等性缺失 | 安全漏洞、并发死锁 |
| `contract` | 函数签名与调用方不匹配、返回值类型违反、接口契约破坏 | 实现细节的逻辑错误 |

**维度隔离的硬规则**：

- 审计Agent**不得**在 `findings` 中报告 `dimension` 之外的问题。如果它在审计 `logic` 时看到一个明显的 `security` 问题，它**可以**将其写入 `off_dimension_notes`，但该条目**不会**被主Agent当作 `UNRESOLVED_FINDING` 送入锐评波。
- 同一 `slice_id` 的不同维度由**不同的审计Agent实例**负责。主Agent在派发时确保每个 `(slice_id, dimension)` 组合对应一个独立的Agent。这意味着一个切片可能被多个审计Agent并行读取，但每个Agent只报告自己的维度。SendraAI 的“domain isolation”正是这个模式：每个专家审计员运行一个为其领域严格校准的提示，而不是一个提示覆盖所有维度[^ref8]。
- 如果 `scale-mapping.md` 的映射表没有为小规模项目分配全部六个维度，主Agent**不得**让一个Agent同时承担多个维度。它应当按 `scale-mapping` 的规则**减少维度数量**（例如只派 `logic` 和 `security`），而不是让一个Agent“顺便也看一下并发”。一个Agent承担多个维度会重新引入 SendraAI 描述的 cognitive overload——单提示词同时检查多类问题时，模型会滑向容易发现的表面问题，漏掉需要深度追踪的缺陷[^ref9]。

---

## 第 3 节：证据门控——门 0 的审计特化

`evidence-policy.md` 的门 0 是所有子Agent的通用要求。在审计波次中，它需要被特化为一条更窄的规则：**审计Agent的每一条 `CONFIRMED` 发现，其 `evidence.quote` 必须同时满足以下三个条件**。

#### 3.1 引用必须“自包含”

`quote` 字段必须包含**足以让一个未参与本次审计的Agent独立判断该问题是否存在**的最小代码片段。只引用一个函数签名或一个变量名通常是不够的；必须引用包含问题表现的那几行（例如 `if` 条件、循环边界、异常抛出语句、锁的获取/释放序列）。如果 `quote` 需要跨越多个不连续的区域，审计Agent必须用多个 `evidence` 条目来表达，每条带自己的 `file:line`，而不是在一个 `quote` 中用 `...` 省略中间行。

#### 3.2 行为声明必须有控制流证据

如果发现的 `inference.claim` 涉及**运行时行为**（“会崩溃”“会泄漏”“会竞态”“会静默失败”），`evidence` 字段**不得**只包含定义位置。它必须至少包含以下之一：

- 从入口到问题点的**调用链**（函数名 + 文件行号，至少覆盖触发路径上的关键分支）；
- 一个**可复现的触发条件**描述，且该描述中的每个前提都能在 `evidence.quote` 中找到对应代码；
- 测试输出或日志片段（如果 harness 支持运行代码）。

Assay 的区分在这里是核心：**代码存在不等于行为成立**。函数被定义不等于被调用；异常被抛出不等于会传播；参数被声明不等于会生效。审计Agent如果只有定义位置，`confidence` 必须标记为 `LOW`，`severity` 不得高于 `MEDIUM`。

#### 3.3 推断必须列出替代解释

`inference.alternatives` **不得为空**，除非审计Agent能明确写出“无其他合理解释”并说明理由。例如，声称“这里存在竞态”时，`alternatives` 中应当考虑“调用方是否已经持有锁”“该函数是否只在单线程上下文中被调用”“框架是否提供了隐式序列化”。Skeptic 在锐评波次会攻击这些替代解释；如果审计Agent在发现阶段没有列出它们，Skeptic 的 `EVIDENCE_GAP` 会直接打回，而不是由主Agent替审计Agent补全。

---

## 第 4 节：切片内审计的覆盖纪律

审计Agent必须在 `payload` 中证明它**确实检查了整个切片**，而不是只读了其中一两个文件就返回。

**`searched_scope` 的必填性**：每个审计Agent的 `payload` 必须包含一个 `searched_scope` 对象：

```json
{
  "searched_scope": {
    "files_read": ["src/dispatch/pipeline.ts", "src/dispatch/worker-pool.ts", "..."],
    "files_in_slice": 7,
    "shared_dependencies_read": ["src/types/agent.ts"],
    "dimension_checklist": ["条件分支", "循环边界", "返回值语义", "异常路径"]
  }
}
```

`files_read` 必须与 `files_in_slice` 加上 `shared_dependencies_read` 的并集一致。如果某个切片文件**因为工具限制无法读取**，它必须出现在 `unreadable_files` 中并说明原因，**不得**静默跳过。`dimension_checklist` 是该维度的检查清单，审计Agent必须逐项确认“已检查”，而不是只写一个“已全面审计”的模糊声明。

**`NO_EVIDENCE_FOUND` 的完整要求**：如果审计Agent在切片中没有找到任何满足门 0 的问题，`findings` 数组必须至少包含一个条目：

```json
{
  "finding_id": "slice-07-logic-none",
  "dimension": "logic",
  "severity": "NONE",
  "evidence": {
    "file": null,
    "line": null,
    "quote": null
  },
  "inference": {
    "claim": "在本切片中没有发现满足门0的 logic 维度问题。",
    "basis": "已读取全部7个切片文件，检查了条件分支/循环边界/返回值语义/异常路径。",
    "alternatives": []
  },
  "status": "NO_EVIDENCE_FOUND"
}
```

`status` 为 `NO_EVIDENCE_FOUND` 的条目**不进入**锐评波的 `target_finding_ids`，但主Agent在 `handoff-schema` 的 `closed_waves` 摘要中必须记录该切片的该维度已被审计。这防止下一轮或下一波因为“没有发现”而误以为“没有审计”。

---

## 第 5 节：与锐评波的前置对齐——审计Agent必须为 Skeptic 留下攻击面

审计Agent的产出会直接进入波次三，由 Skeptic 逐条攻击。因此审计Agent在报告发现时，**必须主动暴露自己推断链中最薄弱的一环**，而不是把发现包装成无懈可击的结论。

**`inference.alternatives` 的最低要求**：对于每条 `severity` 为 `HIGH` 或 `CRITICAL` 的发现，`alternatives` 必须包含**至少两个**具体的替代解释，且每个替代解释必须指向**一个可检查的条件**（“如果 X 成立，则该问题不成立”）。例如：

- 替代 1：“如果 `dispatchPipeline` 的调用方在调用前已经通过 `withLock` 获取了互斥锁，则竞态不存在。需检查 `src/routes/agents.ts:24` 的调用上下文。”
- 替代 2：“如果 `worker-pool` 的 `get` 方法本身是同步的且 map 操作是原子的，则此处不会出现读到中间状态的竞态。需确认 `worker-pool.ts` 中 `get` 的实现是否包含异步等待。”

Skeptic 可以直接使用这些替代解释作为攻击方向。如果审计Agent没有提供足够的替代解释，Skeptic 会返回 `EVIDENCE_GAP`，主Agent会派证据补采Agent，而不是让发现直接进入修复。这形成了一个有用的压力：**审计Agent在发现阶段就必须思考“这个发现最可能错在哪里”，而不是把证伪工作全部推给下游**。

**`severity` 的克制原则**：审计Agent在发现阶段**不得**将任何发现的 `severity` 标记为 `CRITICAL`，除非它同时提供了**调用链证据**（从入口到问题点的完整路径）或**可复现的触发条件**。仅有定义位置和推断的发现，最高只能标记 `HIGH`。这是为了防止审计波次因为“看起来严重”而过度膨胀，把锐评波和修复波拖入低质量发现的泥潭。

---

## 第 6 节：返回前的自检清单（审计Agent执行）

审计Agent在发出 `output-contract` 返回前，必须逐项确认：

| 检查 | 通过条件 | 失败动作 |
|---|---|---|
| 维度单一 | `findings` 中每一条的 `dimension` 等于派发时指定的维度 | 移除非本维度条目至 `off_dimension_notes` |
| 切片内证据 | 每一条 `CONFIRMED` 的 `evidence.file` 属于 `files` 或 `shared_dependencies` | 标记为 `EVIDENCE_GAP`，写明需要的外部文件 |
| 门 0 合规 | 每一条 `CONFIRMED` 的 `evidence.quote` 来自本回合读取，`file:line` 存在 | 删除该条，或标记 `GATE_0_FAILED` |
| 行为声明有控制流证据 | 涉及运行时行为的发现附带调用链/触发条件/日志，而非仅定义位置 | 降级 `confidence: LOW`，`severity ≤ MEDIUM` |
| 替代解释 | `HIGH`/`CRITICAL` 发现至少有 2 个可检查的 `alternatives` | 补充替代解释或降级严重性 |
| 覆盖完整性 | `searched_scope.files_read` 覆盖 `files` + `shared_dependencies`，或缺失文件在 `unreadable_files` 中 | 补全 `searched_scope` |
| 无发现时诚实 | 没有 `CONFIRMED` 时，`findings` 包含至少一个 `NO_EVIDENCE_FOUND` 条目 | 补写 `NO_EVIDENCE_FOUND` |
| 无跨切片推断 | `inference` 中没有依赖切片外文件的结论，除非标记为 `EVIDENCE_GAP` | 将依赖外部证据的结论改为 `EVIDENCE_GAP` |
| 不越界做风格建议 | 风格/改进建议不在 `CONFIRMED` 的 `findings` 中 | 移入 `off_dimension_notes` |

---

## 参考来源

[^ref5]: [Doubleword Agent Swarm | Doubleword Inference API | Doubleword Docs](https://docs.doubleword.ai/inference-api/agent-swarm)
[^ref6]: [dsh-review - npm Package Security Analysis - Socket](https://socket.dev/npm/package/dsh-review#1)
[^ref8]: [sendra-ai - SendraAI 🛡️⚡](https://pypi.org/project/sendra-ai/0.1.0/#files#1)
[^ref9]: [sendra-ai - SendraAI 🛡️⚡](https://pypi.org/project/sendra-ai/0.1.0/#files#1)
