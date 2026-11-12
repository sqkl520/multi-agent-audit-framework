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

## 0. 第一原则：零写入（先读这一节）

**除非用户在本次对话中明确要求，不得对被审仓库做任何写入。**

| 允许（只读取证） | 禁止（除非显式授权） |
|---|---|
| `git log` / `status` / `diff` / `show` / `blame` / `ls-files` / `check-ignore` | `git commit` / `push` / `tag` |
| `Read` / `Grep` / `Glob` | `git add` / `stash` / `reset` / `checkout --` |
| 读依赖清单、读构建配置 | 编辑或删除被审仓库任何文件 |
| | 新建文件到被审仓库 |
| | `npm install` / `gradle build` 等写盘操作 |

**产物写在哪**：

```bash
# 写之前必须先验证目标会被 git 忽略
git check-ignore -q <目标路径> && echo "安全" || echo "会被跟踪，换位置"
```

**「修复」不等于「提交」**：即使用户说「修复」，也只授权改 `target_files` 里的文件，**不授权 commit**。这是两道独立的门。

**为什么这条在最前面**：审计的价值建立在「被审对象未被改动」之上。一旦改过，所有 `file:line` 证据的时间点都无法自证。而且这条最容易因「善意」被违反——「顺手修一下」「先 commit 免得丢了」都是典型违规路径。

**报告必须附自检证据**（不能只说"我没改"）：

```bash
git -C <被审仓库> status --short | grep -E '^ ?[MDARC]' && echo "❌ 有改动" || echo "✅ 零改动"
```

详见 `orchestrator/protocol.md` 第 0 节。

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
  # ⚠ 2026-11-10 修正：此前写的是 min(effective_slices, 40)，
  #   与 scale-mapping.md:186 的 min(effective_slices, sweep_budget) 冲突。
  #   代入 85 片：按旧的写法则宽扫吃掉全部 40，随后
  #   「effective_slices + deep_dive_cost ≤ discovery_budget」
  #   = 「85 + cost ≤ 40」恒假 → 深挖永远为 0，全部切片标 DEFERRED。
  #   那是框架明确说要避免的"只宽扫、零深挖"形态，而 MANUAL 自己就是那个版本。
  sweep_budget:            ceil(discovery_budget × 0.4),   # 40 × 0.4 = 16
  planned_sweep_agents:    min(effective_slices, sweep_budget),
  deep_dive_budget:        discovery_budget - sweep_budget, # 40 - 16 = 24
  concurrency_window:      min(8, harness_cap),          # 1–5 切片时是 min(5, cap)
  admission_ceiling:       min(60, effective_slices + 30),
  total_budget:            60,
  reserved_for_downstream: 20,
  discovery_budget:        40,
  affordable_slices:       min(effective_slices, 40),
  planned_deep_dive_agents: null,                        # 宽扫完成后才确定
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

### 步骤 2A：波次二A · 宽扫（sweep）

**一片一实例**，每个宽扫 Agent 看**全部 6 个维度**，但只产出**线索**（`file:line` + 一行原文 + 疑似维度 + 置信度），**不判严重性、不进锐评、不进报告正文**。

```
主Agent → 派 N 个 sweep-scout（N = planned_sweep_agents，受 concurrency_window 限制）
         加载: evidence-policy + output-contract + wave2a-sweep
         参数: slice_id, files[], shared_dependencies[]      ← 注意：不传 dimension
返回:   role=sweep, payload={ slice_id, reachability, files_read, leads[],
                              lead_count, dimension_histogram }
```

**门控**：

- `lead_count == len(leads)`
- `dimension_histogram` 各值之和 == `lead_count`
- `files_read` 覆盖 `files` + `shared_dependencies`，或缺失项在 `files_unreadable` 中

**两个易错点**：

1. **`leads` 允许为空数组**——宽扫不下「已审计」的结论，覆盖率由 `files_read` 记账。
2. **`reachability` 必填**（`PROD` / `TEST_ONLY` / `UNREACHABLE`）——它决定该切片会不会被深挖，是把成本变成价值的关键。

**为什么要有这一步**：原设计「每个 `(切片, 维度)` 一实例」× 6 维，85 片需要 510 个实例（预算的 8.5 倍）；按片数派则每片只审 1 维（放弃 5/6 覆盖）。宽扫按片派，算术才成立。

### 步骤 2B：波次二B · 深挖（audit）

**只对宽扫判定「该深挖」的切片派**，每片按线索指向的维度拆实例，走完整门 0 证据链。

**触发阈值（写死，零裁量）**：

| 条件 | 动作 |
|---|---|
| 有 ≥1 条 `HIGH` 线索 | 必深挖，维度取该线索的 `suspected_dimension` |
| `lead_count ≥ 3` | 深挖 `dimension_histogram` 计数最高的 2 个维度 |
| `reachability == UNREACHABLE` | **不深挖** |
| 其余 | 不深挖，线索进报告附录 |

