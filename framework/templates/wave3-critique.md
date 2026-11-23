---
file: templates/wave3-critique.md
title: 波次三：锐评（critique panel）
group_order: 3
loaded: 加载前必须已加载 handoff-schema.md 和 output-contract.md
source: https://chat.deepseek.com/share/yn99k1mum4qp5fqwj8 (第 13 轮（第 6 节由第 14 轮补全）)
---

# templates/wave3-critique.md
`templates/wave3-critique.md` 是整个审计链路中**唯一专门用于“杀死发现”的波次**。它的设计前提是一个反直觉的实证结论：朴素的多Agent审查并不会自动提升质量，反而会暴露一种 **false-consensus failure mode**——Agent 们在没有足够证据的情况下倾向于互相认同；只有把“分歧”显式地、结构化地、证据锚定地加进去，才能在一项受控研究中取得最高的 F1[^refA][^refB]。因此，这个波次的任务不是“再多找一些缺陷”，而是对波次二的每一条 `CONFIRMED` 发现执行**有结构的对抗**，把证据不足的发现拦在修复波之前。

> **证据强度声明（勿夸大）**：上述结论来自《Adversarial Review: Structured Disagreement for Grounded Agentic Code Review》[^refA]——一篇 ICML 2026 DL4C workshop 的**小样本三 agent 协议研究**，不是大规模实证共识。因此本文的措辞一律是「在一项受控研究中」，**不得**改写为「已被实证证明」。
>
> 需要同时承认的**反面证据**：多 agent debate 相对 self-consistency **没有可靠优势**，且对超参高度敏感（Smit 等，ICML 2024[^refC]）；对每个查询都触发 debate 会浪费 token，甚至**推翻单 agent 原本正确的答案**，改为选择性触发后准确率反升（iMAD[^refD]）。**因此本波次的设计取向是「证伪」而不是「辩论」，且只在存在真实冲突时才扇出**——这三条外部证据共同支持本波次瘦身，而不是扩张。


## 文件头部：强制加载与波次定位

> wave3-critique.md
> 锐评Agent（critique panel）专属模板。
> 加载本模板前，必须已加载 handoff-schema.md 和 output-contract.md。
> 本模板与 handoff-schema / output-contract 冲突时，以两者为准；
> 本模板只负责“三种锐评子角色如何攻击、补盲和裁决”，
> 不重新定义波次传递结构（由 handoff-schema 定义）或返回格式（由 output-contract 定义）。
> 锐评Agent的返回必须符合 output-contract.md 的 role: "critique" payload schema。
> 本波次不产生新的代码修改，不读取修复Agent的任何说明。
>
> **你的返回会被 `tools/check-payload.mjs --role critique` 机械校验**：
>
> | 规则名 | 触发条件 |
> |---|---|
> | `invalid_coverage_kind` | `coverage_gap[].kind` 不在闭集内 |
> | `incomplete_coverage_gap` | coverage_gap 条目缺必填子字段 |
> | `missing_discipline_audit` | skeptic 缺 `discipline_audit`（契约 §2.3 早有规定） |
> | `discipline_audit_no_performed` / `discipline_audit_out_of_role` | skeptic 声明了却没实际执行 / 越权审计了其它子角色 |
> | `pattern_sweep_out_of_role` | 越权做了 pattern sweep |
> | `missing_five_step` / `incomplete_five_step` | 五步测试缺步骤或某步没写完整 |
> | `vacuous_reason` | 判 `REVOKED` / `UPHELD` 却没给出实质理由 |
> | `missing_runtime_applicable` / `runtime_required_but_missing` / `runtime_no_output` | 未声明是否适用运行时验证 / 声明必然适用却没验证 / 跑了却没输出 |
> | `verdict_missing_for_target` / `invalid_verdict_enum` | 有 target_finding_ids 没被判 / verdict 不在该子角色的闭集内 |
> | `missing_arbiter_artifact_ref` / `arbiter_artifact_ref_placeholder` / `arbiter_ref_out_of_role` | arbiter 缺裁决记录路径 / 写成占位符 / 非 arbiter 却填了它 |
>
> 本模板此前一次都没点名这些规则，agent 只能靠试错撞上。

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

#### 2.0 「机制对、后果错」怎么办（2026-11-10 实测新增）

