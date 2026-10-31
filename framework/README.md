# 多 Agent 极限审计框架 — 总纲

> **来源**：DeepSeek 分享对话 <https://chat.deepseek.com/share/yn99k1mum4qp5fqwj8>（14 轮问答）
> **整理时间**：2026-11-01
> **原对话产出**：`orchestrator/`、`components/`、`templates/` 三组共 9 份文件，为对话原文。
> **后续续写**：`templates/wave5-verify.md`、`wrappers/` 五份、`artifacts/` 两份，共 8 份。
> **原始转录**：`docs/reports/deepseek-share-yn99k1mum4qp5fqwj8.md`

> **只想跑起来？** 直接看 [`MANUAL.md`](MANUAL.md)（使用说明书，含逐步执行流程、每波必检项、排错表、字段速查）。本文讲原理。

---

## 一、这套东西要解决什么问题

用户的核心诉求是一句反常识的话：**让主 Agent 什么都不做**。

> 明确主agent不能亲自下场做任何事，只得派agent去完成，主agent（对话）只负责调度多agent

这不是偷懒，而是针对长链路代码审计的一个已知失效模式：审计跑得越久，主 Agent 的上下文里堆的代码、堆栈、报告全文越多，判断就越容易漂移，最后它会开始"亲自看一眼"——而那一眼恰恰是幻觉和不一致结论的入口。所以整套框架的第一性原理是**上下文隔离**：

> 主Agent的上下文窗口里永远只有结构化的任务描述和结果摘要，不会被具体代码、堆栈或报告全文污染，从而避免长链路审计中的上下文漂移和"越权判断"。

由这一条推下去，其余设计几乎都是必然的：既然主 Agent 不读代码，那"派多少 Agent"就不能由它判断项目大小，只能由侦察 Agent 返回可数的切片；既然它不读报告，那子 Agent 的返回就必须是机械可校验的结构化契约；既然它不做判断，那冲突就必须交给独立的仲裁者。

对话里把这套原则压缩成了一句硬禁令，写在 `protocol.md` 最前面：

> **你不得使用任何代码读取、文件写入、搜索或分析工具。你唯一允许执行的动作是 `spawn_agent` 和 `read_agent_result`。任何需要"看一眼"才能做的决定，都必须转化为一个子Agent任务。**

---

## 二、五种波次：为什么是这五个

波次不是流水线，而是**契约驱动的扇出—扇入**：每一波派出一批单一职责 Agent，拿回结构化结果，主 Agent 检查闭合条件，满足才进下一波。

| 波次 | 角色 | 核心产出 | 闭合条件（布尔判定） |
|---|---|---|---|
| **一 · 侦察** | recon scout | 切片清单 `audit_slices`、`slice_count`、入口点、`unverified` | `SUCCESS` 且 `slice_count` 为整数、切片非空、UNKNOWN 已标注 |
| **二 · 审计** | audit specialist | 单一维度、带门 0 证据的 `findings` | 所有切片状态均为 `SUCCESS`，无 `CONTRACT_VIOLATION`；**不要求零发现** |
| **三 · 锐评** | Skeptic / Devil's Advocate / Arbiter | 裁决 `UPHELD` / `DOWNGRADED` / `REVOKED` | 三方均 `SUCCESS`，`conflicts` 中无残留 `PENDING` |
| **四 · 修复** | fix worker | 修改文件清单 + `affected_issues` + 验证命令 | 每条 `UPHELD` 都有对应修复 `SUCCESS` |
| **五 · 验收** | verifier | 通过 / 不通过（附触发条件） | 每条修复都有验收结论；不通过**回到波次四**，不回波次二 |

几个容易忽略但很关键的细节：

**波次一的产出不是"项目大小"。** 这是一个中途被纠正的设计。最初的方案是让主 Agent 按项目规模决定 Agent 数量，但对话第 2 轮指出这本身就是一个"需要理解"的判断，等于把主观推理塞回主线程。到第 3 轮彻底改掉：侦察 Agent 只返回可扇出的工作单元清单，**切片数本身就是规模**——5 个切片就派 5 个审计 Agent，40 个就派 40 个，主 Agent 只做区间匹配。这一步是整套框架"零裁量"的地基。