```
主Agent → 派 M 个 audit-specialist（M = 命中切片的深挖维度数之和）
         加载: evidence-policy + output-contract + wave2-audit
         参数: slice_id, files[], shared_dependencies[], dimension
返回:   role=audit, payload={ slice_id, searched_scope, findings[], self_checks }
```

**门控**：

- 所有派出的实例**已进入终态**（`SUCCESS` **或** `PERMANENT_FAILURE`）
- 不存在待重派的 `CONTRACT_VIOLATION`（`attempt ≤ 3` 的才算待重派）
- 每个实例的 `searched_scope.files_read` 覆盖了 `files` + `shared_dependencies`，或缺失文件列在 `unreadable_files` 里

**不要求"零发现"**。`NO_EVIDENCE_FOUND` 是合法且有价值的结果。

> **2026-11-03 修正**：原文写的是「所有派出的实例达到终态（`SUCCESS`）」——**把「终态」等同于 `SUCCESS`**，等于排除了 `PERMANENT_FAILURE`。而 `PERMANENT_FAILURE` 在 `protocol.md` §4 中是合法终态且**禁止重派**，于是门控永远为 false，流程卡死。这正是 round31 停在 `IN_PROGRESS` 的一条独立成因。现在两者并列：**终态 = `SUCCESS` ∪ `PERMANENT_FAILURE`**。失败切片写入 `unverified`，在报告「覆盖说明」中列出。深挖失败率 > 20% 时跳过锐评直接出报告（`PARTIALLY_CLOSED`）。

**深挖成本验算**：`planned_sweep_agents + deep_dive_cost ≤ discovery_budget`。超出则按 `reachability` → `lead_count` 降序 → FIFO 截断，其余标 `DEFERRED_DEEP_DIVE`，并把截断决策写进 `discipline_log`。

> **⚠ 2026-11-10 修正**：此处此前写的是 `effective_slices + deep_dive_cost ≤ discovery_budget`——用的是**切片总数**而不是**实际派出的宽扫 agent 数**。代入 85 切片、`discovery_budget = 40`：`85 + cost ≤ 40` 恒假，于是**深挖永远为 0**。`scale-mapping.md:160` 用的分子是 `planned_sweep_agents`，两边不一致，而 MANUAL 是主 Agent 唯一加载的操作文档（见下方「加载顺序」）。已统一为 `planned_sweep_agents`。
>
> 验算示例（85 切片）：`sweep_budget = 16`、`planned_sweep_agents = 16`、`deep_dive_budget = 24`。`16 + cost ≤ 40` 成立，深挖可用 24 个 agent 位。

### 步骤 3：波次三 · 锐评

派三种角色，互斥，一个实例只承担一种：

```
主Agent → 派 skeptic（针对所有 CONFIRMED 发现 + discipline_log 机械比对）
        → 派 devils_advocate（针对覆盖完整性）
        → 若有矛盾结论，派 arbiter
返回:   role=critique, payload={ critique_role, verdicts[], coverage_gaps[] }
```

**门控**：

- Skeptic 和 Devil's Advocate 都 `SUCCESS`
- 所有 `conflicts` 的 `resolution` 不再是 `PENDING`
- 若 Arbiter 返回 `RETRYABLE_FAILURE`（证据不足），派**证据补采实例**，不是让 Arbiter 自己补

**关键规则**：Arbiter 的 `verdict` **不得**为 `EVIDENCE_GAP`。证据不足时它必须返回 `RETRYABLE_FAILURE`。

**Skeptic 的新增固定职责（2026-11-01）**：用机械比对检查 `discipline_log` 与实际派发记录（`wave2_completed`、产物文件列表），找出**未申报的裁量**，输出 `discipline_violations[]`。

> 依据：round31 的 9 处维度偏离正是 Devil's Advocate 用机械比对发现的，主 Agent 事先并未申报。机械比对有效，把它变成固定职责。

### 步骤 4：出报告（**默认路径的终点**）

生成 `docs/reports/round{N}/round{N}-final-report.md`，固定五节：元信息 → 裁决索引表 → 覆盖率 → 未闭合项 → 裁量记录 + 未深挖线索附录。详见 `artifacts/final-report.md`。

**铁律**：每个结论单元都要带 `artifact_ref`。主 Agent **只做排序、加索引、加统计**。

**「跑完了但没有报告」不是合法终态。** 任何终止路径（正常完成 / 预算耗尽 / 用户中断 / 连续失败）都必须先出报告再退出。`state.json` 的 `status` 只能是 `RUNNING` / `PARTIALLY_CLOSED` / `CLOSED` / `BLOCKED`，**`IN_PROGRESS` 已被移除**——round31 正是停在这个值上，既没跑完也没收尾。