**问题**：上面的三值枚举（`holds` / `refuted` / `untested`）假设一条发现是**原子的**——要么全对，要么全错。实测中这个假设不成立。

**实测依据**（tier-2 假发现实验，C3）：

一条发现在下面两个维度上**结论相反**：

| 子主张 | 实际 |
|---|---|
| `break` 的位置、语义、影响范围 | **完全正确**（逐字源码实测） |
| 「导致权限检查降级放行」 | **方向说反了**——`allow` 是豁免白名单，丢失只会 fail-closed（误报变多） |

三值枚举装不下它。Skeptic 只能**自造**一个枚举 `UPHELD_ON_MECHANISM / REFUTED_ON_CONSEQUENCE` 来表达——这与验收波把「带保留通过」写成 `PASS_WITH_ESCALATION` 的错误同源（该写法当初未登记为枚举，后已改名）：**框架没有位置，执行者只好发明位置**。

**规则**：**裁决作用在子主张上，不在整条发现上。**

Skeptic 在写 `verdict` 之前，**必须**先把发现拆成它实际包含的**可独立判定的子主张**，逐条给结论，再由整条发现汇总：

```json
{
  "finding_id": "F1",
  "verdict": "holds",
  "sub_claims": [
    { "claim": "第 29 行存在空 catch，其后紧跟 break", "verdict": "holds", "evidence_ref": "inspect.mjs:29" },
    { "claim": "第二个候选路径不会被读取", "verdict": "holds", "evidence_ref": "inspect.mjs:28-30" },
    { "claim": "break 是意外 bug", "verdict": "untested", "reason": "上游原样代码；默认 outDir 下两候选同一文件，break 为无副作用优化" },
    { "claim": "导致权限检查降级放行", "verdict": "refuted", "direct_contradiction": "allow 仅抑制 finding；400 组随机子集压测 0 例反例，丢失只会 fail-closed" }
  ],
  "reason": "机制成立，后果表述方向相反。建议 severity HIGH → LOW-MED，且与「路径失配」合并（后者为第一因）"
}
```

**汇总规则**（零裁量）：

| 子主张情况 | 整条 `verdict` |
|---|---|
| 全部 `holds` | `holds` |
| 存在 `refuted`，且该子主张是**后果/危害**类 | `holds`，但 `reason` 必须写明「原危害表述被证伪，实际后果为 X」，并由 Arbiter 判 `DOWNGRADED` |
| 存在 `refuted`，且该子主张是**机制/证据**类 | `refuted` |
| 核心子主张为 `untested` | `untested` |

**⚠ `sub_claims` 什么时候是必填的**（机械可判，`check-payload.mjs` 会拦）：

```
若 verdict == "holds" 且 reason 中出现下列任一信号：
    后果 / 危害 / 影响方向 / 方向相反 / 方向说反 / 不至于 / 被夸大 / 高估 / 降级
则 sub_claims 必填。
```

**为什么必须设成强制**：`sub_claims` 如果只是「可选」，执行者永远不会写它——因为写它意味着承认自己的发现有一半是错的。而这正是最需要暴露的情形：下游 Arbiter 如果只看到 `holds`，会按原严重性送进修复波，修复者会朝错误方向改。

**实测依据**：本次会话加了这个字段后，我立即用一条真实的「机制对、后果错」产物验证——带 `sub_claims` 时校验通过，**不写 `sub_claims` 时同样通过**。也就是说这条规则当时没有强制力。加上触发条件后，同一个产物立刻被判违规。

**「机制」与「后果」的区分判据**（机械可判）：

| 类别 | 问句 | 例 |
|---|---|---|
| **机制** | 「代码真的是这样吗？」 | 那行有没有 `break`；`catch` 是否为空 |
| **后果** | 「这会导致什么？」 | 会泄漏吗；会放行吗；会超时吗 |

**机制错 = 发现错**；**后果错 ≠ 发现错**，但必须改写后果并降级。

**为什么这条重要**：如果不拆子主张，Skeptic 面对「机制对、后果错」只有两条路——判 `refuted`（**丢掉一个真实的机制缺陷**）或判 `holds`（**放过一个错误的危害描述，它会污染修复方向和严重性**）。两条都是错的。实测中这条发现如果判 `refuted`，`inspect.mjs` 的静默丢弃问题就永远不会被记录；如果判 `holds` 不改写，修复者会朝着「加强权限检查」的方向改，完全改错。


