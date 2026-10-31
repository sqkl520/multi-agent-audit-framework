---
file: templates/wave3-critique.md
title: 波次三：锐评（critique panel）
group_order: 3
loaded: 加载前必须已加载 handoff-schema.md 和 output-contract.md
source: https://chat.deepseek.com/share/yn99k1mum4qp5fqwj8 (第 13 轮（第 6 节由第 14 轮补全）)
---

# templates/wave3-critique.md
`templates/wave3-critique.md` 是整个审计链路中**唯一专门用于“杀死发现”的波次**。它的设计前提是一个反直觉的实证结论：朴素的多Agent审查并不会自动提升质量，反而会暴露一种 **false-consensus failure mode**——Agent 们在没有足够证据的情况下倾向于互相认同；只有把“分歧”显式地、结构化地、证据锚定地加进去，才能在 SWE-PRBench 上达到最高的 F1。因此，这个波次的任务不是“再多找一些缺陷”，而是对波次二的每一条 `CONFIRMED` 发现执行**有结构的对抗**，把证据不足的发现拦在修复波之前。


## 文件头部：强制加载与波次定位

> wave3-critique.md
> 锐评Agent（critique panel）专属模板。
> 加载本模板前，必须已加载 handoff-schema.md 和 output-contract.md。
> 本模板与 handoff-schema / output-contract 冲突时，以两者为准；
> 本模板只负责“三种锐评子角色如何攻击、补盲和裁决”，
> 不重新定义波次传递结构（由 handoff-schema 定义）或返回格式（由 output-contract 定义）。
> 锐评Agent的返回必须符合 output-contract.md 的 role: "critique" payload schema。
> 本波次不产生新的代码修改，不读取修复Agent的任何说明。

**波次定位**：锐评波只消费 `handoff-schema` 中 `open_items` 的 `kind: "UNRESOLVED_FINDING"` 和 `kind: "EVIDENCE_GAP"` 条目，以及 `closed_waves[wave-2]` 中标记为 `CONFIRMED` 的发现。它**不重新执行审计**，不扩大读取范围到切片之外，除非为了验证某条发现的可触发性而必须打开调用方或包装层——这种打开是**有边界的验证读取**，不是新的发现探索。


## 第 1 节：三种子角色的职责边界——互斥、不重叠、不越界

锐评Agent在派发时收到一个 `critique_role` 参数，取值只能是 `skeptic`、`devils_advocate` 或 `arbiter`。三种角色**不混合**，每个Agent实例只承担一种角色。

#### 1.1 Skeptic：攻击可触发性，默认“未证明”

Skeptic 的默认答案对每一条发现都是 **“not proven”**。它的唯一使命是**杀死站不住的发现**，而不是确认它们。`rt-skeptic` 的设计原则可以概括为一句话：**Skeptic 是唯一以“移除了多少”来衡量的角色；如果它确认了所有发现，这个 session 对它是失败的**[^ref1]。

Skeptic 的**五步证据测试**直接来自 `rt-skeptic` 的验证协议，必须逐条执行[^ref2]：

1. **证据存在吗？** 打开 `file:line`，自己读。许多主张死在这一步。
2. **证据支持主张吗？** 上下文中的一行“看起来错”的代码，在上下文中往往是正确的。
3. **路径可达吗？** 没有调用方能够到达的缺陷不是缺陷。
4. **已经处理过了吗？** 读调用方、包装器、校验逻辑、框架。保护往往在上一层。
5. **失败链成立吗？** 逐步走。一步断了，整条链就死了。

**Skeptic 的“缝隙”职责**：其他审计Agent每人都只拥有一个维度，因此**没有人拥有两个维度之间的空间**。Skeptic 拥有这个空间。在判断完所有主张之后，它必须额外检查三类“缝隙缺陷”[^ref3]：