### 步骤 5：波次四 · 修复（**可选路径，独立启动**）

> **默认路径到此结束。** 以下内容只有用户发出「修复 round{N}」指令时才执行。它消费报告里 `UPHELD` 的发现，**不重新侦察、不重新切片**。

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

**每条发现独立记账**：一条失败（回滚、需人工、环境不可用）只影响该条，不阻塞其他条，也不影响已产出的报告。

### 步骤 6：波次五 · 验收（**可选路径**）

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
| `RETRYABLE_FAILURE` + `ENVIRONMENT` | 无法验证，标 `deferred` 进下一轮，不阻塞收尾 |

### 步骤 7：生成最终报告（若步骤 4 已出，这里是补充修复结果）

> **注意**：默认路径在**步骤 4** 就已产出报告。本节只在跑了可选路径（修复/验收）后，把修复结果追加进去。

```
docs/reports/round{N}/round{N}-final-report.md
```

固定五个部分，顺序不变：

1. 元信息（`round_id`、时间、`trace_id`、`scale_decision` 摘要、`report_state`）
2. 裁决索引表（每条发现：原文严重性 → 最终裁决 → `artifact_ref`）
3. 验收结果表（每条修复：`verdict`、`escalation_required`、`failure_category`）——**只在跑了可选路径时存在**
4. 未闭合项（`blocking: true` 的 `open_items` 原样转写）
5. 覆盖说明（`deferred_slices` + `deferred_deep_dive` + `unverified` 全列；超过 50% 必须标"覆盖不完整"）

**铁律**：每个结论单元都要带 `artifact_ref` 指向原始文件。主 Agent **只做排序、加索引、加统计**，**不得**改写任何子 Agent 的措辞、严重性或裁决结论。

完整骨架与自检清单见 `artifacts/final-report.md`。

---

## 5. 每一波要检查什么

快速对照表。主 Agent 每一波闭合前逐条过。

| 波次 | 必须检查 | 不通过怎么办 |
|---|---|---|
| 0 探测 | `round_id` 非空 | 停止，报告目录不可读 |
| 0 探测 | 若 `state.json` 存在且 `status != CLOSED` | **续跑该轮，不新开 N+1** |
| 1 侦察 | `slice_count == len(audit_slices)` 且非空 | 派新实例重做 |
| 1 侦察 | 无"小型/中型/大型"等规模标签 | 派新实例重做（这是硬禁令） |
| 2A 宽扫 | `lead_count == len(leads)` 且 histogram 之和相符 | `CONTRACT_VIOLATION`，重派 |
| 2A 宽扫 | `reachability` 三值之一，无缺失 | 重派（这一项决定是否深挖） |
| 2A 宽扫 | `files_read` 覆盖切片文件或缺失项已登记 | `CONTRACT_VIOLATION` |
| 2B 深挖 | 每条 finding 都有 `file:line` + 本回合 `quote` | 该条标 `GATE_0_FAILED`，不入下游 |
| 2B 深挖 | 无 `findings` 空数组 | 视为 `CONTRACT_VIOLATION`，重派 |
| 2B 深挖 | 每条 `HIGH`/`CRITICAL` 有 ≥2 个 `alternatives` | 打回要求补，或降级 |
| 2B 深挖 | `effective_slices + deep_dive_cost ≤ discovery_budget` | 按确定性规则截断，记 `discipline_log` |
| 3 锐评 | Arbiter 未输出 `EVIDENCE_GAP` 作为终局裁决 | 视为 `CONTRACT_VIOLATION` |
| 3 锐评 | `untested` 没被当作 `refuted` | 打回 |
| 3 锐评 | `discipline_log` 与实际派发记录逐条比对完成 | 未申报裁量 → 该轮结论作废 |
| 4 报告 | 报告文件**真实写盘**且路径已回写 `state.json` | `status: BLOCKED`，明确报错 |
| 4 报告 | `status` 不是 `IN_PROGRESS` | 视为未收尾，必须出报告 |
| 4 报告 | 每条结论都有 `artifact_ref` | 无出处的条目**删掉** |
| 5 修复 | `files_touched` 都在 `target_files` 内 | 回滚 + `CONTRACT_VIOLATION` |
| 5 修复 | 返回中无"已修复""验收通过" | 视为自我验收，打回 |
| 5 修复 | 空 `affected_issues` 有 `AFFECTED_ISSUES_EMPTY_CONFIRMED` | 打回补标记 |
| 6 验收 | `mutation_check = performed`（除两种例外） | `CONTRACT_VIOLATION`；跳过理由不接受"时间不够" |
| 6 验收 | 「返回值决定用户可见行为」的修复，`mutation_scope = implementation_and_callsite` | 补调用点变异，或报告显式声明未做 |
| 6 验收 | `residual_risk_disposition` 覆盖所有 `residual_risks` | `CONTRACT_VIOLATION` |
| 6 验收 | 未引用"根据修复报告"之类的说法 | `CONTRACT_VIOLATION` |
| 全程 | L0 行为（读源码/亲自修复/提并发/降门控/自裁决/缩范围） | 该轮结论**作废** |
| 全程 | L1 裁量有 `discipline_log` 条目且 `mechanical_check` 可执行 | 未留痕 → 该轮结论**作废** |