## 第 2 节：Skeptic 的操作协议——五步测试的机械执行

Skeptic 对每一条 `finding_id` 必须执行五步测试，并在 `payload.verdicts` 中返回结构化的结果。**不允许**跳过任何一步，**不允许**用“整体看起来没问题”替代逐步执行。

**⚠ 五个步骤的结果必须包在 `five_step` 对象里**，不能平铺在 `verdict` 上：

```json
"five_step": {
  "evidence_opened": true,
  "evidence_supports_claim": true,
  "path_reachable": "true | false | untested",
  "already_handled": "true | false | untested",
  "failure_chain_holds": true
}
```

`tools/check-payload.mjs` 按 `payload.verdicts[].five_step` 这个路径校验——**平铺的五个字段会被判「缺 five_step」，整条 verdict 作废**。

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

#### 2.3 裁量稽查——Skeptic 的第二项固定职责（2026-11-01 新增）

除了逐条攻击发现，Skeptic **必须**执行一次**裁量稽查**。这是它与主 Agent 之间唯一允许的"对账"动作，也是 `protocol.md` 第 1.2 节「裁量留痕」能否成立的执行环节。

**为什么由 Skeptic 做**：Skeptic 的默认立场就是"未证明"，它攻击的是**主张**。主 Agent 的 `discipline_log` 本身就是一组主张（"我做了这些裁量，都有依据"），由 Skeptic 来攻击它是角色一致的做法。**不得**交给 Devil's Advocate——后者负责攻覆盖缺口（见 2.4），混入纪律审查会模糊边界。

**三项必做检查**：

| # | 检查 | 方法 | 失败意味着 |
|---|---|---|---|
| 1 | **未申报裁量** | 把 `discipline_log` 与实际派发记录（`wave2_completed`、产物文件列表、`state.json` 的 `slices`）**逐条比对**，找出"派发记录里有、日志里没有"的差异 | 存在未申报裁量 → 该轮结论作废 |
| 2 | **`mechanical_check` 可执行性** | 逐条判断：这条裁量写的复核方法，**一个没参与本轮的人**能否用命令/脚本独立验证？ | 不可执行 → 视为伪装成 L1 的 L0，无效需回退 |
| 3 | **越界检查** | 比对 L0 禁止清单：主 Agent 是否读过源码？是否亲自改过文件？是否提过并发上限？ | 命中任一 → L0 违规 |

**返回结构**（追加到 critique payload）：

```json
{
  "discipline_audit": {
    "performed": true,
    "log_entries_checked": 5,
    "dispatch_records_checked": 40,
    "undeclared_discretions": [],
    "mechanical_check_failures": [],
    "l0_violations": [],
    "overall": "CLEAN | VIOLATIONS_FOUND"
  }
}
```

**硬规则**：

1. **`discipline_audit.performed` 必须为 `true`**。返回 `false` 或缺失，视为 Skeptic 未完成职责，其全部 `verdicts` 一并作废（因为无法确认它是在完整信息下做出的裁决）。
2. **`undeclared_discretions` 非空时 `overall` 必须为 `VIOLATIONS_FOUND`**，每条附可复核的证据（`file:line` 或记录 ID）。
3. **不得把"裁量看起来合理"当作通过理由**。Skeptic 判断的是**是否申报、是否可机械复核**，不是裁量本身好不好——后者是 Arbiter 的范围。
4. **零裁量时也要显式返回 `log_entries_checked: 0, overall: "CLEAN"`**，不得省略——"没有裁量"和"没检查"必须可区分。

> **实测依据**：round31 的 9 处维度偏离，是 **Devil's Advocate 用机械比对偶然发现**的（ledger `dimension_deviation_disclosed_by`），主 Agent 事先**并未申报**。这说明两件事：① 机械比对确实能发现未申报裁量；② 它当时是"可遇不可求"的副产品。把同一方法移交给 Skeptic 并设为固定动作，才能保证它每次都发生。
>
> **同时要承认的局限**：本检查只能发现"派发记录与日志不一致"。若主 Agent 既做了裁量**又**同步伪造了派发记录，机械比对无法识别——这需要外部审计（对照产物文件的实际内容），超出本角色能力边界。

