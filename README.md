# 多 Agent 极限审计提示词框架

一套「主 Agent 只调度、子 Agent 干活」的代码审计提示词框架，用上下文隔离来对抗长链路审计中的判断漂移。

给任何 harness 和模型用，分五个波次做代码审计：

```
侦察 → 审计 → 锐评 → 修复 → 验收
```

核心主张是一句反常识的话：**让主 Agent 什么都不做**。主 Agent 不读代码、不读报告、不做判断，只负责派 Agent、看结构化返回、按写死的规则调度。所有需要「看一眼」才能决定的事，都必须转化为一个子 Agent 任务。

这样做的收益不是分工，而是**上下文隔离**——主 Agent 的上下文里永远只有结构化的任务描述和结果摘要，不会被代码、堆栈、报告全文污染，从而避免长审计链上的上下文漂移和越权判断。

---

## 快速开始

### 第一步：定三个前提

| 问题 | 说明 |
|---|---|
| **谁来加载模板？** | Markdown 没有加载器。选项：①调度器代码强制拼接（最可靠）②harness 的 skill 机制（中等）③全塞进 system prompt（快，但破坏隔离原则，不推荐） |
| **并发上限多少？** | 框架默认假设 8。harness 只支持 2–3 个并行子 Agent 时，让侦察 Agent 在 `harness_concurrency_cap` 里如实填写；读不到就取保守值 `4`，不要乐观假设 8 |
| **总预算给多少？** | 默认 `total_agent_count = 60`，分给发现波 40、下游预留 20。项目超过 40 个切片时一轮跑不完，超出部分标 `DEFERRED` 留给下一轮 |

### 第二步：选运行方式

**方式一 · Claude Code 或支持 `.claude/agents/` 的 harness**

把 `framework/wrappers/*.md` 复制到 `.claude/agents/`，文件名保持不变。frontmatter 中 `name` / `description` / `tools` / `model` 会被识别，`template` / `wave` / `trigger_event` 会被忽略（它们供主 Agent 和人工阅读）。

**方式二 · Agent SDK 或自己写调度器**（最可靠）

```python
BASE = "framework/"

def spawn_agent(role, template, extra):
    system = "\n\n".join([
        read(BASE + "components/evidence-policy.md"),
        read(BASE + "components/output-contract.md"),
        read(BASE + template),
    ]) + "\n\n" + extra
    return client.agents.create(system=system, tools=TOOLS[role])

# 波次一
recon = spawn_agent("recon", "templates/wave1-recon.md",
                    f"trace_id={trace_id} round_id={round_id}")
```

拼接**顺序**必须是 `evidence-policy` → `output-contract` → 模板，与各模板「强制加载」一节的声明一致，冲突时前面的优先。

**方式三 · 纯提示词**（不推荐）。这种做法下「加载」只是「你把这些文字给了它」，没有强制力。若只能用这种方式，至少做到：每派一个子 Agent 单独开上下文，只塞它需要的文件，不要在一个长对话里连续跑五波。

### 第三步：确认目录

```bash
ls docs/reports/ || mkdir -p docs/reports/
```

轮次探测 Agent 会扫描 `round(\d+)` 模式，取最大值 +1 作为本轮编号。检查一下：

```bash
ls docs/reports/ | grep -i '^round' | sort -V | tail -5
```

看到的最后一个编号，就是本轮轮次号的前一个。

---

## 执行流程

### 步骤 0 · 轮次探测

主 Agent 派子 Agent 执行 `artifacts/round-detection.md`，返回 `round_id` 写入账本。

**门控**：`round_id` 非空。返回 `PERMANENT_FAILURE`（目录读不了）则**停止，不要猜一个编号**。

### 步骤 1 · 侦察

```
主Agent → 派 recon-scout
         加载: evidence-policy + output-contract + wave1-recon
返回:   role=recon, payload={ slice_count, audit_slices[], unverified[],
                              entry_points[], covered_modules[],
                              harness_concurrency_cap }
```

**门控（全部满足）**：`status == SUCCESS`；`slice_count` 是整数；`slice_count == len(audit_slices)`；`audit_slices` 非空；`unverified` 已标注。任一不满足 → 派**全新实例**重做，不缩小任务。

随后主 Agent 做**唯一一次算术**：