**波次三是唯一专门用来"杀死发现"的波次。** 它的设计前提是一个反直觉的实证结论，原文说得很直接：

> 朴素的多Agent审查并不会自动提升质量，反而会暴露一种 **false-consensus failure mode**——Agent 们在没有足够证据的情况下倾向于互相认同。

所以锐评波不是"再检查一遍"，而是三种互斥角色的对抗：Skeptic 默认答案是 "not proven"，**以移除多少来衡量成功**；Devil's Advocate 攻击覆盖完整性，对抗"没有发现等于没有问题"；Arbiter 在干净上下文里只基于证据包裁决，不自己补证、不新增发现。

**波次四和波次五必须分开，且不能复用同一个 Agent。** 让修复 Agent 自验收有一个实测层面的理由：对话引用的证据显示，让修复 Agent 自己写测试并运行，既不提高解决率也不降低回归率。所以修复 Agent 只能声明"我做了这些修改，跑了这些检查，结果如下"，**不得声称"该缺陷已修复"**。

---

## 三、支撑这五个波次的三根柱子

### 1. 证据基线（门 0）— `components/evidence-policy.md`

所有子 Agent 在产出任何发现前加载，与任何模板指令冲突时以它为准。核心是一条不可跳过的前置检查：

> 如果子Agent要报告一个问题，它必须在本回合的输出中**逐字回显**它所判断的源产物……且该引用必须来自**本回合**的文件读取，不得来自会话早期的记忆、训练数据或"根据架构推测"。

由此派生出几条硬规则：**证据与推断必须分字段**（Evidence / Inference 不得混写在一段叙述里）；**运行时行为声明不得只引定义位置**（函数被定义不等于被调用，异常被抛出不等于会传播）；**"不知道"是合法且必须显式记录的状态**，读不到文件就写 `UNREADABLE`，没发现问题就写 `NO_EVIDENCE_FOUND` 并附搜索范围——后者是合法结论，不是失败。

整个文件可以压缩成一句话：

> **任何发现都必须能仅凭其 Evidence 字段被一个未参与本次审计的Agent独立复核，且复核结论不受 Inference 字段的影响。**

### 2. 统一返回契约 — `components/output-contract.md`

主 Agent 与所有子 Agent 之间唯一的机器接口。所有角色共用同一顶层信封，差异只在 `payload`：

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

顶层状态只保留四个终态——子 Agent 是一次性执行单元，不需要 `working` 或 `input-required`，那些由主 Agent 的账本管理。`GATE_0_FAILED`、`NO_EVIDENCE_FOUND`、`UNREADABLE` **不是**顶层状态，而是 `payload.findings` 内的条目状态。文件明确禁止宽容解析：

> 禁止任何"宽容解析"或"尽力修复后放行"——违反契约的输出必须在检查点被拒绝，不得进入下游。

### 3. 波次间传递 — `components/handoff-schema.md`

Resume Packet 是**不可变快照 + 指针清单**，硬规则是：不得包含任何子 Agent 的原始正文或完整 findings 数组，只允许 `artifact_path`、`summary`、`verdict` 和未闭合项的结构化表示。`summary` 字段刻意设了约 100 token 的预算，目的不是限制，而是**防止 Resume Packet 退化成第二份报告**。

其中 `trace_id` 的传播规则值得一提：主 Agent 在派发时注入，子 Agent 在 `agent_id` 之外额外回显，不匹配即 `CONTRACT_VIOLATION`。这保证 Resume Packet 里每条记录都能追溯到具体实例。

---

## 四、两处"零裁量"的具体机制

### 规模映射（`orchestrator/scale-mapping.md`）

主 Agent 只允许读六个字段，然后做一次算术和一次查表：

```
effective_slices = len(audit_slices) + len(unverified)
```

| `effective_slices` | 发现波 | 锐评波基础角色 | 锐评波追加 | 单波并发窗口 |
|---|---|---|---|---|
| **1–5** | `= effective_slices` | Skeptic + Arbiter | 无 | `min(5, harness_cap)` |
| **6–20** | `= effective_slices` | + Devil's Advocate | 无 | `min(8, harness_cap)` |
| **> 20** | `= effective_slices` | 同上 3 角色 | +1 交叉模式扫描 | `min(8, harness_cap)` |