- 需要**两个维度同时作用**才能触发的缺陷（因此单一维度的审计Agent错过了它）；
- 只有在**两条发现组合**时才出现的缺陷；
- 一个审计Agent提出的修复会**破坏另一个维度所拥有的不变量**（虽然修复尚未发生，但该发现的 `inference.alternatives` 中如果隐含了这种风险，Skeptic 应当标记）。

**Skeptic 的五个“不可自信”领域**：在以下五个领域，错误的 `refuted` 会**静默删除一个真实缺陷**，而且没有人会知道它被丢弃了。Skeptic 在这些领域**只有能够直接引用一行与之矛盾的代码时，才可以裁决 `refuted`**；任何弱于“直接矛盾”的证据，裁决必须是 `holds`[^ref4]：

| 领域 | 为什么 Skeptic 不能自信 |
|---|---|
| 内存安全 | 分配大小、缓冲区长度、索引边界、off-by-one、use-after-free、空指针解引用 |
| 并发 | 锁与锁模式、原子操作、数据竞争、代码并未遵守的同步论证 |
| 声明一致性 | 声明与定义不一致、可见性或链接方式变化、缺少导出 |
| 行为/兼容性变更 | 旧代码产生的消息、字段、状态或默认值，新代码不再产生；错误路径改变；计数器更新位置移动 |
| 函数接受但从未使用的参数 | 这类参数往往是一个未完成的接入，而不是无害的遗留 |

#### 1.2 Devil's Advocate：指出未覆盖模块，攻击“没有发现”不等于“没有问题”

Devil's Advocate 不攻击已报告的发现。它的任务是**攻击审计波次的覆盖完整性**：找出那些**没有任何切片覆盖、或切片覆盖了但审计Agent没有实际读取**的模块，并判断这些未覆盖区域是否可能隐藏高严重性问题。Devil's Advocate 对抗的是 **“absence of evidence” 被当作 “evidence of absence”** 的风险。

`devils-advocate` 和 `ce-devils-advocate` 的职责描述都明确包含 **coverage gaps** 和 **evidence gaps**：它不是去重复已报告的问题，而是去挑战“清理和测试提案”中的**隐藏风险、弱证据和覆盖回归**[^ref5]。在这个波次中，“清理和测试提案”的对应物就是审计波次的覆盖结论。

**Devil's Advocate 必须执行的覆盖扫描**：

1. **切片级集合差**：读取 `handoff-schema` 的 `closed_waves[wave-1].artifact_paths` 中侦察Agent的切片清单，对照 `closed_waves[wave-2]` 中实际被审计的 `slice_id` 集合。任何在 wave-1 中存在但 wave-2 中没有对应审计记录的 `slice_id`，立即标记为 `COVERAGE_GAP`。
2. **文件级读取差**：对于每一个被审计的切片，检查审计Agent返回的 `searched_scope.files_read` 是否覆盖了该切片的全部 `files` 和 `shared_dependencies`。如果有文件未被读取且未出现在 `unreadable_files` 中，标记为 `PARTIAL_COVERAGE`。
3. **维度级遗漏**：检查 `scale-mapping` 的 `critique_roles` 和实际派发的审计维度。如果某个 `dimension` 在小规模项目的映射中被合并或省略，Devil's Advocate 必须评估被省略的维度是否可能隐藏高严重性问题。它**不自行审计**，而是输出 `DIMENSION_GAP`，由主Agent决定是否在后续轮次补派审计。
4. **入口点未覆盖**：对照侦察Agent返回的 `entry_points`，检查每一个入口是否最终映射到了某个被审计的切片中的代码路径。如果某个入口的 `next_hop` 落在未审计或未被读取的文件中，标记 `ENTRY_UNCOVERED`。

**Devil's Advocate 的产出纪律**：它**不报告具体的代码缺陷**。它只报告**覆盖缺口**，每条缺口必须指向具体的 `slice_id`、`file`、`dimension` 或 `entry_id`，并给出一个**可检查的理由**：“这个区域没有被任何审计Agent的 `searched_scope` 覆盖，因此任何在该区域的缺陷都不可能被波次二发现。”