```
effective_slices = len(audit_slices) + len(unverified)
        ↓ 若账本有 covered_modules 且带"上轮成功"标记，按 30% 上限折减
        ↓ 查 scale-mapping 第 3 节映射表
scale_decision = {
  effective_slices:         <上面结果>,
  planned_discovery_agents: min(effective_slices, 40),
  concurrency_window:       min(8, harness_cap),      # 1–5 切片档是 min(5, cap)
  admission_ceiling:        min(60, effective_slices + 30),
  total_budget: 60,  reserved_for_downstream: 20,  discovery_budget: 40,
  critique_roles:           <按切片数档位查表>,
  critique_extra:           null | "cross-pattern-scan"
}
写入账本，之后不再修改
```

锐评角色随规模变化：`1–5` 切片 → `[Skeptic, Arbiter]`；`6–20` → 加 `Devil's Advocate`；`>20` → 再加 1 个交叉模式扫描。

**易错点**：`concurrency_window` 在 1–5 档是 `min(5, cap)`，6 以上才是 `min(8, cap)`，不要一律写 8。

### 步骤 2 · 审计

每个 `(slice_id, dimension)` 组合派**一个独立实例**。同一切片的不同维度必须是不同实例，不允许一个 Agent 承担多个维度。

**门控**：所有实例达到终态；无 `CONTRACT_VIOLATION`；每个实例的 `searched_scope.files_read` 覆盖了 `files` + `shared_dependencies`，或缺失文件列在 `unreadable_files` 里。

**不要求「零发现」**——`NO_EVIDENCE_FOUND` 是合法且有价值的结果。但 `findings` 数组不能为空，空数组一律视为 `CONTRACT_VIOLATION`，因为「没查」和「查了没发现」必须可区分。

### 步骤 3 · 锐评

三种角色互斥，一个实例只承担一种。Skeptic 杀发现、Devil's Advocate 找覆盖缺口、Arbiter 在干净上下文中裁决。

**门控**：Skeptic 与 Devil's Advocate 均 `SUCCESS`；所有 `conflicts` 的 `resolution` 不再是 `PENDING`。

**关键规则**：Arbiter 的 `verdict` **不得**为 `EVIDENCE_GAP`。证据不足时它必须返回 `RETRYABLE_FAILURE`，由主 Agent 派证据补采实例，而不是自己下场补证。

### 步骤 4 · 修复

每条 `UPHELD` 的发现派一个修复实例。不同 `target_files` 可并行；**共享同一文件的必须串行**。

**门控**：每条 `UPHELD` 都有对应修复返回 `SUCCESS`；每条修复都带了 `affected_issues`（空数组必须配 `AFFECTED_ISSUES_EMPTY_CONFIRMED`）。

**预算检查**：修复 + 验收数量不要超过预留的 20。超出部分按 FIFO 处理前若干个，其余标 `UNRESOLVED_FINDING` + `blocking: false` 留给下一轮。

### 步骤 5 · 验收

派发时**不要传**修复 Agent 的 `verification_commands` 和 `output_snippet`。

| 返回 | 动作 |
|---|---|
| `PASS` + `escalation_required: false` | 关闭该缺陷 |
| `PASS` + `escalation_required: true` | 列入「待人工裁决」，本轮 `PARTIALLY_CLOSED` |
| `FAIL` + `FIX_INCOMPLETE` / `FIX_INCORRECT` | 回步骤 4 重修，**不回步骤 2** |
| `FAIL` + `BASELINE_INVALID` | 标 `REVOKED`，原发现是误报 |
| `RETRYABLE_FAILURE` + `ENVIRONMENT` | 无法验证，标 `deferred`，需人工 |

### 步骤 6 · 生成最终报告

`docs/reports/round{N}/round{N}-final-report.md`，固定五节：元信息 → 裁决索引表 → 验收结果表 → 未闭合项 → 覆盖说明。

**铁律**：每个结论单元都要带 `artifact_ref` 指向原始文件。主 Agent **只做排序、加索引、加统计**，不得改写任何子 Agent 的措辞、严重性或裁决结论。

---

## 每波必检项