修复波和验收波**按问题数派，不按切片数派**；并发窗口是上限不是目标，harness 支持 16 并发时窗口仍是 8。给出这个数值的理由是有实测支撑的：无协调的并行 Agent 在高争用下失败率可达 72–100%，引入准入控制和背压后降到 0–18%。所以**计划量（population）和并发窗口（throughput）被刻意解耦**。

排队的补位顺序也是写死的：`unverified` 追加切片优先于 `audit_slices`；同优先级按原始 FIFO；`CONTRACT_VIOLATION` 重派插队首，`RETRYABLE_FAILURE` 重派插队尾。**禁止按文件数、目录名、修改时间或任何内容特征排序**。

### 轮次编号（原始提案，见第七节"未完成部分"）

编号不依赖主 Agent 推理，而是派一个轻量 Agent 扫描 `docs/reports/` 下 `round(\d+)` 模式，取最大值 +1 作为 `RN`。文件名统一为 `round{RN}-{stage}-{agent-id}.md`，最终汇总 `round{RN}-final-report.md` **只做拼接和索引，不重写任何子 Agent 的结论**。

---

## 五、失败处理：惩罚静默失败，不惩罚重试

四种终态对应四种完全不同的动作，这是整套框架里最容易被实现走样的地方：

| 状态 | 触发 | 主 Agent 动作 |
|---|---|---|
| `RETRYABLE_FAILURE` | 超时、限流、工具瞬时错误 | 同模板同负载**原样重派新实例**，attempt +1，最多 2 次重试；新实例拿全新超时预算，**不继承 partial output** |
| `CONTRACT_VIOLATION` | 缺字段、无证据、越权写文件 | **作废该实例全部输出**，派全新实例从原始任务描述重跑，attempt 从 0 计数，旧输出不得作为输入 |
| `PERMANENT_FAILURE` | 连续 3 次失败或 harness 明确不可恢复 | 不得缩小范围重派，写入 `unverified`，最终报告显式暴露"未能覆盖" |
| 多失败窗口 | 同一波次 2 个以上 Agent 在 60 秒内同时失败 | 暂停该波次新派发，记录 `phase_level_failure`，等待人工介入 |

门控失败时的行为被写成硬约束：

> **主Agent不得自行降低门控标准，不得将失败子任务合并到主线程执行，不得缩小任务范围后重派。**

这直接对应用户原话里的"不要有任何缩水和将任务推给主线程"。

---

## 六、两个护栏数字

- **单波瞬时并发上限**：从 `scale-mapping.md` 读取，主 Agent 不得自行提高；harness 上限更低时取 `min`。
- **单次运行总 Agent 数上限 = 60**（硬护栏）。触达即停止派发新 Agent，把账本状态和未闭合项写入最终报告，**不得压缩剩余波次任务来"挤进"上限**。

---

## 七、续写与验收记录

原始对话在第 14 轮结束时只完成 9 份文件，其余 8 份标为"未做"。本仓库已补齐全部 8 份，并做了一轮跨文件一致性修复。

### 7.1 补齐的 8 份

| 组别 | 文件 | 状态 |
|---|---|---|
| 第三组 | [`templates/wave5-verify.md`](templates/wave5-verify.md) | ✅ 已写 |
| 第四组 | [`wrappers/recon-scout.md`](wrappers/recon-scout.md) | ✅ 已写 |
| 第四组 | [`wrappers/audit-specialist.md`](wrappers/audit-specialist.md) | ✅ 已写 |
| 第四组 | [`wrappers/critique-panel.md`](wrappers/critique-panel.md) | ✅ 已写 |
| 第四组 | [`wrappers/fix-worker.md`](wrappers/fix-worker.md) | ✅ 已写 |
| 第四组 | [`wrappers/verifier.md`](wrappers/verifier.md) | ✅ 已写 |
| 第五组 | [`artifacts/round-detection.md`](artifacts/round-detection.md) | ✅ 已写 |
| 第五组 | [`artifacts/report-naming.md`](artifacts/report-naming.md) | ✅ 已写 |