#### 1.3 Arbiter：裁决维持/降级/撤销，不新增发现，不亲自审计

Arbiter 是锐评波的**终局裁决者**。它的输入是 Skeptic 的 `verdicts`（`refuted` / `holds` / `untested`）和 Devil's Advocate 的 `coverage_gaps`，以及波次二的原始发现。Arbiter **不重新执行审计**，不打开新的文件来“自己找证据”，它只在**双方已经提交的证据**基础上做出裁决。`adversarial-review-gate` 的 roundtable 模式明确将仲裁者定义为 **“clean-context judge”**： specialist seats 各自发现和攻击，由一个**干净的上下文**来做裁决[^ref7]。Arbiter 实例在派发时**不携带任何先前波次的倾向性上下文**，它只看到证据包。

**Arbiter 的裁决枚举与语义**：

| 裁决 | 触发条件 | 对下游的影响 |
|---|---|---|
| `UPHELD` | Skeptic 返回 `holds`（尝试反驳但失败），或 Skeptic 返回 `untested` 但 Devil's Advocate 未对该发现所在区域标记覆盖缺口，且 Arbiter 确认证据满足 `evidence-policy` 的最低结构要求 | 进入修复波；`handoff-schema` 中 `conflicts.resolution` 写 `UPHELD`，`arbiter_artifact_ref` 必填 |
| `DOWNGRADED` | Skeptic 返回 `holds`，但 Arbiter 认为 `severity` 被高估（例如 `CRITICAL` 发现只提供了定义位置证据，没有调用链证据），或 Skeptic 指出该发现依赖的某个替代解释虽然未被完全排除，但使其影响范围显著缩小 | 仍然进入修复波，但 `severity` 按裁决结果降级；修复Agent的验收标准以降级后的严重性为准 |
| `REVOKED` | Skeptic 返回 `refuted` 且提供了直接矛盾的代码证据；或 Skeptic 返回 `untested` 且 Arbiter 确认该发现**依赖切片外证据**但审计Agent未标记 `EVIDENCE_GAP`（即审计Agent越界做了跨切片推断） | 不进入修复波；该发现从 `open_items` 中移除，`conflicts.resolution` 写 `REVOKED` |
| `EVIDENCE_GAP` | Arbiter 认为双方证据不足以做出 `UPHELD` / `DOWNGRADED` / `REVOKED` 中的任何一个，**且**缺口是可补采的（例如缺少某个调用方的读取） | **Arbiter 不得直接输出 `EVIDENCE_GAP` 作为终局裁决**（见第 4 节的约束）；Arbiter 必须返回 `RETRYABLE_FAILURE`，并在 `error` 中写明需要补采的具体证据，由主Agent派证据补采Agent |

**Arbiter 的“干净上下文”规则**：Arbiter 的 `payload` 中**不得**包含 Skeptic 或 Devil's Advocate 的完整叙述正文，只包含结构化的 `verdicts` 和 `coverage_gaps` 字段，以及原始发现的 `evidence` / `inference` 结构。如果 Arbiter 的返回中出现了“根据 Skeptic 的论述……”或“Devil's Advocate 认为……”这类引用对方叙述的表述，而不是直接引用证据，主Agent判定为 `CONTRACT_VIOLATION`。`saalis` 的治理层设计也强调了 **explainability 和 audit logging** 应当基于结构化的裁决记录，而不是自由文本[^ref8]。


## 第 2 节：Skeptic 的操作协议——五步测试的机械执行

Skeptic 对每一条 `finding_id` 必须执行五步测试，并在 `payload.verdicts` 中返回结构化的结果。**不允许**跳过任何一步，**不允许**用“整体看起来没问题”替代逐步执行。

#### 2.1 每一步的输出要求