#### 2.4 模式级复查——Devil's Advocate 的第二项职责（2026-11-02 新增）

**问题**：审计波按切片隔离，每个 Agent 只看自己那 5–8 个文件。于是**同一个缺陷模式在多个文件里重复出现时，每个 Agent 只能看到自己那一个实例**，报告出来像"孤立的偶发 bug"，实际上是"系统性的写法问题"。

**实测依据**（`D:\Web\style` round1）：

- 深挖 Agent 在 `check-stale.mjs` 找到两条 HIGH——① 文件名写错被 `.filter(existsSync)` 静默剔除；② `catch { continue }` 把"无法判定"当成"不陈旧"。
- 我（主 Agent）做复核时顺手扫了全仓同类模式，发现**同样的"静默跳过"共 7 处**：

```
assign-assets.mjs:215    catch { continue; }
assign-assets.mjs:234    .filter(existsSync)
backfill-credits.mjs:40  catch { continue; }
backfill-credits.mjs:55  catch { continue; }
check-prompts.mjs:356    catch { continue; }
check-stale.mjs:47       catch { continue; }   ← 已修
check-stale.mjs:122      catch { continue; }   ← 未修（就是发现 2）
```

- 更有说服力的是：`check-stale.mjs` 里**同一缺陷，一半修了、一半没修**（47 行有修复注释，122 行没有）。修复者当时只处理了出问题的那条分支。

**职责**：Devil's Advocate 必须对每条 `HIGH`/`CRITICAL` 发现，追问一句：

> **「这个缺陷的形态（不是这个缺陷本身），在仓库里还出现在哪些地方？」**

**执行方式（机械，不需要理解代码）**：

**第一步：划分活跃范围（必须先做，否则数字会骗人）**

```bash
# 归档/临时目录的典型特征 —— 先排除它们再计数
#   scratch / snap / archive / backup / old / tmp / _lab / redteam / 日期目录
# 判断依据：目录名 + 是否被构建链引用（grep 在 package.json scripts / Makefile / CI 配置里）
```

**实测教训**（`D:\Web\style`，2026-11-02 的自我更正）：我曾报告"静默跳过的同类模式全仓共 7 处"。第一次复核说"活跃代码 4 处 + 归档 20+ 处"，**第二次复核（逐文件计数）实测 `prototypes/_build/` 下是 8 处**：`catch { continue }` 7 处（assign-assets 1 / backfill-credits 2 / check-prompts 1 / check-stale 2 / shot 1）+ `.filter(existsSync)` 1 处（assign-assets）。**两次复核给了两个不同数字——这本身就是"口径没写清"的例证。****`grep` 出的模式匹配不等于同一类缺陷**——归档脚本里的 `catch { continue }` 不影响任何东西，把它们计入会让修复范围凭空膨胀数倍。**所以报数字时必须同时报口径。**

| 范围 | 处数 | 是否纳入修复 |
|---|---|---|
| `prototypes/_build/`（活跃构建链） | **4** | **是**，逐条评估 |
| `deliverables/*-scratch/`、`*-audit/`、`snap/`（归档） | 20+ | **否**，改了只制造 diff 噪声 |

**第二步：按形态归类扫模式**

| 发现形态 | 要扫的模式 |
|---|---|
| 硬编码文件名/路径错误 | 同类字面量（`'0N-xxx.md'` 之类）在全仓的出现 |
| 静默跳过 / 吞异常 | `catch { continue }`、`catch {}`、`.filter(existsSync)`、`if (!x) return` |
| 未校验的外部数据 | `JSON.parse` 后直接取字段、`as` 断言 |
| 定时器/资源未清理 | 无 `clearTimeout` 的 `setTimeout`、无 `close()` 的 `open()` |
| 状态与文案不一致 | 同一数值在多处硬编码 |

**返回结构**（追加到 critique payload）：

