# 使用说明书

> 这份文档回答一个问题：**拿到这堆文件之后，具体怎么跑起来。**
>
> 想了解设计原理，看 [`README.md`](README.md)；想移植到别的 harness，看 [`PORTABILITY.md`](PORTABILITY.md)。本文只讲操作。

---

## 目录

1. [先做三个决定](#1-先做三个决定)
2. [选择运行方式](#2-选择运行方式)
3. [首次运行前的准备](#3-首次运行前的准备)
4. [完整执行流程（逐步）](#4-完整执行流程逐步)
5. [每一波要检查什么](#5-每一波要检查什么)
6. [出错了怎么办](#6-出错了怎么办)
7. [报告怎么读](#7-报告怎么读)
8. [字段速查表](#8-字段速查表)
9. [常见问题](#9-常见问题)

---

## 1. 先做三个决定

在写任何代码或提示词之前，先回答这三个问题。它们的答案会改变后面的做法。

### 决定一：谁来加载模板？

Markdown 文件没有加载器。"波次一加载 `wave1-recon.md`"不会自动发生。三个选项：

| 选项 | 做法 | 适合 |
|---|---|---|
| **A. 代码强制** | 调度器在派发子 Agent 时把模板正文拼进 system prompt | 用 Agent SDK / LangGraph / 自己写脚本。**最可靠** |
| **B. Skill 机制** | 每个模板做成一个 skill，靠 description 触发加载 | harness 支持按需加载。中等可靠 |
| **C. 全部塞入** | 所有文件拼成一个大 system prompt | 快速验证。上下文占用大，破坏隔离原则 |

**建议**：主 Agent 用 A（只加载 `orchestrator/` 两份 + `artifacts/` 两份 + 模板的触发条件摘要）；子 Agent 用 A 或 B 加载自己的模板。不要用 C，那会让主 Agent 看到所有代码审查细节，等于放弃了这套框架的核心价值。

### 决定二：并发上限是多少？

`scale-mapping.md` 默认假设并发窗口 8。如果你的 harness 只支持 2–3 个并行子 Agent：

- 让侦察 Agent 在 `harness_concurrency_cap` 字段里如实填写；
- 如果它读不到，按 `scale-mapping.md` 第 7 节取保守值 `4`；
- **不要**乐观假设 8，那会导致大量 Agent 排队或被杀。

### 决定三：总预算给多少？

框架默认 `total_agent_count = 60`，分给发现波 40、下游预留 20。如果你的项目很大（>40 个切片），一轮跑不完，会有一部分切片标为 `DEFERRED` 留给下一轮。这是**设计意图**——宁可诚实报告覆盖率，也不缩小每片的审计深度去凑数。

如果你愿意多花预算，把 60 调高即可（改 `protocol.md` 第 6 节和 `scale-mapping.md` 第 4 节两处，保持数值一致）。

---

## 2. 选择运行方式

### 方式一：Claude Code / 支持 `.claude/agents/` 的 harness

把 `wrappers/*.md` 复制到 `.claude/agents/`，文件名保持 `recon-scout.md` 等。frontmatter 里的 `name` / `description` / `tools` / `model` 会被识别，其余字段（`template` / `wave` / `trigger_event`）会被忽略——那没关系，它们的读者是你和主 Agent。

然后确认 tools 字段与你 harness 的工具名匹配：

```yaml
tools: Read, Grep, Glob, Bash        # 只读角色
tools: Read, Grep, Glob, Edit, Write, Bash   # 只有 fix-worker 需要写权限
```

改完用 `git status` 确认没有把 `tools` 改错——**验收 Agent 有写权限会破坏"只读验收"的设计**。

### 方式二：Agent SDK / 自己写调度器

用代码加载，这是最可靠的方式：

```python
# 伪代码
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

注意拼接**顺序**：`evidence-policy` → `output-contract` → 模板。这个顺序与各模板"强制加载"一节的声明一致，冲突时前面的优先。

### 方式三：纯提示词（不推荐，但可行）

把文件内容粘进对话，靠模型自律遵守。这种做法下，"加载"只是"你把这些文字给了它"，没有任何强制力。如果模型在第 30 轮忘了 `evidence-policy` 的门 0，你不会收到任何警告。

如果只能用这种方式，**至少**做到：每派一个子 Agent，单独开一个上下文，只塞它需要的那几个文件，不要在一个长对话里连续跑五波。

---

## 3. 首次运行前的准备

### 3.1 确认目录

```bash
# 在目标项目根目录下
ls docs/reports/ || mkdir -p docs/reports/
```

如果 `docs/reports/` 不存在，轮次探测 Agent 会自己创建（这是它唯一允许的写动作）。

### 3.2 确认历史命名

轮次探测会扫描 `round(\d+)` 模式。如果你的历史目录是 `round16/`、`round29/` 这种，会被正确识别。如果是不带 round 前缀的（例如 `audit-2026-10-19/`），不会被计入轮次号，会记在 `anomalies` 里——这正常，不影响。

**检查方法**：

```bash
ls docs/reports/ | grep -i '^round' | sort -V | tail -5
```

看到的最后一个编号，就是你本轮轮次号的前一个。

### 3.3 写死一个协议版本

在你的调度器里记录 `schema_version: "output-contract-v1"` 和 `"handoff-schema-v1"`。这两个字符串是硬校验，版本不匹配会被直接拒绝——将来改了契约格式，记得同步改版本号。

---

## 4. 完整执行流程（逐步）

下面是一轮完整审计的全过程。每一步都标了**谁做**、**产出什么**、**怎么判断能不能进下一步**。

### 步骤 0：轮次探测（主 Agent 派子 Agent 做）

```
主Agent → 派轮次探测Agent
         加载: artifacts/round-detection.md
         参数: trace_id, docs/reports 路径
返回:   { round_id: "round30", round_number: 30, anomalies: [...] }
主Agent → 写入账本 ledger.round_detection，之后不再改
```

**门控**：`round_id` 非空即通过。如果返回 `PERMANENT_FAILURE`（目录读不了），**停止**，不要猜一个轮次号。

### 步骤 1：波次一 · 侦察

```
主Agent → 派 1 个 recon-scout
         加载: evidence-policy + output-contract + wave1-recon
返回:   role=recon, payload={ slice_count, audit_slices[], unverified[], 
                              entry_points[], covered_modules[], 
                              harness_concurrency_cap }
```

**门控（必须全满足）**：

- 顶层 `status == "SUCCESS"`
- `slice_count` 是整数
- `slice_count == len(audit_slices)`
- `audit_slices` 非空
- `unverified` 已标注（空数组也算已标注）

任一不满足 → 派**全新实例**重做，不缩小任务。

**然后主 Agent 做一次计算**（这是它唯一做算术的地方）：

```
effective_slices = len(audit_slices) + len(unverified)
        ↓ (若账本有 covered_modules 且带"上轮成功"标记，按 30% 上限折减)
        ↓ 查 scale-mapping 第 3 节映射表
scale_decision = {
  effective_slices:        <上面的结果>,
  planned_discovery_agents: min(effective_slices, 40),   # 40 = discovery_budget
  concurrency_window:      min(8, harness_cap),          # 1–5 切片时是 min(5, cap)
  admission_ceiling:       min(60, effective_slices + 30),
  total_budget:            60,
  reserved_for_downstream: 20,
  discovery_budget:        40,
  affordable_slices:       min(effective_slices, 40),
  critique_roles:          <按切片数档位查表>,
  critique_extra:          null | "cross-pattern-scan"
}
写入账本，之后不再修改
```

**`critique_roles` 取决于切片数**（`scale-mapping.md` 第 3 节）：

| `effective_slices` | 锐评角色 | 额外 |
|---|---|---|
| 1–5 | `[Skeptic, Arbiter]` | 无 |
| 6–20 | `[Skeptic, Devil's Advocate, Arbiter]` | 无 |
| > 20 | 同上 3 个 | `+1 交叉模式扫描`（`critique_extra: "cross-pattern-scan"`） |

**易错点**：`concurrency_window` 在 1–5 档是 `min(5, harness_cap)`，6 以上才是 `min(8, harness_cap)`。别一律写 8。

**注意**：若 `effective_slices > 40`，超出的切片标 `DEFERRED`，最终报告要标注"本轮覆盖不完整"。不要自己挑哪 40 个——按 FIFO 取前 40。

### 步骤 2：波次二 · 审计

每个 `(slice_id, dimension)` 组合派**一个独立实例**。同一个切片的不同维度必须是不同实例。

```
主Agent → 派 N 个 audit-specialist（受 concurrency_window 限制）
         加载: evidence-policy + output-contract + wave2-audit
         参数: slice_id, files[], shared_dependencies[], dimension
返回:   role=audit, payload={ slice_id, searched_scope, findings[] }
```

**门控**：

- 所有派出的实例达到终态（`SUCCESS`）
- 无 `CONTRACT_VIOLATION`
- 每个实例的 `searched_scope.files_read` 覆盖了 `files` + `shared_dependencies`，或缺失文件列在 `unreadable_files` 里

**不要求"零发现"**。`NO_EVIDENCE_FOUND` 是合法且有价值的结果。

### 步骤 3：波次三 · 锐评

派三种角色，互斥，一个实例只承担一种：

```
主Agent → 派 skeptic（针对所有 CONFIRMED 发现）
        → 派 devils_advocate（针对覆盖完整性）
        → 若有矛盾结论，派 arbiter
返回:   role=critique, payload={ critique_role, verdicts[], coverage_gaps[] }
```

**门控**：

- Skeptic 和 Devil's Advocate 都 `SUCCESS`
- 所有 `conflicts` 的 `resolution` 不再是 `PENDING`
- 若 Arbiter 返回 `RETRYABLE_FAILURE`（证据不足），派**证据补采实例**，不是让 Arbiter 自己补

**关键规则**：Arbiter 的 `verdict` **不得**为 `EVIDENCE_GAP`。证据不足时它必须返回 `RETRYABLE_FAILURE`。

### 步骤 4：波次四 · 修复

每条 `UPHELD` 的发现派一个修复实例。不同 `target_files` 可并行，**共享同一文件的必须串行**。

```
主Agent → 派 M 个 fix-worker
         加载: output-contract + handoff-schema + wave4-fix
         参数: finding_id, verdict=UPHELD, target_files[], 
               acceptance_criteria, shared_dependencies[]
返回:   role=fix, payload={ files_touched, verification_commands,
                            affected_issues, residual_risks }
```

**门控**：

- 每条 `UPHELD` 都有对应修复返回 `SUCCESS`
- 每条修复都带了 `affected_issues`（空数组必须配 `AFFECTED_ISSUES_EMPTY_CONFIRMED`）

**预算检查**：修复 + 验收的数量不要超过预留的 20。超出部分按 FIFO 处理前若干个，其余标 `UNRESOLVED_FINDING` + `blocking: false` 留给下一轮。不要让发现波吃光预算。

### 步骤 5：波次五 · 验收

**派发时注意**：不要把修复 Agent 的 `verification_commands` 传进去。

```
主Agent → 派 K 个 verifier
         加载: evidence-policy + output-contract + wave5-verify
         参数: finding_id, fix_agent_id, target_files[], 
               acceptance_criteria, affected_issues[], residual_risk_flags[]
         ✗ 禁止传: verification_commands, output_snippet
返回:   role=verify, payload={ finding_id, verdict, escalation_required,
                               evidence{}, residual_risk_disposition[],
                               affected_issues_status[], failure_category }
```

**门控（三种情形分别处理）**：

| 返回 | 动作 |
|---|---|
| `PASS` + `escalation_required: false` | 关闭该缺陷 |
| `PASS` + `escalation_required: true` | 列入「待人工裁决」；本轮 `PARTIALLY_CLOSED` |
| `FAIL` + `FIX_INCOMPLETE`/`FIX_INCORRECT` | 回步骤 4 重修，**不回步骤 2** |
| `FAIL` + `BASELINE_INVALID` | 标 `REVOKED`，缺陷是误报 |
| `RETRYABLE_FAILURE` + `ENVIRONMENT` | 无法验证，标 `deferred`，需要人工 |

### 步骤 6：生成最终报告

```
docs/reports/round{N}/round{N}-final-report.md
```

固定五个部分，顺序不变：

1. 元信息（`round_id`、时间、`trace_id`、`scale_decision` 摘要）
2. 裁决索引表（每条发现：原文严重性 → 最终裁决 → `artifact_ref`）
3. 验收结果表（每条修复：`verdict`、`escalation_required`、`failure_category`）
4. 未闭合项（`blocking: true` 的 `open_items` 原样转写）
5. 覆盖说明（`deferred_slices` + `unverified` 全列；超过 50% 必须标"覆盖不完整"）

**铁律**：每个结论单元都要带 `artifact_ref` 指向原始文件。主 Agent **只做排序、加索引、加统计**，**不得**改写任何子 Agent 的措辞、严重性或裁决结论。

---

## 5. 每一波要检查什么

快速对照表。主 Agent 每一波闭合前逐条过。

| 波次 | 必须检查 | 不通过怎么办 |
|---|---|---|
| 0 探测 | `round_id` 非空 | 停止，报告目录不可读 |
| 1 侦察 | `slice_count == len(audit_slices)` 且非空 | 派新实例重做 |
| 1 侦察 | 无"小型/中型/大型"等规模标签 | 派新实例重做（这是硬禁令） |
| 2 审计 | 每条 finding 都有 `file:line` + 本回合 `quote` | 该条标 `GATE_0_FAILED`，不入下游 |
| 2 审计 | 无 `findings` 空数组 | 视为 `CONTRACT_VIOLATION`，重派 |
| 2 审计 | 每条 `HIGH`/`CRITICAL` 有 ≥2 个 `alternatives` | 打回要求补，或降级 |
| 3 锐评 | Arbiter 未输出 `EVIDENCE_GAP` 作为终局裁决 | 视为 `CONTRACT_VIOLATION` |
| 3 锐评 | `untested` 没被当作 `refuted` | 打回 |
| 4 修复 | `files_touched` 都在 `target_files` 内 | 回滚 + `CONTRACT_VIOLATION` |
| 4 修复 | 返回中无"已修复""验收通过" | 视为自我验收，打回 |
| 4 修复 | 空 `affected_issues` 有 `AFFECTED_ISSUES_EMPTY_CONFIRMED` | 打回补标记 |
| 5 验收 | `residual_risk_disposition` 覆盖所有 `residual_risks` | `CONTRACT_VIOLATION` |
| 5 验收 | 未引用"根据修复报告"之类的说法 | `CONTRACT_VIOLATION` |

---

## 6. 出错了怎么办

四种终态对应四种完全不同的动作。**不要一律重试**——这是最容易实现走样的地方。

| 返回状态 | 含义 | 动作 |
|---|---|---|
| `RETRYABLE_FAILURE` | 超时、限流、工具瞬时错误 | 同模板同负载**原样重派新实例**，attempt +1，最多 2 次重试（总 3 次）。新实例拿全新超时预算，**不继承 partial output** |
| `CONTRACT_VIOLATION` | 缺字段、无证据、越权写文件 | **作废该实例全部输出**，派全新实例从原始任务重跑，attempt 从 0 计，旧输出不得作为输入 |
| `PERMANENT_FAILURE` | 连续 3 次失败，或 harness 明确不可恢复 | **不得缩小范围重派**。写 `unverified`，最终报告显式暴露"未能覆盖" |
| 多 Agent 同时失败 | 同波次 2 个以上 Agent 在 60 秒内同时失败 | 暂停该波次新派发，记 `phase_level_failure`，等待人工 |

**门控失败时的三条禁令**（写死在 `protocol.md` 第 3 节）：

1. 不得自行降低门控标准
2. 不得把失败的子任务合并到主线程执行
3. 不得缩小任务范围后重派

### 修复 Agent 的特殊规则

修复是**有副作用**的，失败处理比发现波严格：

- 返回 `RETRYABLE_FAILURE` 且 `files_touched` **为空** → 可重派新实例
- 返回 `RETRYABLE_FAILURE` 且 `files_touched` **非空** → **先执行 `rollback_command`**，确认基线恢复后才重派
- `rollback_command` 不可用 → 标 `deferred_items` + `requires_human_intervention: true`，**不要**在没回滚的情况下重派

---

## 7. 报告怎么读

### 7.1 先看哪一节

打开 `round{N}-final-report.md`，**先看第 5 节"覆盖说明"**。如果那里写着"本轮覆盖不完整"，说明后面所有结论都只覆盖了一部分代码——在此之前先别急着看修了什么。

然后看第 3 节"验收结果表"。这一节是"哪些缺陷真的被修好了"的**唯一来源**。修复 Agent 自己的说法不采信。

### 7.2 三种结论怎么理解

| 看到 | 含义 |
|---|---|
| `PASS` + `escalation_required: false` | 真的修好了，可以关 |
| `PASS` + `escalation_required: true` | 技术检查过了，但有件事得人定（例如测试和修复冲突了）。**不要**当成已修复 |
| `FAIL` | 没修好，报告里会给可复现的触发条件 |

### 7.3 被撤销的发现

`REVOKED` 表示"经裁决或复验确认原发现不成立"。这**不是**审计做错了——多 Agent 审查中误报是常态，锐评波的存在就是为了杀掉它们。撤销率高说明锐评波在正常工作，不说明整体质量差。

---

## 8. 字段速查表

### 8.1 顶层信封

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

**注意**：子 Agent **不得**返回 `PENDING` 或 `RUNNING`——那两个是主 Agent 账本的内部状态。子 Agent 返回这两个值一律判 `CONTRACT_VIOLATION`。

### 8.2 五种角色的 payload 必填字段

| 角色 | 必填字段 |
|---|---|
| `recon` | `slice_count`、`audit_slices[]`、`unverified[]`、`entry_points[]`、`covered_modules[]`、`harness_concurrency_cap` |
| `audit` | `slice_id`、`searched_scope{}`、`findings[]`（至少一个条目） |
| `critique` | `critique_role`、`target_finding_ids[]`、`verdicts[]`、`coverage_gaps[]` |
| `fix` | `finding_id`、`files_touched[]`、`verification_commands[]`、`affected_issues[]`、`residual_risks[]` |
| `verify` | `finding_id`、`fix_agent_id`、`verdict`、`escalation_required`、`evidence{}`（含 `original_trigger_retested` / `regression_scan_performed` / `user_journey_aligned` / `mutation_check`）、`residual_risk_disposition[]`、`affected_issues_status[]`、`new_issues_found[]`（可为空）、`failure_trigger`（FAIL 时）、`failure_category`（FAIL 时） |

### 8.3 三个关键枚举

**裁决（`verdict`，锐评波）**

```
UPHELD      → 进入修复波
DOWNGRADED  → 进入修复波，但严重性降级
REVOKED     → 不修复，原发现作废
EVIDENCE_GAP → 仅 Skeptic 可用；Arbiter 不得输出此值
```

**验收（`verdict`，验收波）**

```
PASS | FAIL
```

"带保留通过"不是第三个枚举值，而是 `PASS` + `escalation_required: true`。

**`open_items.kind`（10 种）**

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

**前 8 种是"可自动消解的阻塞"，必须处理完才能推进；后 2 种是"人工阻塞"，不阻止本轮终止，但阻止把该缺陷记为已修复。**

---

## 9. 常见问题

**Q：审计 Agent 报了一堆问题，但我觉得都是误报。**

先看锐评波的 `REVOKED` 数量。如果 Skeptic 已经撤销了大部分，那是框架在正常工作。如果 Skeptic 全确认了没撤销任何一条，反而要警惕——Skeptic 的成功标准是"移除了多少"，全盘确认对它是失败。可能它在橡皮图章。

**Q：为什么验收 Agent 看不到修复 Agent 的测试结果？**

刻意的。如果验收能看到"修复者说测试通过了"，它会倾向于复述而不是自己验证。修复者选的测试可能根本没瞄准缺陷。这条隔离是框架里最重要的设计之一，不要为了"方便"打破它。

**Q：一轮跑不完怎么办？**

正常。超过 40 个切片就会有一部分 `DEFERRED`。下一轮接着审。框架选择"每轮诚实报告覆盖率"，而不是"一轮内悄悄降低深度假装审完了"。

**Q：能不能跳过锐评波直接修复？**

不要。锐评波是唯一专门杀发现的环节。跳过后，误报会直接进入修复波，浪费修复预算（而修复是最贵的——唯一有写权限、有副作用的角色）。

**Q：Arbiter 说证据不足，但我不想去补采。**

那这条发现就只能悬着。框架里没有"证据不足也先修了再说"的路径。要么派证据补采 Agent，要么把它标 `REVOKED`，要么标 `HUMAN_DECISION_REQUIRED` 交给人。**不允许** Arbiter 自己"综合判断"——那等于把裁量塞回主 Agent。

**Q：想改某个阈值（比如并发窗口从 8 改成 16）。**

改可以，但要改两处并保持一致：`scale-mapping.md` 第 3 节的表、以及 `protocol.md` 第 6 节的护栏。改完记得更新本说明书。另外想清楚为什么要改——8 这个数字来自"无协调并行 Agent 在高争用下失败率可达 72–100%"的实测，不是随手定的。

---

## 附：一页纸流程

```
0. 探测轮次      → round_id          门控: 非空
1. 侦察          → 切片清单          门控: slice_count == len(audit_slices)，非空
   ↓ 主Agent 算: effective_slices → 查表 → scale_decision（写入后不改）
2. 审计          → 带证据的发现      门控: 全部终态，覆盖完整
   ↓ 每个 (切片, 维度) 一个独立实例
3. 锐评          → 裁决              门控: 无 PENDING 冲突
   ↓ Skeptic 杀发现 / Devil's Advocate 找缺口 / Arbiter 裁决
4. 修复          → 修改 + 影响半径   门控: 每条 UPHELD 都有 SUCCESS
   ↓ 唯一有写权限的角色；不做自我验收
5. 验收          → PASS / FAIL       门控: 每条修复都有结论
   ↓ 不看修复者的验证记录，自己构造定向检查
6. 最终报告      → 只拼接不重写      每个结论带 artifact_ref
```