| 步骤 | 必须返回的字段 | 如果失败 |
|---|---|---|
| 1. 证据存在 | `evidence_opened: true/false`，附 `file:line` 和本回合读取的 `quote` | `evidence_opened: false` → 该发现立即 `refuted`，`reason: "EVIDENCE_NOT_FOUND"` |
| 2. 证据支持主张 | `evidence_supports_claim: true/false`，附一句解释 | `false` → `refuted`，`reason: "EVIDENCE_MISMATCH"` |
| 3. 路径可达 | `path_reachable: true/false/untested`，附调用链或说明为什么不可达 | `false` → `refuted`，`reason: "UNREACHABLE"`；`untested` 需说明缺少什么才能判断 |
| 4. 已被处理 | `already_handled: true/false/untested`，附调用方/包装器/框架层的 `file:line` | `true` → `refuted`，`reason: "HANDLED_UPSTREAM"` |
| 5. 失败链成立 | `failure_chain_holds: true/false`，逐步列出每一步的引用 | 任何一步断裂 → `refuted`，`reason: "CHAIN_BROKEN"`，并指出断裂的步骤 |

**`untested` 的严格语义**：只有当 Skeptic **无法访问**所需的代码（切片外、工具限制）且该证据**不在** Devil's Advocate 的覆盖扫描范围内时，才允许返回 `untested`。`untested` **不等于 `refuted`**；它的下游处理由 Arbiter 根据覆盖情况决定。`rt-skeptic` 的原文是：“Unverifiable is not…”——即不可验证不等于被反驳，这两者必须严格区分[^ref9]。

#### 2.2 五个“不可自信”领域的特殊规则

当 `finding_id` 属于内存安全、并发、声明一致性、行为/兼容性变更、或未使用参数这五个领域时，Skeptic 的 `refuted` 裁决**必须**附带 `direct_contradiction` 字段，内容是一行**直接与主张矛盾**的代码引用。如果找不到这样一行，`verdict` 必须为 `holds` 或 `untested`，**不得**为 `refuted`。这条规则是为了防止 Skeptic 在它最不擅长的领域“自信地”删除真实缺陷[^ref10]。


## 第 3 节：Devil's Advocate 的操作协议——覆盖缺口的枚举

Devil's Advocate 的 `payload` 中 `coverage_gaps` 数组的每一条必须包含以下字段：

```json
{
  "gap_id": "gap-001",
  "kind": "SLICE_UNCOVERED | FILE_UNREAD | DIMENSION_OMITTED | ENTRY_UNCOVERED",
  "target": "slice-07 | src/dispatch/worker-pool.ts | concurrency | entry-http-post-agents",
  "evidence": {
    "source": "handoff-schema.closed_waves[wave-2]",
    "observation": "slice-07 在 wave-1 中存在，但 wave-2 中没有对应 slice_id 的审计记录。"
  },
  "potential_impact": "该切片包含 6 个文件，全部涉及 worker 池的锁管理，若未被审计，并发维度的缺陷可能完全遗漏。",
  "recommended_action": "REASSIGN_TO_NEW_AUDIT | REQUEST_EVIDENCE_RECOLLECTION"
}
```

**`kind` 的语义**：

| `kind` | 含义 | 推荐的下一动作 |
|---|---|---|
| `SLICE_UNCOVERED` | 侦察切片在审计波次中完全没有对应的审计Agent返回 | `REASSIGN_TO_NEW_AUDIT`（派新的审计Agent，而不是让锐评Agent自己审计） |
| `FILE_UNREAD` | 切片被审计了，但某个文件既不在 `files_read` 中，也不在 `unreadable_files` 中 | `REASSIGN_TO_NEW_AUDIT`，明确指定补读该文件 |
| `DIMENSION_OMITTED` | 某个维度因为规模映射被省略，且该维度可能隐藏高严重性问题 | 由主Agent决定是否在后续轮次补派；Devil's Advocate 不直接要求补派 |
| `ENTRY_UNCOVERED` | 某个入口点的 `next_hop` 落在未被审计的代码路径中 | `REASSIGN_TO_NEW_AUDIT`，针对该入口的调用链补审 |

