# 多 Agent 极限审计提示词框架

[![checks](https://github.com/sqkl520/multi-agent-audit-framework/actions/workflows/checks.yml/badge.svg)](https://github.com/sqkl520/multi-agent-audit-framework/actions/workflows/checks.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dependencies: none](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen.svg)](tools)

一套「主 Agent 只调度、子 Agent 干活」的代码审计提示词框架，用上下文隔离来对抗长链路审计中的判断漂移。

**给谁用**：已经有（或愿意搭）子 Agent 派发能力、想让 AI 审一个真实代码库而不是玩具项目的人。
**和同类有什么不同**：它不只是提示词，还有一层**会失败的机械校验**。规则写了没有执行，在这里算 bug。

---

## 30 秒判断它适不适合你

| 你想要的 | 这套东西 |
|---|---|
| 让 AI 读完一个仓库并给出发现 | ✅ 默认路径，四个只读波次 |
| 让 AI 顺手改代码 | ⚠️ 修复是**独立可选路径**，默认不启用 |
| 保证修得对 | ❌ **不能**。机械闸门验的是流程合规，不是代码正确 |
| 零依赖、能审计时不给目标仓库留下任何改动 | ✅ 全程只读，报告写在目标仓库外 |

**先读 [`CAPABILITIES.md`](CAPABILITIES.md)** —— 它逐条列出这套东西能拦住什么、拦不住什么，
以及**当它漏掉检查时不会有任何东西提醒你**。那份文档比本 README 更能帮你决定要不要用。

---

## 快速开始

零依赖，只需要 Node.js ≥ 20。

```bash
git clone https://github.com/sqkl520/multi-agent-audit-framework.git
cd multi-agent-audit-framework

# 跑全部机械校验（约 40 个自测套件）。这是唯一能区分
# 「规则存在」和「规则被强制执行」的东西。
node tools/check-all.mjs
```

看到 `✅ 全部通过` 就说明框架自身是健康的。然后按 [`START-HERE.md`](START-HERE.md) 开始审计第一个仓库。

---

## 它长什么样

一次真实运行（7 条缺陷、905 测试基线）的实测数据：

| | 数值 |
|---|---|
| 墙钟时间 | 约 90 分钟 |
| 子 Agent | 9 个（10 次真实 subagent 调用）|
| 产出 | 20 个文件 / +804 −78 / 15 个新测试 |
| 机械闸门 | 26 个校验套件，0 误拦 |
| **然后独立红队评审这 7 条修复** | **5 条有缺陷，其中 2 条严重** |

最后一行是这套框架最重要的自我说明：**闸门全绿和代码正确是两件事。**
那次复盘写下的根因与修复记录在 [`experiments/review-7/`](experiments/review-7/)——
包括「一个会亮的绿灯比没有灯更危险」这条结论，以及为此删掉的三条自己写的假检查。

---

## 核心主张

**让主 Agent 什么都不做**。主 Agent 不读代码、不读报告、不做判断，只负责派 Agent、看结构化返回、按写死的规则调度。所有需要「看一眼」才能决定的事，都必须转化为一个子 Agent 任务。

这样做的收益不是分工，而是**上下文隔离**——主 Agent 的上下文里永远只有结构化的任务描述和结果摘要，不会被代码、堆栈、报告全文污染，从而避免长审计链上的上下文漂移和越权判断。

默认路径分四个只读波次（修复为独立的可选路径）：

```
侦察 → 宽扫 → 深挖 → 锐评 → 报告
```

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

> **🔒 第一原则 · 零写入**：除非你在本次对话中**明确要求**，主 Agent 与所有子 Agent **不得对被审仓库做任何写入**——不 `commit`、不 `push`、不 `add`、不编辑文件、不新建文件、不安装依赖。审计是纯只读活动，报告写到被审仓库之外（或 `.gitignore` 覆盖的目录）。
>
> **「修复」授权不等于「提交」授权**：即使你让它修代码，它也只能改 `target_files`，**不得 commit**。改文件 ≠ 可以提交，这是两道独立的授权门。
>
> 报告末尾必须附 `git status` 自检输出，证明跟踪文件零改动。详见 [`framework/orchestrator/protocol.md`](framework/orchestrator/protocol.md) 第 0 节。

> **2026-11-01 结构性修订**：默认路径已改为**只读**，修复移出默认流程。原因：round31 实跑中 83 条待修复只完成 1 条，整轮停在 `IN_PROGRESS` 且**没有最终报告**。修复是唯一有写权限、规则最严的角色，把它放在默认路径里等于让最脆弱的环节决定整轮能否结束。
>
> 详见 [`docs/analysis/2026-11-01-proposal.md`](docs/analysis/2026-11-01-proposal.md) 与 [`framework/orchestrator/protocol.md`](framework/orchestrator/protocol.md) 第 0.7 节。

```
【默认路径 · 只读】侦察 → 宽扫 → 深挖 → 锐评 → 出报告
                  全程无写权限、无副作用；终止状态必然是 CLOSED 或 PARTIALLY_CLOSED
【可选路径 · 有副作用】修复 → 验收（独立启动，消费默认路径报告的 UPHELD 发现）
```

### 步骤 0 · 轮次探测 + 状态机初始化

主 Agent 派子 Agent 执行 `artifacts/round-detection.md`，返回 `round_id`。

**关键**：若 `docs/reports/round{N}/state.json` 已存在且 `status != CLOSED`，**续跑它，不要新开 round{N+1}**。round31 停在 `IN_PROGRESS`，新开一轮会重复审已审过的 40 片。

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
  effective_slices:              <上面结果>,
  concurrency_window:            min(8, harness_cap),      # 1–5 切片档是 min(5, cap)
  planned_sweep_agents:          <见下：宽扫与深挖共享 discovery_budget，不能先到先得>,
  admission_ceiling:             min(60, effective_slices + 30),
  total_budget: 60,  reserved_for_downstream: 20,  discovery_budget: 40,
  critique_roles:                <按切片数档位查表>,
  critique_extra:                null | "cross-pattern-scan",
  planned_deep_dive_agents:      null,     # 宽扫完成后才确定
}
写入账本，之后不再修改（深挖相关字段在二A 闭合后第二段冻结）
```

**宽扫预算必须与深挖切分，否则两遍制会失效**：

```
if effective_slices < discovery_budget:
    planned_sweep_agents = effective_slices
    deep_dive_budget     = discovery_budget - effective_slices
else:
    sweep_budget         = ceil(discovery_budget × 0.4)
    planned_sweep_agents = min(effective_slices, sweep_budget)
    deep_dive_budget     = discovery_budget - planned_sweep_agents
```

> **为什么**：若写成 `planned_sweep_agents = min(effective_slices, discovery_budget)`，当 `effective_slices ≥ discovery_budget` 时（round31 是 85 ≥ 40），宽扫会**吃光全部预算**，深挖可用预算为 0，两遍制退化成"只宽扫、零深挖"——**比原设计更糟**。代入 round31：宽扫 16 片 + 深挖约 24 个实例，覆盖片数变少但**深挖的是经可达性筛选的 PROD 代码**。

**易错点**：`concurrency_window` 在 1–5 档是 `min(5, cap)`，6 以上才是 `min(8, cap)`，不要一律写 8。

**报告必须给两个独立覆盖率**：「宽扫覆盖率」和「深挖覆盖率」。不得合并成一个数字假装覆盖完整。

### 步骤 2A · 宽扫（sweep）

**每个切片派一个宽扫实例**，它看全部 6 个维度，但只产出**线索**（`file:line` + 一行原文 + 疑似维度 + 置信度），**不判严重性、不进锐评、不进报告正文**。

同时为切片标记 **`reachability`**（`PROD` / `TEST_ONLY` / `UNREACHABLE`）——这是把预算从死代码里救回来的关键。

**门控**：`lead_count == len(leads)`；`dimension_histogram` 之和 == `lead_count`；`files_read` 覆盖切片文件或缺失项在 `files_unreadable` 中。

> **为什么这一步是必需的**：原设计「每个 `(切片, 维度)` 派一个实例」× 6 维，85 片需要 510 个实例（预算的 8.5 倍）；按片数派则每片只能审 1 维（放弃 5/6 覆盖）。宽扫按片派，算术成立。

### 步骤 2B · 深挖（audit）

**只对宽扫标记为「该深挖」的切片派**，每片按线索指向的维度拆实例，走完整门 0 证据链。

**触发阈值（写死，零裁量）**：有 `HIGH` 线索 → 必深挖该维度；`lead_count ≥ 3` → 深挖计数最高的 2 个维度；`UNREACHABLE` → 不深挖。

**门控**：所有实例达到终态；无 `CONTRACT_VIOLATION`；每个实例的 `searched_scope.files_read` 覆盖了 `files` + `shared_dependencies`，或缺失文件列在 `unreadable_files` 里。

**不要求「零发现」**——`NO_EVIDENCE_FOUND` 是合法且有价值的结果。但 `findings` 数组不能为空，空数组一律视为 `CONTRACT_VIOLATION`。

### 步骤 3 · 锐评

三种角色互斥，一个实例只承担一种。Skeptic 杀发现、Devil's Advocate 找覆盖缺口、Arbiter 在干净上下文中裁决。

**Skeptic 新增固定职责**：用机械比对检查 `discipline_log` 与实际派发记录，找出**未申报的裁量**，输出 `discipline_violations[]`。

**门控**：Skeptic 与 Devil's Advocate 均 `SUCCESS`；所有 `conflicts` 的 `resolution` 不再是 `PENDING`。

**关键规则**：Arbiter 的 `verdict` **不得**为 `EVIDENCE_GAP`。证据不足时它必须返回 `RETRYABLE_FAILURE`，由主 Agent 派证据补采实例。

### 步骤 4 · 出报告（**默认路径的终点，不可跳过**）

生成 `docs/reports/round{N}/round{N}-final-report.md`，固定五节：元信息 → 裁决索引表 → 覆盖率 → 未闭合项 → 裁量记录 + 未深挖线索附录。

**铁律**：每个结论单元都要带 `artifact_ref` 指向原始文件。主 Agent **只做排序、加索引、加统计**。

**「跑完了但没有报告」不是合法终态。** 任何终止路径（正常完成 / 预算耗尽 / 用户中断 / 连续失败）都必须先出报告再退出，详见 `artifacts/final-report.md`。

### 步骤 5 · 修复（**可选路径，独立启动**）

用户发出「修复 round{N}」指令才启动。消费默认路径报告里 `UPHELD` 的发现，**不重新侦察、不重新切片**。

每条发现独立记账：一条失败（回滚、需人工、环境不可用）只影响该条，**不阻塞其他条，也不影响已产出的报告**。

**验收的硬约束**：派发时**不要传**修复 Agent 的 `verification_commands` 和 `output_snippet`。且变异验证是**强制**的（除 `harness_unsupported` / `unsafe_revert`），并要求覆盖**调用点**一层——只测纯函数会导致「改回错误实现仍全绿」。

---

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
| `CONTRACT_VIOLATION` | 缺字段、无证据、越权写文件 | **作废该实例全部输出**，派全新实例从原始任务重跑，**attempt 继续 +1（不归零）**，同一失败原因连续 2 次即停止重派 |
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
│   ├── protocol.md            调度协议：两条路径、裁量分级、账本、门控、重派、护栏
│   └── scale-mapping.md       切片数 → 宽扫/深挖派发量与并发窗口，零裁量
├── components/            ← 叶子节点，无内部依赖
│   ├── evidence-policy.md     证据基线（门 0）+ 引用分级纪律
│   ├── output-contract.md     统一返回契约（六个角色，含 sweep）
│   └── handoff-schema.md      波次间 Resume Packet
├── templates/             ← 波次模板
│   ├── wave1-recon.md         侦察
│   ├── wave2a-sweep.md        宽扫（1 片 1 实例，产出线索 + 可达性）
│   ├── wave2-audit.md         深挖（按维度，完整门 0）
│   ├── wave3-critique.md      锐评（+ 裁量稽查）
│   ├── wave4-fix.md           修复（可选路径）
│   └── wave5-verify.md        验收（可选路径）
├── wrappers/              ← 角色包装器（身份 + 触发 + 引用）
└── artifacts/             ← 机械规则
    ├── round-detection.md     轮次编号探测
    ├── report-naming.md       产物命名
    ├── run-state.md           状态机：断点续跑的唯一依据
    └── final-report.md        最终报告：必须产出，不允许缺席
```

依赖单向：`wrappers → templates → components`，无反向引用，组件间不横向依赖。

---

## 与旧版的差异（2026-11-01）

| 项 | 旧 | 新 | 原因 |
|---|---|---|---|
| 默认路径 | 五波次连跑（含修复） | **只读四波 + 出报告** | round31：83 待修 / 1 完成，无最终报告 |
| 波次二 | 每 `(切片,维度)` 一实例 | **二A 宽扫 + 二B 深挖** | 6 维 × 85 片 = 510 实例，算术不可行 |
| 主 Agent 裁量 | 零裁量 | **L0 禁止 / L1 留痕 / L2 自由** | 禁令把裁量逼成不申报（round31 9/40 偏离） |
| 状态 | 内存账本 | **`state.json` 落盘 + 续跑协议** | 中断是常态；R22 双实例覆盖事故 |
| 报告 | 跑完才出 | **任何终止路径都必须出** | round31 停在 IN_PROGRESS 且无报告 |
| 变异检验 | 可选但推荐 | **强制 + 覆盖调用点** | R28：只看纯函数，改回错误实现 493 条测试全绿 |
| 引用 | 不分级 | **A/B/C/D 四级 + 口径要求** | 25 个 URL 无一 404，但存在「用错地方」 |

---

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
改可以，但要改两处并保持一致：`scale-mapping.md` 第 3 节的表，以及 `protocol.md` 第 6 节的护栏。改完记得同步 `MANUAL.md`。

> **⚠️ 2026-11-02 更正**：本节此前写「8 这个数字来自『无协调并行 Agent 失败率可达 72–100%』的实测」。经核实，那两个数字是**某论文在 mock API server 上测得的 HTTP 502/连接重置率**，不是审计失败率；该论文**从未建议并发窗口 = 8**；且「准入+背压即降到 0–18%」是对原文的反向误读。**并发窗口 8 是一个工程取值，没有直接实测支撑**——正确读法见 `orchestrator/scale-mapping.md` 第 3 节。

---

## 诚实说明

- **来源**：这套东西的设计出自一段 DeepSeek 对话（转录在 `docs/reports/`）。其中 9 份文件是对话原文，8 份是本仓库续写。该分享链接现返回 **429**，无法复核——也就是说**多数论断的真实上游是一段 LLM 对话，而非论文**。它的正确定位是「一套设计约定的集合」，不是「实证研究的汇总」。
- **局限**：Markdown 文件本身没有加载器，所谓「波次一加载某文件」不会被任何 harness 自动执行。要做可靠加载，得用调度器代码强制拼接，或依赖 harness 的 skill 机制。纯提示词方案下，加载靠模型自律。
- **已在真实项目上跑过一轮，结果是「部分失效」**：`dsh-fcl-android-launcher` 的 round31 是五波次的首次完整实跑，暴露了三个结构性问题（详见 [`docs/analysis/2026-11-01-structural-diagnosis.md`](docs/analysis/2026-11-01-structural-diagnosis.md)）：
  1. **覆盖率**：侦察出 85 个有效切片，实际只派发 40 个，38 片 `DEFERRED`；
  2. **预算被死代码吃掉**：40 片里有 29 片是 `fakefx`（JavaFX 移植），而锐评波事后判定其中 162 个文件「从任何生产入口都到不了」；
  3. **没有跑完**：83 条待修复只完成 1 条，`wave_status` 停在 `IN_PROGRESS`，**没有最终报告**。
- **框架的引用经逐条核实，发现「链接真实、用错地方」**：25 个外部 URL 无一 404，但有把「API 掉线率」当「审计失败率」、把「某包存在」当「某结论已证明」等问题。已修复并新增引用分级纪律（`components/evidence-policy.md` 第 8 节），核实详情见 [`docs/analysis/2026-11-01-citation-audit.md`](docs/analysis/2026-11-01-citation-audit.md)。
- **当前状态**：本文档的**引用与契约一致性**已修复；**覆盖率、断点续跑、两遍制**等结构性改造仍是提案，见 [`docs/analysis/2026-11-01-proposal.md`](docs/analysis/2026-11-01-proposal.md)。

## License

[MIT](LICENSE)