`wave5-verify.md` 严格遵循对话给出的设计约束：验收输入**不含**修复 Agent 的 `verification_commands`，只从 `finding_ref` 与原始验收标准出发；必须独立执行能直接瞄准故障的检查（含变异检验）；对 `affected_issues` 与 `residual_risks` 逐项处置；`TEST_CONFLICT`、`ROLLBACK_UNAVAILABLE` 等情形不得自动放行。

### 7.2 验收中发现并修复的契约漏洞

跨 19 个文件做交叉比对后，修掉了以下几处会导致流程跑不通或结论不可靠的问题：

| 问题 | 表现 | 修复 |
|---|---|---|
| `open_items.kind` 枚举不全 | 实际用到 10 种 kind，`handoff-schema` 只定义 5 种；`COVERAGE_GAP`、`AFFECTED_BY_FIX`、`REGRESSION_SCAN_REQUIRED`、`HUMAN_DECISION_REQUIRED`、`REVOKED` 均未登记 | 扩展为 10 种并逐条给出语义与对应 `next_action`；新增"枚举是闭集，新 kind 必须先登记"的纪律 |
| `next_action` 枚举不全 | 同上，`REASSIGN_TO_FIX`、`REASSIGN_TO_VERIFY`、`REQUIRE_HUMAN_DECISION`、`MARK_REVOKED` 等未定义 | 扩展为 10 种并给出与 `kind` 的对应表 |
| 总量护栏自相矛盾 | `protocol.md` 写死总量上限 60，`scale-mapping.md` 却用 `max(60, effective_slices + 30)`，大项目会突破 60 | 改为 `min(60, effective_slices + 30)`，并说明二者是"单波队列上限"与"跨波累计上限"两层约束，60 是天花板 |
| verify 追加字段未入契约 | `wave5-verify.md` 用了 `escalation_required`、`failure_category`、`residual_risk_disposition` 等字段，但 `output-contract` 的 verify schema 没有，按"禁止宽容解析"规则会被判 `CONTRACT_VIOLATION` | 扩展 `output-contract` 第 2.5 节的 verify payload，把追加字段正式纳入，并说明"第三态"如何用两字段组合表达而不新增枚举 |
| 账本状态多于返回状态 | 账本有 6 个状态，契约只有 4 个，`PENDING`/`RUNNING` 归属不明 | 补"两个枚举分属不同主体"的说明表与机械判定规则 |
| `.round-claim` 命名冲突 | 占位文件放在 `round{N}/` 内，既不匹配命名正则，又污染产物目录 | 移到独立隐藏目录 `docs/reports/.round-claims/`，枚举时跳过 |
| 孤儿轮次目录导致跳号 | 探测后主 Agent 崩溃、账本未写入时，重跑会得到 N+1，`round{N}/` 成为孤儿 | 增加"孤儿轮次回收规则"：三个条件全满足才复用 N，否则按 N+1 推进并记 `anomalies` |
| wrapper 冗余行为规则 | 包装器里复述了模板的行为规则，违反"包装器只做身份+触发+引用"的原则，且产生双份需同步维护的规则 | 全部删除，改为指向模板 |
| 主观措辞 | "视情况""通常"出现在判定表中，与"零裁量"原则冲突 | 改为可判定的具体条件 |

### 7.3 可移植性

`wrappers/*.md` 的 `name` / `description` / `tools` / `model` 是主流 harness 的通用字段，其余（`template` / `requires` / `wave` / `trigger_event`）是本框架的自定义调度元数据，harness 会忽略它们——它们的读者是主 Agent 和人工。跨 harness 移植的注意事项见 [`PORTABILITY.md`](PORTABILITY.md)，其中说明了"加载时机"的三种落地方式、各 harness 能力对照，以及移植时必改的三处。

**必须承认的局限**：Markdown 文件本身没有加载器，"波次一加载 `wave1-recon.md`"不会被任何 harness 自动执行。若要做到可靠加载，需要用调度器（代码）强制拼接，或依赖 harness 的 skill 机制。纯提示词方案下，加载靠模型自律。

---

## 八、五组板块的依赖关系

```
第四组 wrappers/  ──────►  第三组 templates/  ──────►  第二组 components/
   （身份+触发）              （组合组件+专属指令）          （叶子节点，无内部依赖）
```