**Devil's Advocate 不得报告具体缺陷**：如果它在覆盖扫描中**恰好**看到了一个可能的缺陷（例如读到了 `worker-pool.ts` 中一个可疑的锁模式），它**不得**将其写入 `coverage_gaps`。它只能在 `potential_impact` 中用一行说明“该未覆盖区域包含锁管理代码，可能存在并发风险”，但**不提供 `evidence.quote`，不声称发现缺陷**。具体缺陷的发现是审计波次的职责；Devil's Advocate 越界报告缺陷会混淆“覆盖缺口”和“已确认发现”的界限。


## 第 4 节：Arbiter 的裁决协议——仅基于证据包，不自行补证

#### 4.1 裁决的输入结构

Arbiter 在派发时收到一个**证据包**，包含：

- 原始发现的 `evidence` 和 `inference`（来自波次二）；
- Skeptic 对该发现的 `verdicts`（`refuted` / `holds` / `untested`，附逐步测试结果）；
- Devil's Advocate 的 `coverage_gaps` 中与该发现所在切片/文件/维度相关的条目（如果没有相关条目，Arbiter 必须明确记录“无覆盖缺口指向该发现”）；
- `evidence-policy` 中的机械检查清单（门 0 回显、Evidence/Inference 分离、推断可推翻性、运行时证据适用性、UNKNOWN 诚实性）。

Arbiter **不接收** Skeptic 或 Devil's Advocate 的完整叙述文本，只接收上述结构化字段。

#### 4.2 裁决的机械判定树

Arbiter 按以下顺序执行判定，**不允许跳过或合并步骤**：

```
1. Skeptic verdict = refuted?
   → 是：检查 direct_contradiction（如果是五个不可自信领域之一）。
        → 存在直接矛盾证据：REVOKED
        → 不存在直接矛盾证据，但 Skeptic 在非敏感领域返回 refuted：仍需检查 Arbiter 是否认可该反驳的证据强度；如果不认可，标记 RETRYABLE_FAILURE 要求补证，不得直接 UPHELD。
   → 否：进入 2。

2. Skeptic verdict = untested?
   → 检查 Devil's Advocate 是否对该发现所在区域标记了 coverage_gap。
        → 是：RETRYABLE_FAILURE，要求先补采覆盖缺口中的证据。
        → 否：进入 3。

3. Skeptic verdict = holds?
   → 检查 evidence-policy 机械清单是否全部通过。
        → 有任何一项不通过（例如 inference.alternatives 为空且未声明“无其他合理解释”）：DOWNGRADED（降级 severity）或 RETRYABLE_FAILURE（要求补证，取决于缺口是否可补）。
        → 全部通过：进入 4。

4. 检查 severity 与证据强度的匹配
   → 如果 severity = CRITICAL 但 evidence 只有定义位置、没有调用链/触发条件：DOWNGRADED 至 HIGH（或按实际证据强度降级）。
   → 如果 severity ≤ HIGH 且证据强度匹配：UPHELD。
```

**`EVIDENCE_GAP` 不得作为 Arbiter 的终局裁决**：`output-contract` 已经规定，Arbiter 的 `verdicts` 中 `verdict` 不得为 `EVIDENCE_GAP`。如果判定树走到需要补证的分支，Arbiter 必须返回 `RETRYABLE_FAILURE`，在 `error` 中写明 `error_type: "EvidenceGateFailure"`，`suggestions: ["request_evidence_recollection"]`，并具体说明需要补采什么（哪个文件、哪个调用方、哪个测试输出）。由主Agent派证据补采Agent，而不是 Arbiter 自己下场补证，也不是 Arbiter 把“证据不足”当作一个裁决结果推回给主Agent。

#### 4.3 裁决的审计日志