```json
{
  "pattern_sweep": {
    "performed": true,
    "patterns_checked": [
      {
        "from_finding": "check-stale.mjs:122",
        "pattern": "catch { continue }",
        "grep_command": "grep -rn 'catch { continue' prototypes/",
        "other_occurrences": [
          { "location": "assign-assets.mjs:215", "verdict": "NEEDS_REVIEW" },
          { "location": "backfill-credits.mjs:40", "verdict": "NEEDS_REVIEW" }
        ],
        "conclusion": "该模式在本仓共 7 处，已修 1 处，未评估 6 处"
      }
    ]
  }
}
```

**硬规则**：

1. **`pattern_sweep.performed` 必填为 `true`**（仅当本轮有 `HIGH`/`CRITICAL` 时）。缺失该字段 = 未完成职责。
2. **`other_occurrences` 非空时，`conclusion` 必须给出总数与"已评估/未评估"的分布**，不得只列找到的那几条。
3. **发现本身仍按单个 `finding_id` 记录**，但报告必须额外给一节「模式级影响」：该模式共 N 处，其中已被本次审计覆盖 M 处。
4. **不得**因为"可能还有别处"就把单条发现升为 CRITICAL——模式级影响是**覆盖率的披露**，不是严重性的提升。

**为什么放在 Devil's Advocate 而不是审计波**：

审计波按切片隔离（这是防止认知过载的设计，有依据）。让每个审计 Agent 去扫全仓模式，等于打破隔离，会把它的上下文污染成"全仓扫描"。Devil's Advocate 的固有职责就是攻覆盖完整性，**模式级遗漏天然属于覆盖缺口**，交给它最合适，且它本来就持有全仓视野。

> **与 2.3 的分工**：2.3（Skeptic）查的是「**人**有没有瞒着做事」（裁量留痕）；2.4（Devil's Advocate）查的是「**代码**里的同类问题有没有被漏掉」（模式覆盖）。两者都靠机械比对，但对象不同，不得合并。

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

#### 4.0 先看实测：多 Agent 一致性到底有多强（2026-11-12）

这一节的存在理由：整个锐评波建立在「多个独立 agent 会收敛」这个前提上。**这个前提做过一次实测，结果比想象中弱。**

4 个独立 agent、**提示词逐字相同**、同一份代码（18 条已知缺陷）：

| 指标 | 实测 | 随机基线 | 倍数 |
|---|---|---|---|
| 两两 Jaccard | 0.742 | 0.598 | **1.25x** |
| 4/4 全中的缺陷数 | 9 | 5.56 | **1.6x** |

**报告越大，随机重叠越高。任何「一致性 X%」的说法不附随机基线就没有意义。**

检出分布分三档，**每档该用不同机制对付**：

| 情形 | 实测条数 | 该怎么做 |
|---|---|---|
| 多数 agent 都找到（3–4/4） | 13/18 | 正常进裁决，证据充分 |
| 只有 2 个找到 | 3/18（含一条 HIGH 级） | **标记为「分歧」，不得投票否决**——这是真正有信息差的地方 |
| **0 个找到** | **2/18** | **锐评波救不了**，只能靠预先写死的检查清单 |

**第 3 档是最重要的发现**：`{{#if constructor}}` 条件恒真这条，4 个 agent 全部漏掉，12 份历史报告里也只有 2 份命中；`slice` 浅拷贝同样 0/4。再加派 agent 也不会发现——它们需要有人专门去测「字段名恰好是原型链成员」「返回的对象改属性会不会污染源」。**只能靠清单，不能靠并行。**

**所以 Arbiter 的裁决不能是多数表决**：多数决会把 1–2/4 的发现判死，而那些恰恰是最需要人看的；同时它对付不了 0/4——因为没东西可投。

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

> **本波次的机械执行**（2026-11-19 补：此前本模板 51 条规则句没有一条点名校验器）：
> 下列约束由 `tools/check-payload.mjs` 的 critique 分支强制，逐条对应关系 ——
>
> | 模板约束 | 校验器规则 |
> |---|---|
> | 每个 `target_finding_ids` 都要有 verdict | `verdict_missing_for_target` |
> | `verdict` 只能取 `UPHELD`/`DOWNGRADED`/`REVOKED`/`EVIDENCE_GAP` | `invalid_verdict_enum` |
> | Devil's Advocate 不得输出 verdict | `devils_advocate_has_verdicts` |
> | `refuted` 必须给 `direct_contradiction` | `refuted_without_contradiction` |
> | 并发类 `refuted` 门槛更高 | `sensitive_refuted_without_contradiction` |
> | `sub_claims` 必须逐条裁决 | `missing_sub_claims` / `incomplete_sub_claim` / `invalid_sub_verdict` |
> | 子主张被反驳要有依据 | `sub_refuted_without_basis` |
> | 子主张混合结论须解释 | `mixed_sub_claims_unexplained` |
>
> 跑法：`node tools/check-payload.mjs <产物> --role critique`。