---

## 6. 出错了怎么办

四种终态对应四种完全不同的动作。**不要一律重试**——这是最容易实现走样的地方。

| 返回状态 | 含义 | 动作 |
|---|---|---|
| `RETRYABLE_FAILURE` | 超时、限流、工具瞬时错误 | 同模板同负载**原样重派新实例**，attempt +1，最多 2 次重试（总 3 次）。新实例拿全新超时预算，**不继承 partial output** |
| `CONTRACT_VIOLATION` | 缺字段、无证据、越权写文件 | **作废该实例全部输出**，派全新实例从原始任务重跑，**attempt +1**（不归零，见 `protocol.md` §4.1），旧输出不得作为输入 |
| `PERMANENT_FAILURE` | 连续 3 次失败，或 harness 明确不可恢复 | **不得缩小范围重派**。写 `unverified`，最终报告显式暴露"未能覆盖" |
| 多 Agent 同时失败 | 同波次 2 个以上 Agent 在 60 秒内同时失败 | 暂停该波次新派发；失败切片标 `DEFERRED`；出报告并自动开下一轮（`protocol.md` §4） |

> **2026-11-04 修订**：本表此前与 `protocol.md` 有两处不一致——① `CONTRACT_VIOLATION` 写「attempt 从 0 计」，那是已修的**死锁源头**（会导致无限重派）；② 多失败窗口写「等待人工」，那是用户必须值守的直接来源。**同一个规则在三份文件里各写一遍，改一处必须同步三处**，这正是「机械归代码」那条结论的又一个例证。

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

改可以，但要改两处并保持一致：`scale-mapping.md` 第 3 节的表、以及 `protocol.md` 第 6 节的护栏。改完记得更新本说明书。另外想清楚为什么要改——**8 是设计假设，不是实测得出的最优值**，依据是切片粒度与协调开销的经验权衡。harness 上限更低时取 `min`，不要因为"可能支持更高并发"而上调。

> **⚠️ 2026-11-02 更正**：本节此前写"8 来自『无协调并行 Agent 失败率可达 72–100%』的实测"。经核实，那两个数字是**某论文在 mock API server 上测得的 HTTP 502/连接重置率**，不是审计失败率；该论文**从未建议并发窗口 = 8**；且**仅加准入控制仍有 81.8% 失败率**，"准入+背压即降到 0–18%"是对原文的反向误读。正确读法见 `orchestrator/scale-mapping.md` 第 3 节。

---

## 附：一页纸流程

> **⚠️ 2026-11-02 更正**：本节此前画的是含「修复 → 验收」的旧五波次，与 `orchestrator/protocol.md` 第 0.7 节「默认路径到报告结束、修复独立启动」**直接冲突**。以下为更正后的版本。

```
【默认路径 · 只读】
0. 探测轮次      → round_id          门控: 非空
   └─ 若 state.json 存在且 status != CLOSED → 续跑它，不开 N+1
1. 侦察          → 切片清单          门控: slice_count == len(audit_slices)，非空
   ↓ 主Agent 算: effective_slices → 查表 → scale_decision（写入后不改）
2A. 宽扫         → 线索 + 可达性     门控: lead_count == len(leads)，reachability 必填
   ↓ 1 片 = 1 agent，看全部 6 维，只出线索不出发现
2B. 深挖         → 带证据的发现      门控: 全部终态，覆盖完整
   ↓ 只对线索密集的切片派，按维度拆实例
3. 锐评          → 裁决              门控: 无 PENDING 冲突
   ↓ Skeptic 杀发现 / Devil's Advocate 找缺口 / Arbiter 裁决
4. 出报告        → 只拼接不重写      每个结论带 artifact_ref
   ↓ 任何终止路径都必须出报告；status 禁止 IN_PROGRESS

【可选路径 · 有副作用，用户显式启动】
5. 修复          → 修改 + 影响半径   门控: 每条 UPHELD 都有 SUCCESS
   ↓ 唯一有写权限的角色；不做自我验收；修改 ≠ 可以提交
6. 验收          → PASS / FAIL       门控: 每条修复都有结论
   ↓ 不看修复者的验证记录，自己构造定向检查
```