`saalis` 的治理层提供了可借鉴的审计日志设计：每次裁决记录应当包含 `question`、参与方、各自提案、裁决策略和最终 `verdict`，以 append-only 的形式持久化[^ref11]。在我们的 `output-contract` 框架下，Arbiter 的 `payload` 中必须包含 `arbiter_artifact_ref`（指向其完整裁决记录的路径），以及每条裁决的 `resolution_reason`（一句话，说明为什么是 `UPHELD` / `DOWNGRADED` / `REVOKED`，**必须引用证据或指出具体缺失**，不得写“综合判断”）。


## 第 5 节：与 `handoff-schema` 的精确对接

锐评波结束后，主Agent按以下规则将三种子角色的产出写入 Resume Packet：

| 锐评输出 | 写入 `handoff-schema` 的位置 | 规则 |
|---|---|---|
| Skeptic 的 `verdicts`（每条发现一个） | `conflicts` 数组中新增或更新对应 `conflict_id` 的 `parties` 字段，`position` 写 `"REFUTED"` / `"HOLDS"` / `"UNTESTED"`，`artifact_ref` 指向 Skeptic 的产出文件 | 不复制 Skeptic 的叙述正文，只写结构化立场 |
| Devil's Advocate 的 `coverage_gaps` | `open_items` 中新增 `kind: "COVERAGE_GAP"` 条目，`blocking: true`（如果缺口指向的发现是 `UPHELD` 候选），`next_action` 按 `recommended_action` 填写 | 每一条 gap 必须带 `target` 和 `evidence.observation` |
| Arbiter 的 `verdicts` | `conflicts` 中对应条目的 `resolution` 写 `UPHELD` / `DOWNGRADED` / `REVOKED`，`arbiter_agent_id` 和 `arbiter_artifact_ref` 必填，`resolution_reason` 取 Arbiter 返回的 `reason` | 主Agent**不得**修改 Arbiter 的裁决；如果 Arbiter 返回 `RETRYABLE_FAILURE`，对应 `conflict_id` 的 `resolution` 保持 `PENDING` 或 `ARBITRATING`，并新增 `open_item` 指向证据补采 |
| 被 `REVOKED` 的发现 | 从 `open_items` 的 `UNRESOLVED_FINDING` 中移除，并在 `closed_waves[wave-3]` 的 `summary` 中记录“N 条发现被撤销” | 被撤销的发现不进入修复波；其 `finding_ref` 保留在 `conflicts` 中供审计追溯 |


## 第 6 节：返回前的自检清单（锐评Agent执行）

#### Skeptic 自检

| 检查 | 通过条件 |
|---|---|
| 每条发现都执行了五步测试 | `verdicts` 中每一条都有 `evidence_opened`、`evidence_supports_claim`、`path_reachable`、`already_handled`、`failure_chain_holds` 五个字段 |
| `refuted` 有直接矛盾证据 | 非敏感领域的 `refuted` 附 `direct_contradiction` 或至少 `file:line` 引用；五个敏感领域必须有直接矛盾引用 |
| `untested` 有明确原因 | 说明无法访问的具体代码或工具限制 |
| 未越界做审计 | 没有在 `payload` 中新增 `finding_id` 或报告新缺陷 |
| 缝隙检查已执行 | 如果发现组合缺陷或跨维度风险，写入 `verdicts` 的 `reason` 字段，但不新增 `finding_id`；若无缝隙发现，返回 `"skeptic_gap_scan": "no_gap_found"` |
| 未将 `untested` 当作 `refuted` | `untested` 的条目保留在 `verdicts` 中，不归入 `refuted` 列表 |
| 五个不可自信领域已应用特殊规则 | 属于内存安全、并发、声明一致性、行为/兼容性变更、未使用参数的发现，`refuted` 均附 `direct_contradiction` |
| 返回符合 `output-contract` | `payload.critique_role = "skeptic"`，`verdicts` 数组非空，每条含 `finding_id`、`verdict`、`reason` |

#### Devil's Advocate 自检