| 波次 | 必须检查 | 不通过怎么办 |
|---|---|---|
| 0 探测 | `round_id` 非空 | 停止，报告目录不可读 |
| 1 侦察 | `slice_count == len(audit_slices)` 且非空 | 派新实例重做 |
| 1 侦察 | 无「小型/中型/大型」等规模标签 | 派新实例重做（硬禁令） |
| 2 审计 | 每条 finding 有 `file:line` + 本回合 `quote` | 该条标 `GATE_0_FAILED`，不入下游 |
| 2 审计 | 无 `findings` 空数组 | 视为 `CONTRACT_VIOLATION`，重派 |
| 2 审计 | 每条 `HIGH`/`CRITICAL` 有 ≥2 个 `alternatives` | 打回要求补，或降级 |
| 3 锐评 | Arbiter 未把 `EVIDENCE_GAP` 当终局裁决 | 视为 `CONTRACT_VIOLATION` |
| 3 锐评 | `untested` 没被当作 `refuted` | 打回 |
| 4 修复 | `files_touched` 都在 `target_files` 内 | 回滚 + `CONTRACT_VIOLATION` |
| 4 修复 | 返回中无「已修复」「验收通过」 | 视为自我验收，打回 |
| 4 修复 | 空 `affected_issues` 有确认标记 | 打回补标记 |
| 5 验收 | `residual_risk_disposition` 覆盖所有 `residual_risks` | `CONTRACT_VIOLATION` |
| 5 验收 | 未引用「根据修复报告」之类的说法 | `CONTRACT_VIOLATION` |

---

## 出错了怎么办

四种终态对应四种不同动作，**不要一律重试**——这是最容易实现走样的地方。

| 状态 | 含义 | 动作 |
|---|---|---|
| `RETRYABLE_FAILURE` | 超时、限流、工具瞬时错误 | 同模板同负载**原样重派新实例**，attempt +1，最多 2 次重试（总 3 次）。新实例拿全新超时预算，**不继承 partial output** |
| `CONTRACT_VIOLATION` | 缺字段、无证据、越权写文件 | **作废该实例全部输出**，派全新实例从原始任务重跑，attempt 从 0 计 |
| `PERMANENT_FAILURE` | 连续 3 次失败，或 harness 明确不可恢复 | **不得缩小范围重派**。写 `unverified`，最终报告暴露「未能覆盖」 |
| 多 Agent 同时失败 | 同波次 2 个以上在 60 秒内失败 | 暂停该波次新派发，记 `phase_level_failure` |

**门控失败的三条禁令**：不得自行降低门控标准；不得把失败子任务合并到主线程；不得缩小任务范围后重派。

修复是有副作用的，规则更严：返回 `RETRYABLE_FAILURE` 且 `files_touched` **非空**时，**必须先执行 `rollback_command`**，确认基线恢复后才重派；`rollback_command` 不可用则标 `deferred_items` + `requires_human_intervention`，**不要**在没回滚的情况下重派。

---

## 字段速查

**顶层信封**

```json
{
  "schema_version": "output-contract-v1",
  "agent_id": "string",
  "role": "recon | audit | critique | fix | verify",
  "status": "SUCCESS | RETRYABLE_FAILURE | CONTRACT_VIOLATION | PERMANENT_FAILURE",
  "contract_valid": true,
  "payload": {},
  "error": null
}
```

子 Agent **不得**返回 `PENDING` 或 `RUNNING`——那两个是主 Agent 账本的内部状态，返回它们一律判 `CONTRACT_VIOLATION`。

**五种角色 payload 必填字段**

| 角色 | 必填字段 |
|---|---|
| `recon` | `slice_count`、`audit_slices[]`、`unverified[]`、`entry_points[]`、`covered_modules[]`、`harness_concurrency_cap` |
| `audit` | `slice_id`、`searched_scope{}`、`findings[]`（至少一个条目） |
| `critique` | `critique_role`、`target_finding_ids[]`、`verdicts[]`、`coverage_gaps[]` |
| `fix` | `finding_id`、`files_touched[]`、`verification_commands[]`、`affected_issues[]`、`residual_risks[]` |
| `verify` | `finding_id`、`fix_agent_id`、`verdict`、`escalation_required`、`evidence{}`、`residual_risk_disposition[]`、`affected_issues_status[]`、`new_issues_found[]`、`failure_trigger`（FAIL）、`failure_category`（FAIL） |

**裁决枚举（锐评波）**

```
UPHELD        → 进入修复波
DOWNGRADED    → 进入修复波，但严重性降级
REVOKED       → 不修复，原发现作废
EVIDENCE_GAP  → 仅 Skeptic 可用；Arbiter 不得输出此值
```

**验收枚举（验收波）**：只有 `PASS | FAIL`。「带保留通过」不是第三个枚举值，而是 `PASS` + `escalation_required: true`。

**`open_items.kind`（10 种）**

前 8 种是「可自动消解的阻塞」，必须处理完才能推进；后 2 种是「人工阻塞」，不阻止本轮终止，但阻止把该缺陷记为已修复。