依赖单向，无反向引用，组件之间不横向依赖。主 Agent 的上下文里**只加载**第一组（`protocol.md`、`scale-mapping.md`）和第五组的操作规则，以及第三组模板的**触发条件摘要**（不加载模板正文）。具体审查逻辑全部由子 Agent 在自己的隔离上下文中按需加载。

这就是"主 Agent 只调度"在文件组织层面的落地方式——不是靠提示词反复叮嘱它别多看，而是**根本不让那些文件出现在它的上下文里**。

---

## 九、文件索引

| 文件 | 加载时机 | 一句话职责 |
|---|---|---|
| [`MANUAL.md`](MANUAL.md) | 人读，不加载 | 使用说明书：三个前置决定、三种运行方式、逐步执行流程、每波必检项、排错表、字段速查 |
| [`PORTABILITY.md`](PORTABILITY.md) | 人读，不加载 | 跨 harness 移植：加载机制的三种落地方式、能力对照、必改三处 |
| [`orchestrator/protocol.md`](orchestrator/protocol.md) | 主 Agent 全程常驻 | 调度协议：工具白名单、状态账本、波次门控、重派规则、冲突送仲裁、并发护栏 |
| [`orchestrator/scale-mapping.md`](orchestrator/scale-mapping.md) | 波次一闭合后、波次二派发前 | 切片数 → 派发量与并发窗口的查找表，零裁量 |
| [`components/evidence-policy.md`](components/evidence-policy.md) | 所有子 Agent 产出发现前 | 门 0 反捏造检查、证据/推断分离、UNKNOWN 纪律、`file:line` 精度 |
| [`components/output-contract.md`](components/output-contract.md) | 所有子 Agent 返回前 | 统一信封、五种角色 payload schema、错误对象、状态机 |
| [`components/handoff-schema.md`](components/handoff-schema.md) | 每个波次闭合时 | Resume Packet：只带指针、摘要、裁决，不带正文 |
| [`templates/wave1-recon.md`](templates/wave1-recon.md) | 波次一 | 侦察：切片独立性、5–8 文件区间、入口点证据、UNKNOWN 标记 |
| [`templates/wave2-audit.md`](templates/wave2-audit.md) | 波次二 | 审计：单维度隔离、门 0 特化、为 Skeptic 预留攻击面 |
| [`templates/wave3-critique.md`](templates/wave3-critique.md) | 波次三 | 锐评：Skeptic 五步测试、覆盖缺口枚举、Arbiter 裁决树 |
| [`templates/wave4-fix.md`](templates/wave4-fix.md) | 波次四 | 修复：写权限硬边界、修复契约前置登记、影响半径声明 |
| [`templates/wave5-verify.md`](templates/wave5-verify.md) | 波次五 | 验收：定向检查、变异检验、影响半径处置、失败归因、人工升级 |
| [`wrappers/recon-scout.md`](wrappers/recon-scout.md) | 波次一派发时 | 侦察角色声明 + 触发条件 + 模板引用 |
| [`wrappers/audit-specialist.md`](wrappers/audit-specialist.md) | 切片指派时 | 审计角色声明 + 触发条件 + 模板引用 |
| [`wrappers/critique-panel.md`](wrappers/critique-panel.md) | 波次二闭合后 | 三种锐评子角色声明 + 触发条件 + 模板引用 |
| [`wrappers/fix-worker.md`](wrappers/fix-worker.md) | 发现被裁决维持时 | 修复角色声明 + 写权限边界 + 模板引用 |
| [`wrappers/verifier.md`](wrappers/verifier.md) | 某修复完成时 | 验收角色声明 + 只读约束 + 模板引用 |
| [`artifacts/round-detection.md`](artifacts/round-detection.md) | 波次一启动前 | 轮次号机械探测、边界情况表、并发锁、孤儿轮次回收 |
| [`artifacts/report-naming.md`](artifacts/report-naming.md) | 子 Agent 写出产物前 | 文件名正则、stage 取值、最终报告"只拼接不重写"规则 |

`orchestrator/`、`components/`、`templates/` 三组文件末尾附有**参考来源**，是原对话中实际联网检索并引用的材料（HiveMind 的并发实测、rt-skeptic 的验证协议、Fan-out auditing 的切片经验、Delivery Packet 的握手规范等）。`wrappers/` 与 `artifacts/` 是本轮续写，未引用新检索材料。