| 检查 | 通过条件 |
|---|---|
| 覆盖扫描四类均执行 | `coverage_gaps` 中或 `payload` 中有明确的 `slice_scan_performed`、`file_scan_performed`、`dimension_scan_performed`、`entry_scan_performed` 布尔字段，四者均为 `true` |
| 每条缺口可定位 | `coverage_gaps` 中每一条都有 `gap_id`、`kind`、`target`、`evidence.observation`、`potential_impact`、`recommended_action` |
| 未越界报告具体缺陷 | `coverage_gaps` 中不存在 `evidence.quote` 字段；`potential_impact` 中没有声称“发现缺陷”，只描述风险区域 |
| `SLICE_UNCOVERED` 有交叉核对 | 该 gap 的 `evidence.source` 引用了 `handoff-schema.closed_waves[wave-1]` 和 `closed_waves[wave-2]` 的对照 |
| 返回符合 `output-contract` | `payload.critique_role = "devils_advocate"`，`target_finding_ids` 可为空（它不攻击具体发现），`coverage_gaps` 非空或明确返回 `"no_coverage_gap_found"` |

#### Arbiter 自检

| 检查 | 通过条件 |
|---|---|
| 每个 `finding_id` 都有裁决 | `verdicts` 覆盖派发时传入的全部 `target_finding_ids`，无遗漏 |
| 未输出 `EVIDENCE_GAP` 作为终局裁决 | `verdicts` 中 `verdict` 只取 `UPHELD` / `DOWNGRADED` / `REVOKED`；需要补证时返回 `RETRYABLE_FAILURE` |
| 裁决基于证据包而非叙述 | `reason` 中引用的是 `evidence`、`verdicts` 的结构化字段或 `coverage_gaps` 的 `target`，没有“根据 Skeptic 的论述”或“Devil's Advocate 认为” |
| `DOWNGRADED` 有严重性依据 | `reason` 中说明了为什么原 `severity` 被高估（例如“仅有定义位置，无调用链证据”） |
| `REVOKED` 有直接矛盾或越界证据 | 敏感领域附带 `direct_contradiction`；非敏感领域附带 `file:line` 引用或指出审计Agent越界做了跨切片推断 |
| 返回符合 `output-contract` | `payload.critique_role = "arbiter"`，`arbiter_artifact_ref` 非空，`verdicts` 中每条含 `finding_id`、`verdict`、`reason` |

---

## 参考来源

[^ref1]: [adversarial-review-gate - adversarial-review-gate](https://app.unpkg.com/adversarial-review-gate@3.0.2/files/agents/rt-skeptic.md#1)
[^ref2]: [adversarial-review-gate - adversarial-review-gate](https://app.unpkg.com/adversarial-review-gate@3.0.2/files/agents/rt-skeptic.md#1)
[^ref3]: [adversarial-review-gate - adversarial-review-gate](https://app.unpkg.com/adversarial-review-gate@3.0.2/files/agents/rt-skeptic.md#1)
[^ref4]: [adversarial-review-gate - adversarial-review-gate](https://app.unpkg.com/adversarial-review-gate@3.0.2/files/agents/rt-skeptic.md#1)
[^ref5]: [devils-advocate - PyPI Package Security Analysis - Socket](https://socket.dev/pypi/package/devils-advocate/overview/0.9.49#1)
[^ref7]: [adversarial-review-gate - adversarial-review-gate](https://app.unpkg.com/adversarial-review-gate@3.0.2/files/agents/rt-skeptic.md#1)
[^ref8]: [saalis](https://pypi.org/project/saalis/0.1.0/#1)
[^ref9]: [adversarial-review-gate - adversarial-review-gate](https://app.unpkg.com/adversarial-review-gate@3.0.2/files/agents/rt-skeptic.md#1)
[^ref10]: [adversarial-review-gate - adversarial-review-gate](https://app.unpkg.com/adversarial-review-gate@3.0.2/files/agents/rt-skeptic.md#1)
[^ref11]: [saalis](https://pypi.org/project/saalis/0.1.0/#1)