| kind | 有自动动作？ |
|---|---|
| `UNRESOLVED_FINDING` | 有（派仲裁 / 派修复） |
| `EVIDENCE_GAP` | 有（派证据补采） |
| `COVERAGE_GAP` | 有（派新审计） |
| `REGRESSION_SCAN_REQUIRED` | 有（追加回归扫描） |
| `AFFECTED_BY_FIX` | 有（转验收复核） |
| `PERMANENT_FAILURE` | 有（标未覆盖） |
| `UNVERIFIED_TARGET` | 有（下轮追加切片） |
| `DEFERRED_SLICE` | 有（下轮处理） |
| `HUMAN_DECISION_REQUIRED` | **无**，只能人裁决 |
| `REVOKED` | **无**，只能人确认 |

---

## 目录结构

```
framework/
├── MANUAL.md              ← 完整使用说明书（本文的详细版）
├── README.md              ← 总纲：设计原理
├── PORTABILITY.md         ← 跨 harness 移植指南
├── orchestrator/          ← 主 Agent 唯一常驻加载
│   ├── protocol.md            调度协议：工具白名单、账本、门控、重派、护栏
│   └── scale-mapping.md       切片数 → 派发量与并发窗口，零裁量
├── components/            ← 叶子节点，无内部依赖
│   ├── evidence-policy.md     证据基线（门 0）
│   ├── output-contract.md     统一返回契约
│   └── handoff-schema.md      波次间 Resume Packet
├── templates/             ← 五个波次模板
├── wrappers/              ← 五个角色包装器（身份 + 触发 + 引用）
└── artifacts/             ← 轮次探测、报告命名（机械规则）
```

依赖单向：`wrappers → templates → components`，无反向引用，组件间不横向依赖。

---

## 文档导航

| 文档 | 内容 |
|---|---|
| [`framework/MANUAL.md`](framework/MANUAL.md) | **完整使用说明书**——三个前置决定、三种运行方式、逐步流程、每波必检项、排错表、字段速查、常见问题 |
| [`framework/README.md`](framework/README.md) | 总纲——每一条设计为什么这样定，以及被推翻过的中间方案 |
| [`framework/PORTABILITY.md`](framework/PORTABILITY.md) | 跨 harness 移植——加载机制的三种落地方式、能力对照、必改三处 |
| [`docs/reports/`](docs/reports/) | 来源对话的完整转录（含思考与检索过程） |

---

## 常见问题

**审计报了一堆问题，但我觉得都是误报。**
先看锐评波的 `REVOKED` 数量。Skeptic 已撤销大部分，说明框架在正常工作。反过来，如果 Skeptic 一条都没撤销，反而要警惕——它的成功标准是「移除了多少」，全盘确认对它是失败，可能是橡皮图章。

**为什么验收 Agent 看不到修复 Agent 的测试结果？**
刻意的。验收若能看到「修复者说测试通过了」，它会倾向于复述而不是自己验证，而修复者选的测试可能根本没瞄准缺陷。这条隔离是框架里最重要的设计之一，不要为「方便」打破它。

**能不能跳过锐评波直接修复？**
不要。锐评是唯一专门杀发现的环节，跳过会让误报直接进入修复波，浪费最贵的预算——修复是唯一有写权限、有副作用的角色。

**Arbiter 说证据不足，但我不想补采。**
那这条发现只能悬着。框架里没有「证据不足也先修了再说」的路径。要么派证据补采，要么标 `REVOKED`，要么标 `HUMAN_DECISION_REQUIRED` 交给人。**不允许** Arbiter 自己「综合判断」——那等于把裁量塞回主 Agent。

**想改阈值（比如并发从 8 改成 16）。**
改可以，但要改两处并保持一致：`scale-mapping.md` 第 3 节的表，以及 `protocol.md` 第 6 节的护栏。改完记得同步 `MANUAL.md`。另外想清楚为什么要改——8 这个数字来自「无协调并行 Agent 在高争用下失败率可达 72–100%」的实测，不是随手定的。

---

## 诚实说明

- **来源**：这套东西的设计出自一段 DeepSeek 对话（转录在 `docs/reports/`）。其中 9 份文件是对话原文，8 份是本仓库续写。
- **局限**：Markdown 文件本身没有加载器，所谓「波次一加载某文件」不会被任何 harness 自动执行。要做可靠加载，得用调度器代码强制拼接，或依赖 harness 的 skill 机制。纯提示词方案下，加载靠模型自律。
- **未验证**：这套框架没有在真实项目上跑过完整一轮。它的逻辑一致性经过多轮交叉审查，但实际效果未经实测。

## License

[MIT](LICENSE)