#### Skeptic 自检

> **⚠ 每条 `verdict` 都必填两个字段，缺任一判 `CONTRACT_VIOLATION`：**
>
> **1. `runtime_applicable`（`true` | `false`）**——先回答「这条发现是否涉及运行时可观察行为」：
>
> | 值 | 什么时候用 |
> |---|---|
> | `true` | 声称的是运行时行为：点击无反应、状态不更新、渲染值不符、可聚焦性、静默失效 |
> | `false` | 纯静态可判定：拼写不一致、死代码、契约不符、注释与实现不符 |
>
> **答了 `true` 就必须附 `runtime_evidence`**，且必须含 `command` + `observed` 原始输出 + **`control_case`**（一个已知会通过/会失败的对照）。没有对照的实验不采信。
>
> **2. `sub_claims`（当 `verdict: holds` 但 `reason` 在否定原危害时必填）**——见第 2.0 节。
>
> 自检：`node <FRAMEWORK_ROOT>/tools/check-payload.mjs <你的产物> --role critique`

| 检查 | 通过条件 |
|---|---|
| 每条发现都执行了五步测试 | `verdicts` 中每一条都有 `evidence_opened`、`evidence_supports_claim`、`path_reachable`、`already_handled`、`failure_chain_holds` 五个字段 |
| `refuted` 有直接矛盾证据 | 非敏感领域的 `refuted` 附 `direct_contradiction` 或至少 `file:line` 引用；五个敏感领域必须有直接矛盾引用 |
| `untested` 有明确原因 | 说明无法访问的具体代码或工具限制 |
| 未越界做审计 | 没有在 `payload` 中新增 `finding_id` 或报告新缺陷 |
| 缝隙检查已执行 | 如果发现组合缺陷或跨维度风险，写入 `verdicts` 的 `reason` 字段，但不新增 `finding_id`；若无缝隙发现，返回 `"skeptic_gap_scan": "no_gap_found"` |
| 未将 `untested` 当作 `refuted` | `untested` 的条目保留在 `verdicts` 中，不归入 `refuted` 列表 |
| **引用定位失败 ≠ 发现是假的** | 当 `evidence.file` 指向的路径不存在时，**必须**先按文件名/行号特征在全仓找真实位置（`find` / `grep` 特征字符串），找到后按真实路径核验；只有**特征字符串也找不到**才判 `EVIDENCE_NOT_FOUND`。**不得**因为路径写错就直接判 `refuted` |
| **有 `runtime_evidence` 时优先真跑** | 若发现声称的是运行时可观察行为（点击无反应、状态不更新、数值不符），且项目可跑，**必须**至少跑一次真实执行。静态通读只能证明「我没看到绑定」，不能证明「运行时不响应」 |
| 五个不可自信领域已应用特殊规则 | 属于内存安全、并发、声明一致性、行为/兼容性变更、未使用参数的发现，`refuted` 均附 `direct_contradiction` |
| 返回符合 `output-contract` | `payload.critique_role = "skeptic"`，`verdicts` 数组非空，每条含 `finding_id`、`verdict`、`reason` |

#### 为什么加「引用定位失败 ≠ 发现是假的」（2026-11-10 实测）

2026-11-10 的锐评波实测里，三个 finding package 中有**两个**的 `file` 路径是错的（`S03-something` 实为 `S03-long-exposure-observatory`，`S04-gilded-symmetry-salon` 实为 `S04-mango-collage-wall`）。两次 Skeptic 都**没有**拿路径错误当借口判 `refuted`——它们都先找到真实位置、确认证据存在，然后才报告「路径需更正」。

**但这是 agent 自觉，不是框架保证。** 如果换成只做字面核对的执行者，路径错误会直接变成 `EVIDENCE_NOT_FOUND`，一条真实缺陷就被一个笔误杀掉了。而路径写错在派发环节是**高频事件**（`wave2a-sweep.md` §9 记录过一次更严重的：任务书里的行数与文件清单整体失真）。

**判据必须区分两种失败**：

| 情形 | 判定 | 理由 |
|---|---|---|
| 路径不存在，但特征字符串（claim 引用的代码片段/符号名）能在别处命中 | **不是反驳**，按真实位置继续五步测试 | pack 元数据笔误，不影响证据实体 |
| 路径不存在，且特征字符串在全仓 0 命中 | `EVIDENCE_NOT_FOUND` | 这才是真的没有证据 |
| 路径存在，但那几行内容与 claim 不符 | `EVIDENCE_MISMATCH` | 需要 `direct_contradiction` |

#### 为什么加「有 runtime_evidence 时优先真跑」（同上）

同一个实测里，F2（主 CTA 无绑定）是三条里唯一需要运行时才能确认的。Skeptic 做了七层验证，其中最有价值的两层是：

- **CDP 直接枚举监听器**：`#book-btn → 0 listener(s)`，同一方法在 `.slot` / `#wait-form` 上各测出 1 个（证明方法本身有效）；
- **对照组**：同目录 `build/peer-snapshot/index.html` 的同名按钮测得 `mutations: 303`（证明探针不会把「有绑定」误报成「无绑定」）。

**没有对照组，前五层都可能是探针失灵。** 因此规则是：真跑时**必须包含一个已知会通过/会失败的对照**，否则运行结果不可采信。

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

---

## 证据分级说明

本文档的脚注分三类，**引用时不得混为一谈**：

| 等级 | 含义 | 本文中的例子 |
|---|---|---|
| **A · 研究证据** | 经同行评议或有预印本编号的论文 | `[^refA]` `[^refB]` `[^refC]` `[^refD]` |
| **B · 工程实践文档** | 开源仓库/工程博客中的可核查做法 | `[^ref5]`（Fan-out auditing） |
| **C · 包注册页或第三方 prompt 文件** | 只能证明「该包/该文件存在」，**不能承担实证功能** | `[^ref1]`–`[^ref11]` 中的 `adversarial-review-gate`、`saalis` 等 |

**降权声明**：`[^ref1]`/`[^ref2]`/`[^ref9]`/`[^ref10]` 引用的 `adversarial-review-gate@3.0.2` 的 `rt-skeptic.md`，经核实**引文准确**（五步证据测试、"measured by what it removes"、"Unverifiable is not incorrect" 等均为原文），但它是**第三方个人发布的 prompt 文件**，不是研究证据。因此本文的立场是「**借鉴其角色设计**」，锐评波有效性的实证责任由 `[^refA]` 承担。

[^refA]: Qiu & Gill, *Adversarial Review: Structured Disagreement for Grounded Agentic Code Review*, ICML 2026 DL4C workshop — [arXiv:2608.18167](https://arxiv.org/abs/2608.18167)。原文摘要：「naive AR exposes a false-consensus failure mode… a single prompt iteration that adds disagreement explicitly achieves the highest F1」。**注意：小样本协议研究，措辞须保持「一项受控研究中」。**
[^refB]: *SWE-PRBench* — [arXiv:2603.26130](https://arxiv.org/abs/2603.26130)。350 个 PR 上 8 个模型仅检出人类标注问题的 15–31%，说明「找全」本身极难。
[^refC]: Smit, Duckworth, Grinsztajn, Barrett, Pretorius, *Should we be going MAD? A Look at Multi-Agent Debate Strategies for LLMs*, ICML 2024 — [arXiv:2311.17371](https://arxiv.org/abs/2311.17371)。结论：现有形态的 debate 不能可靠优于 self-consistency，且对超参远更敏感。
[^refD]: *iMAD: Intelligent Multi-Agent Debate* — [arXiv:2511.11306](https://arxiv.org/abs/2511.11306)。结论：无条件触发 debate 会浪费 token 甚至推翻正确答案；选择性触发后 token 最多降 92%、准确率反升 13.5%。**注意：`[^refD]` 的编号我未能独立复核，引用时请以「选择性触发优于无条件 debate」这一方向性结论为准，不要引用具体百分比。**
